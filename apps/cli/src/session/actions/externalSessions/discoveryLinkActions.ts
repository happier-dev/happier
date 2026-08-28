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
import { validateExternalMachineSource } from '@/api/session/external/security/validateExternalMachineSource';
import { readStoredCredentials } from '@/persistence';
import { configuration } from '@/configuration';
import { logger } from '@/utils/logger';
import { EXTERNAL_SESSIONS_INVOCATION_POLICY } from '@/session/external/agentExternalSessionsInvocation';

import { annotateExternalSessionCandidates } from './candidateAnnotations';
import {
    executeExternalSessionCandidateQuery,
    hydrateExternalSessionCandidateThroughAgentSource,
    isExternalSessionCandidateIndexCursorResetError,
} from './candidateQuery';
import {
    externalSessionsError,
    internalErrorResponse,
    mapExternalSessionProviderFailureToExternalSessionsError,
} from './responseErrors';

export async function executeExternalSessionCandidatesListAction(
    raw: unknown,
    options: Readonly<{ signal?: AbortSignal }> = {},
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
        const limit = parsed.data.limit
            ?? EXTERNAL_SESSIONS_INVOCATION_POLICY.listCandidates.maxItems;
        const startedAtMs = Date.now();
        const startMemory = process.memoryUsage();
        const providerOps = validatedSource.providerOps;
        if (!providerOps.listCandidates) {
            return externalSessionsError('agent_unavailable', 'candidates_list_not_supported') satisfies ExternalSessionsCandidatesListResponse;
        }
        const currentAgent = validatedSource.currentAgent;
        const res = await executeExternalSessionCandidateQuery({
            activeServerDir: configuration.activeServerDir,
            agentIdentity: currentAgent.identity,
            agentRuntimeGeneration: validatedSource.agentRuntimeGeneration,
            source,
            ...(cursor ? { cursor } : {}),
            limit,
            ...(searchTerm ? { searchTerm } : {}),
            ...(searchMode ? { searchMode } : {}),
            ...(options.signal ? { signal: options.signal } : {}),
            listCandidates: async (request) => await providerOps.listCandidates!({
                source,
                ...request,
                ...(options.signal ? { signal: options.signal } : {}),
            }),
            hydrateCandidate: async (candidate) => (
                await hydrateExternalSessionCandidateThroughAgentSource({
                    source,
                    candidate,
                    providerOps,
                    ...(options.signal ? { signal: options.signal } : {}),
                })
            ),
        });
        const credentials = await readStoredCredentials().catch(() => null);
        if (!credentials) {
            return externalSessionsError('agent_unavailable', 'not_authenticated') satisfies ExternalSessionsCandidatesListResponse;
        }
        const sourceKeyOwner = validatedSource.sourceKeyOwner;
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
        /**
         * Link/import annotation retrieves Account encryption currentness and scans the
         * bounded active and archived Session pages. A preparing index republishes the
         * same partial prefix on every progress round-trip — hundreds of them for one
         * browse open — so annotating a partial page repeats that whole retrieval for
         * rows that are already presented as partial and carry no title either. It runs
         * for a complete generation only; `link.ensure` is idempotent, so opening an
         * already-linked partial row still resolves to its existing Session.
         */
        const annotationResult = res.preparation
            ? {
                candidates: res.candidates,
                // A partial candidate index has no matching complete Session
                // annotation pass. Its missing positive link/import projections
                // are therefore intentionally typed as incomplete rather than
                // interpreted as negative facts by a consumer.
                annotationsIncomplete: res.candidates.length > 0,
            }
            : await annotateExternalSessionCandidates({
                credentials,
                machineId: parsed.data.machineId,
                agentId,
                source,
                candidates: res.candidates,
                sourceKeyOwner,
                ...(options.signal ? { signal: options.signal } : {}),
            });
        logger.debug('[externalSessions.actions.candidates] list finished', {
            agentId,
            elapsedMs: Date.now() - startedAtMs,
            searchTermLength: typeof searchTerm === 'string' ? searchTerm.trim().length : 0,
            searchMode: searchMode ?? 'default',
            cursorPresent: Boolean(cursor),
            limit,
            returnedCandidates: annotationResult.candidates.length,
            hasNextCursor: Boolean(res.nextCursor),
            searchIncomplete: Boolean(res.searchIncomplete),
            annotationsIncomplete: annotationResult.annotationsIncomplete,
            preparation: res.preparation?.kind,
            preparationScanned: res.preparation?.scanned,
            heapDeltaBytes: process.memoryUsage().heapUsed - startMemory.heapUsed,
            rssBytes: process.memoryUsage().rss,
        });
        return {
            ok: true,
            candidates: [...annotationResult.candidates],
            nextCursor: res.nextCursor,
            ...(res.searchIncomplete ? { searchIncomplete: true } : {}),
            ...(annotationResult.annotationsIncomplete ? { annotationsIncomplete: true } : {}),
            ...(res.preparation ? { preparation: res.preparation } : {}),
            autoLinkPolicyScopeV1,
        } satisfies ExternalSessionsCandidatesListResponse;
    } catch (error) {
        /**
         * A dead continuation is a listing outcome, not a request error: the only
         * recovery is to drop it and rebuild from the root, so answering with a
         * retryable-looking failure would leave the caller re-sending a cursor that
         * can never resolve. It is reported as an empty typed reset instead, which
         * keeps the rows the caller already has while telling it to start over.
         */
        if (isExternalSessionCandidateIndexCursorResetError(error)) {
            return {
                ok: true,
                candidates: [],
                nextCursor: null,
                cursorReset: true,
            } satisfies ExternalSessionsCandidatesListResponse;
        }
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
        const providerFailure = mapExternalSessionProviderFailureToExternalSessionsError(error);
        if (providerFailure) return providerFailure satisfies ExternalSessionLinkEnsureResponse;
        return internalErrorResponse(
            'external_session_link_ensure.validate_source',
            error,
            'external_session_link_ensure_failed',
        ) satisfies ExternalSessionLinkEnsureResponse;
    }
    if (!validatedSource.ok) {
        return externalSessionsError(validatedSource.errorCode ?? 'invalid_request', validatedSource.error) satisfies ExternalSessionLinkEnsureResponse;
    }

    const credentials = await readStoredCredentials().catch(() => null);
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
            resolveExternalSessionProviderOps: async () => validatedSource.providerOps,
            resolveCurrentAgent: async () => validatedSource.currentAgent,
            resolveSourceKeyOwner: async (_agentId, source) => {
                const sourceKey = validatedSource.sourceKeyOwner.resolveSourceKey(source);
                if (!sourceKey) return null;
                return sourceKey === validatedSource.sourceKeyOwner.sourceKey
                    ? validatedSource.sourceKeyOwner
                    : Object.freeze({
                        ...validatedSource.sourceKeyOwner,
                        sourceKey,
                    });
            },
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
