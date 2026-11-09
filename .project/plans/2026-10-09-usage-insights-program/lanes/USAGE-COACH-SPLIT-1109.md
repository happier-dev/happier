# USAGE-COACH-SPLIT-1109

**Verdict: IMPLEMENTED; full owner GREEN and entry-loads remain queued in AUTO.**
Delivery uses private-index read-tree/commit-tree/CAS under the orchestrator's
06:46Z instruction that queued checks do not block a commit; this is not DONE.
Owner approval: 2026-11-09. Evidence: `.project/tmp/usage-coach-split-1109/` (`E`).

## Mechanism and delta
Protocol `usageWorkEvidence.ts#createUsageSessionFactRecordsV1` derives both payloads
from one admitted Session projection. `usageSessionFactKinds.ts` owns addresses and
read scope. Namespace/kind stay `usage` / `work_facts.v1`; local ids are work/coach.
The existing Session mode/sealing owner saves Coach first, then work. The existing
actor set reader reads demanded addresses once per existing Session-access batch.
Work keeps shared compactions; Coach keeps original composition/model/MCP/detail
and coverage. One Session seq/content-version owner decides both records' freshness.
Missing/stale Coach preserves partial history; no visual composition changes.
Checks +2/−0: exact demanded-record set and opened-kind binding at the client trust
boundary prevent omitted/duplicate/substituted records from claiming completeness.
Payload variants +1/−0; read-scope +1/−0; scalar content field −1, replaced by the
record array. Existing currentness/coverage states are reused.
Error codes, timers, retries, gates, migrations and second readers: each +0/−0.
Writes +1 per complete conversion: a separately sealed Coach sibling is necessary
because the server cannot project E2EE fields. Ordinary Usage reads acquire none.
Packet files +3/−0: report, PostgreSQL test, concurrent browser Action leaf; the
Usage kind leaf is already in the shared base.
Compatible concurrent quota/catalog and Voice-doc hunks are retained, not reverted.

## Every reader and writer traced
- Writer: `usageQueryResource.ts#loadTranscript` derives once; `persistUsageCompactInput`
  seals both through Session key/mode resolution and existing SystemRecord upsert.
- Usage and How you work: widget demand has `includeCoach:false`; the same Resource
  acquires work only. Shared compactions remain in work; no surface layout changed.
- Coach: `includeCoach:true` requests work + Coach through that Resource; the opener
  merges only current records and keeps missing/stale sibling coverage unknown.
- Retained facts: `getUsageSessionEvidenceDemandKey` includes scope; Account-owned
  `usageQuerySessionInputs.ts` retains/cancels/invalidates. Either address wakes it.
- History read/status/cancel: `useUsageHistory.ts` → `usageActionDeps.ts` →
  `readUiUsageHistory` retains original query/progress; explicit reads and existing
  short-window conversion save both records. No new background read or backfill.
- Native `usage.history.read`: reverse Account Action uses those same dependencies
  and history Resource; no browser-owned or second native reader is introduced.
- Protocol work projector consumes current work facts; existing Coach aggregation
  consumes reconstructed original Coach evidence through the same typed projection.
- Generic SystemRecord catalog and payload union now both admit the two variants;
  scalar CRUD and set transport retain their distinct existing roles/admission.
- Legacy unscoped listing excludes Usage before pagination. Old unshipped
  `how_you_work` rows remain stored; source history can be reread, with no adapter.
- Retention/deletion: existing Session/Account cascades remove both rows. Sidechain
  import-protection classification ignores Usage; no retention policy/schema edit.

## Validation and limits
- RED: `E/ui-scope-red.log` failed at the owner: initial Usage acquired 3,368 Coach
  records, expected zero. The census test then mounts duplicate Coach consumers and
  asserts exactly one additional scoped cohort read, followed by no Usage reread.
- Recovered GREEN: `E/server-green.log`, 20/20 SQLite route/access/store tests, with
  3,368 Sessions, query counts, actor isolation and real plain/E2EE seal/store/open.
- Relaunch generic payload regression: 1 passed / 31 skipped; queued before the fix,
  ran after it. `E/relaunch-generic-payload-red.log` is GREEN, not a separate RED.
- Full deciding checks remain queued: `E/relaunch-auto-protocol.log`,
  `E/relaunch-auto-ui.log` (owner/cost/native Action), `E/relaunch-auto-server.log`,
  `E/relaunch-auto-entry-loads-final.log`. No 7/7 entry success is inferred.
- Local queued attempts were stopped after 06:46Z; no local test/typecheck executed.
  AUTO retries report memory-busy/sync problems; existing handles remain in use.
- PostgreSQL: prior launch failed at `docker info` (`E/server-postgres.log`);
  no plan/index success claimed. Whole-package typechecks: NOT RUN, as instructed.
- Export lockfile refresh passed: Already up to date (`E/lockfile-refresh.log`).
  No dependency install, Prisma change, migration draft, browser or UI bundle export.

## Reload request
Usage orchestrator: after the controller all-clear, reload matching Protocol/server/
UI/native Account Action host. On the existing QA Account open Usage without Coach,
then Coach, then How you work; count opaque records/bytes and verify freshness,
partial history and native history status/read. Only the orchestrator reloads.

## Exactly what the next Opus security review must read
Read the commit diff plus Protocol `usageSessionFactKinds.ts`, `usageWorkEvidence.ts`
schemas/builders/currentness, `usageSessionEvidence.ts`, SystemRecord catalog/payload
schemas; server `sessionSystemRecordService.ts` set reader, `admitV1RecordTarget`,
`actorRecordSessionSelect`, and `registerSessionEvidenceRoute.ts`; UI
`usageCompactInput.ts`, Resource request scope and SessionInputs retention/invalidation.
Re-measure actor isolation, mode/kind rejection, stale/missing sibling coverage and
seal/store/open using `usageQueryResource.test.ts` and both `usageSessionWorkFacts`
store suites. Read `docs/encryption.md` Usage facts, `docs/compatibility.md` Usage
contract, and terminal logs above. Also inspect included concurrent connected
presentation schema/caller hunks; their original owner retains its broader review.

Residual risk: owner GREEN/entry-loads, PostgreSQL and loaded QA remain unverified;
11,057,935 historical Coach bytes are the motivation, not a measured live saving.
