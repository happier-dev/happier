import { USAGE_SESSION_EVIDENCE_PATH, UsageSessionEvidenceRequestSchema, UsageSessionEvidenceResponseSchema,
    type UsageSessionEvidenceRequest, type UsageSessionEvidenceResponse } from '@happier-dev/protocol/usage/usageSessionEvidence';
import { getUsageSessionFactKinds, getUsageSessionFactRecordAddress } from '@happier-dev/protocol/usage/usageSessionFactKinds';
import { USAGE_COLLABORATION_TOOL_LEAF_KEYS, projectSessionUsageWorkEvidence, usageQueryNeedsSessionCandidates,
    UsageSessionPermissionRequestProjectionSchema, UsageSessionPermissionCompletedProjectionSchema,
    projectUsageSessionStateEvidenceFromRequests, type UsageSessionPermissionRequestProjection,
    type UsageSessionPermissionCompletedProjection,
    type UsageSessionMessageEvidence, type UsageSessionMessageProjection } from '@happier-dev/protocol/usage/usageWorkEvidence';
import type { Fastify } from '@/app/api/types';
import { readSessionAccessAuthenticationFromRequest } from '@/app/session/access/sessionAccessAuthentication';
import { readAccountStoredContentCompatibilityForHttpRequest } from '@/app/clientCompatibility/accountStoredContentCompatibility';
import { readSessionDetails } from '@/app/api/routes/session/registerSessionListingRoutes';
import { readSessionTurnsBatch } from '@/app/api/routes/session/readSessionTurns';
import { readSessionMessagePages } from '@/app/api/routes/session/readSessionMessagePages';
import { readSessionTranscriptRowsInTx } from '@/app/session/access/readSessionTranscriptRows';
import { applySessionTranscriptPublicationCeiling, hasSessionTranscriptPublicationLiveFacts,
    resolveSessionTranscriptPublicationCeiling, resolveSessionTranscriptPublicationRecencyMs } from '@/app/session/sessionTranscriptPublicationPolicy';
import { projectSessionEffectiveAccessV1, SESSION_ACCESS_SESSION_BATCH_SIZE } from '@/app/session/access/sessionAccess';
import { projectViewerSessionDataKey } from '@/app/session/encryption/sessionDataKeyEnvelopePersistence';
import { readActorSessionSystemRecordsV1 } from '@/app/session/systemRecords/sessionSystemRecordService';
import { sessionSystemRecordV1ErrorStatus } from '@/app/session/systemRecords/sessionSystemRecordSerialization';
import { inReadSnapshot } from '@/storage/inTx';
import { readDatabaseErrorCode } from '@/storage/transactionErrors';
import { readSessionEvidenceCandidateIdsInTx, selectSessionEvidenceSubjectsInTx } from './selectSessionEvidenceSubjects';
import { readSessionMessageEvidenceRowsInTx, type UsageMessageEvidenceStorageRow } from './readSessionMessageEvidenceRows';
import { readUsageSessionMessageProjection } from './messageEvidenceProjection';
import { readSessionStateEvidenceRowsInTx, type UsageStateEvidenceStorageRow } from './readSessionStateEvidenceRows';
import { Readable } from 'node:stream';

/** Query demand owns the selected subjects and content-free read; Session owners still admit each component. */
export function registerSessionEvidenceRoute(app: Fastify): void {
    app.post<{ Body: UsageSessionEvidenceRequest; Reply: UsageSessionEvidenceResponse | Readable }>(USAGE_SESSION_EVIDENCE_PATH, {
        preHandler: app.authenticate,
        schema: { body: UsageSessionEvidenceRequestSchema, response: { 200: UsageSessionEvidenceResponseSchema } },
    }, async (request, reply) => {
        const authentication = readSessionAccessAuthenticationFromRequest(request);
        const compatibility = readAccountStoredContentCompatibilityForHttpRequest(request);
        const selected = await inReadSnapshot(async tx => {
            let candidates: Promise<string[]> | undefined;
            const result: UsageSessionEvidenceResponse['requests'] = [];
            for (const demand of request.body.requests) {
                if (reply.raw.destroyed) break;
                const explicit = demand.sessionIds ?? (demand.query.session === null ? undefined
                    : typeof demand.query.session === 'string' ? [demand.query.session] : demand.query.session);
                const accessible = () => candidates ??= readSessionEvidenceCandidateIdsInTx(tx, { accountId: request.userId, authentication });
                // A named wake asks only whether those Sessions join the window.
                const sessionIds = explicit !== undefined ? [...new Set(explicit)]
                    : !usageQueryNeedsSessionCandidates(demand.query) ? []
                    : await selectSessionEvidenceSubjectsInTx(tx, { accountId: request.userId, query: demand.query, nowMs: request.body.nowMs,
                        candidateIds: demand.candidateSessionIds === undefined ? await accessible()
                            : await readSessionEvidenceCandidateIdsInTx(tx, { accountId: request.userId, authentication,
                                candidateIds: demand.candidateSessionIds }) });
                result.push({ query: demand.query, sessionIds });
            }
            return result;
        });
        if (reply.raw.destroyed) { reply.hijack(); return; }
        const ids = [...new Set(selected.flatMap(row => row.sessionIds))];
        const sendEvidence = (results: UsageSessionEvidenceResponse['results']) => {
            reply.header('Cache-Control', 'no-store');
            if (reply.raw.destroyed) { reply.hijack(); return; }
            if (request.headers.accept?.split(',').some(value => value.trim().split(';')[0] === 'application/x-ndjson')) {
                // Serialize one admitted Session at a time; opaque histories can exceed one V8 string.
                async function* lines() {
                    yield JSON.stringify({ requests: selected }) + '\n';
                    for (const result of results) yield JSON.stringify(result) + '\n';
                }
                return reply.type('application/x-ndjson').send(Readable.from(lines()));
            }
            return reply.send({ requests: selected, results });
        };
        const unavailable = (reason: unknown) => ({ status: 503 as const,
            body: { error: readDatabaseErrorCode(reason) ?? 'session_read_unavailable' } });
        if (request.body.readWorkFacts) {
            const factKinds = [...new Set(request.body.workFactKinds ?? getUsageSessionFactKinds({ includeCoach: false }))];
            const kindsByLocalId = new Map<string, typeof factKinds[number]>(factKinds.map(kind => [getUsageSessionFactRecordAddress(kind).localId, kind]));
            const workAddress = getUsageSessionFactRecordAddress('work');
            const records = await readActorSessionSystemRecordsV1({ actorUserId: request.userId, authentication,
                sessionIds: ids, addresses: factKinds.map(getUsageSessionFactRecordAddress) });
            if (reply.raw.destroyed) { reply.hijack(); return; }
            const evidenceIds = new Set(selected.flatMap(row => row.query.includeSessionEvidence ? row.sessionIds : []));
            const workEvidenceIds = new Set(selected.flatMap(row => row.query.includeWorkEvidence ? row.sessionIds : []));
            const turns = await readSessionTurnsBatch({ userId: request.userId, authentication,
                sessionIds: ids.filter(id => {
                    const record = records.get(id);
                    // Saved Work intervals omit native turn provenance. The Run length
                    // owner needs it to exclude failed carriers that never started.
                    return record?.ok && record.records.some(row => row.address.localId === workAddress.localId
                        && (!row.record || workEvidenceIds.has(id)))
                        && evidenceIds.has(id);
                }) });
            const results: UsageSessionEvidenceResponse['results'] = ids.map(sessionId => {
                const record = records.get(sessionId);
                if (!record) return { sessionId, detail: unavailable(undefined) };
                if (!record.ok) {
                    const databaseError = readDatabaseErrorCode(record.cause);
                    return { sessionId, detail: databaseError ? { status: 503, body: { error: databaseError } }
                        : { status: sessionSystemRecordV1ErrorStatus(record.code),
                            body: { error: 'Plugin Session system record operation failed', code: record.code } } };
                }
                const session = record.session;
                const turn = turns.get(sessionId);
                return { sessionId, workFacts: { session: {
                    id: session.id,
                    seq: applySessionTranscriptPublicationCeiling(session.seq, session),
                    createdAt: session.createdAt.getTime(),
                    updatedAt: resolveSessionTranscriptPublicationRecencyMs({ createdAt: session.createdAt, liveRecencyAt: session.updatedAt }, session),
                    active: hasSessionTranscriptPublicationLiveFacts(session) && session.active,
                    metadataVersion: session.metadataVersion,
                    agentStateVersion: session.agentStateVersion,
                    metadataLayoutVersion: session.metadataLayoutVersion,
                    encryptionMode: session.encryptionMode,
                    dataEncryptionKey: projectViewerSessionDataKey(session),
                    viewerRole: record.access.level === 'owner' ? 'owner' : 'recipient',
                    access: projectSessionEffectiveAccessV1(record.access),
                }, records: record.records.map(({ address, record }) => ({
                    kind: kindsByLocalId.get(address.localId)!, content: record?.content ?? null,
                })) },
                ...(turn ? { turns: turn.status === 'fulfilled' ? turn.value : unavailable(turn.reason) } : {}) };
            });
            return sendEvidence(results);
        }
        const privateStateIds = new Set<string>();
        const details = await readSessionDetails({ userId: request.userId, authentication, sessionIds: ids,
            accessProjectionVersion: 1, storedContentCompatibility: compatibility, includePrivateRuleProjection: false,
            usageProjection: true, onUsageStateAdmission: (id, admitted) => { if (admitted) privateStateIds.add(id); } });
        const evidenceIds = new Set(selected.flatMap(row => row.query.includeSessionEvidence ? row.sessionIds : []));
        const transcriptIds = new Set(selected.flatMap(row => row.query.includeSessionEvidence && row.query.includeTranscriptEvidence ? row.sessionIds : []));
        const readableIds = ids.filter(id => { const detail = details.get(id); return detail?.status === 'fulfilled' && detail.value.status === 200; });
        const turns = await readSessionTurnsBatch({ userId: request.userId, authentication,
            sessionIds: readableIds.filter(id => evidenceIds.has(id)) });
        const plainIds = readableIds.filter(id => { const result = details.get(id); return transcriptIds.has(id)
            && result?.status === 'fulfilled' && result.value.status === 200 && result.value.body.session.encryptionMode === 'plain'; });
        const plainIdSet = new Set(plainIds);
        const opaqueIds = readableIds.filter(id => transcriptIds.has(id) && !plainIdSet.has(id));
        const stateIds = readableIds.filter(id => { const detail = details.get(id); return evidenceIds.has(id)
            && detail?.status === 'fulfilled' && detail.value.status === 200 && detail.value.body.session.encryptionMode === 'plain'; });
        const stateById = new Map<string, UsageStateEvidenceStorageRow>();
        const stateFailures = new Map<string, ReturnType<typeof unavailable>>();
        for (let offset = 0; offset < stateIds.length; offset += SESSION_ACCESS_SESSION_BATCH_SIZE) {
            const batch = stateIds.slice(offset, offset + SESSION_ACCESS_SESSION_BATCH_SIZE);
            try {
                const rows = await inReadSnapshot(tx => readSessionStateEvidenceRowsInTx(tx,
                    batch.map(id => ({ id, privateState: privateStateIds.has(id) }))));
                for (const row of rows) stateById.set(row.id, row);
            } catch (reason) {
                for (const id of batch) stateFailures.set(id, unavailable(reason));
            }
        }
        if (reply.raw.destroyed) { reply.hijack(); return; }
        const opaque = await readSessionMessagePages({ userId: request.userId, authentication,
            sessionIds: opaqueIds, previewRequest: request, includeAccountActors: false });
        const plainCapture: { rows: UsageMessageEvidenceStorageRow[]; admitted: Set<string>;
            denied: Map<string, { status: 403 | 404 | 503; body: { error: string } }> } = {
                rows: [], admitted: new Set(), denied: new Map(),
            };
        for (let offset = 0; offset < plainIds.length; offset += SESSION_ACCESS_SESSION_BATCH_SIZE) {
            const batch = plainIds.slice(offset, offset + SESSION_ACCESS_SESSION_BATCH_SIZE);
            try {
                const captured = await inReadSnapshot(async tx => {
                    const access = await readSessionTranscriptRowsInTx(tx, { accountId: request.userId, sessionIds: batch, authentication });
                    const denied = new Map<string, { status: 403 | 404 | 503; body: { error: string } }>();
                    const subjects = batch.flatMap(id => access.decisions.get(id)?.status === 'allowed'
                        && access.rows.has(id) ? [{ id, maximumSeq: resolveSessionTranscriptPublicationCeiling(access.rows.get(id)!) }]
                        : (denied.set(id, access.decisions.get(id)?.status === 'authentication_required'
                            ? { status: 403, body: { error: 'team_authentication_required' } }
                            : access.decisions.get(id)?.status === 'authentication_unavailable'
                                ? { status: 503, body: { error: 'team_authentication_unavailable' } }
                                : { status: 404, body: { error: 'Session not found' } }), []));
                    return { rows: await readSessionMessageEvidenceRowsInTx(tx, subjects, USAGE_COLLABORATION_TOOL_LEAF_KEYS),
                        admitted: subjects.map(subject => subject.id), denied };
                });
                for (const row of captured.rows) plainCapture.rows.push(row);
                for (const id of captured.admitted) plainCapture.admitted.add(id);
                for (const [id, denial] of captured.denied) plainCapture.denied.set(id, denial);
            } catch (reason) {
                for (const id of batch) plainCapture.denied.set(id, unavailable(reason));
            }
        }
        if (reply.raw.destroyed) { reply.hijack(); return; }
        const messages = new Map<string, UsageSessionMessageProjection[]>();
        const malformed = new Set<string>();
        for (const row of plainCapture.rows) {
            if (row.envelopeType !== 'plain') { malformed.add(row.sessionId); continue; }
            if (row.recordType === 'acp' && typeof row.nativeAgentId !== 'string') malformed.add(row.sessionId);
            const value = readUsageSessionMessageProjection({ ...row,
                createdAt: row.createdAt instanceof Date ? row.createdAt.getTime() : Number(row.createdAt) });
            if (!value) { malformed.add(row.sessionId); continue; }
            const group = messages.get(row.sessionId) ?? [];
            group.push(value); messages.set(row.sessionId, group);
        }
        const results: UsageSessionEvidenceResponse['results'] = [];
        for (const sessionId of ids) {
            const detail = details.get(sessionId);
            const result: UsageSessionEvidenceResponse['results'][number] = { sessionId,
                detail: stateFailures.get(sessionId) ?? (!detail ? unavailable(undefined) : detail.status === 'rejected' ? unavailable(detail.reason) : detail.value) };
            const turn = turns.get(sessionId);
            if (turn) result.turns = turn.status === 'fulfilled' ? turn.value : unavailable(turn.reason);
            const state = stateById.get(sessionId);
            if (state && Number(state.known) === 1 && Number(state.malformed) === 0 && result.turns?.status === 200) {
                const readMap = <T>(value: unknown, parse: (entry: unknown) => { success: boolean; data?: T }): Record<string, T> | null => {
                    let opened: unknown = value;
                    if (typeof value === 'string') { try { opened = JSON.parse(value); } catch { return null; } }
                    if (!opened || typeof opened !== 'object' || Array.isArray(opened)) return null;
                    const admitted: Record<string, T> = Object.create(null);
                    for (const [key, entry] of Object.entries(opened)) {
                        const parsed = parse(entry);
                        if (!key || !parsed.success || parsed.data === undefined) return null;
                        admitted[key] = parsed.data;
                    }
                    return admitted;
                };
                const requestMap = (value: unknown) => readMap<UsageSessionPermissionRequestProjection>(value,
                    entry => UsageSessionPermissionRequestProjectionSchema.safeParse(entry));
                const completedMap = (value: unknown) => readMap<UsageSessionPermissionCompletedProjection>(value,
                    entry => UsageSessionPermissionCompletedProjectionSchema.safeParse(entry));
                const sharedRequests = requestMap(state.sharedRequests), privateRequests = requestMap(state.privateRequests);
                const sharedCompleted = completedMap(state.sharedCompleted), privateCompleted = completedMap(state.privateCompleted);
                if (sharedRequests && privateRequests && sharedCompleted && privateCompleted) {
                    result.stateEvidence = projectUsageSessionStateEvidenceFromRequests({ sessionId,
                        machineId: typeof state.machineId === 'string' ? state.machineId : null,
                        turns: result.turns.body.turns, requests: { ...sharedRequests, ...privateRequests },
                        completedRequests: { ...sharedCompleted, ...privateCompleted } });
                }
            }
            const page = opaque.get(sessionId);
            if (page) {
                const messagePage = page.status === 'fulfilled' ? page.value : unavailable(page.reason);
                result.messages = messagePage;
                result.messagesComplete = messagePage.status === 200 && !messagePage.body.hasMore;
            }
            const denial = plainCapture.denied.get(sessionId);
            if (denial) { result.messages = denial; result.messagesComplete = false; }
            if (plainCapture.admitted.has(sessionId)) {
                const complete = !malformed.has(sessionId) && result.turns?.status === 200;
                const projections = messages.get(sessionId) ?? [];
                result.messagesComplete = complete;
                if (!complete && !projections.length) result.messageEvidence = {};
                if (complete || projections.length) {
                    const projected = projectSessionUsageWorkEvidence({ id: sessionId, metadata: null, agentState: null,
                        ...(result.turns?.status === 200 ? { sessionTurns: result.turns.body } : {}) }, undefined,
                    { messageProjections: projections, messagesComplete: complete });
                    const evidence: UsageSessionMessageEvidence = {
                        ...(projected.acceptedInputs === undefined ? {} : { acceptedInputs: projected.acceptedInputs }),
                        ...(projected.phaseEvents === undefined ? {} : { phaseEvents: projected.phaseEvents }),
                        ...(projected.coach === undefined ? {} : { coach: projected.coach }),
                        ...(projected.collaboration === undefined ? {} : { collaboration: projected.collaboration }),
                    };
                    result.messageEvidence = evidence;
                }
            }
            results.push(result);
        }
        return sendEvidence(results);
    });
}
