> **MEASURED: limited fold/pricing improvement; the few-second goal remains unmet. Project time did not improve.**
> Combined production settles at 14.190 / 14.227 s against 14.614 s control. Full retained-PostgreSQL wire response equality passes.
> Keep client commit `6df82450568b`: RED→GREEN proves removed serialization work, despite no client-only admission win. UI typecheck remains pending; no delta success is claimed.

USAGE-SWITCH-FREEZE-7-1108 — 2026-11-08. Server `fe747e5cbf6b`; client `6df82450568b`.
Evidence root: `.project/tmp/usage-switch-freeze-7-1108/` (paths below are relative to it).

| Production metric | Reload 127 control | Reload 127 client fix | Reload 128 combined | Reload 128 confirmation |
| --- | ---: | ---: | ---: | ---: |
| Settled | 14.614 s | 14.111 s | 14.190 s | 14.227 s |
| All measured frames visibly ready | 13.507 s | 13.022 s | 12.710 s | 12.280 s |
| Pointer → native activity POST | 1.996 s | 2.055 s | 1.911 s | 1.592 s |
| Server read | 1.731 s | 1.669 s | 1.845 s | 1.774 s |
| Server fold | 2.686 s | 2.387 s | 2.412 s | 2.363 s |
| Server price | 1.387 s | 1.321 s | 0.859 s | 0.816 s |
| Server project | 2.435 s | 2.168 s | 2.446 s | 2.468 s |
| Switch activity query-batches / Session evidence | 1 / 0 | 1 / 0 | 1 / 0 | 1 / 0 |

**Production basis.** `client/composed-production-pair-metrics.json` points to each raw result/bundle and exact clock formulas.
Control is the FREEZE-6 production export on reload 127, snapshot `f71bfb26378dd3c7`; initial clean supplemental capture settled 14.616 s.
Owner attested reload 128 READY, selected=loaded snapshot `99bf40701272235f`, source time `2026-11-08T06:46:15Z`, including both commits.
Combined captures serve the retained candidate production export; actual script ownership is attested, rather than inferred from current source.
All four deciding captures have profiling off, Account A / 3,623 Sessions, Coach 90D selected, zero pre-switch activity queries, and exactly one new activity query.
Demand remains day granularity / activity `both`, zero contribution queries, one Session-membership query; other optional outputs are false.
Each deciding capture is COMPLETE/CLEANED with zero collection errors. Account A canonical attestation passes; scoped Rhythm charts visually match.
The first browser exited after SSH forwarding failed. Both reload-127 control and reload-128 replacement were fresh canonical owned browsers; this replacement limits exact browser matching.
The unavailable-endpoint attempt and directory-route confirmation failure produced no interaction metric. Only the scratch asset-directory handler was corrected before the valid confirmation.
Owned browser custody cleanup is terminal; this lane never restarted/stopped a stack or recreated reload 127.

**Server owner and fix.** The isolated query reads retained QA PostgreSQL without writes, profiling existing capture/fold/price/project phases and CPU.
Original CPU work includes optional-metadata schema/error construction, rich event pricing, and compact summary/calendar construction over 74,212 events.
Output flags already suppress series, insights, leaders, message statistics and model timeline; no competing output filter was added.
`readScopedUsageAccountingEvidence` and `readUsageRequestAttribution` now skip schema parsing of absent optional values, preserving validation when present.
`resolveUsageContributionProviderAttribution` parses fallback strings only when captured attribution has not selected the source.
Observed census: 39,085 native subjects and 10,766 attributions among 74,212 rows; absent-field schema-error work was disproportionate.
The batch path treated an existing empty `contributionQueries` array as rich-detail demand, repricing every event before compact preparation.
`projectUsageAnalyticsBatch` now derives priced-detail demand once; `prepareUsageAnalyticsProjectionSteps` prepares the existing compact summary before its existing repricer for private unranked demand.
Unpriced admitted rows remain internal for canonical delivery's Session/turn membership; requested detail never receives unpriced rows.
Requested detail, ranked/cost-ordered outputs, timelines and public populations retain rich pricing. No alternate tariff calculation, catalog cache or accounting owner was added.

**Equality and count proof.** Canonically normalized control and candidate have full structural serialized-JSON equality: exact numbers and ordered arrays, including all 2,300 selected 90D Session memberships.
`measure-delivery-control-normalized.log` verifies the rich control against the original; `measure-compact-normalized.log` verifies final delivered equality against that control.
`server-compact-normalized.json` safely records 818 calendar cells / 2,891 groups, 137 summary groups, nine account entries, 91 days / 13 weeks / 606 hours, without identities or bodies.
V8 precise coverage records 13,260 tariff calls. Count RED initially observed 555 calls versus at most 13 derived rendered pricing units; GREEN also covers the enlarged 74,212-event / 3,623-Session shape.
Optional-metadata RED observes 74,212 absent-subject parses on constructed rows; GREEN observes zero. Present malformed data, captured-source precedence and four cost modes remain covered.
The count diagnostic enables precise coverage while its control uses CPU sampling; their wall times are not a speed comparison.
CPU-only `pricing/remaining-profile-costs.json` shows pricing plus summary 2546.6 → 2339.5 ms (about 207 ms), with calendar population reconstruction 459 ms and pricing 422 ms remaining.
Accounting sidecars already prevent downstream re-normalization. Attribution projection performs the first validation per selected contribution/coordinate; moving it earlier alone saves no parses here.
Initial raw-versus-normalized controls yielded zero memberships and were rejected; the corrected normalized comparison proves all 2,300. Byte-only key-order mismatch was rejected as an equality criterion.
All SQL operations were reads; no retained data, Prisma schema or migration changed.

**Client attribution and deletion test.** `client/admission-cpu-exact/admission.json` clips samples strictly to pointerdown → native POST start, reproducing 1883.155 ms.
Progress drain is 420.6 ms inclusive (projection 149.6, encoding 114.8); React ancestry 518.6 overlaps it, with 150.3 ms React self time. These costs cannot be added.
Session-input reads cost 134.2 ms inclusive; evidence-phase read costs 83.5 ms self. That owner serialized unchanged phase facts per admitted input.
`UsageQueryEvidencePhase.publishedPhase` now retains the typed phase, comparing status/refusal facts before constructing source objects; this replaces its existing JSON witness.
`client/phase-red.log`: 3,424 serializations for two publications. `client/phase-green.log`: zero serializations across 3,423 inputs, two publications, with refusal/completion/coverage controls preserved (5/5 tests).
`client/client-cpu-owner-pair-metrics.json`: separate same-browser clipped phase self time 85.98 ms / 80 samples → 0.521 ms / one sample; both captures complete and clean up without errors.
Those instrumented windows vary 3.993 → 2.813 s and do not replace timing-off evidence. `client/client-production-pair-metrics.json` shows admission 1.996 → 2.055 s: no demonstrated client admission improvement.
Deletion-test verdict: **keep** `6df82450568b`; deleting it restores count-proven serialization work and measured phase CPU. It is not credited with a settled-latency win.
Session version/envelope basis reads remain necessary independently of Home invalidations; no safe narrower admission rule or suppression of visible initial progress was proven.
Mapped-export navigation yielded no admission evidence; later CDP bundle transfers took 103.2 / 28.4 s outside the interaction, so short health probes did not prove a stalled product. Inherited-activity replay with zero new requests was rejected.

**Validation and ownership.** Server query/projection/row suite 54/54; additional fold/row checks 35/35; native route formats 4/4; protocol adjacent tests 43/43; client focused tests 5/5.
Logs: `fold-{red,green}.log`, `pricing/{grouped-red,grouped-green,server-grouped-tests,route-grouped,protocol-grouped-tests}.log`, `client/{phase-red,phase-green}.log`.
Final client-inclusive entry loads pass 7/7 (`client/entryloads-final.log`), as do protocol-edit entry loads; no lane source edits followed these checks.
Protocol public typecheck passes with zero diagnostics (`protocol-typecheck.log`). Server public check exits 2; touched comparison adds 0/removes 6, with 6,330 unattributed locations for integration (`server-typecheck.log`). Whole-package green is not claimed.
UI public touched check remains in flight on existing handle 39054 (`client/ui-typecheck-existing-baseline.log`); no delta evidence yet. Initial stale baseline was rejected; retry retains 1,120 recorded resolvable locations, excluding 21 removed-path entries without inventing diagnostics.
Tests use real internal owners and call-through boundary/count instrumentation. Real retained equality and fixtures cover present invalid metadata, mixed currency, unknown models, richer outputs and memberships.
The compact/rich paths serve distinct requested outputs under the same owners; scalar/default and public paths remain intentionally. No wire/storage/push/freshness/cancellation/visibility contract changed, so no canonical documentation update is needed.

**Mechanism delta / self-attack.** Files +1/−0 (this requested report); thirteen existing source/test files modified. Owner checks +8/−1: five presence/source/type guards, one detail-demand decision, one compact-eligibility decision, and one typed phase comparison replacing JSON comparison; each removes reproduced work while preserving required output.
States, error codes, caches, timers, retries, limits, telemetry and persistence +0/−0. Rich pricing remains necessary for detail/ranking; no parallel tariff, membership or admission authority was introduced.
The server commit names its sole foreign hunk: pre-existing `registerSessionEvidenceRoute` import movement. Client commit contains no foreign hunks; commits used private index / commit-tree / CAS without touching the shared index.

**Residual risk.** Reload-128 Server-Timing supports lower fold/pricing, not lower projection; 14.190 / 14.227 s settlement still misses the few-second goal. Two after samples do not establish a robust latency distribution or sole-cause attribution on the shared moving stack.
Client admission remains variable and its matched client-only pair shows no win. Projection/summary/calendar CPU and existing progress/input work remain measured costs; no speculative cache, debounce, cap or telemetry was added.
UI package delta remains [blocked] on the already-running canonical check's completion; preserve handle 39054 rather than cancel/re-pin it. Server whole-package diagnostics remain an integration-owner concern.
