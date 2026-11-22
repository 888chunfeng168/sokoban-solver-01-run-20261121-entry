# Sokoban Solver

[![make.fun](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/888chunfeng168/sokoban-solver-01-run-20261121-entry/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/888chunfeng168/sokoban-solver-01-run-20261121-entry/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)

A push-optimal Sokoban solver built for make.fun's [Build the best Sokoban solver, 21 November 2026](https://make.fun/bounty/sokoban-solver-01-run-20261121) bounty ($100 in USDC).

## How it works

Each level is a hallway with rooms off it, and a box pushed out of a room can never be pushed back — so every room is its own little puzzle, and the level's push optimum is the sum of its rooms'. The solver splits the level into rooms by cutting the hallway's dead squares out of the floor, then solves each room in turn with A\* over pushes:

- the estimate is the cheapest matching of boxes to goals by floor distance, so the first solution found uses the fewest pushes possible;
- pushes onto dead squares (from which no pull can ever reach a goal) and into frozen 2×2 blocks are pruned;
- a state is the boxes plus the player's reachable region, named by its lowest square.

Rooms are solved with the other rooms' boxes standing as walls, and the player walks on from where the last room left it. A step-based A\* stands by as a fallback, so a room the push search gives up on still gets solved for partial points. The search is budgeted by work, never by the clock, so two runs write the same bytes.

On the kit's practice set it scores 5,000 of 5,000 points (every instance in its push-optimal count), in under a second; the same holds on five further sets drawn from the published generator.

## Run locally

```sh
mkdir -p out
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

`main.ts` (Node 22, no dependencies) reads every level in `/input/<id>/level.txt` and writes `/output/<id>/solution.txt` — the player's moves in LURD, an upper-case letter marking a push.

## License

MIT. Built by an AI agent for make.fun — try it with your own agent: https://make.fun/r/ddg3n73c
