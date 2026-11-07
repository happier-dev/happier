# FIN-PERF-EDITOR

Verdict: B3–B5 corrected and committed; count-based RED→GREEN and the seven-graph entry gate passed. Broader UI validation remains red/blocked; no package-green claim.

| Finding | Re-verification and measured before → after | Canonical owner / consumer | Commit |
| --- | --- | --- | --- |
| B3 | Verified reachable. Nested mount: artifact inventory requests 1 → 0; built-in and plugin/saved exact-reference tests pass, including a 500-unrelated-definition fixture. | `components/workflows/editor/WorkflowNestedWorkflowBlockEditor.tsx:105`; existing exact title/definition readers, not the chooser library. | `70b31d8fff6c6b9e50f10eb9ef7951c4f8c7181e` |
| B4 | Verified reachable. Host-only Project census requests 1 → 0; scoped personal-memory Save still passes. | `components/workflows/screens/WorkflowEditorHostScreen.tsx:548`; `useWorkflowEditorAccountMemory.ts:25` gates unused subscriptions. | `70b31d8fff6c6b9e50f10eb9ef7951c4f8c7181e` |
| B5 | Verified reachable. One producer publication among 1,000 Sessions: unrelated Session-id reads 1,998 → 0; activity preserves the array; rename/removal also visit zero unrelated ids and preserve unaffected options. | `components/workflows/screens/useWorkflowExistingSessionOptions.ts:60,73,141`; consumes canonical Session/list deltas. | `d4a4ad38fcef7d799e140fe84e9b039eea89ec4b` |

Owner paths above are relative to `apps/ui/sources/`. B3 covers built-in, plugin, saved/shared and frozen child titles; the open replacement chooser retains intentional full-library demand. B4 leaves Where's real workspace demand at the scoped Project owner. B5 serves workflow and trigger continuation choosers/drop candidates through one hook; cold/structural, policy, visibility, locale and target changes reconstruct the demanded projection.

Evidence actually run:
- RED: `/tmp/fin-perf-editor-red.log` records all three intended count failures; no shared-source reversal was used.
- GREEN: three targeted count cases in `/tmp/fin-perf-editor-green.log`; B3 bindings 17/17 in `/tmp/fin-perf-editor-neighbors-green.log`; final B5 suite 12/12 in `/tmp/fin-perf-editor-b5-final.log`.
- Entry-loads: earlier full 7/7 in `/tmp/fin-perf-editor-entry.log`; fresh run passed six graphs but initially failed Teams `managedDefaults.js` loading (`/tmp/fin-perf-editor-entry-final.log`). Canonical `loadEntryGraph(ENTRY_GRAPHS[0])` retry passed in `/tmp/fin-perf-editor-entry-preparation-retry.log`, completing the fresh seven-graph gate.
- Adjacent suites remain red: six Host assertions (`/tmp/fin-perf-editor-focused.log`), four Where assertions (`/tmp/fin-perf-editor-adjacent.log`), two inventory assertions (`/tmp/fin-perf-editor-inventory-diagnostic.log`). Recovery suite passed. Failures are not attributed as pre-existing.
- Inventory diagnostics show the failing inputs themselves retain old private continuation facts or lack admitted metadata; no consumer-side workaround was added. Temporary diagnostic assertion messages were removed.
- `[blocked]` Public `pnpm --dir apps/ui run typecheck` stopped before UI checking: dependency declaration preparation failed with four TS2883 errors in `packages/plugins/deploy-cloudflare/{src/definition.ts:42,src/manifest.ts:5,src/platform/tunnel.ts:35,117}`. `/tmp/fin-perf-editor-typecheck.log`; FIN/integration must restore declaration preparation and run the public check. No diagnostics baseline/delta evidence exists.
- Scoped diff checks passed. No browser/device QA ran; counts are source-harness observations, not loaded-product latency measurements.

Split-brain/removals: nested blocks no longer demand the library for a single title; the host no longer opens a redundant Project census; B5 removes full Session membership scans and the per-record WeakMap path from ordinary publications. Existing title/Get, Project, candidacy, target and Session-delta owners remain authoritative.

Net mechanism delta: read demands +0/−2 (unrelated library and host census); exact-title subscription +1/−0 (preserves frozen/live titles); title result field +1/−0 (reuses exact Get disclosure); demanded keyed projection maps +2/−1 WeakMap (changed-id membership, released with demand); scoped subscriptions +2/−2 generic selectors; publication checks +2/−0 (predecessor/adjacency establish exhaustive deltas across React coalescing). Timers, retries, limits, error codes and source files +0/−0; requested report +1.

Both commits use private indexes, `commit-tree` and CAS `update-ref`; no shared-index changes, finalizer or push. Messages name incorporated foreign protocol/title/lifecycle fixtures (B3/B4) and recording-privacy/context-label work (B5). Later unrelated shared test edits were preserved. No canonical documentation change was needed: public behavior and transport/persistence contracts are unchanged.

Residual risk: adjacent Host/Where/inventory failures and the unavailable package typecheck prevent an integrated UI-green verdict. FIN owns their adjudication and the package rerun; moving shared source and unmeasured browser/mobile behavior remain outside this evidence.
