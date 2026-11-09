# Verdict

DONE under Coordination's 2026-11-08 19:01 compiler-queue fallback: implementation, focused contracts, loaded measurements and entry-loads 7/7 passed. Final touched typecheck not run; existing queued handles are preserved. No foreign Stack was reloaded; adopt-only policy was not changed.

## Deliverables

- Reload's existing `run.reload.*.log` now retains redacted producer stderr and remote diagnostics. `prepareSourceRuntimeReload` owns the sink; runtime builder, command runner and remote supervisor forward to it. Complete lines and pending writes drain before return.
- Plugin UI's existing v2 build-input record retains optional `sourceInputs` and `compilerInputs`. The canonical `readSourcePluginUiBuildInputs` validates consumed bytes, resolver options, workspace membership and consumed-directory membership before skipping graph discovery. No new cache layer, output file or record version.
- Missing metadata rediscover graphs; changed inputs/conditions and damaged artifacts retain existing rebuild/repair behavior. A reproduced unrelated-source invalidation narrowed membership to consumed source directories.
- `docs/binary-runtime.md` now documents borrowed Expo as the source QA default and finite export as explicit `--ui=export`.

## Observed loaded measurements

All times are elapsed milliseconds on this loaded Linux machine, not isolated performance benchmarks. Evidence below is under `.project/tmp/daemon-prep-phases-1108/`.

| Measurement | Before/seed | Unchanged/warm | Compiler evidence |
| --- | ---: | ---: | --- |
| Full local daemon bundle | 980734 | 801380 | Both executable probes and publication completed |
| Author SDK closure | 353809 | 62288 | 18 → 0 compilers; all 18 package input identities equal |
| New full-size Plugin UI owner, 86 plugins | 207962 | 55816 | graph 87 → 0; artifacts 86 → 0; warm reused all 86 |

Full cold daemon phases: entry 203574; esbuild 20810; Plugin UI 247812; SDK owner 353809. The full warm daemon measurement retained the pre-lane UI owner to isolate SDK reuse; it is not a measurement of the final combined reload. It changed only an owned captured CLI host entry, leaving SDK inputs equal.

The historical 476-second SDK measurement predates `0dd47729db`'s per-package reuse. Current SDK owner already satisfies host/dependency-only reuse; no second SDK cache or emission owner was added. Today's cold build still needs 18 compilers. Lost stderr prevents assigning the original 16:15 reload's exact subphase costs retroactively.

Pre-change exploratory UI warm preparation took 260230 with 173 graph calls and 64 artifact builds. Its artifact invalidation cause was not isolated; do not infer a clean causal speedup from that timing. The deciding new-owner proof uses identical captured inputs and a fixed compiler root: 55816, zero graph/artifact compilers, zero plugin failures.

## Verification

- Logging RED sensitivity: final current tests with exact pre-edit owners supplied through a temporary Node load hook failed 3/3 specifically on missing local/remote diagnostics, without shared-source mutation (`logging-final-test-sensitivity-red.log`). GREEN: 7/7 (`logging-green-2.log`).
- UI RED: unchanged captured inputs invoked 5 graph compilers (`plugin-ui-owner-red.log`). Membership RED: an unrelated UI source addition invoked 1 unnecessary compiler (`plugin-ui-membership-red.log`). Final GREEN: 1/1, including zero work, legacy metadata, higher-priority new source, unused source edits, missing asset repair and resolver-condition controls (`plugin-ui-membership-green-final.log`).
- Input-owner adjacent suite: 8/8 (`plugin-ui-input-tests-final.log`). SDK owner contract: 1/1; dependency-only case 0 compilers (`author-owner-test.log`).
- Loaded build evidence: `before-build.log`, `after-sdk-build.log`, `sdk-input-comparison.log`, `plugin-ui-loaded-new-fixed.log`; the latter test passed 1/1. Measurement driver: `plugin-ui-loaded-fixed.test.mjs`.
- Changed-module syntax/import checks passed. `pnpm run tsc --allowJs --noEmit --noResolve --skipLibCheck --target es2022 --module nodenext ...` passed for all nine touched `.mjs` files (`touched-tsc.log`) before the final membership refinement. This is compiler parsing of JavaScript, not a checked-JavaScript or whole-UI-package typecheck.
- Final touched typecheck not run: helper/test compiler handles 30937 and 47812, plus delegate 3844, remain queued/preserved (`touched-ui-final-tsc.log`, `touched-ui-stable-tsc.log`, `plugin-ui-touched-tsc.log`). Coordination's 2026-11-08 19:01 RULING to all fix lanes explicitly permits commit on focused tests and entry-loads when compiler admission cannot finish; any later touched-file diagnostic is a follow-up.
- Entry-loads 7/7 passed from current source through `hstack-exec --local --allow-local-compilation -- node apps/stack/scripts/perf/entry-load.mjs` (`entry-loads-local-final.log`). The earlier AUTO entry-load run 90540 is preserved; it had not started before this local deciding check.
- Existing bundled runtime UI test failed with a synchronous initializer containing `await`. Exact pre-edit and current owner bundling both reproduce it (`plugin-ui-adjacent-baseline-comparison.log`, `/tmp/plugin-ui-adjacent-{before,current}-1108.mjs`). No adjacent GREEN is claimed.
- An attempted explicit web-export fixture test failed before its assertion because captured locale-source fixtures are incomplete (`logging-web-red.log`). Added test edits were removed; that run supplies no RED/GREEN evidence.

## Ownership and same-shape sweep

SDK emission remains `source_author_packages.mjs`; graph membership/fingerprints remain `workspaceBuildInputs.mjs`; UI admission/reuse remains `prepareSourcePluginUiArtifacts.mjs`; reload-log retention remains `prepareSourceRuntimeReload.mjs`. Legacy metadata delegates to graph discovery, not another decision-maker. SDK code needed no change.

Compatibility classification: internal build-tool metadata, with no published SDK, wire or Account-data change. The existing v2 reader accepts extra fields by property access; the new reader accepts records without graph metadata and rediscovers it, as exercised by the legacy-record control. No migration, new version or predecessor adapter is needed.

Same-shape sweep: producer diagnostics — local server/daemon builders and remote workers fixed through the one reload sink; explicit web-export stderr forwarding routed to Coordination's source-web owner. Compiler graph rediscovery — daemon Plugin UI fixed; `prepareSourceUiAssets.mjs` routed to Systemic's web/Expo owner, which uses the same canonical input reader but has a separate asset-record lifecycle.

Net mechanism delta: +1 canonical graph-reuse predicate; +2 optional fields in the existing build-input record; +1 serialized existing-log write queue. +0 runtime files, caches, record versions, lifecycle states, error codes, timers or retries; −unchanged graph compiler work (87 → 0 in the full-size owner proof). Files: +1 owner test and +1 requested lane report, no production files added or removed. Each addition addresses reproduced compiler work or lost diagnostic output at its existing owner.

## Residual risk

No final combined live Stack reload or Windows/macOS execution was performed; the authorized local finite source bundle and loaded owner measurements were used. Whole-UI TypeScript checking is not applicable to these `.mjs` tools. SDK reuse still copies and fingerprints the public package closure, and UI reuse still verifies/copies artifacts; zero compilers does not mean zero preparation cost. The two routed web/Expo twins and existing fixture defects remain outside this daemon brief. No DB, dependency installation, foreign Stack, adopt-only policy or push was changed.
