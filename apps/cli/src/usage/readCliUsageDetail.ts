import { createExternalActionHeaderRefusalError } from '@/api/externalActionHeaderRefusal';
import type { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { MetadataSchema, AgentStateSchema } from '@happier-dev/session-core/state';
import { readSessionAccessProjectionRoleV1 } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import { readSessionReadBatchFailureCodeV1 } from '@happier-dev/protocol/sessions/read/sessionReadBatchV1';
import { readStoredSessionMessageDeliveryResolutionV1, SessionMessageAcceptedDeliveryFactsV1StoredSchema } from '@happier-dev/protocol/sessions/messages/sessionMessageDeliveryResolutionV1';
import { resolveAgentExecutionTargetFromSessionMetadata } from '@happier-dev/agents/runtime/identity/resolveAgentIdFromSessionMetadata';
import { readAcpConfiguredBackendV1FromMetadata } from '@happier-dev/protocol/sessions/metadata/acpConfiguredBackendV1';
import { projectSessionUsageWorkEvidence, projectUsageQueryWorkEvidence, readUsageAccountingSessionMembership, selectUsageQueryWorkEvidenceSessionIds, usageQueryNeedsSessionCandidates, hasUsageActivitySessionPopulation,
    type OpenedUsageMessage, type OpenedUsageSession } from '@happier-dev/protocol/usage/usageWorkEvidence';
import { USAGE_SESSION_EVIDENCE_PATH, UsageSessionEvidenceRequestSchema, UsageSessionEvidenceResponseSchema, createUsageSessionEvidenceStreamDecoder,
    type UsageSessionEvidenceRequest, type UsageSessionEvidenceResponse } from '@happier-dev/protocol/usage/usageSessionEvidence';
import { collectUsageWorkSources, resolveUsageWorkSessionTarget } from '@happier-dev/protocol/usage/usageWorkSources';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import type { UsageCoachRemedySession } from '@happier-dev/protocol/usage/coach/buildUsageCoachRemedies';
import { getUsageQueryKey, type UsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { projectUsageSessionEvidenceCoverage, type UsageHowYouWorkDetailInput } from '@happier-dev/protocol/usage/resolveUsageHowYouWork';
import { projectUsageActivitySourceStatus, readUsageAuthorityRefusalCode, type UsageAccountingSourceSnapshot, type UsageQuerySourceState } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { OperationUpdateRequiredV1Schema, type OperationUpdateRequiredV1 } from '@happier-dev/protocol/compat/operationUpdateRequiredV1';
import type { StoredCredentials } from '@/persistence';
import type { AccountRecipientEnvelopeReadiness } from '@happier-dev/protocol/account/encryptionMode';
import axios from '@/api/client/credentialAxios';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { configuration } from '@/configuration';
import { resolveCredentialSessionContentCrypto, tryDecryptSessionOwnerMetadataView, openSessionMessageContent, SessionStoredContentError } from '@/session/transport/encryption/sessionEncryptionContext';
import { readSessionAgentState } from '@/session/actions/cliActionDeps/sessionStateReaders';
import { callExactMachineRpc } from '@/session/transport/rpc/machineRpc';
import { classifyServerEndpointError } from '@/api/client/classifyServerEndpointError';
import { createHttpStatusError, HttpStatusError, readHttpStatus } from '@/api/client/httpStatusError';

function classifySessionEvidencePartRead(status: number, body: object) {
    const error = createHttpStatusError(status, 'Usage Session evidence unavailable');
    const classification = classifyServerEndpointError(error);
    const errorCode = readSessionReadBatchFailureCodeV1(body)
        ?? (status === 404 ? 'not_found' : status === 403 ? 'forbidden' : classification.kind);
    return { errorCode, retryable: ['network', 'timeout', 'server_error', 'dependency_unavailable', 'rate_limited'].includes(classification.kind) };
}

/** Protected transport adapter; deterministic membership, phases and SCM joins are shared. */
export async function readCliUsageDetail(input: Readonly<{
    queries: readonly UsageQuery[];
    accounting: readonly UsageAccountingSourceSnapshot[];
    credentials: StoredCredentials;
    serverId: string;
    serverHttpBaseUrl: string;
    accountEncryptionMode: 'plain' | 'e2ee' | null;
    accountStorageErrorCode?: string;
    recipientEnvelopeReadiness?: AccountRecipientEnvelopeReadiness;
    allowPrivateRead: boolean;
    nowMs: number;
    signal?: AbortSignal;
    assertCurrent: () => Promise<void>;
    resolveHeaders: (request: Readonly<{ method: 'GET' | 'POST'; path: string; body?: unknown }>) => Readonly<Record<string, string>> | null;
}>) {
    const accounting = new Map(input.accounting.map(row => [getUsageQueryKey(row.query), row.value?.contributions]));
    const membership = new Map(input.accounting.map(row => [getUsageQueryKey(row.query), readUsageAccountingSessionMembership(row.value)]));
    const admitted = input.allowPrivateRead && input.accountEncryptionMode !== null;
    const accountActivityFailure = input.allowPrivateRead && !admitted && input.accountStorageErrorCode !== undefined
        ? { errorCode: input.accountStorageErrorCode } : undefined;
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
        evidence: UsageHowYouWorkDetailInput; messagesComplete: boolean;
        workTarget: ReturnType<typeof resolveUsageWorkSessionTarget>; canReadWork: boolean }>;
    const sessions = new Map<string, Detail>();
    type ReadFailure = Readonly<{ errorCode: string; updateRequired?: OperationUpdateRequiredV1 }>;
    const activityFailures = new Map<string, ReadFailure>();
    const transcriptFailures = new Map<string, ReadFailure & { blocksSessionEvidence: boolean }>();
    type WorkReadFailure = ReadFailure & Readonly<{ httpStatus?: number }>;
    const workTargetFailures = new Map<string, WorkReadFailure>();
    let requestFailure: WorkReadFailure | undefined;
    const selectReadFailure = (failuresById: ReadonlyMap<string, ReadFailure>, sessionIds: readonly string[]) => {
        if (failuresById.size === 0) return undefined;
        const failures = sessionIds.flatMap(id => {
            const failure = failuresById.get(id);
            return failure ? [failure] : [];
        });
        return failures.find(failure => failure.updateRequired !== undefined) ?? failures[0];
    };
    if (admitted && plans.length) {
        try {
            await input.assertCurrent();
            const body = UsageSessionEvidenceRequestSchema.parse({ nowMs: input.nowMs,
                requests: plans.map(({ evidence: _evidence, ...request }) => request) });
            const headers = input.resolveHeaders({ method: 'POST', path: USAGE_SESSION_EVIDENCE_PATH, body });
            if (!headers) throw createExternalActionHeaderRefusalError();
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
                if (response.status !== 200) {
                    let errorCode: string | undefined;
                    if (String(response.headers['content-type'] ?? '').toLowerCase().includes('application/json')) {
                        let text = '';
                        for await (const chunk of response.data.setEncoding('utf8')) text += chunk;
                        try { errorCode = readSessionReadBatchFailureCodeV1(JSON.parse(text)); }
                        catch { /* A malformed error body has only its transport status. */ }
                    }
                    throw createHttpStatusError(response.status, 'Usage Session evidence unavailable', errorCode ?? undefined);
                }
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
                // The wire query omits host-only Coach and quota projection flags.
                if (getUsageQueryKey(request.query) !== getUsageQueryKey(body.requests[index]!.query)
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
            const code = error instanceof HttpStatusError && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
            const httpStatus = readHttpStatus(error) ?? undefined;
            requestFailure = requirement.success
                ? { errorCode: 'update_required', updateRequired: requirement.data } : { errorCode: code ?? kind, httpStatus };
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
            const sessionParts = [part.detail, ...(includeTurns ? [part.turns] : [])];
            const requirement = sessionParts.flatMap(read => read?.status !== 200 && read?.body
                && 'kind' in read.body && read.body.kind === 'update_required' ? [read.body] : [])[0];
            if (requirement) {
                const failure = { errorCode: 'update_required', updateRequired: requirement };
                workTargetFailures.set(sessionId, failure);
                activityFailures.set(sessionId, failure);
                continue;
            }
            // Work sees failures of the shared Session snapshot transport. A
            // missing target or a failure opening Activity data does not answer an SCM read.
            const failedSnapshot = sessionParts.find(read => read && read.status !== 200 && read.status !== 404);
            if (failedSnapshot) {
                const { kind } = classifyServerEndpointError(createHttpStatusError(failedSnapshot.status, 'Usage Session evidence unavailable'));
                workTargetFailures.set(sessionId, { errorCode: readSessionReadBatchFailureCodeV1(failedSnapshot.body) ?? kind, httpStatus: failedSnapshot.status });
            }
            const detail = part.detail!; // Batch admission requires every requested detail.
            if (detail.status !== 200) {
                activityFailures.set(sessionId, { errorCode: classifySessionEvidencePartRead(detail.status, detail.body).errorCode });
                continue;
            }
            const turns = part.turns;
            if (includeTurns && turns?.status !== 200) {
                const errorCode = turns ? classifySessionEvidencePartRead(turns.status, turns.body).errorCode : 'session_read_batch_invalid_response';
                activityFailures.set(sessionId, { errorCode });
                // A missing turns part supplies no interval facts. The detail
                // previously admitted for this Session can still be used.
                if (turns?.status !== 404) continue;
            }
            const rawSession = detail.body.session;
            const role = readSessionAccessProjectionRoleV1(rawSession);
            if (role === 'unavailable' || rawSession.effectiveAccess?.capabilities.readTranscript === false) {
                activityFailures.set(sessionId, { errorCode: role === 'unavailable' ? 'invalid_response' : 'forbidden' });
                continue;
            }
            const resolvedCrypto = resolveCredentialSessionContentCrypto(input.credentials, rawSession, input.recipientEnvelopeReadiness);
            if (resolvedCrypto.crypto === null) {
                activityFailures.set(sessionId, { errorCode: resolvedCrypto.errorCode });
                continue;
            }
            const crypto = resolvedCrypto.crypto;
            const ownerMetadata = tryDecryptSessionOwnerMetadataView({ credentials: input.credentials,
                accountEncryptionMode: input.accountEncryptionMode!, rawSession });
            // Owner metadata cannot be substituted with a raw public projection.
            const parsedMetadata = MetadataSchema.safeParse(ownerMetadata);
            const metadata = parsedMetadata.success ? parsedMetadata.data : null;
            if (role === 'owner' && !metadata) {
                activityFailures.set(sessionId, { errorCode: 'metadata_unavailable' });
                continue;
            }
            const agentState = AgentStateSchema.safeParse(intervalSessionIds.has(sessionId)
                ? readSessionAgentState({ rawSession, ...crypto }) : null);
            const sessionTurns = turns?.status === 200 ? turns.body : null;
            await input.assertCurrent();
            let messages: OpenedUsageMessage[] | undefined;
            let messagesComplete = false;
            const messageEvidence = includeMessages && crypto.mode === 'plain' ? part.messageEvidence : undefined;
            const messagePart = part.messages;
            if (includeMessages && messagePart && messagePart.status !== 200
                && 'kind' in messagePart.body && messagePart.body.kind === 'update_required') {
                transcriptFailures.set(sessionId, { errorCode: 'update_required', updateRequired: messagePart.body, blocksSessionEvidence: true });
            } else if (includeMessages) try {
                if (messageEvidence !== undefined) messagesComplete = part.messagesComplete === true;
                else {
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
                const failed = messagePart && messagePart.status !== 200 ? classifySessionEvidencePartRead(messagePart.status, messagePart.body)
                    : { errorCode: error instanceof SessionStoredContentError ? error.code : 'session_read_batch_invalid_response', retryable: false };
                const status = messagePart?.status;
                if (status === 401 || status === 403 || status === 404 || readUsageAuthorityRefusalCode(failed.errorCode) !== null) {
                    activityFailures.set(sessionId, { errorCode: failed.errorCode });
                    continue;
                }
                // The message format is independent of the already opened summary.
                transcriptFailures.set(sessionId, { errorCode: failed.errorCode, blocksSessionEvidence: !failed.retryable });
            }
            const access = rawSession.effectiveAccess ?? (role === 'owner' ? { capabilities: { submitAgentInput: true } } : undefined);
            const session: OpenedUsageSession = { id: sessionId, seq: rawSession.seq, createdAt: rawSession.createdAt, origin: rawSession.origin,
                manager: rawSession.manager, metadata, agentState: agentState.success ? agentState.data : null, sessionTurns,
                stateEvidence: crypto.mode === 'plain' ? part.stateEvidence : undefined };
            sessions.set(sessionId, { session,
                remedySession: { id: sessionId, serverId: input.serverId, active: rawSession.active, access,
                    ownerMetadata, agentTarget: readAcpConfiguredBackendV1FromMetadata(ownerMetadata)?.backendId ? null
                        : resolveAgentExecutionTargetFromSessionMetadata(ownerMetadata) },
                evidence: projectSessionUsageWorkEvidence(session, messages, { messagesComplete, messageEvidence }), messagesComplete,
                workTarget: resolveUsageWorkSessionTarget(ownerMetadata),
                canReadWork: role === 'owner' || rawSession.effectiveAccess?.capabilities.submitAgentInput === true });
        } catch (error) {
            await input.assertCurrent();
            const { kind } = classifyServerEndpointError(error);
            activityFailures.set(sessionId, { errorCode: kind });
        }
    }
    await input.assertCurrent();
    const remedySessionIds = new Set<string>();
    const openedByQuery = new Map<string, readonly Detail[]>();
    for (const query of input.queries) {
        const key = getUsageQueryKey(query);
        const candidates = query.includeSessionEvidence ? idsByQuery.get(key) ?? [] : [...sessions.keys()];
        const ids = selectUsageQueryWorkEvidenceSessionIds({ query,
            selectedSessionIds: candidates,
            sessions: candidates.flatMap(id => sessions.has(id) ? [sessions.get(id)!.session] : [{ id }]),
            contributions: accounting.get(key), sessionMembership: membership.get(key) });
        const needsTranscript = query.includeSessionEvidence && query.includeTranscriptEvidence;
        const opened = ids.flatMap(id => {
            const row = sessions.get(id);
            return row && !(needsTranscript && transcriptFailures.get(id)?.blocksSessionEvidence) ? [row] : [];
        });
        if (query.includeSessionEvidence) {
            idsByQuery.set(key, [...ids]);
            openedByQuery.set(key, opened);
        }
        for (const row of opened) remedySessionIds.add(row.session.id);
    }
    // Work admits accounting turns and resolves them from the opened Session metadata.
    const work = await collectUsageWorkSources({ queries: workQueries, accounting: input.accounting, assertCurrent: input.assertCurrent, now: Date.now,
        resolveSession: async sessionId => {
            const session = sessions.get(sessionId);
            if (!session) {
                return requestFailure ?? workTargetFailures.get(sessionId) ?? null;
            }
            if (!session.canReadWork) return { errorCode: RPC_ERROR_CODES.FORBIDDEN };
            return session.workTarget;
        },
        readMachine: async (machineId, request) => {
            await input.assertCurrent();
            const response = await callExactMachineRpc({ credentials: input.credentials, serverUrl: input.serverHttpBaseUrl,
                machineId, method: RPC_METHODS.SCM_WORK_EVIDENCE_READ, request, timeoutMs: null,
                authorization: { kind: 'scm.workEvidence', sessionIds: request.sessions.map(session => session.sessionId) }, signal: input.signal });
            await input.assertCurrent();
            return response;
        },
    });
    await input.assertCurrent();
    const howYouWorkProgress = new Map<string, { pending: boolean; sources: readonly UsageQuerySourceState[] }>();
    const howYouWork = evidenceQueries.map(query => {
        const key = getUsageQueryKey(query);
        const ids = idsByQuery.get(key) ?? [];
        const contributions = accounting.get(key);
        const sessionMembership = membership.get(key);
        const opened = openedByQuery.get(key) ?? [];
        const detail = projectUsageQueryWorkEvidence({ query,
            sessions: opened.map(row => row.session),
            sessionEvidence: new Map(opened.map(row => [row.session.id,
                query.includeTranscriptEvidence ? row.evidence : projectSessionUsageWorkEvidence(row.session)])),
            contributions, sessionMembership,
        });
        const sessionFailure = selectReadFailure(activityFailures, ids);
        const transcriptFailure = query.includeTranscriptEvidence ? selectReadFailure(transcriptFailures, ids) : undefined;
        const failure = sessionFailure?.updateRequired ? sessionFailure
            : transcriptFailure?.updateRequired ? transcriptFailure : sessionFailure ?? transcriptFailure;
        const canPublishEvidence = admitted && !requestFailure && !failure?.updateRequired;
        const populationObserved = hasUsageActivitySessionPopulation(query, contributions, sessionMembership);
        const sessionCoverage = canPublishEvidence && populationObserved
            ? projectUsageSessionEvidenceCoverage(ids.length, opened,
                row => query.includeTranscriptEvidence && row.messagesComplete ? 'read' : 'unread')
            : undefined;
        if (canPublishEvidence) {
            const sessionsCovered = sessionCoverage !== undefined && sessionCoverage.admitted === sessionCoverage.selected;
            const transcriptsCovered = sessionsCovered && sessionCoverage.notRead === 0;
            howYouWorkProgress.set(key, { pending: false, sources: [
                { source: 'how_you_work:sessions', status: projectUsageActivitySourceStatus(true, true, sessionsCovered && !sessionFailure),
                    ...(sessionFailure ? { errorCode: sessionFailure.errorCode } : {}) },
                { source: 'how_you_work:transcripts', status: projectUsageActivitySourceStatus(query.includeTranscriptEvidence, true, transcriptsCovered),
                    ...(transcriptFailure ? { errorCode: transcriptFailure.errorCode } : {}) },
            ] });
        }
        return { query, asOfMs: input.nowMs, detail, ...(sessionCoverage ? { sessionCoverage } : {}),
            ...(requestFailure ? { errorCode: requestFailure.errorCode, ...(requestFailure.updateRequired ? { updateRequired: requestFailure.updateRequired } : {}) }
                : accountActivityFailure ?? (failure && (detail.status === 'unknown' || failure.updateRequired)
                    ? { errorCode: failure.errorCode, ...(failure.updateRequired ? { updateRequired: failure.updateRequired } : {}) }
                    : undefined)) };
    });
    return { howYouWork, howYouWorkProgress, work, sessions: [...sessions.values()]
        .flatMap(row => remedySessionIds.has(row.session.id) ? [row.remedySession] : []) };
}
