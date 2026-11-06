import type { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { MetadataSchema, AgentStateSchema } from '@happier-dev/session-core/state';
import { readSessionAccessProjectionRoleV1 } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import { readStoredSessionMessageDeliveryResolutionV1, SessionMessageAcceptedDeliveryFactsV1StoredSchema } from '@happier-dev/protocol/sessions/messages/sessionMessageDeliveryResolutionV1';
import { resolveAgentExecutionTargetFromSessionMetadata } from '@happier-dev/agents/runtime/identity/resolveAgentIdFromSessionMetadata';
import { readAcpConfiguredBackendV1FromMetadata } from '@happier-dev/protocol/sessions/metadata/acpConfiguredBackendV1';
import { projectSessionUsageWorkEvidence, projectUsageQueryWorkEvidence, readUsageAccountingSessionMembership, selectUsageQueryWorkEvidenceSessionIds, usageQueryNeedsSessionCandidates,
    type OpenedUsageMessage, type OpenedUsageSession } from '@happier-dev/protocol/usage/usageWorkEvidence';
import { USAGE_SESSION_EVIDENCE_PATH, UsageSessionEvidenceRequestSchema, UsageSessionEvidenceResponseSchema, createUsageSessionEvidenceStreamDecoder,
    type UsageSessionEvidenceRequest, type UsageSessionEvidenceResponse } from '@happier-dev/protocol/usage/usageSessionEvidence';
import { collectUsageWorkSources } from '@happier-dev/protocol/usage/usageWorkSources';
import type { UsageCoachRemedySession } from '@happier-dev/protocol/usage/coach/buildUsageCoachRemedies';
import { getUsageQueryKey, type UsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import type { UsageHowYouWorkDetailInput } from '@happier-dev/protocol/usage/resolveUsageHowYouWork';
import type { UsageAccountingSourceSnapshot, UsageWorkSourceSnapshot } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { OperationUpdateRequiredV1Schema, type OperationUpdateRequiredV1 } from '@happier-dev/protocol/compat/operationUpdateRequiredV1';
import type { StoredCredentials } from '@/persistence';
import axios from '@/api/client/credentialAxios';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { configuration } from '@/configuration';
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
    const membership = new Map(input.accounting.map(row => [getUsageQueryKey(row.query), readUsageAccountingSessionMembership(row.value)]));
    const admitted = input.allowPrivateRead && input.accountEncryptionMode !== null;
    const evidenceQueries = input.queries.filter(query => query.includeSessionEvidence);
    const workQueries = input.queries.filter(query => query.includeWorkEvidence);
    const plans: (UsageSessionEvidenceRequest['requests'][number] & { evidence: boolean })[] = [];
    for (const query of input.queries) {
        const contributions = accounting.get(getUsageQueryKey(query));
        const sessionMembership = membership.get(getUsageQueryKey(query));
        const admittedTurns = sessionMembership?.turns;
        const sessionIds = query.includeSessionEvidence
            ? selectUsageQueryWorkEvidenceSessionIds({ query, sessions: [], contributions, sessionMembership }) : [];
        if (query.includeSessionEvidence && usageQueryNeedsSessionCandidates(query)) {
            plans.push({ query, evidence: true });
        }
        if (sessionIds.length) {
            // Current metadata discovery cannot replace accounting's historical admission.
            plans.push({ query, sessionIds: [...sessionIds], evidence: true });
        }
        const workIds = query.includeWorkEvidence ? [...new Set(admittedTurns?.map(row => row.sessionId) ?? contributions
            ?.flatMap(row => row.sessionId !== null && row.turnId !== null ? [row.sessionId] : []) ?? [])] : [];
        const evidenceIds = new Set(sessionIds);
        const missingWorkIds = workIds.filter(id => !evidenceIds.has(id));
        // A separate positional request supplies SCM metadata without widening
        // the evidence query's server-selected historical Session membership.
        if (missingWorkIds.length) plans.push({ query, sessionIds: missingWorkIds, evidence: false });
    }
    const idsByQuery = new Map(evidenceQueries.map(query => [getUsageQueryKey(query), [] as string[]]));
    let parts: UsageSessionEvidenceResponse['results'] = [];
    type Detail = Readonly<{ session: OpenedUsageSession; remedySession: UsageCoachRemedySession;
        evidence: UsageHowYouWorkDetailInput;
        machineId: string | null; cwd: string | null; canReadWork: boolean }>;
    const sessions = new Map<string, Detail>();
    type ReadFailure = Readonly<{ errorCode: string; updateRequired?: OperationUpdateRequiredV1 }>;
    const readFailures = new Map<string, ReadFailure>();
    let requestFailure: ReadFailure | undefined;
    const selectReadFailure = (sessionIds: readonly string[]) => {
        const failures = sessionIds.flatMap(id => readFailures.has(id) ? [readFailures.get(id)!] : []);
        return failures.find(failure => failure.updateRequired !== undefined) ?? failures[0];
    };
    if (admitted && plans.length) {
        try {
            await input.assertCurrent();
            const body = UsageSessionEvidenceRequestSchema.parse({ nowMs: input.nowMs,
                requests: plans.map(({ evidence: _evidence, ...request }) => request) });
            const headers = input.resolveHeaders({ method: 'POST', path: USAGE_SESSION_EVIDENCE_PATH, body });
            if (!headers) throw new Error('External Action authorization unavailable');
            const response = await axios.post<Readable>(`${input.serverHttpBaseUrl}${USAGE_SESSION_EVIDENCE_PATH}`, body, {
                headers: { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(), ...headers,
                    'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
                ...(input.signal ? { signal: input.signal } : {}), timeout: configuration.sessionControlHttpTimeoutMs,
                validateStatus: () => true, responseType: 'stream',
            });
            let value: UsageSessionEvidenceResponse;
            try {
                await input.assertCurrent();
                if (response.status === 404) {
                    const details: OperationUpdateRequiredV1 = { kind: 'update_required', operation: 'usage.query',
                        component: 'server', reason: 'usage_session_evidence_unsupported' };
                    throw Object.assign(createHttpStatusError(response.status, 'Usage Session evidence requires a newer server', 'update_required'), { details });
                }
                if (response.status !== 200) throw createHttpStatusError(response.status, 'Usage Session evidence unavailable');
                const utf8 = new StringDecoder('utf8');
                const ndjson = String(response.headers['content-type'] ?? '').toLowerCase().includes('application/x-ndjson');
                const streamed: UsageSessionEvidenceResponse = { requests: [], results: [] };
                const decoder = ndjson ? createUsageSessionEvidenceStreamDecoder({
                    onRequests: requests => { streamed.requests = requests; },
                    onResult: result => { streamed.results.push(result); },
                }) : undefined;
                const json: string[] = [];
                for await (const value of response.data) {
                    const chunk: unknown = value;
                    if (!Buffer.isBuffer(chunk)) throw new Error('Invalid Usage evidence response stream');
                    const text = utf8.write(chunk);
                    if (decoder) decoder.write(text); else json.push(text);
                }
                const last = utf8.end();
                if (decoder) { decoder.write(last); decoder.finish(); value = streamed; }
                else { json.push(last); value = UsageSessionEvidenceResponseSchema.parse(JSON.parse(json.join(''))); }
                await input.assertCurrent();
            } finally { response.data.destroy(); }
            if (value.requests.length !== plans.length) throw new Error('Invalid Usage Session evidence response');
            const expected = new Set<string>();
            value.requests.forEach((request, index) => {
                const plan = plans[index]!;
                const suppliedIds = plan.sessionIds ? new Set(plan.sessionIds) : undefined;
                if (getUsageQueryKey(request.query) !== getUsageQueryKey(plan.query)
                    || new Set(request.sessionIds).size !== request.sessionIds.length
                    || suppliedIds && (suppliedIds.size !== request.sessionIds.length
                        || request.sessionIds.some(id => !suppliedIds.has(id)))) {
                    throw new Error('Invalid Usage Session evidence response');
                }
                for (const id of request.sessionIds) expected.add(id);
                if (plan.evidence) {
                    const key = getUsageQueryKey(plan.query);
                    idsByQuery.set(key, [...new Set([...(idsByQuery.get(key) ?? []), ...request.sessionIds])]);
                }
            });
            for (const part of value.results) {
                if (!expected.delete(part.sessionId) || !part.detail
                    || part.detail.status === 200 && part.detail.body.session.id !== part.sessionId
                    || part.turns?.status === 200 && part.turns.body.sessionId !== part.sessionId) {
                    throw new Error('Invalid Usage Session evidence response');
                }
            }
            if (expected.size) throw new Error('Invalid Usage Session evidence response');
            parts = value.results;
        } catch (error) {
            await input.assertCurrent();
            const { kind } = classifyServerEndpointError(error, { featureAbsentStatusCodes: [404] });
            const requirement = OperationUpdateRequiredV1Schema.safeParse(
                error !== null && typeof error === 'object' && 'details' in error ? error.details : undefined);
            requestFailure = requirement.success
                ? { errorCode: 'update_required', updateRequired: requirement.data } : { errorCode: kind };
        }
    }
    const intervalSessionIds = new Set([...idsByQuery.values()].flat());
    const transcriptSessionIds = new Set(evidenceQueries.filter(query => query.includeTranscriptEvidence)
        .flatMap(query => idsByQuery.get(getUsageQueryKey(query)) ?? []));
    for (const part of parts) {
        const sessionId = part.sessionId;
        const includeTurns = intervalSessionIds.has(sessionId);
        const includeMessages = transcriptSessionIds.has(sessionId);
        try {
            await input.assertCurrent();
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
            const messageEvidence = crypto.mode === 'plain' ? part.messageEvidence : undefined;
            if (transcriptSessionIds.has(sessionId)) try {
                if (messageEvidence !== undefined) messagesComplete = part.messagesComplete === true;
                else {
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
                }
            } catch (error) {
                await input.assertCurrent();
                // Failed access/format admission cannot revive any Session private facts.
                const { kind } = classifyServerEndpointError(error);
                if (!['network', 'timeout', 'server_error', 'dependency_unavailable', 'rate_limited'].includes(kind)) continue;
            }
            const access = rawSession.effectiveAccess ?? (role === 'owner' ? { capabilities: { submitAgentInput: true } } : undefined);
            const machineId = typeof ownerMetadata?.machineId === 'string' ? ownerMetadata.machineId : null;
            const cwd = typeof ownerMetadata?.path === 'string' ? ownerMetadata.path : null;
            const session: OpenedUsageSession = { id: sessionId, createdAt: rawSession.createdAt, origin: rawSession.origin,
                manager: rawSession.manager, metadata, agentState: agentState.success ? agentState.data : null, sessionTurns,
                stateEvidence: crypto.mode === 'plain' ? part.stateEvidence : undefined };
            sessions.set(sessionId, { session,
                remedySession: { id: sessionId, serverId: input.serverId, active: rawSession.active, access,
                    ownerMetadata, agentTarget: readAcpConfiguredBackendV1FromMetadata(ownerMetadata)?.backendId ? null
                        : resolveAgentExecutionTargetFromSessionMetadata(ownerMetadata) },
                evidence: projectSessionUsageWorkEvidence(session, messages, { messagesComplete, messageEvidence }), machineId, cwd,
                canReadWork: role === 'owner' || rawSession.effectiveAccess?.capabilities.submitAgentInput === true });
        } catch { await input.assertCurrent(); }
    }
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
            const ids = membership.get(getUsageQueryKey(source.query))?.turns?.map(row => row.sessionId) ?? accounting.get(getUsageQueryKey(source.query))
                ?.flatMap(row => row.sessionId !== null && row.turnId !== null ? [row.sessionId] : []) ?? [];
            const failure = requestFailure ?? selectReadFailure(ids);
            return failure?.updateRequired ? { ...source, ...failure,
                status: source.evidence?.length || source.branchEvidence?.length ? 'partial' : 'unsupported' } : source;
        }), sessions: [...sessions.values()].map(row => row.remedySession),
        howYouWork: evidenceQueries.map(query => {
            const ids = idsByQuery.get(getUsageQueryKey(query)) ?? [];
            return { query, asOfMs: input.nowMs,
                ...(requestFailure ?? selectReadFailure(ids)),
                detail: projectUsageQueryWorkEvidence({ query,
                    sessions: ids.flatMap(id => sessions.has(id) ? [sessions.get(id)!.session] : []),
                    sessionEvidence: new Map(ids.flatMap(id => {
                        const row = sessions.get(id);
                        return row ? [[id, query.includeTranscriptEvidence ? row.evidence : projectSessionUsageWorkEvidence(row.session)]] : [];
                    })),
                    contributions: accounting.get(getUsageQueryKey(query)),
                    sessionMembership: membership.get(getUsageQueryKey(query)),
                }),
            };
        }),
    };
}
