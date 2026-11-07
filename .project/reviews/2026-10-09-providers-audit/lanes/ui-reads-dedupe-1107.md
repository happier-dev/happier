STATUS: BLOCKED — F2/F3/F4/F5 and Usage owner fixes implemented and committed; focused checks and entry-loads pass; F5 build awaits Protocol prerequisite fixes.

Code commit: `c7b5f4dad047acd6b8410e739a828135848cef39`. The coarse commit includes concurrent Saved Secret writer tests, collection command/touch refinements and ChangedFilesReview public-export closure needed by the tested source. Other lane changes were already captured by concurrent commits.

Observed broader failures: managed-view/picker batch has 127 passing / 4 failing neighboring Account reconnect and schema-retry cases. Plugin UI's current-source build stopped in Protocol prerequisites, before its compiler ran. Package typecheck and loaded replays belong to Providers ORCH.

Evidence root: `.project/tmp/providers-audit/ui-reads-dedupe-1107/`.

| Check | Verdict | Evidence |
| --- | --- | --- |
| F2 selected rotation, 1 and 128 external Secrets | RED: whole-catalog reads; GREEN: 4 exact-resource reads and 0 metadata catalog reads for either size; stale revision refused | `f2-red.log`, `f2-green.log` (8 passed) |
| F2 personal Action selector forwarding | GREEN, existing list/census contract retained | `f2-port-green.log` (1 passed) |
| F3 Provider unrelated Profile publication | RED 1 commit → GREEN 0; relevant account/group updates still work | `f3-usage-red.log`, `f3-profile-usage-green.log` |
| F3 Account unrelated Profile publication | GREEN 0 commits with settled mount and idle control; initial fixture counted unfinished mount work and was corrected | `account-fixture-green.log` (1 passed) |
| F3 Machine unrelated publication | RED 2 commits → GREEN 0; focused 6/6 also checks selected name, current picker options, installation and absence | `f3-machine-red-normalized-scope.log`, `f3-machine-focused-green.log` |
| F4 Secrets header menu | RED shared-menu selection contract; full GREEN 21/21 including rename, convert and move | `f4-red-local.log`, `f4-green-local.log` |
| F5 core wrapping/removal and chip toggle/touch | GREEN 2 + 1 + 1; earlier cold-import/host-locator and export-collection failures resolved | `f5-wrap.log`, `f5-filterchips-rerun.log`, `f5-filterchips-touch-current-source.log` |
| F5 public adapter | GREEN 1/1: accessible exact removal, Save and Save withdrawal | `f5-public-tokens.log` |
| F5 Plugin UI build | [blocked] Current-source retry: Protocol actions/actionExecutor.ts:5251 TS18048 and deployments/deploymentCandidatePublicationV1.ts:137 TS2542; no Plugin UI compiler verdict | `f5-plugin-ui-build-current-source.log`:43–44; earlier prerequisite failure in `f5-plugin-ui-build.log` |
| Duplicate Usage owner | RED 2 reads for equal declaration → GREEN 17/17 hook/resource; original detail expectations unchanged and all 3 pass | `usage-hook-baseline.log`, `usage-owner-green.log`, `f3-profile-usage-green.log` |
| Entry loads | GREEN 7/7 current-source graphs | `entry-loads-auto.log` |

F2 carries the existing exact resourceId through `secrets.list` and its personal port, UI selected read and update lookup. Existing revision/currentness checks remain. The CLI host's separate snapshot adaptation is unchanged.

F3 selects consumed Profile fields and exact requested/receipt Machine facts. The concurrent canonical controller-scope narrowing is consumed in place. Test fixtures restore their own published Machine rows through applyMachines; no new cache or snapshot owner was added.

F4 replaces the local DropdownMenu state/id dispatch with PageHeaderMenu actions. F5 moves wrapping/Save layout to Plugin UI presentation, exposes a public components adapter, and shares the filter-chip shell with core. Core retains its chooser behavior and host theme/localization bindings. FILTERS-1106 + UI refinements CLAIM posted before moving; no objection observed. Collection architecture and plugin author docs updated.

Usage attribution: committed `f9ba5bd13c` used JSON.stringify for authority identity. Bundled destination properties and schema-parsed Machine properties have equal values but different insertion order; this retired/reacquired the same demand. The canonical hook now uses existing stableJsonStringify. Own F3 edits did not introduce it. See `usage-attribution.log`.

SECRET-SEAM-1107 attribution: **not mine**. This lane did not edit the CLI personalSavedSecretActionHost test or add secrets.usedBy calls/Action IDs. RESULT posted to SECRET-SEAM-1107 + Providers ORCH at 17:31Z; route that producer elsewhere.

Broader failures routed at 17:20Z to MACH-CONTINUITY, OPTIONS-READY and O-MACH: view test:2458 (two reconnect cases) waits for a new provisioner identity while useManagedProvisioners.ts:105–106 retains equal refreshes; view test:3145 (two widths) expects schema errors withdrawn while useManagedProvisionerOptionsInput.ts:68,75–77 retains settled retry state. These are derived cause candidates, not a measured pre-existing baseline. No workaround or expectation change applied.

Split-brain audit: selected-resource API remains the sole Secret reader; revision writer and Used-by census remain existing owners. Usage sharing/retirement remains in its existing resource. Profile/Machine facts use existing selectors. Header menu and condition-row layout local duplicates were removed; core/public adapters only supply presentation bindings.

Net mechanism delta for lane changes: exact scalar Machine selectors +2 / full-list subscription −1; checks +0/−1 redundant controller-membership recheck; local states +0/−1 menu-open state; error codes/timers/retries/caches +0/−0. Files +4/−0 for the neutral row, shared chip shell, public adapter and adapter test; host adapters/exports/docs updated in place. Existing wrapping state moved unchanged.

Residual risk / owed live rows: ORCH must replay dummy converted Saved Secret account-key rotation with request counts, plus Provider and Account detail render counts while an unrelated Profile publishes, after reload. No loaded-runtime replay or package typecheck ran in this lane. F5's build remains blocked on the two named Protocol diagnostics; all lane runner handles are terminal.
