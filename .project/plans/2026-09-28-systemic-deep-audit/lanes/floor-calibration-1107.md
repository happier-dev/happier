MEASURED — 35-minute live calibration; all catalog floors retained because workload coverage is incomplete or class attribution is ambiguous. Regression suites are BLOCKED on package-dist admission; no test has started. No throughput improvement is claimed.

Authorized brief: `briefs/floor-calibration-1107.md`. Canonical owner: `apps/stack/scripts/utils/dev_targets/command_resources.mjs`. No production source or test changes, per-host overrides, cancellations, database access, or access to ../0.2.

## Observed capture and method

- 2026-11-07T10:42:02.928Z–2026-11-07T11:17:00.970Z: 71 ticks at nominal 30-second cadence on nl1, nl3 and controller; 184 distinct host/PID holders, 2,114 holder observations, 2,064 complete observations used for peaks/ranges.
- Canonical helpers: requestAdmissionSample, readLinuxWorkerProcesses, readSlotAddress, buildSshWorkerArgs. Read only process status for VmHWM; never print process bindings, argv or credentials. SSH uses configured targets and SSH config.
- One nl3 transport exit255 at tick62; subsequent samples succeeded. Fifty holder observations had vanished members or HWM below the earlier RSS snapshot and were excluded from peak/range arithmetic. All observations remain counted.
- A separate control snapshot found zero nested admitted roots on all three hosts; no overlapping admitted trees were observed in that control. This does not certify every earlier tree as disjoint.
- Raw helpers/data: `/tmp/floor-calibration-1107/{worker,measure,probe-worker,probe,analyze}.mjs`, `samples.jsonl`, `probe.jsonl`, `analysis.json`. Scratch is OS temp as the brief requires. Independent Python recomputation matched every count, peak and within-holder range.

Live VmHWM sums combine each extant process's historical high-water mark, not a simultaneous tree peak. Thirty-second sampling misses exited transient children. Anonymous slots carry PID/floor, not workload scope, terminal outcome or class. Equal-floor classes cannot be separated; old20-GiB tsrs requests can still coexist with Microsoft UI20.

## Per-class disposition

GiB throughout; samples are holders / observations. Shared observations repeat across candidate rows and must not be added across those rows. Peak is maximum live VmHWM sum; no shared peak is attributed to a specific class.

| Class | Old floor | Samples | Peak GiB | New floor | Disposition |
| --- | ---: | --- | ---: | ---: | --- |
| validation | 2 | 87 / 477 | 7.7426 | 2 | Missing host/workload coverage; retain |
| focused-validation | 1 | 0 attributable; 23 / 157 shared | 2.1854 shared | 1 | Shared/legacy floor cannot identify this class |
| focused-validation-ui | 3 | 0 attributable; 49 / 646 shared | 5.4873 shared | 3 | Shared/legacy floor cannot identify this class |
| entry-loads | 3 | 0 attributable; 49 / 646 shared | 5.4873 shared | 3 | Shared/legacy floor cannot identify this class |
| native-source-test | 1 | 0 attributable; 23 / 157 shared | 2.1854 shared | 1 | Shared/legacy floor cannot identify this class |
| native-custody | 1 | 0 attributable; 23 / 157 shared | 2.1854 shared | 1 | Shared/legacy floor cannot identify this class |
| source-bundle | 10 | 0 attributable; 1 / 70 shared | 0.6118 shared | 10 | Shared/legacy floor cannot identify this class |
| source-web-export | 32 | 0 / 0 | — | 32 | No live holders; retain |
| dependency-install | 3 | 0 attributable; 49 / 646 shared | 5.4873 shared | 3 | Shared/legacy floor cannot identify this class |
| package-dist | 6 | 3 / 95 | 4.6300 | 6 | Missing host/workload coverage; retain |
| runtime-build | 18 | 0 / 0 | — | 18 | No live holders; retain |
| compilation | 38 | 13 / 105 | 31.5342 | 38 | Missing host/workload coverage; retain |
| compilation-ui | 20 | 0 attributable; 8 / 564 shared | 10.6771 shared | 20 | Shared/legacy floor cannot identify this class |
| compilation-cli | 15 | 0 / 0 | — | 15 | No live holders; retain |
| compilation-server | 16 | 0 / 0 | — | 16 | No live holders; retain |

compilation-ui-tsrs is explicitly excluded by the brief: its10-GiB floor is untouched. Its equal-floor source-bundle observations cannot re-calibrate either class. Legacy targeted/full-validation names continue to consume the existing validation disk-class compatibility mapping; no second catalog was added.

## Derived candidates, not replacement floors

Same arithmetic as finalizer-floor-1106: ceil((max live HWM sum + maximum within-holder RSS range) /1,048,576). These are observations of mixed/partial live work, not evidence that each class's real workload is covered.

| Observed floor | Holders / observations / valid | RSS / HWM peak GiB | RSS range GiB | Formula candidate GiB | Hosts observed |
| ---: | ---: | ---: | ---: | ---: | --- |
| 1 | 23 / 157 / 151 | 2.1725 / 2.1854 | 1.7902 | 4 | nl3, controller |
| 2 | 87 / 477 / 456 | 7.0047 / 7.7426 | 6.0768 | 14 | controller, nl1 |
| 3 | 49 / 646 / 628 | 5.1985 / 5.4873 | 4.4017 | 10 | controller, nl1, nl3 |
| 6 | 3 / 95 / 95 | 4.4541 / 4.6300 | 4.1089 | 9 | nl3, controller |
| 10 | 1 / 70 / 70 | 0.3876 / 0.6118 | 0.1684 | 1 | nl3 |
| 20 | 8 / 564 / 564 | 7.4057 / 10.6771 | 0.3339 | 12 | nl1, nl3 |
| 38 | 13 / 105 / 100 | 29.8166 / 31.5342 | 23.7601 | 56 | controller |

Observed: validation2 has a7.7426-GiB HWM sum and compilation38 yields a56-GiB formula candidate; package-dist6 yields9. These data do not support reducing those classes. Validation was not observed on nl3, compilation only on controller, and package-dist had only three holders on controller/nl3; command scopes remain unknown. No named class has attributable representative coverage across the three requested hosts. The1/3-GiB shared groups also exceed their nominal floors; do not treat their candidate values as per-class calibration.

Derived decision: retain current floors under brief goal2's insufficient-sample rule. Lowering20→12 or10→1 from these anonymous groups would conflate classes and ignore the retained Microsoft UI18.0338-GiB and general37.1863-GiB historical peaks documented in finalizer-floor-1106. Raising mixed-class floors from these candidates would likewise guess which class needs it. Follow-up needs canonical workload attribution plus live holders for the missing host/class workloads; no new runtime registry or guessed floor is introduced here.

## Queues before and after 35 minutes

| Host | Before active / waiting | Queued GiB | After active / waiting | Queued GiB |
| --- | ---: | ---: | ---: | ---: |
| controller | 10 / 11 | 418 | 18 / 45 | 277 |
| nl1 | 7 / 67 | 1075 | 4 / 55 | 1048 |
| nl3 | 8 / 117 | 1353 | 8 / 98 | 1259 |

Before:10:42 UTC; after:11:17 UTC. Counts are broker facts, not completion/success counts. Changes include concurrent activity and are not an effect of this lane: no floor changed. Existing queued/admitted requests retain submitted floors; any future catalog edit affects new commands from current source, not already queued waiters. The achievable-head rule remains at the broker/placement owner, unchanged.

## Validation and handoff

- PASS: independent aggregate recomputation (71 ticks,184 holders,2,114 observations,2,064 valid); canonical catalog syntax via hstack-exec --local -- node --check; the analysis command also imported the catalog successfully.
- BLOCKED: `./apps/stack/bin/hstack-exec -- node --test apps/stack/scripts/utils/dev_targets/command_resources.test.mjs apps/stack/scripts/utils/proc/admission_broker.test.mjs apps/stack/scripts/utils/dev_targets/service_placement.test.mjs`. Native operation session35051 is still queued for package-dist6 GiB; zero tests started. Evidence: `/tmp/floor-calibration-1107/suites.log`; eventual status: `suites.exit`. Do not call these suites green. No duplicate run or admission bypass was started.
- No contract changed, so no test was added. Stack has no standalone typecheck; no TS/build/export changed and product builds are not applicable to this report-only packet.
- Self-attack: challenged class identity, legacy20-GiB requests, missing processes, tree overlap, historical larger peaks, false before/after causality and the unstarted suite. Existing command policy consumes the catalog and native projection derives it; no competing owner or bypass was introduced.
- Net runtime mechanisms: checks/states/errors/timers/retries/files +0/−0; one authorized lane report added. The35-minute sampler is finite and exited0.

Residual risk: transient children, incomplete class/workload/host attribution, observed under-reservation, and the unrun regression suites prevent a claim of fully calibrated floors or improved queue throughput. Retain the OS-temp evidence before host cleanup; rerun/finish the existing suite when admission capacity becomes available.
