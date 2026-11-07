Verdict: B9/B10/B11 verified reachable and fixed; committed under the 11-07 fast path. Validation exceptions are explicit below.

| Finding | Before → after counts | Canonical owner | Source SHA |
| --- | --- | --- | --- |
| B9 verified | Three healthy sends: +6 retention queries → 0 before deadline; three live retry writes against empty terminal history: 6 → 0. At expiry, 202-row fixture/2 expired: 200 bodies → 3 (2 expired + 1 future anchor). | `outwardDeliverySupervisor.ts:816,947`; `outwardDelivery.ts:1609`; `collections.ts:2219` | `f44b9b8f09f3971d307483e3ea7cfae4acde69c4` |
| B10 verified | Old source: 1 invalidation and N bucket queries per healthy write (derived). Observed after: healthy write 0/0; one changed connection 1 invalidation/1 selected-connection query; initial three-connection read 1 set query. Paging follows matching attention rows, not N serial traversals. | `connectionsResource.ts:88,106,173`; `outwardDelivery.ts:1895` | `f44b9b8f09f3971d307483e3ea7cfae4acde69c4` |
| B11 verified | Home with 1,000 bindings: 1,000 Session reads/watches → 4; 996 hidden pushes → 0 reads. Column 12 shown → 12 watches; filter to 1 → 1. | `ui/glance/channelsGlance.tsx:278,294`; `ui/conversationRows.ts` | `f44b9b8f09f3971d307483e3ea7cfae4acde69c4` |

Owner paths above are under `packages/plugins/channels/src/`. The approved retention constant remains exactly 30 days.
Publication: source writer, CLI bundled manifest, packaged plugin manifest and active Expo UI inventory all declare deliveries V6/state V20. Both tracked projections match the canonical renderer. Delivery digest: `8anLqSSMAeFuPIU5AyIclYbf66wCmnN3xUmZg1NxLpM`.
The real Account Collection test reads a stored V5 row through the V6 reader, stages/promotes it, and preserves its logical payload and physical revision. CLI test owner: `apps/cli/src/plugins/runtime/context/accountPluginDataStorage.candidatePreparation.test.ts:417`.

Observed validation:
- B9 RED → GREEN: supervisor traffic/empty-history counts and store age selection; supervisor 116, outwardDelivery 101, collections 32, manifest 27 tests passed.
- B10 original cost RED was not observed: its first invocation selected the wrong cwd. Before counts above are source-derived. Subsequent stale-recovery, metadata refresh, re-observation and overlapping read→observe regressions did fail for their intended reasons; current Resource suite passes 8/8.
- B11 count RED → GREEN: glance/conversationRows 26/26 passed using the real Session host boundary.
- PostgreSQL 16.15 collection-owner contract: 7/7, including boolean terminal prefix, numeric cutoff, tied-cutoff cursor paging and earliest future anchor. Private test database stopped cleanly.
- Entry loads: 7/7 terminal at 11:59Z. Later owner watch-installation changes retain the same imports/exports and pass the Resource suite; later manifest publication passes the actual Account read. A fresh entry run remains queued, not passed.
- CLI full candidate suite: 34/35; actual stored-V5→V6 read passed. Foreign retained-state V19→V20 widening expectation failed; corrected to the declared identity-preparation contract, with narrow rerun still queued.
- Publication RED observed stale bundled V5 reader versus V6 writer. It stopped before Account.get: a separate stored-row-read RED was NOT observed; actual migration/read has GREEN evidence only.
- Pending, NOT run: Channels typecheck `76605` (no diagnostics-delta claim), extra idle/source-origin/recovery suites `27390`, entry refresh `60969`, narrow publication `94789`, corrected state adoption `53943`. Existing handles retained; no finalizer or push.

Evidence: `.project/tmp/fin-perf-channels-b9/{red,empty-red,green-adjacent,terminal-watch-green,publication-red,publication-green}.log`; `.project/tmp/FIN-PERF-CHANNELS/{b10-metadata-reobserve-red,b10-metadata-reobserve-green,b10-overlapping-observe-red,b10-overlapping-observe-green,b11-red,b11-green,postgres-b9-final-contract,entry-loads}.log`. Pending commands/logs remain in those directories or `/tmp/fin-perf-b9-*`.

Net mechanism delta: +1 terminal/update-time index, +1 identity migration, +1 terminal subscription and +1 fixed cursor cutoff preserve deadline scheduling and query identity; +1 producer using the existing Resource context lifecycle owns changed-connection projection/subscriptions. No new custody/lifecycle states, error codes, timers, retries or public plugin-ui API changes.
Removed: in-memory age filtering, per-write retention restart, broad delivery Resource invalidation, N serial attention traversals, and both eager snapshot-level Session demands. Page demand remains at its existing owner; glance demand follows presented rows. No new cache, debounce, timeout or interval.
Commit includes compatible foreign test/public-host and retired-custody fixture work, conversationRows status/error cleanup, portable CLI loader/Jiti interop, historical migration fixtures and candidate-preparation coverage, and admitted-read PostgreSQL coverage; these are named in its message. Compiler/Babel campaign excluded. Private index + commit-tree + CAS used; shared staging untouched.
Self-simplification found and fixed the reachable initial-read/observe subscription gap using the same watch owner; no additional lifecycle machinery. Reader/writer declarations have one canonical source and no competing tracked live V5 declaration remains.

Residual risk: unresolved partial/unknown terminal rows stay retained and may supply one future deadline wake. [blocked] Browser QA could not start: QA-host SSH timed out; loaded daemon source identity predates these fixes. Active Expo inventory is V6, but a new daemon/loaded-client journey and native Windows/macOS QA were not claimed. Pending validation above remains integration follow-up; original cost/migration-read RED gaps remain explicit.
