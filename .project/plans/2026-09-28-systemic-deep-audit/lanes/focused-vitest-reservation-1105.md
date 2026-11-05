DONE

Focused UI Vitest: 1 → 3 GiB; CLI: 1 → existing validation 2 GiB; native Stack validation remains 2 GiB. No broker changes.
Unattributed moving-work measurement failures (no evidence this reservation change caused them): ChangedFilesReview (31 pass/1 fail), autoCollapse (1 fail), accountArtifactStore (138 pass/2 fail); these produced verdicts, not SIGKILLs.
Stack policy sampling included this lane’s pre-fix RED assertions; its full-suite exit 1 is not a GREEN claim.

OOM confirmed: privileged windows1-linux kernel journal records global OOM kills at 09:47:55Z and 09:52:47Z, matching the reported exit-137 windows.
Victims included PIDs 15749 / 28174, anonymous RSS 1,023,780 / 1,080,672 KiB; journal offsets were converted from −08:00.
Evidence: `.project/tmp/focused-vitest-reservation-1105/kernel-correlation.log`; original `.project/tmp/review-rail-relayout/adjacent-*.log`.

Measurements: sequential payloads under one hstack-exec admission on windows1-linux (L-C-005); one file/worker at a time.
Canonical process-tree discovery, 200 ms RSS/PSS and live VmHWM samples; maximum observed gap 212 ms. Values below are KiB.

| Shape / file (package-relative) | Peak tree RSS | Peak live HWM | Exit |
| --- | ---: | ---: | ---: |
| UI `sources/components/workspaces/scm/review/ChangedFilesReview.test.tsx` | 2,793,384 | 2,868,324 | 1 |
| UI `sources/components/workspaces/scm/review/ChangedFilesReview.autoCollapse.test.tsx` | 2,727,208 | 2,790,812 | 1 |
| UI `sources/components/workspaces/scm/review/ChangedFilesReviewDiffBlock.test.tsx` | 2,995,796 | 3,068,784 | 0 |
| CLI `src/utils/path/expandHomeDirPath.test.ts` | 422,572 | 442,652 | 0 |
| CLI `src/api/artifacts/accountArtifactStore.test.ts` | 1,601,992 | 1,783,032 | 1 |
| CLI `src/settings/accountSettingsClient.test.ts` | 1,169,468 | 1,184,396 | 0 |
| Stack `scripts/utils/dev_targets/config.test.mjs` | 21,112 | 27,264 | 0 |
| Stack `scripts/utils/dev_targets/remote_commands.test.mjs` | 1,397,264 | 1,657,124 | 1 |
| Stack `scripts/utils/dev_targets/native_execution_projection.test.mjs` | 335,396 | 336,024 | 0 |

The 126 ms config run has only two samples; it does not determine its class’s reservation. Full evidence: `.project/tmp/focused-vitest-reservation-1105/measurements.json` and `measure-v2.log`.
Derived rounding: ceil(2,995,796 / 1,048,576) = UI 3 GiB; ceil(1,601,992 / 1,048,576) = CLI 2 GiB; native Stack peak rounds to its existing 2 GiB class. No margin.
An 11 GiB worker fits 11 → 3 focused UI reservations, or 11 → 5 CLI reservations, before services/other work; actual admission still uses available memory and existing accounting.
Observed windows1-linux MemTotal 12,250,604 KiB (~11.68 GiB) yields the same slot counts. This does not promise three admissions on a busy worker.

Canonical owner: `command_resources.mjs`; existing single-file refinement in `remote_commands.mjs` selects by its already-known package. Generated `native_command_policy.sh` consumes that decision.
Generic focused server/package calibration stays 1 GiB; native Stack keeps general validation; compiler-demand overrides remain authoritative. No parallel owner or bypass added.
RED: `red.log` exited 1 before implementation; `red-owner-probe.log` confirms missing UI class and prior 1 GiB package selection. The draft CLI-specific class was removed in favor of existing validation.
The delayed `red-tap` command ran after implementation and is GREEN only. Final policy GREEN: 59/59 on nl1 (`green-final.log`); `hstack-exec -- node --test --test-reporter=tap --test-name-pattern='measured native workload reservations|focused source validation uses|focused test selections reserve compilation|compound build:packages then raw Vitest|CLI integration skips publication' apps/stack/scripts/utils/dev_targets/remote_commands.test.mjs`.
Launcher: 1/1 PASS, exit 0 on nl3 (`launcher-restored.log`), automatic placement; `hstack-exec -- node --test --test-reporter=tap --test-name-pattern='AUTO resolves repository-relative cwd' apps/stack/scripts/preferred_execution_launcher.test.mjs`.
Entry-loads: 7/7 PASS, exit 0 on windows1-linux (`entry-restored.log`); `hstack-exec -- node apps/stack/scripts/perf/entry-load.mjs` after reported broker recovery 10:54–10:59Z (88043a69f3).
Source import and canonical generated-shell equality: PASS; real existing UI/CLI file probes resolve 3 / 2 GiB respectively. An earlier nonexistent-file probe correctly retained general validation.
Remote attempts: pre-payload HSTACK_ADMISSION_UNAVAILABLE, no test verdict. Local entry-load policy refused compilation; no override used. Local UI fallback was canceled after correcting routing (exit 130), no verdict.

Self-simplification removed the redundant CLI class. Net: +1/−0 resource classes; +4/−0 class/package branches (two package selections, generated floor and explicit-wrapper cases), justified by measured underreservation; +0/−0 admission checks, states, errors, timers or retries.
Files: five existing source/test/projection files changed, one report added; no product documentation changes needed for operational calibration. Unrelated shared hunks preserved through a private index.
Private-index finalizer evidence: `.project/tmp/focused-vitest-reservation-1105/finalizer.log`; commit is this report’s enclosing fix(stack) packet. No push. Both required automatic-placement reruns passed after the reported broker recovery.
Residual risk: sampling is not a universal maximum; only the Linux guest was measured. Other operating systems remain unmeasured; the named UI/CLI test failures remain unattributed and need their owning lanes.
