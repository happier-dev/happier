> **IMPLEMENTED; client-only production replay shows no admission improvement. The combined production-after measurement is [blocked] on the orchestrator's server reload; the few-second goal remains unmet.**
> The retained PostgreSQL response is structurally JSON-identical, including all 2,300 Session memberships in the 90D result.
> Final client-inclusive entry loads pass 7/7; protocol typecheck is green; server touched diagnostics add zero, while whole-package checking is red. UI checking remains pending. Rejected attempts are described below.

USAGE-SWITCH-FREEZE-7-1108 — observed 2026-11-08; server commit `fe747e5cbf6b`, client commit `6df82450568b`; evidence root `.project/tmp/usage-switch-freeze-7-1108/`.

| Gate / measurement | Control / before | Candidate / status |
| --- | ---: | ---: |
| Matched client-only production pair, old server: settled | 14.614 s | 14.111 s; server phase variation, no client causal claim |
| Same production switch: all measured frames visibly ready | 13.507 s | 13.022 s |
| Pointer → activity request start, timing off | 1.996 s | 2.055 s; no observed admission improvement |
| Switch requests, 3,623 Sessions | 1 query-batch; zero Session evidence | Same; both pre-switch activity counts zero |
| Loaded old-server read / fold / price / project | 1.731 / 2.686 / 1.387 / 2.435 s | 1.669 / 2.387 / 1.321 / 2.168 s |
| Combined server + client production-after | Reload 127 control | Pending orchestrator reload |
| Retained PostgreSQL full delivered response, real 74,212-event shape | Rich control | Exact structural JSON equality; 2,300 memberships |
| Missing native-subject schema parses, constructed 74,212 rows | 74,212 (RED) | 0 (GREEN), valid/malformed present values preserved |
| Missing attribution/provider fallback parses, constructed measured shape | Per absent row (RED) | 0 (GREEN), present/captured-source controls preserved |
| Tariff calls, initial constructed 2,048-event compact case | 555 (RED) | At most 13 derived rendered pricing units (GREEN) |
| Same cost contract enlarged to 74,212 events / 3,623 Sessions | Rich control | GREEN; full wire equality and membership preserved |
| Real compact query, inspector precise coverage | — | 13,260 tariff calls; 137 summary groups + 2,891 calendar groups |
| Focused server query / projection / row suite | — | 54/54 pass |
| Additional scoped fold / row checks | — | 35/35 pass |
| Native route delivery formats / protocol adjacent suite | — | 4/4 and 43/43 pass |
| Server/protocol entry loads / server touched diagnostic delta / protocol typecheck | — | 7/7 pass / 0 added, 6 removed; package red / protocol green |

**Observed server cost and fix.** The isolated query reads the retained QA PostgreSQL without writes and profiles its existing capture/fold/price/project owners.
The original CPU profile identifies metadata schema/error construction, event repricing, and compact summary/calendar construction as material CPU work.
Requested-output flags already suppress series, insights, leaders, message statistics and model timeline in the canonical projector; no second output filter was added.
Native subjects and request attribution are optional. Their existing readers now return the same absent result without building schema errors for absent fields.
Provider fallback parsers run only for present strings when captured attribution has not already selected the source.
Actual metadata census is 74,212 rows, 39,085 native subjects and 10,766 attributions; boundary validation of present data remains intact.

The batch route previously retained rich contributions whenever `contributionQueries` existed, including the actual empty list.
This caused every selected event to enter rich pricing before its compact summary was prepared, although the caller requested no priced detail.
`projectUsageAnalyticsBatch` now derives priced-detail demand once from the existing request and passes it to the existing projection owner.
For private unranked compact demand, that owner prepares the existing tariff-linear summary first, then calls the existing compact repricer.
It retains unpriced admitted rows internally for the existing delivery owner's Session/turn membership projection; no unpriced detail page is delivered.
Requested contribution pages, ranked/cost-ordered candidates, model timelines and public populations retain their existing rich pricing path.
No alternate tariff calculation, catalog cache, accounting fold or membership owner was introduced.

**Equality and profiling evidence.** `measure-before.log` / `server-before.cpuprofile` preserve the original isolated control.
`measure-delivery-control-normalized.log` proves its value still matches the original control after canonical request normalization, then saves the final rich wire control privately in OS temp.
`measure-compact-normalized.log` proves full serialized-JSON structural equality against that control, including ordered arrays and exact numeric values; only object-key insertion order is immaterial.
Its safe companion `server-compact-normalized.json` records 818 calendar pricing cells, 91 days, 13 weeks, 606 hours and nine account entries, with no identities or bodies.
The normalized control uses CPU sampling; the candidate count diagnostic also enables precise coverage. Their wall times are not a speed comparison.
The optional-metadata-only measurement showed modest savings; source cost reductions do not establish a production latency win.
`pricing/remaining-profile-costs.json` shows CPU-only pricing plus summary at 2546.6 → 2339.5 ms (about 207 ms); compact calendar population reconstruction still costs 459 ms and pricing 422 ms.
The admitted accounting sidecar already prevents repeated schema normalization downstream. Attribution validation is first performed per selected runtime contribution/coordinate; moving it earlier alone would save no parses for this private query.
All retained-QA SQL operations are reads. No retained data, Prisma schema, migration, stack process or server lifecycle was changed by this lane.

**Client and production basis.** `client/before-production-clean/{result,interaction,bundle}.json` and scoped `usage.png` preserve the initial clean 14.616 s before capture.
It uses the retained FREEZE-6 production export, profiling off, Account A sign-in, and the canonical `capture.mjs` cleanup path.
Coach 90D is active before the pointer; every pre-pointer accounting query has activity disabled. The switch issues exactly one new activity query.
The demand has day granularity, activity resolution `both`, zero contribution queries and one Session-membership query; other optional outputs are false.
Server-Timing is auth 39.216, read 1697.319, fold 2419.760, price 1422.044, project 2412.222 and serialize 34.360 ms.
The request starts at +1883.6 ms and its controller finishes at +12222.6 ms.
An earlier 14.403 s timing capture remains supplemental. A subsequent inherited-URL replay preloaded activity and issued no new request, so it was rejected for admission attribution.
The clean harness now starts from Coach 90D without inherited query overrides and rejects pre-switch activity acquisition.
The deciding client-only pair is `client/{client-before-production-c,client-after-production-c}/`, using the same owned browser and unchanged reload-127 server: settled 14.614 → 14.111 s, native admission 1.996 → 2.055 s. Both are profiling-off production exports, Coach 90D active, 3,623 Sessions, pre-switch activity zero, exactly one switch query-batch POST and zero Session evidence; cleanup passes without collection errors. Scoped Rhythm output matches visually.
`client/candidate-owner-attestation.json` proves the served candidate bundle contains the typed phase comparison and zero phase serializations. Reduced server phase times explain much of the settled difference; neither that difference nor a client admission gain is attributed to this fix.
Mapped-export navigation yielded no admission evidence. Later observed CDP transfers took 103.2 s for the main bundle and 28.4 s for a chunk, outside the interaction; a short health probe was insufficient evidence to retire those attempts. Only owned browsers were affected; failed attempts do not replace the valid captures.
`client/admission-cpu-exact/admission.json` now proves a 1883.155 ms pointer-to-native-request window on that export, with zero pre-switch activity queries and one new POST; only this window's samples are analyzed.
Initial progress drain accounts for 420.6 ms inclusive (projection 149.6 ms, encoding 114.8 ms); React ancestry 518.6 ms overlaps that drain, with 150.3 ms React self time. These costs are not additive.
Retained Session-input reads account for 134.2 ms inclusive and evidence-phase read for 83.5 ms self; that owner reserialized unchanged phase facts per admitted Session. RED witnessed 3,424 serializations for two publications; GREEN has zero serializations across 3,423 inputs and preserves two publications, refusal, completion and coverage transitions (5/5 focused tests).
The existing `UsageQueryEvidencePhase.publishedPhase` now retains its typed published phase instead of a JSON string, comparing status/refusal facts before allocating source objects. The paired production timing does not demonstrate a client latency win.
`client/client-cpu-owner-pair-metrics.json` records a separate same-browser clipped CPU pair: phase-module self time 85.98 ms / 80 samples → 0.521 ms / one sample. Diagnostic admission windows vary 3.993 → 2.813 s and do not replace the timing-off latency conclusion; both captures complete and clean up with no collection errors.
Session-input basis reads remain necessary: admitted Session versions and envelopes can change independently of Home invalidations. The profile did not establish a safe narrower admission rule or justify suppressing initial visible progress.

**Validation and ownership.** `fold-red.log`, `fold-green.log`, `pricing/grouped-red.log`, `pricing/grouped-green.log` and `pricing/server-grouped-tests.log` hold deciding RED/GREEN evidence.
`pricing/route-grouped.log` covers native delivery formats; `pricing/protocol-grouped-tests.log` covers changed readers and adjacent cost/calendar behavior.
Tests use real internal owners and call-through schema spies / V8 precise coverage, without mocking pricing, reconciliation or projections.
The real fixture and retained control check the neighbouring cases: present invalid metadata, captured native/provider attribution, four cost modes, mixed currency, unknown models, series, requested detail and richer shared rankings.
The source owners remain `readScopedUsageAccountingEvidence`, `readUsageRequestAttribution`, `resolveUsageContributionProviderAttribution`, `prepareUsageAnalyticsProjectionSteps` and the existing protocol summary/repricer/delivery owners.
Scalar/default batch and rich/public demand paths intentionally remain; they serve distinct requested outputs, not competing pricing decisions.
No wire, storage, push, freshness, cancellation, visibility or interaction contract changed; no canonical documentation change is needed.

**Mechanism delta / self-attack.** Files +1/−0 (this requested report); thirteen existing source/test files modified.
Owner-level checks +8/−1: five presence/source/type guards avoid reproduced absent-field schema work; one batch detail decision and one projector eligibility decision preserve requested pricing; one typed phase comparison replaces the per-input JSON comparison at the evidence-phase owner.
States, error codes, caches, timers, retries, limits, telemetry and persistence: +0 / −0. No polling, debounce or feature gate was added.
The rich path cannot be removed because requested detail and cost-ranked selection still require priced event operands; the compact path reuses the existing summary repricer.
The equality harness's initial raw-versus-normalized query key mismatch produced zero memberships in both controls and was rejected; canonical normalization now proves all 2,300 memberships.

**Residual risk / reload ask.** Orchestrator: reload the retained `agent-qa-usage-insights` server from current source, then return the selected/loaded reload identity so this lane can run the matched production after capture.
Reload request posted successfully to the canonical board. Owner deferred reload for available-memory/OOM risk; client attribution continues without a server reload.
This lane never restarts or stops a stack. Until that reload and after capture, the few-second goal and loaded performance/freshness gate remain open.
`pricing/entryloads-grouped.log` and the final client-inclusive `client/entryloads-final.log` both contain terminal 7/7 passes. Server public typecheck completed exit 2: touched comparison adds 0/removes 6 against `server-1103.locs`, with 6,330 unattributed locations for the integration owner (`server-typecheck.log`); whole-package green is not claimed.
Protocol public typecheck passed with zero diagnostics (`protocol-typecheck.log`). UI checking first rejected the stale `ui-1104b.locs` baseline, then launched with its 1,120 still-resolvable recorded locations (21 removed-path entries excluded), without adding baseline diagnostics; result pending.
