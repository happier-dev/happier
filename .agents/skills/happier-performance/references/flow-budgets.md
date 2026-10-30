# Flow count contracts

Current development source, 2026-10-29. Totals are observations, never ceilings.
Each assertion follows a resource, request, changed item or effect. Unobserved
dimensions are not zero. FLOWBUDGET's lane report links the focused run evidence.

| Flow | Shape contract | Measured count | Test path | Owner |
| --- | --- | --- | --- | --- |
| Send / transcript reply | One daemon authorization per dispatched request; one receipt per accepted input; one baseline read and one read/push per committed message. | Latest zero-delay original branch, per follow: HTTP 5, RPC 1, daemon authorization 1, pages 2, push/body 1. Input receipt 1 for user input / 0 for transcript-only reply. Access calls 5 / 6. SQL plain 333 / 174, E2EE 310 / 175 (includes synthetic held-writer stress). | `apps/server/sources/app/events/eventRouter.transcriptFollow.composed.integration.spec.ts` | Session input/write and transcript-follow owners |
| Session socket stream inside the composed Send/follow journey | An admitted publisher relays chunks without reopening access/publication authority (`it.fails`, Session stream admission cleanup). One actual client frame per snapshot/delta; no HTTP or input admission per chunk. | Plain and E2EE: 3 chunks → 3 client frames; publication admissions 3, structural checks 3, permission checks 6, Machine admissions 3, audience reads 3. SQL 60, including AccessKey SELECT 3 and Session SELECT 6. Additional HTTP/input admissions 0. SQL totals are informational. | `apps/server/sources/app/events/eventRouter.transcriptFollow.composed.integration.spec.ts`; `transcriptFollowTiming.composed.testkit.ts` | `sessionUpdateHandler`, current publication admission and event router |
| Open transcript, cold / warm | Read demanded Session documents and transcript once; reuse warm content without fetching unrelated resources. | Cold physical HTTP: snapshot batch 1, transcript page 1 (one row), Account identity 1, metadata PATCH 1. Warm: 0 HTTP, same stored message identity. | `apps/ui/sources/sync/sync.ensureSessionVisibleForMessageRoute.test.ts` | Sync route hydration and message-page pipeline |
| Foreground, 1,000 acquired Sessions | One catch-up page; unchanged resources have no body reads; one changed Session appears in exactly one set read. | Unchanged: changes 1 + metadata discovery 1. Changed: those + batch 1 (one Session) + identity 1. Cold snapshot: 5 pages + 1 batch / 1,000 bodies; persisted warm: 5 pages / 0 bodies. | `apps/ui/sources/sync/sync.accountChangeCatchUp.composed.test.ts`; `apps/ui/sources/sync/engine/sessions/sessionSnapshot.performance.test.ts` | Sync resume/catch-up and Session snapshot owners |
| Session list / read-batch, real HTTP + SQLite | One bearer admission per HTTP request; no scalar access acquisition; one document-set query for demanded detail and none for compact lists. Larger pages/sets use the same database read batches. Each demanded Session gets one access decision (normal passing test after CP-READMIT capture/readmission consolidation). | 1,000 retained Sessions, demand 1 / 3: original list SQL 48 / 46, zero document reads, access rows 1 / 3. CP-READMIT detail SQL 38 / 38, one document-set query, access rows 1 / 3 (`session-detail-green-rerun.log`). Every request: bearer admission 1. SQL totals include transaction/provider setup and are informational. | `apps/server/sources/app/api/routes/session/sessionReadBatch.sqlite.integration.spec.ts` | `verifyRequestPrincipal`, Session listing/detail and `sessionReadAdmission` |
| Approve pending Action | One original effect/RPC; no redispatch on repeated decision. A settled decision reads each resource once (`it.fails`, approval acquisition cleanup). | First decide: approval GET 3, mode GET 5, settings GET 1, POST 1, optional features GET 1; RPC/effect 1. Repeated terminal decide: approval GET 2, mode GET 2, additional RPC/effect 0. | `apps/cli/src/session/actions/approvals/remoteDecider.composed.test.ts` | Action executor / registered approval RPC / Artifact store |
| Phone UI approval ingress, real HTTP + SQLite | One bearer admission per HTTP request; execute the rule mutation once; settled decisions read the approval/row once and do not write. Reuse an unchanged approval before its first write (`it.fails`, app approval/Artifact acquisition cleanup). | First decision: HTTP/admissions 16, SQL 328, approval GET 5 / POST 3, Artifact row reads 21, rule mutation 1. Two approval GETs precede the first write. Settled: HTTP/admissions 3, SQL 36, approval GET / Artifact row read 1, writes 0. Lifecycle CAS reads are informational, not a SQL ceiling. | `apps/cli/src/session/actions/approvals/skillRules.appReplay.composed.integration.test.ts` | Default UI Action executor, HTTP authentication and Artifact/skill-rule persistence |

Client-only fixtures provide the cold/warm transport census; complementary real
SQLite compositions count server HTTP admission, resource access and SQL.
The socket journey now observes real snapshot/delta frames at a Socket.IO client
alongside accepted input and committed-reply follow. Its existing socket handshake
authentication boundary is substituted, and the held-writer committed-row leg
retains its manual post-write event-router call. No real Agent process, rendered
phone, managed-stack journey or PostgreSQL measurement is claimed.
These are source-composition owner guards. SQL totals include authentication,
governance, transactions and real lifecycle transitions; they are not limits.

Reference shape: Paseo `dc07efe937c3160e8fe83d02dc972c8a0b014957`,
`packages/client/src/daemon-client.ts#sendMessage` delegates to one
`sendAgentMessage` request and awaits its accepted response. This is source shape,
not a measured reference-runtime total or an equivalent authorization topology.
