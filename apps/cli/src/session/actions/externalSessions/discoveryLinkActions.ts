import {
    buildLinkedExternalSessionQualifiedIdentityV1,
    deriveExternalSessionsAutoLinkSourcePolicyIdV1,
    ExternalSessionLinkEnsureRequestSchema,
    ExternalSessionsCandidatesListRequestSchema,
    type ExternalSessionLinkEnsureResponse,
    type ExternalSessionsCandidatesListResponse,
} from '@happier-dev/protocol';

import {
    ensureExternalSessionLink,
    type ExternalSessionIndexedTagLookupProof,
} from '@/api/session/external/linking/ensureExternalSessionLink';
import { resolveCurrentExternalSessionAgentIdentity } from '@/api/session/external/linking/qualifiedLinkIdentityRegistry';
import { validateExternalMachineSource } from '@/api/session/external/security/validateExternalMachineSource';
import { readCredentials } from '@/persistence';
import { configuration } from '@/configuration';
import { logger } from '@/utils/logger';

import { resolveDefaultCandidatesLimit } from './actionConfiguration';
import { annotateExternalSessionCandidates } from './candidateAnnotations';
import {
    executeExternalSessionCandidateQuery,
    hydrateExternalSessionCandidateThroughAgentSource,
} from './candidateQuery';
import {
    resolveExternalSessionSourceKeyOwner,
    resolveExternalSessionSurfaceOps,
} from './providerOpsResolution';
import {
    externalSessionsError,
    internalErrorResponse,
    mapExternalSessionProviderFailureToExternalSessionsError,
} from './responseErrors';

export async function executeExternalSessionCandidatesListAction(
    raw: unknown,
): Promise<ExternalSessionsCandidatesListResponse> {
    const parsed = ExternalSessionsCandidatesListRequestSchema.safeParse(raw);
    if (!parsed.success) return externalSessionsError('invalid_request') satisfies ExternalSessionsCandidatesListResponse;
    try {
        const validatedSource = await validateExternalMachineSource({
            agentId: parsed.data.agentId,
            source: parsed.data.source,
            env: process.env,
        });
        if (!validatedSource.ok) {
            return externalSessionsError(validatedSource.errorCode ?? 'invalid_request', validatedSource.error) satisfies ExternalSessionsCandidatesListResponse;
        }
        const { agentId, cursor, searchTerm, searchMode } = parsed.data;
        const source = validatedSource.source;
        const limit = parsed.data.limit ?? resolveDefaultCandidatesLimit();
        const startedAtMs = Date.now();
        const startMemory = process.memoryUsage();
        const providerOps = await resolveExternalSessionSurfaceOps(agentId);
        if (!providerOps.listCandidates) {
            return externalSessionsError('agent_unavailable', 'candidates_list_not_supported') satisfies ExternalSessionsCandidatesListResponse;
        }
        const currentAgent = await resolveCurrentExternalSessionAgentIdentity(agentId);
        if (!currentAgent) {
            return externalSessionsError('agent_unavailable', 'external_session_agent_unavailable') satisfies ExternalSessionsCandidatesListResponse;
        }
        const res = await executeExternalSessionCandidateQuery({
            activeServerDir: configuration.activeServerDir,
            agentIdentity: currentAgent.identity,
            source,
            ...(cursor ? { cursor } : {}),
            limit,
            ...(searchTerm ? { searchTerm } : {}),
            ...(searchMode ? { searchMode } : {}),
            listCandidates: async (request) => await providerOps.listCandidates!({
                source,
                ...request,
            }),
            hydrateCandidate: async (candidate) => (
                await hydrateExternalSessionCandidateThroughAgentSource({
                    source,
                    candidate,
                    providerOps,
                })
            ),
        });
        const credentials = await readCredentials().catch(() => null);
        if (!credentials) {
            return externalSessionsError('agent_unavailable', 'not_authenticated') satisfies ExternalSessionsCandidatesListResponse;
        }
        const sourceKeyOwner = await resolveExternalSessionSourceKeyOwner(agentId, source);
        if (!sourceKeyOwner) {
            return externalSessionsError('invalid_request', 'external_session_source_invalid') satisfies ExternalSessionsCandidatesListResponse;
        }
        const qualifiedIdentity = buildLinkedExternalSessionQualifiedIdentityV1({
            agent: currentAgent.identity,
            sourceKind: source.kind,
        });
        const autoLinkPolicyScopeV1 = {
            qualifiedIdentity,
            sourcePolicyId: deriveExternalSessionsAutoLinkSourcePolicyIdV1({
                machineId: parsed.data.machineId,
                qualifiedIdentity,
                canonicalResolvedSourceKey: sourceKeyOwner.sourceKey,
            }),
        };
        const candidates = await annotateExternalSessionCandidates({
            credentials,
            machineId: parsed.data.machineId,
            agentId,
            source,
            candidates: res.candidates,
            sourceKeyOwner,
        });
        logger.debug('[externalSessions.actions.candidates] list finished', {
            agentId,
            elapsedMs: Date.now() - startedAtMs,
            searchTermLength: typeof searchTerm === 'string' ? searchTerm.trim().length : 0,
            searchMode: searchMode ?? 'default',
            cursorPresent: Boolean(cursor),
            limit,
            returnedCandidates: candidates.length,
            hasNextCursor: Boolean(res.nextCursor),
            searchIncomplete: Boolean(res.searchIncomplete),
            preparation: res.preparation?.kind,
            preparationScanned: res.preparation?.scanned,
            heapDeltaBytes: process.memoryUsage().heapUsed - startMemory.heapUsed,
            rssBytes: process.memoryUsage().rss,
        });
        return {
            ok: true,
            candidates: [...candidates],
            nextCursor: res.nextCursor,
            ...(res.searchIncomplete ? { searchIncomplete: true } : {}),
            ...(res.preparation ? { preparation: res.preparation } : {}),
            autoLinkPolicyScopeV1,
        } satisfies ExternalSessionsCandidatesListResponse;
    } catch (error) {
        const providerFailure = mapExternalSessionProviderFailureToExternalSessionsError(error);
        if (providerFailure) return providerFailure satisfies ExternalSessionsCandidatesListResponse;
        return internalErrorResponse(
            'external_sessions_candidates_list',
            error,
            'external_sessions_candidates_list_failed',
        ) satisfies ExternalSessionsCandidatesListResponse;
    }
}

export async function executeExternalSessionLinkEnsureAction(
    raw: unknown,
    options: Readonly<{
        expectedSourceKey?: string;
        shouldCommit?: () => boolean;
        indexedTagLookupProof?: ExternalSessionIndexedTagLookupProof;
        requireIndexedTagLookup?: boolean;
        signal?: AbortSignal;
        deadlineAtMs?: number;
    }> = {},
): Promise<ExternalSessionLinkEnsureResponse> {
    const parsed = ExternalSessionLinkEnsureRequestSchema.safeParse(raw);
    if (!parsed.success) return externalSessionsError('invalid_request') satisfies ExternalSessionLinkEnsureResponse;
    let validatedSource: Awaited<ReturnType<typeof validateExternalMachineSource>>;
    try {
        validatedSource = await validateExternalMachineSource({
            agentId: parsed.data.agentId,
            source: parsed.data.source,
            env: process.env,
        });
    } catch (error) {
        return internalErrorResponse(
            'external_session_link_ensure.validate_source',
            error,
            'external_session_link_ensure_failed',
        ) satisfies ExternalSessionLinkEnsureResponse;
    }
    if (!validatedSource.ok) {
        return externalSessionsError(validatedSource.errorCode ?? 'invalid_request', validatedSource.error) satisfies ExternalSessionLinkEnsureResponse;
    }

    const credentials = await readCredentials().catch(() => null);
    if (!credentials) {
        return externalSessionsError('agent_unavailable', 'not_authenticated') satisfies ExternalSessionLinkEnsureResponse;
    }

    try {
        const res = await ensureExternalSessionLink({
            credentials,
            machineId: parsed.data.machineId,
            agentId: parsed.data.agentId,
            remoteSessionId: parsed.data.remoteSessionId,
            linkData: parsed.data.linkData,
            codexBackendMode: parsed.data.codexBackendMode,
            runtimeDescriptor: parsed.data.runtimeDescriptorV1,
            titleHint: parsed.data.titleHint,
            directoryHint: parsed.data.directoryHint,
            source: validatedSource.source,
            ...(options.expectedSourceKey !== undefined
                ? { expectedSourceKey: options.expectedSourceKey }
                : {}),
            ...(options.shouldCommit
                ? { shouldCommit: options.shouldCommit }
                : {}),
            ...(options.indexedTagLookupProof
                ? { indexedTagLookupProof: options.indexedTagLookupProof }
                : {}),
            ...(options.requireIndexedTagLookup === true
                ? { requireIndexedTagLookup: true }
                : {}),
            ...(options.signal ? { signal: options.signal } : {}),
            ...(options.deadlineAtMs !== undefined
                ? { deadlineAtMs: options.deadlineAtMs }
                : {}),
        }, {
            resolveExternalSessionProviderOps: resolveExternalSessionSurfaceOps,
            resolveCurrentAgent: resolveCurrentExternalSessionAgentIdentity,
            resolveSourceKeyOwner: resolveExternalSessionSourceKeyOwner,
        });
        return { ok: true, sessionId: res.sessionId, created: res.created } satisfies ExternalSessionLinkEnsureResponse;
    } catch (error) {
        const providerFailure = mapExternalSessionProviderFailureToExternalSessionsError(error);
        if (providerFailure) return providerFailure satisfies ExternalSessionLinkEnsureResponse;
        return internalErrorResponse(
            'external_session_link_ensure',
            error,
            'external_session_link_ensure_failed',
        ) satisfies ExternalSessionLinkEnsureResponse;
    }
}
