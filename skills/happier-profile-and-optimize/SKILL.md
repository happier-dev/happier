---
name: happier-profile-and-optimize
description: The method for profiling and optimizing anything whose success is a measured cost — frame the phase and metric, choose an instrument that can actually see the cost, label the waste, falsify the hypothesis with a cheap control before building a fix, and prove the result without over-claiming. Covers app/device and server/database work. Use when work is about slowness, jank, startup/open time, blocked JS, hangs, memory, render churn, a slow query, or a claimed speedup. It does not carry the write-time gotchas for UI code — those live in `apps/ui/AGENTS.md`.
metadata: {"openclaw":{"homepage":"https://github.com/happier-dev/happier"}}
---

# Happier Profile and Optimize

Use this skill for any work whose success is a measured cost, not a behavior: slow open/foreground/navigation, jank, hangs, startup, memory, render churn, a query that got slow, or verifying somebody's speedup claim. It is the *investigation* method — reach for it once a cost exists.

It is deliberately **not** the list of things to watch for while writing code. Those must apply unprompted, at authoring time, long before anyone suspects a problem, so they live in package instructions that are read on every task: `apps/ui/AGENTS.md` → **Performance and continuity** owns the UI write-time invariants (referential stability, narrow subscriptions, component-type stability, high-frequency state placement, dependency-array identity, loop stop conditions, one perf change lands on all platforms). If you are about to restate one of those here, stop and strengthen it there instead.

The rules this skill operates under also live elsewhere and are not restated: root `AGENTS.md` → **Product priorities** (name the phase and metric, instrument must be able to see the cost, no ratio without both sides on the same workload and machine state, no blanket memoization) and **Risk-weighted execution**. Read those; do not re-derive them.

Route out, do not absorb:

- `skills/happier-diagnose` — the incident is a *failure* (error, hang-to-crash, broken session), not a cost. Diagnose first, then return here only if the outcome is a cost.
- `skills/happier-testing` — lanes, RED/GREEN, mutation proof, live gates. A perf fix with a behavior change is still test-first there.
- `skills/happier-implement` — the actual change, canonical-owner discovery, split-brain sweep.
- `skills/verify-claims` — before relying on any delegated or reported number.
- `skills/attack-conclusion` — before handing off a perf verdict.

## 1. Frame the cost before touching an instrument

State, in one line each: the **phase** (cold open, warm foreground, navigation, steady state, per-commit), the **metric** (blocked ms, count, bytes, dropped frames), the **workload** (session size, row count, account), and the **user-visible symptom**. A metric without a phase cannot be reproduced or compared.

Measure the moment that hurts. Some costs are steady-state, not open-time; some are per-commit rather than a resting loop. Profiling the wrong moment produces a real number about the wrong thing.

## 2. Pick the instrument that can see the cost

Get a **total** first — total blocked/elapsed time for the phase — then reconcile every instrument's attributed total against it, per the instrument-coverage rule in root `AGENTS.md`. What that rule costs when skipped, measured here: a React profiler reported ~1.4 s while the JS thread was blocked ~12 s; 88% of the cost was outside React, and a full round of work went into render churn that was not the bottleneck.

Route to the instrument by what it can observe:

| You need | Instrument |
| --- | --- |
| Entry point for RN perf work, sweep order, fix patterns | `argent-react-native-optimization` |
| React render/commit counts, slow components, before/after render deltas | `argent-react-native-profiler` |
| CPU hotspots with call paths, UI hangs, memory — anything outside React | `argent-native-profiler` (xctrace / Perfetto) |
| Component tree, props/state identity, *why* something re-rendered | `react-devtools` |
| CDP `evaluate`, arming an in-app probe, reading the log registry | `argent-metro-debugger` |
| Server/database cost: which index a query actually seeks, what falls into `Filter:`, whether a predicate forces a scan | the planner — `EXPLAIN QUERY PLAN` (SQLite) and `EXPLAIN` (PostgreSQL), on a seeded table, post-`ANALYZE` |

Do not restate their contents; open the one you need.

**Server and database work uses this same method** — the instrument just changes. Read a plan for its *shape*, not its cost number: which index was chosen, which columns the `Index Cond` actually binds, and what residual predicate landed in `Filter:`. Run every engine that ships, because they disagree in ways that change the diagnosis: here the same attention query was a bare `SCAN main.Session` on SQLite but a `Bitmap Index Scan` on Postgres whose index condition bound only `meaningfulActivityAt IS NOT NULL`, leaving `accountId` in the `Filter:` — an account-wide scan wearing a bitmap. Isolate the cause with counterfactual query shapes, not by reading the query: dropping one `OR` arm at a time proved the intended index existed and was correct all along, and that a visibility `OR` alone was sufficient to destroy the seek. Costs on a small dev table are planner estimates, not production timings; the shape is the load-bearing part, and it must be engine-consistent before you act on it.

**Locate in time, then in code.** Block timing (e.g. a 16 ms drift sampler armed over the phase) tells you *when* the thread was stolen; a CPU profile with call paths tells you *what* stole it. Never fix something located only in time — a time window plus a plausible suspect is a hypothesis, not an attribution.

## 3. Label the waste, then write the hypothesis

Force one of these labels before proposing anything. The label constrains the fix:

`TOO EARLY` (work done before it is needed) · `TOO OFTEN` (repeated per event/commit/row) · `TOO MUCH` (correct work, oversized input) · `TOO SERIAL` (awaited in sequence, parallelizable) · `WRONG SHAPE` (data structure forces a scan) · `N+1` (per-item round trip) · `RENDER CHURN` (re-render without changed output) · `CACHE HAZARD` (missing key input, no in-flight sharing, or a stale/poisoned entry).

Then, before any edit:

> **Hypothesis:** `<cost>` is caused by `<work>` because `<evidence>`.
> **Verification:** measure with `<tool>`, inspect `<files>`.

If `<evidence>` is a subtraction ("the rest must be X"), root `AGENTS.md` already rules that a hypothesis, not a measurement — go observe X before fixing it.

## 4. Build the falsifying control before the fix

Design the cheapest observation that would prove the hypothesis **wrong**, and run it first. A control that costs minutes routinely retires days of queued work: here, one second-open-with-modules-already-resolved run showed the cost was not module loading and retired an entire lazy-loading workstream before it was built.

Good controls: same flow twice (cold vs warm), the flow with one input emptied, the suspect path short-circuited behind a temporary local branch, the same phase on a second account/session size. Keep the control disposable; it is evidence, not a deliverable.

## 5. Change, prove, and be willing to revert

- Fix at the canonical owner via `skills/happier-implement`; a perf fix that adds a second path for the same concept is a defect, not an optimization.
- Replay the *same* flow, phase, and workload with the same instrument, under root `AGENTS.md`'s paired-measurement gate. Concretely here, work-avoided proofs are call counts, commit counts, bytes parsed, and blocked ms.
- **A fix that costs UX is not a win.** This program built, measured, and reverted an idle-rAF scheduling fix because it broke bottom-follow. Record such reverts with the precondition that would make the idea viable again; a reverted measured attempt is a result, not a failure.
- Sweep after the fix per root `AGENTS.md`: the same waste label usually has siblings.

## 6. When you cannot measure

No device, saturated machine, flapping tooling, unreproducible phase: say so plainly and claim nothing. Report the phase, what was attempted, and the missing prerequisite as `[blocked]`. An inferred number is worse than no number — it survives into later decisions with false authority.

## Device measurement recipe

1. Boot the simulator, launch the app, let it settle.
2. Resolve the device id from `curl -s localhost:18829/json/list` and use **`reactNative.logicalDeviceId`** — never the raw simulator UDID. Wrong id = a profile of a different device.
3. Arm the probe *before* the action (profiler start, sampler, log registry), then perform exactly the flow you framed in step 1.
4. Stop and analyze. `react-profiler-analyze` requires `project_root`.
5. Pin bundle identity when a stale bundle could invalidate the result — see `skills/happier-testing` device QA rules.

**Do not wrap Metro's `global.__r` to count module evaluations.** It drops the CDP connection: the `for-in` over the registry loses its non-enumerable state. Use the first-vs-second-open control from step 4 instead.

## Stop and ask when

- the only available fix trades correctness, accessibility, continuity, freshness, or privacy for speed;
- the measurement requires a destructive action, another user's session, or shared/production state;
- the phase cannot be reproduced and the user wants a number anyway;
- the fix's blast radius exceeds the authorized scope and the local variant would be a second owner.
