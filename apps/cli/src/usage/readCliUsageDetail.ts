import { MetadataSchema, AgentStateSchema } from '@happier-dev/session-core/state';
import { readSessionAccessProjectionRoleV1 } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import { readStoredSessionMessageDeliveryResolutionV1, SessionMessageAcceptedDeliveryFactsV1StoredSchema } from '@happier-dev/protocol/sessions/messages/sessionMessageDeliveryResolutionV1';
import { resolveAgentExecutionTargetFromSessionMetadata } from '@happier-dev/agents/runtime/identity/resolveAgentIdFromSessionMetadata';
import { readAcpConfiguredBackendV1FromMetadata } from '@happier-dev/protocol/sessions/metadata/acpConfiguredBackendV1';
import { projectUsageQueryWorkEvidence, selectUsageQueryWorkEvidenceSessionIds, usageQueryNeedsSessionCandidates, type OpenedUsageMessage, type OpenedUsageSession } from '@happier-dev/protocol/usage/usageWorkEvidence';
import { collectUsageWorkSources } from '@happier-dev/protocol/usage/usageWorkSources';
import type { UsageCoachRemedySession } from '@happier-dev/protocol/usage/coach/buildUsageCoachRemedies';
import { getUsageQueryKey, type UsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import type { UsageAccountingSourceSnapshot, UsageWorkSourceSnapshot } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { OperationUpdateRequiredV1Schema, type OperationUpdateRequiredV1 } from '@happier-dev/protocol/compat/operationUpdateRequiredV1';
import type { StoredCredentials } from '@/persistence';
import { fetchSessionListPage, fetchSessionSnapshotsBatch } from '@/session/transport/http/sessionsHttp';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { resolveExactSessionOrCredentialCryptoContext, tryDecryptSessionOwnerMetadataView, openSessionMessageContent } from '@/session/transport/encryption/sessionEncryptionContext';
import { readSessionAgentState } from '@/session/actions/cliActionDeps/sessionStateReaders';
import { callMachineRpc } from '@/session/transport/rpc/machineRpc';
import { classifyServerEndpointError } from '@/api/client/classifyServerEndpointError';
import { createHttpStatusError } from '@/api/client/httpStatusError';

/** Protected transport adapter; deterministic membership, phases and SCM joins are shared. */
export async function readCliUsageDetail(input: Readonly<{
    queries: readonly UsageQuery[];
    accounting: readonly UsageAccountingSourceSnapshot[];
    credentials: StoredCredentials;
    serverId: string;
    serverHttpBaseUrl: string;
    accountEncryptionMode: 'plain' | 'e2ee' | null;
    allowPrivateRead: boolean;
    nowMs: number;
    signal?: AbortSignal;
    assertCurrent: () => Promise<void>;
    resolveHeaders: (request: Readonly<{ method: 'GET' | 'POST'; path: string; body?: unknown }>) => Readonly<Record<string, string>> | null;
}>) {
    const accounting = new Map(input.accounting.map(row => [getUsageQueryKey(row.query), row.value?.contributions]));
    const admitted = input.allowPrivateRead && input.accountEncryptionMode !== null;
    const evidenceQueries = input.queries.filter(query => query.includeSessionEvidence);
    const candidates: { id: string }[] = [];
    if (admitted && evidenceQueries.some(usageQueryNeedsSessionCandidates)) {
        await runWithServerHttpBaseUrl(input.serverHttpBaseUrl, async () => {
            try {
                for (const archivedOnly of [false, true]) {
                    let cursor: string | undefined;
                    do {
                        await input.assertCurrent();
                        const page = await fetchSessionListPage({ token: input.credentials.token, archivedOnly, cursor,
                            resolveAuthorizationHeaders: input.resolveHeaders, signal: input.signal });
                        await input.assertCurrent();
                        candidates.push(...page.sessions.map(session => ({ id: session.id })));
                        cursor = page.hasNext && page.nextCursor !== null ? page.nextCursor : undefined;
                    } while (cursor !== undefined);
                }
            } catch { await input.assertCurrent(); candidates.length = 0; }
        });
    }
    const idsByQuery = new Map(evidenceQueries.map(query => [getUsageQueryKey(query), selectUsageQueryWorkEvidenceSessionIds({
        query, sessions: candidates, contributions: accounting.get(getUsageQueryKey(query)),
    })]));
    const intervalSessionIds = new Set([...idsByQuery.values()].flat());
    const transcriptSessionIds = new Set(evidenceQueries.filter(query => query.includeTranscriptEvidence)
        .flatMap(query => idsByQuery.get(getUsageQueryKey(query)) ?? []));
    const workQueries = input.queries.filter(query => query.includeWorkEvidence);
    const workSessionIds = workQueries.flatMap(query => accounting.get(getUsageQueryKey(query))
        ?.flatMap(row => row.sessionId !== null && row.turnId !== null ? [row.sessionId] : []) ?? []);
    type Detail = Readonly<{ session: OpenedUsageSession; remedySession: UsageCoachRemedySession;
        messages?: readonly OpenedUsageMessage[]; messagesComplete: boolean;
        machineId: string | null; cwd: string | null; canReadWork: boolean }>;
    const sessions = new Map<string, Detail>();
    type ReadFailure = Readonly<{ errorCode: string; updateRequired?: OperationUpdateRequiredV1 }>;
    const readFailures = new Map<string, ReadFailure>();
    const selectReadFailure = (sessionIds: readonly string[]) => {
        const failures = sessionIds.flatMap(id => readFailures.has(id) ? [readFailures.get(id)!] : []);
        return failures.find(failure => failure.updateRequired !== undefined) ?? failures[0];
    };
    await runWithServerHttpBaseUrl(input.serverHttpBaseUrl, async () => {
        if (!admitted) return;
        const sessionIds = [...new Set([...intervalSessionIds, ...workSessionIds])];
        // Each cohort asks for exactly the parts its queries consume. The
        // transport owns HTTP body chunking; Usage adds no Session count cap.
        for (const [includeTurns, includeMessages] of [[true, true], [true, false], [false, false]] as const) {
            const cohort = sessionIds.filter(id => intervalSessionIds.has(id) === includeTurns
                && transcriptSessionIds.has(id) === includeMessages);
            if (cohort.length === 0) continue;
            let parts: Awaited<ReturnType<typeof fetchSessionSnapshotsBatch>>;
            try {
                await input.assertCurrent();
                parts = await fetchSessionSnapshotsBatch({ token: input.credentials.token, serverUrl: input.serverHttpBaseUrl,
                    sessionIds: cohort, includeTurns, includeMessages, signal: input.signal,
                    resolveAuthorizationHeaders: input.resolveHeaders });
                await input.assertCurrent();
            } catch (error) {
                await input.assertCurrent();
                const { kind } = classifyServerEndpointError(error, { featureAbsentStatusCodes: [404] });
                const requirement = OperationUpdateRequiredV1Schema.safeParse(
                    error !== null && typeof error === 'object' && 'details' in error ? error.details : undefined);
                const failure: ReadFailure = requirement.success
                    ? { errorCode: 'update_required', updateRequired: requirement.data } : { errorCode: kind };
                for (const id of cohort) readFailures.set(id, failure);
                continue;
            }
            for (const sessionId of cohort) {
                try {
                    await input.assertCurrent();
                    const part = parts.get(sessionId);
                    const requiredParts = [part?.detail, ...(includeTurns ? [part?.turns] : []),
                        ...(includeMessages ? [part?.messages] : [])];
                    const requirement = requiredParts.flatMap(read => read?.status !== 200 && read?.body
                        && 'kind' in read.body && read.body.kind === 'update_required' ? [read.body] : [])[0];
                    if (requirement) {
                        readFailures.set(sessionId, { errorCode: 'update_required', updateRequired: requirement });
                        continue;
                    }
                    const rawSession = part?.detail?.status === 200 ? part.detail.body.session : null;
                    if (!rawSession || rawSession.id !== sessionId) continue;
                    const role = readSessionAccessProjectionRoleV1(rawSession);
                    if (role === 'unavailable' || rawSession.effectiveAccess?.capabilities.readTranscript === false) continue;
                    const crypto = resolveExactSessionOrCredentialCryptoContext({ credentials: input.credentials }, sessionId, rawSession);
                    if (!crypto) continue;
                    const ownerMetadata = tryDecryptSessionOwnerMetadataView({ credentials: input.credentials,
                        accountEncryptionMode: input.accountEncryptionMode!, rawSession });
                    // Owner metadata cannot be substituted with a raw public projection.
                    const parsedMetadata = MetadataSchema.safeParse(ownerMetadata);
                    const metadata = parsedMetadata.success ? parsedMetadata.data : null;
                    if (role === 'owner' && !metadata) continue;
                    const agentState = AgentStateSchema.safeParse(intervalSessionIds.has(sessionId)
                        ? readSessionAgentState({ rawSession, ...crypto }) : null);
                    const turns = part?.turns;
                    if (includeTurns && (!turns || turns.status !== 200 && turns.status !== 404)) continue;
                    if (turns?.status === 200 && turns.body.sessionId !== sessionId) continue;
                    const sessionTurns = turns?.status === 200 && turns.body.sessionId === sessionId ? turns.body : null;
                    await input.assertCurrent();
                    let messages: OpenedUsageMessage[] | undefined;
                    let messagesComplete = false;
                    if (transcriptSessionIds.has(sessionId)) try {
                        const messagePart = part?.messages;
                        if (!messagePart) throw Object.assign(new Error('Session messages unavailable'), { code: 'session_read_batch_invalid_response' });
                        if (messagePart.status !== 200) throw createHttpStatusError(messagePart.status, 'Session messages unavailable');
                        const page = messagePart.body;
                        await input.assertCurrent();
                        const opened = page.messages.flatMap(message => {
                                const content = openSessionMessageContent({ ...crypto, content: message.content });
                                const resolution = readStoredSessionMessageDeliveryResolutionV1(message.deliveryResolution);
                                const accepted = resolution?.kind === 'provider_accepted'
                                    ? SessionMessageAcceptedDeliveryFactsV1StoredSchema.safeParse(openSessionMessageContent({ ...crypto, content: resolution.content })) : null;
                                return [{ id: message.id, localId: message.localId, content, createdAt: message.createdAt,
                                    ...(accepted?.success ? { acceptedDelivery: accepted.data } : {}) }];
                        });
                        if (page.messages.length === 0 || opened.length > 0) messages = opened;
                        messagesComplete = page.hasMore === false && opened.length === page.messages.length;
                    } catch (error) {
                        await input.assertCurrent();
                        // Failed access/format admission cannot revive any Session private facts.
                        const { kind } = classifyServerEndpointError(error);
                        if (!['network', 'timeout', 'server_error', 'dependency_unavailable', 'rate_limited'].includes(kind)) continue;
                    }
                    const access = rawSession.effectiveAccess ?? (role === 'owner' ? { capabilities: { submitAgentInput: true } } : undefined);
                    const machineId = typeof ownerMetadata?.machineId === 'string' ? ownerMetadata.machineId : null;
                    const cwd = typeof ownerMetadata?.path === 'string' ? ownerMetadata.path : null;
                    sessions.set(sessionId, { session: { id: sessionId, createdAt: rawSession.createdAt, origin: rawSession.origin,
                        manager: rawSession.manager, metadata, agentState: agentState.success ? agentState.data : null, sessionTurns },
                        remedySession: { id: sessionId, serverId: input.serverId, active: rawSession.active, access,
                            ownerMetadata, agentTarget: readAcpConfiguredBackendV1FromMetadata(ownerMetadata)?.backendId ? null
                                : resolveAgentExecutionTargetFromSessionMetadata(ownerMetadata) },
                        messages, messagesComplete, machineId, cwd,
                        canReadWork: role === 'owner' || rawSession.effectiveAccess?.capabilities.submitAgentInput === true });
                } catch { await input.assertCurrent(); }
            }
        }
    });
    await input.assertCurrent();
    const work = await collectUsageWorkSources({ queries: workQueries, accounting: input.accounting, assertCurrent: input.assertCurrent,
        readSession: async sessionId => {
            const session = sessions.get(sessionId);
            if (!session?.canReadWork || !session.machineId || !session.cwd) return null;
            return async (method, request) => {
                await input.assertCurrent();
                const response = await callMachineRpc({ credentials: input.credentials, serverUrl: input.serverHttpBaseUrl,
                    machineId: session.machineId!, method, request: { ...request, cwd: session.cwd, outcomeVersion: 1 },
                    authorization: { kind: 'session.write', sessionId }, signal: input.signal });
                await input.assertCurrent();
                return response;
            };
        },
    });
    await input.assertCurrent();
    return { work: work.map((source): UsageWorkSourceSnapshot => {
            const ids = accounting.get(getUsageQueryKey(source.query))
                ?.flatMap(row => row.sessionId !== null && row.turnId !== null ? [row.sessionId] : []) ?? [];
            const failure = selectReadFailure(ids);
            return failure?.updateRequired ? { ...source, ...failure,
                status: source.evidence?.length || source.branchEvidence?.length ? 'partial' : 'unsupported' } : source;
        }), sessions: [...sessions.values()].map(row => row.remedySession),
        howYouWork: evidenceQueries.map(query => {
            const ids = idsByQuery.get(getUsageQueryKey(query)) ?? [];
            return { query, asOfMs: input.nowMs,
                ...selectReadFailure(ids),
                detail: projectUsageQueryWorkEvidence({ query,
                    sessions: ids.flatMap(id => sessions.has(id) ? [sessions.get(id)!.session] : []),
                    ...(query.includeTranscriptEvidence ? {
                        openedMessages: new Map([...sessions].flatMap(([id, row]) => row.messages === undefined ? [] : [[id, row.messages]])),
                        completeMessageSessionIds: new Set([...sessions].filter(([, row]) => row.messagesComplete).map(([id]) => id)),
                    } : {}),
                    contributions: accounting.get(getUsageQueryKey(query)),
                }),
            };
        }),
    };
}
