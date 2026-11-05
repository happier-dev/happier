import {
    SessionReadBatchRequestV1Schema,
    SessionReadBatchResponseV1Schema,
    SessionReadBatchTurnsV1Schema,
    SessionReadBatchMessagesV1Schema,
    type SessionReadBatchResultV1,
} from '@happier-dev/protocol/sessions/read/sessionReadBatchV1';

import type { Fastify } from '../../types';
import { readSessionAccessAuthenticationFromRequest } from '@/app/session/access/sessionAccessAuthentication';
import { readAccountStoredContentCompatibilityForHttpRequest } from '@/app/clientCompatibility/accountStoredContentCompatibility';
import { projectSessionTurnWaitingCompatibility } from '@/app/clientCompatibility/sessionTurnWaitingCompatibility';
import { readDatabaseErrorCode } from '@/storage/transactionErrors';
import { resolveApiHotEndpointRateLimit } from '@/app/api/utils/apiRateLimitCatalog';
import { logUnexpectedRequestError } from '@/app/api/utils/logUnexpectedRequestError';
import { readSessionDetails } from './registerSessionListingRoutes';
import { readSessionMessagePages } from './readSessionMessagePages';
import { readSessionTurnsBatch } from './readSessionTurns';
import { inReadSnapshot } from '@/storage/inTx';
import { loadSessionRuleReadBoundariesInTx, projectSessionRuleReadStates } from '@/app/session/personal/readState';
import { readAccountFollowRuleProjectionRowsInTx, projectAccountFollowRuleReceiverCounts } from '@/app/session/follow/accountFollowRuleService';
import { parseProjectedSessionBatchDetail, parseProjectedSessionBatchResponse } from './sessionRecordResponse';

/** Each demanded kind reads one admitted set; projection preserves per-id outcomes. */
export function registerSessionReadBatchRoute(app: Fastify) {
    app.post('/v2/sessions/read-batch', {
        preHandler: app.authenticate,
        config: { rateLimit: resolveApiHotEndpointRateLimit(process.env, 'session.detail'),
            restrictedCredentialBinding: { scope: 'session_managed_subtree', session: 'body.underSessionId' },
        },
        schema: { body: SessionReadBatchRequestV1Schema, response: { 200: SessionReadBatchResponseV1Schema } },
    }, async (request, reply) => {
        const authentication = readSessionAccessAuthenticationFromRequest(request);
        const storedContentCompatibility = readAccountStoredContentCompatibilityForHttpRequest(request);
        const readComponent = async <T>(read: () => Promise<T>) => {
            try {
                return await read();
            } catch (error) {
                const databaseError = readDatabaseErrorCode(error);
                if (!databaseError) logUnexpectedRequestError(error, { module: 'fastify-error', httpRequestId: request.id });
                return { status: 503 as const, body: { error: databaseError ?? 'session_read_unavailable' } };
            }
        };
        const details = request.body.includeSnapshot ? await readComponent(() => readSessionDetails({
            userId: request.userId, sessionIds: request.body.sessionIds, authentication,
            accessProjectionVersion: request.body.accessProjectionVersion, storedContentCompatibility,
            underSessionId: request.body.underSessionId,
            includePrivateRuleProjection: false,
        })) : undefined;
        const turnIds = request.body.includeSnapshot && request.body.includeTurns !== false && details && !('status' in details)
            ? request.body.sessionIds.filter(id => {
                const detail = details.get(id);
                return detail?.status === 'fulfilled' && detail.value.status === 200;
            }) : [];
        const turnResults = turnIds.length ? await readComponent(() => readSessionTurnsBatch({
            userId: request.userId, sessionIds: turnIds, authentication,
        })) : undefined;
        const messageResults = request.body.includeMessages ? await readComponent(() => readSessionMessagePages({
            userId: request.userId, sessionIds: request.body.sessionIds, authentication, previewRequest: request,
        })) : undefined;
        const componentFor = <T>(batch: ReadonlyMap<string, PromiseSettledResult<T>> | { status: 503; body: { error: string } } | undefined, id: string): T | { status: 503; body: { error: string } } => {
            if (!batch) throw new Error('Session component batch missing');
            if ('status' in batch) return batch;
            const result = batch.get(id);
            if (!result) throw new Error('Session component result missing');
            if (result.status === 'rejected') throw result.reason;
            return result.value;
        };
        const readSession = async (sessionId: string) => {
            const result: SessionReadBatchResultV1 = { sessionId };
            if (request.body.includeSnapshot) {
                result.detail = await readComponent(async () => {
                    if (!details) throw new Error('Session detail batch missing');
                    if ('status' in details) return details;
                    const result = details.get(sessionId);
                    if (!result) throw new Error('Session detail result missing');
                    if (result.status === 'rejected') throw result.reason;
                    const detail = result.value;
                    return parseProjectedSessionBatchDetail({ ...detail,
                        body: projectSessionTurnWaitingCompatibility(detail.body, storedContentCompatibility) });
                });
                if (result.detail.status === 200 && request.body.includeTurns !== false) {
                    result.turns = await readComponent(async () => {
                        const turns = componentFor(turnResults, sessionId);
                        return SessionReadBatchTurnsV1Schema.parse({ ...turns,
                            body: projectSessionTurnWaitingCompatibility(turns.body, storedContentCompatibility) });
                    });
                }
            }
            if (request.body.includeMessages) {
                result.messages = await readComponent(async () => {
                    const messages = componentFor(messageResults, sessionId);
                    return SessionReadBatchMessagesV1Schema.parse({ ...messages,
                        body: projectSessionTurnWaitingCompatibility(messages.body, storedContentCompatibility) });
                });
            }
            return result;
        };
        const results: SessionReadBatchResultV1[] = [];
        for (const sessionId of request.body.sessionIds) results.push(await readSession(sessionId));
        // Only already-admitted details supply this corpus, visible sequence
        // and private cursor. One fresh mode-admitted rule snapshot serves the
        // whole request; no per-Session rule census or private filter evaluation.
        const projectedDetails = results.flatMap(result => result.detail?.status === 200 && result.detail.body.session.viewer
            ? [{ result, detail: result.detail, session: result.detail.body.session, viewer: result.detail.body.session.viewer }] : []);
        if (projectedDetails.length) {
            const ruleProjection = await readComponent(() => inReadSnapshot(async tx => {
                const ruleRows = await readAccountFollowRuleProjectionRowsInTx(tx, { accountId: request.userId, authentication });
                return { receiverCounts: projectAccountFollowRuleReceiverCounts(ruleRows),
                    boundaries: await loadSessionRuleReadBoundariesInTx(tx, { accountId: request.userId, authentication,
                        sessionIds: projectedDetails.map(row => row.session.id), ruleRows }) };
            }));
            for (const row of projectedDetails) {
                if ('status' in ruleProjection) row.result.detail = ruleProjection;
                else {
                    const ruleReadStates = projectSessionRuleReadStates({ visibleSessionSeq: row.session.seq, readState: row.viewer.readState,
                        boundaries: ruleProjection.boundaries.get(row.session.id) ?? [] });
                    row.result.detail = parseProjectedSessionBatchDetail({ ...row.detail, body: { ...row.detail.body, session: {
                        ...row.session, viewer: { ...row.viewer, ...(ruleReadStates.length ? { ruleReadStates } : {}) },
                        ...(row.session.ownerAccountId === request.userId && ruleProjection.receiverCounts
                            ? { receivedRuleCount: ruleProjection.receiverCounts.get(row.session.id) ?? 0 } : {}),
                    } } });
                }
            }
        }
        return reply.header('Cache-Control', 'no-store').serializer(JSON.stringify).send(parseProjectedSessionBatchResponse({ results }));
    });
}
