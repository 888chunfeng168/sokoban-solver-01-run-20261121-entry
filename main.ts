// Sokoban solver: push-optimal, room by room.
//
// A level is a hallway with rooms off it; a box pushed out of a room can
// never come back, so each room is its own little puzzle and the level's
// push optimum is the sum of the rooms'. Each room is solved with A* over
// pushes (admissible: the cheapest matching of boxes to goals by floor
// distance), pruned by dead squares and frozen 2x2 blocks. The search is
// budgeted by work, never by the clock, so two runs answer alike.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Work budgets: states expanded, per room and for the whole set.
const ROOM_BUDGET = 600_000;
const WHOLE_BUDGET = 400_000;
const MOVE_BUDGET = 200_000;
const TOTAL_BUDGET = 2_500_000;

const DIRS = [
  { dx: 0, dy: -1, step: 'u', push: 'U' },
  { dx: 0, dy: 1, step: 'd', push: 'D' },
  { dx: -1, dy: 0, step: 'l', push: 'L' },
  { dx: 1, dy: 0, step: 'r', push: 'R' },
];

type Level = {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
};

/** XSB text into a level. Short rows and the outer frame count as walls. */
function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x]!;
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  return { w, h, wall, goals, boxes: boxes.sort((a, b) => a - b), player };
}

/** Squares a lone box can be pulled onto some goal from, over open floor. */
function liveSquares(L: Level): Uint8Array {
  const { w, wall, goals } = L;
  const live = new Uint8Array(wall.length);
  const queue = [...goals];
  for (const g of goals) live[g] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi]!;
    for (const d of DIRS) {
      const dd = d.dy * w + d.dx;
      const y = x - dd;
      if (!wall[y] && !wall[y - dd] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/** Floor distances from one square, over walls alone (boxes ignored). */
function floorDist(L: Level, from: number): Int32Array {
  const { w, wall } = L;
  const dist = new Int32Array(wall.length).fill(-1);
  const queue = [from];
  dist[from] = 0;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    for (const d of DIRS) {
      const q = p + d.dy * w + d.dx;
      if (!wall[q] && dist[q] < 0) {
        dist[q] = dist[p]! + 1;
        queue.push(q);
      }
    }
  }
  return dist;
}

/** The rooms: cut the hallway row's dead squares out of the floor; each
 *  part left that holds boxes is a room. Null when the level is no set of
 *  rooms (a box in the hallway, or a part whose boxes and goals mismatch). */
function roomsOf(L: Level, live: Uint8Array): { boxes: number[]; goals: number[] }[] | null {
  const { w, wall, goals, boxes, player } = L;
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) if (!wall[i] && !live[i]) cut[i] = 1;
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: { boxes: number[]; goals: number[] }[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      const p = squares[i]!;
      for (const d of DIRS) {
        const q = p + d.dy * w + d.dx;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ boxes: [], goals: [] });
  }
  for (const b of boxes) rooms[part[b]!]!.boxes.push(b);
  for (const g of goals) {
    if (part[g]! < 0) return null;
    rooms[part[g]!]!.goals.push(g);
  }
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/** A binary heap on [f, -g, seq, state]: smallest f first, deepest first on ties. */
class Heap {
  a: number[][] = [];
  get size(): number {
    return this.a.length;
  }
  push(e: number[]): void {
    const a = this.a;
    a.push(e);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(a[i]!, a[p]!)) break;
      [a[i], a[p]] = [a[p]!, a[i]!];
      i = p;
    }
  }
  pop(): number[] {
    const a = this.a;
    const top = a[0]!;
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= a.length) break;
        if (c + 1 < a.length && less(a[c + 1]!, a[c]!)) c++;
        if (!less(a[c]!, a[i]!)) break;
        [a[i], a[c]] = [a[c]!, a[i]!];
        i = c;
      }
    }
    return top;
  }
}
function less(x: number[], y: number[]): boolean {
  return (
    x[0]! < y[0]! ||
    (x[0]! === y[0]! && (x[1]! < y[1]! || (x[1]! === y[1]! && x[2]! < y[2]!)))
  );
}

/**
 * Push-optimal solution of a level: {pushes, moves}, or null past the budget.
 * A state is the boxes (packed, sorted) and the player's reachable region,
 * named by its lowest square. Cost is pushes; the estimate is the cheapest
 * box-to-goal matching by floor distance.
 */
function solvePushes(L: Level, budget: number, spent: { n: number }): { pushes: number; moves: string } | null {
  const { w, h, wall, goals, boxes, player } = L;
  const size = wall.length;
  const n = boxes.length;
  if (n === 0) return { pushes: 0, moves: '' };
  // The packed state key is exact only for a few boxes; bigger levels go
  // to the move search instead (rooms never hold more than four).
  if (n > 5) return null;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares(L);
  if (boxes.some((b) => !live[b])) return null;
  const solved = (bs: number[]): boolean => bs.every((b) => goal[b]);
  if (solved(boxes)) return { pushes: 0, moves: '' };

  const goalDist = goals.map((g) => floorDist(L, g));
  const hCache = new Map<number, number>();
  const estimate = (bs: number[]): number => {
    const pack = packBoxes(bs, size);
    const hit = hCache.get(pack);
    if (hit !== undefined) return hit;
    // Cheapest bijection boxes -> goals, by floor distance (n <= 4 here).
    let best = Infinity;
    const used = new Array(n).fill(false);
    const walk = (i: number, sum: number): void => {
      if (sum >= best) return;
      if (i === n) {
        best = sum;
        return;
      }
      for (let j = 0; j < n; j++) {
        if (used[j]) continue;
        const d = goalDist[j]![bs[i]!]!;
        if (d < 0) continue; // this box never reaches that goal; try another
        used[j] = true;
        walk(i + 1, sum + d);
        used[j] = false;
      }
    };
    walk(0, 0);
    hCache.set(pack, best);
    return best;
  };

  const packBoxes = (bs: number[], s: number): number => {
    let p = 0;
    for (const b of bs) p = p * s + b;
    return p;
  };
  const unpackBoxes = (p: number, count: number, s: number): number[] => {
    const bs = new Array<number>(count);
    for (let i = count - 1; i >= 0; i--) {
      bs[i] = p % s;
      p = Math.floor(p / s);
    }
    return bs;
  };

  // Flood fill from `from` around walls and stamped boxes; returns the
  // region's lowest square and marks it in `seenArr` with a fresh stamp.
  // Two stamp arrays: `seen` for the state being expanded, `mark` for the
  // state a push makes, so the second never overwrites the first's region.
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  const occ = new Int32Array(size);
  let stamp = 0;
  const reachLow = (from: number, bs: number[], seenArr: Int32Array): number => {
    stamp++;
    for (const b of bs) occ[b] = stamp;
    let low = from;
    let sp = 0;
    stack[sp++] = from;
    seenArr[from] = stamp;
    while (sp > 0) {
      const p = stack[--sp]!;
      if (p < low) low = p;
      for (const d of DIRS) {
        const q = p + d.dy * w + d.dx;
        if (!wall[q] && occ[q] !== stamp && seenArr[q] !== stamp) {
          seenArr[q] = stamp;
          stack[sp++] = q;
        }
      }
    }
    return low;
  };
  const focc = new Int32Array(size);
  let fstamp = 0;
  const frozen = (bs: number[], t: number): boolean => {
    fstamp++;
    for (const b of bs) focc[b] = fstamp;
    const mark = fstamp;
    const tx = t % w;
    const ty = Math.floor(t / w);
    for (const [ax, ay] of [
      [tx - 1, ty - 1],
      [tx, ty - 1],
      [tx - 1, ty],
      [tx, ty],
    ]) {
      if (ax < 0 || ay < 0 || ax + 1 >= w || ay + 1 >= h) continue;
      const a = ay * w + ax;
      const cells = [a, a + 1, a + w, a + w + 1];
      if (!cells.every((c) => wall[c] || focc[c] === mark)) continue;
      if (cells.some((c) => focc[c] === mark && !goal[c])) return true;
    }
    return false;
  };

  const keyOf = (pack: number, low: number): number => pack * size + low;
  const packs: number[] = [packBoxes(boxes, size)];
  const players: number[] = [player];
  const parents: number[] = [-1];
  const madeBy: number[] = [-1]; // from-cell * 4 + dir index of the push
  const gs: number[] = [0];
  const closed = new Map<number, number>();
  const startLow = reachLow(player, boxes, seen);
  closed.set(keyOf(packs[0]!, startLow), 0);
  const heap = new Heap();
  let seq = 0;
  heap.push([estimate(boxes), 0, seq++, 0]);
  let expanded = 0;
  let found = -1;
  while (heap.size > 0) {
    const [, negG, , s] = heap.pop()!;
    const g = -negG;
    if (gs[s]! !== g) continue;
    const bs = unpackBoxes(packs[s]!, n, size);
    if (solved(bs)) {
      found = s;
      break;
    }
    if (expanded >= budget || spent.n >= TOTAL_BUDGET) return null;
    expanded++;
    spent.n++;
    reachLow(players[s]!, bs, seen);
    const here = stamp;
    for (let bi = 0; bi < n; bi++) {
      const b = bs[bi]!;
      for (let di = 0; di < 4; di++) {
        const d = DIRS[di]!;
        const dd = d.dy * w + d.dx;
        const t = b + dd;
        if (seen[b - dd] !== here || wall[t] || bs.includes(t) || !live[t]) continue;
        const next = bs.slice();
        next[bi] = t;
        next.sort((x, y) => x - y);
        if (frozen(next, t)) continue;
        const nLow = reachLow(b, next, mark);
        const pack = packBoxes(next, size);
        const k = keyOf(pack, nLow);
        if ((closed.get(k) ?? Infinity) <= g + 1) continue;
        closed.set(k, g + 1);
        const h = estimate(next);
        if (!Number.isFinite(h)) continue;
        const t2 = packs.length;
        packs.push(pack);
        players.push(b);
        parents.push(s);
        madeBy.push(b * 4 + di);
        gs.push(g + 1);
        heap.push([g + 1 + h, -(g + 1), seq++, t2]);
      }
    }
  }
  if (found < 0) return null;
  // The pushes, then the moves: walk to each push's square, then push.
  const chain: number[] = [];
  for (let s = found; s > 0; s = parents[s]!) chain.push(s);
  chain.reverse();
  let moves = '';
  let p = player;
  let cur = boxes;
  for (const s of chain) {
    const from = Math.floor(madeBy[s]! / 4);
    const di = madeBy[s]! % 4;
    const d = DIRS[di]!;
    moves += walkTo(L, cur, p, from - (d.dy * w + d.dx));
    moves += d.push;
    p = from;
    cur = unpackBoxes(packs[s]!, n, size);
  }
  return { pushes: chain.length, moves };
}

/** Shortest walk from `from` to `to` around walls and boxes, lower LURD. */
function walkTo(L: Level, boxes: number[], from: number, to: number): string {
  const { w, wall } = L;
  if (from === to) return '';
  const box = new Set(boxes);
  const prev = new Int32Array(wall.length).fill(-1);
  const how = new Array<string>(wall.length);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    if (p === to) break;
    for (const d of DIRS) {
      const q = p + d.dy * w + d.dx;
      if (wall[q] || box.has(q) || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = d.step;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: push square out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]!) s = how[p]! + s;
  return s;
}

/**
 * Fallback: A* over single steps (fewest moves, not fewest pushes), so a
 * room the push search gave up on still gets solved, for partial points.
 */
function solveMoves(L: Level, budget: number, spent: { n: number }): { pushes: number; moves: string } | null {
  const { w, wall, goals, boxes, player } = L;
  const size = wall.length;
  const n = boxes.length;
  if (n === 0) return { pushes: 0, moves: '' };
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const goalDist = goals.map((g) => floorDist(L, g));
  const estimate = (bs: number[]): number =>
    bs.reduce((a, b) => a + Math.min(...goalDist.map((gd) => gd[b]!)), 0);
  // String keys: this fallback also runs on whole levels, where a packed
  // number would overflow past 2**53 for many boxes.
  const keyOf = (p: number, bs: number[]): string => p + ':' + bs.join(',');
  const players: number[] = [player];
  const boxSets: number[][] = [boxes];
  const parents: number[] = [-1];
  const steps: string[] = [''];
  const gs: number[] = [0];
  const closed = new Map<string, number>([[keyOf(player, boxes), 0]]);
  const heap = new Heap();
  let seq = 0;
  heap.push([estimate(boxes), 0, seq++, 0]);
  let expanded = 0;
  let found = -1;
  while (heap.size > 0) {
    const [, negG, , s] = heap.pop()!;
    const g = -negG;
    if (gs[s]! !== g) continue;
    const bs = boxSets[s]!;
    if (bs.every((b) => goal[b])) {
      found = s;
      break;
    }
    if (expanded >= budget || spent.n >= TOTAL_BUDGET) return null;
    expanded++;
    spent.n++;
    const p = players[s]!;
    for (const d of DIRS) {
      const q = p + d.dy * w + d.dx;
      if (wall[q]) continue;
      let nb = bs;
      let letter = d.step;
      const at = bs.indexOf(q);
      if (at >= 0) {
        if (wall[q + d.dy * w + d.dx] || bs.includes(q + d.dy * w + d.dx)) continue;
        nb = bs.slice();
        nb[at] = q + d.dy * w + d.dx;
        nb.sort((a, b) => a - b);
        letter = d.push;
      }
      const k = keyOf(q, nb);
      if ((closed.get(k) ?? Infinity) <= g + 1) continue;
      closed.set(k, g + 1);
      const t = players.length;
      players.push(q);
      boxSets.push(nb);
      parents.push(s);
      steps.push(letter);
      gs.push(g + 1);
      heap.push([g + 1 + estimate(nb), -(g + 1), seq++, t]);
    }
  }
  if (found < 0) return null;
  let moves = '';
  let pushes = 0;
  for (let s = found; s > 0; s = parents[s]!) {
    moves = steps[s]! + moves;
    if (steps[s]! === steps[s]!.toUpperCase()) pushes++;
  }
  return { pushes, moves };
}

/** The player square after `moves` from `from`. */
function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves) p += ch === 'u' || ch === 'U' ? -w : ch === 'd' || ch === 'D' ? w : ch === 'l' || ch === 'L' ? -1 : 1;
  return p;
}

/** Solve one level's text into its moves string. */
function solveLevel(text: string, spent: { n: number }): string {
  const L = parseLevel(text);
  if (L.boxes.length === 0) return '';
  const live = liveSquares(L);
  const rooms = roomsOf(L, live);
  if (rooms !== null) {
    let player = L.player;
    let moves = '';
    const done: boolean[] = rooms.map(() => false);
    for (let r = 0; r < rooms.length; r++) {
      const room = rooms[r]!;
      const wall = L.wall.slice();
      for (let o = 0; o < rooms.length; o++) {
        if (o === r) continue;
        for (const b of done[o]! ? rooms[o]!.goals : rooms[o]!.boxes) wall[b] = 1;
      }
      const sub: Level = {
        w: L.w,
        h: L.h,
        wall,
        goals: room.goals.slice().sort((a, b) => a - b),
        boxes: room.boxes.slice().sort((a, b) => a - b),
        player,
      };
      const solved = solvePushes(sub, ROOM_BUDGET, spent) ?? solveMoves(sub, MOVE_BUDGET, spent);
      if (solved === null) return '';
      moves += solved.moves;
      player = endOf(L.w, player, solved.moves);
      done[r] = true;
    }
    return moves;
  }
  const solved = solvePushes(L, WHOLE_BUDGET, spent) ?? solveMoves(L, MOVE_BUDGET, spent);
  return solved === null ? '' : solved.moves;
}

const spent = { n: 0 };
for (const id of readdirSync(I, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()) {
  const moves = solveLevel(readFileSync(join(I, id, 'level.txt'), 'utf8'), spent);
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
