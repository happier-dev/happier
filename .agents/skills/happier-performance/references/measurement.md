# Measuring Happier performance

Use the existing owners. Browser capture, analysis and regression comparison live in `apps/stack/scripts/perf/` (`capture`, `analysis`, `perf`, `regression`). Pipeline orchestration is `scripts/pipeline/run.mjs` → `scripts/pipeline/perf/validate-perf.mjs`. Seeded environments come from `packages/tests/src/testkit/stress`. Don't build a parallel harness.

## Live recipes

Each one runs on a loaded runtime whose identity you've verified: stack name, PID and birth, selected = loaded source/snapshot identity. Run them one at a time on a stack you own, because QA stacks have one lifecycle owner.

| Recipe                   | Window                                                                               | Record                                                                                                                                          | Gate                                                        |
| ------------------------ | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| **Idle census**          | 300 s, no browser, ≥3 min after start                                                | Requests/min by route **and caller** (joined to PID), CPU user/system per process, threads (Tokio worker count), RSS / heap / external, 409/5xx | ≈0 requests except named liveness; no host-core-sized pools |
| **Settled Home (J13)**   | A true 60 s quiet (hydrated, 0 root/Artifact publications), then 300 s               | Commits, component renders, root notifications, main-thread occupancy, long tasks, GC, requests by route                                        | ≈0 commits and requests on a settled Home                   |
| **Stationary inventory** | 60 s on the same settled document                                                    | HTTP starts, socket frames, timer installs/fires by callback owner, mounted closed surfaces, loaders per resource family                        | No loads for closed surfaces; every recurring timer named   |
| **Busy per-arrival**     | 60 s on a large Account                                                              | Renders per arrival, rows re-rendered per arrival, commit trigger per commit                                                                    | O(changed rows)                                             |
| **Transfer census**      | 72 s settled Home with background Sessions active, then foreground and open → leave one Session | `bundle.json.counts` `transfer.http.<method>.<route-class>.*` (requests, decoded and encoded body bytes, unavailable kept null) and `transfer.socket.<direction>.<family>.<type>.<delivery>.*` (hint vs full frames and bytes, `update-session`, deltas) | Non-consumed Sessions: hints only, 0 deltas; no full list refresh per row change |
| **Interaction journey**  | One operation                                                                        | Phase decomposition from client action through admission, owner, native, projection and back to the client                                      | Each phase attributed to an owner                           |
| **Heap**                 | One snapshot per process, sequential, exact PID, release before the next             | Retainers by owner: code/strings vs data, duplicates, closures, native/external                                                                 | Retained bytes per owner trend down                         |
| **SQL**                  | ≤120 s, read-only (`BEGIN TRANSACTION READ ONLY; …; COMMIT;`), never a session `SET` | Statements by calls/time per route, N+1, repeated identical statements, idle-loop statements                                                    | Statements per request bounded and owned                    |

## Pitfalls that produced false findings

- **Our own sampler.** The JS thread-lag telemetry (`sync/runtime/performance/jsThreadLagTelemetry.ts`, a 50 ms self-rearming timer) runs only when `syncPerformanceTelemetry` is enabled. It's off by default, but our counts harness turned it on: 1,190 of 1,327 "idle" timer fires. Turn it off, or report it as a separate line.
- **Dev bundle.** React development performance tracking cost 14.6 s of a 60 s capture. The Metro module registry is about 98 MB of UI heap. The dev main bundle is 39 MB encoded / 255 MB decoded and never cached. Use dev runs for **counts**; use an **export** build (`--ui=export`) for timing milestones.
- **RSS without GC.** The daemon read 1.25 GB in the census and 0.81 GB after a heap snapshot forced GC. Report heap used, external, ArrayBuffers and RSS after GC before calling something a leak.
- **Shared Accounts and DB.** Other stacks' daemons create real arrivals: status approvals and Artifacts at about 1.3/s on the dev test Account. Attribute by caller PID or `application_name` before blaming your own process. Use a fresh, quiet fixture Account for settled-state gates, and the shared Account only for busy per-arrival work.
- **Warm vs cold confound.** Navigating from an already-busy Home inflates "warm" open. Split J1 into native document start, bundle delivery and Home-ready.
- **Fixture authority.** A Machine view grant isn't a credential grant, so a fixture Account needs its own connected service, or the approved Team share, before it can start Sessions.
- **Lane-held browsers.** Interrupting a lane retires the browser it owns, along with any fixture Account that exists only in that profile. Run fixture browsers detached from the lane's turn.
- **Inspectors on shared QA processes.** A QA server segfaulted under a CPU profiler (2026-10-23). A shared QA daemon vanished 13 s after an inspector detach (2026-10-26), which cost a measured process mid-recount. Use Doctor `/doctor/vitals` (heapUsed, heapTotal, RSS) and log-based counts. No inspector on QA servers or daemons until an owner-managed release path is validated.
- **Heap snapshots perturb.** One snapshot paused the daemon for 18.5 s and left RSS at 2.4 GB. Never compare RSS taken after a snapshot; restart before the next RSS measurement.
- **Async DB cost.** V8 CPU profiles left 92% of Prisma engine time without a domain caller. Attribute database cost with the existing query spans (`webLatencyTrace.ts`, `HAPPIER_WEB_LATENCY_TRACE=1` with JSON trace logging), in a bounded window, extracting only span fields: phase, elapsed, status, request/span ids, route. Never copy raw trace lines.
- **Source maps.** A UI CPU profile is attributable only when its matching source maps are captured with it. A failed map left 53 s of a 92 s busy window unmapped.
- **Restarts move ports.** Every QA stack restart moves internal ports. Refresh fixture daemons and re-read `stack info` before using either.
- **Version skew across stacks.** A newer peer daemon (for example a Team broker on another stack) can expose capability shapes an older QA server cannot read. Before blaming product code, compare the loaded identities of both sides.

## CI tiers (PERFCI)

- **Tier 1 (gating):** deterministic count contracts in existing unit/owner suites. Examples: no-op publication, Session-list clock only with a named deadline, unrelated subscriptions during streaming. A contract is admitted only after a deliberate-regression RED and 10/10 unchanged passes.
- **Tier 2 (gating once calibrated):** seeded composed scenarios measuring wire bytes and message counts.
- **Report-only:** timings, forced-GC heap, SQL counts, bundle bytes and CPU/event-loop metrics, via the canonical `comparison.json` / `comparison.md`. These are never release or CI failures until calibrated.

When you land a fix with a count contract, propose it as a Tier 1 contract so the regression can't silently return.
