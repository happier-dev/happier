import {
    ExternalSessionLinkEnsureRequestSchema,
    ExternalSessionsCandidatesListRequestSchema,
    normalizeCodexBackendMode,
    type ExternalSessionLinkEnsureResponse,
    type ExternalSessionsCandidatesListResponse,
} from '@happier-dev/protocol';

import { ensureExternalSessionLink } from '@/api/session/external/linking/ensureExternalSessionLink';
import { validateDirectMachineSource } from '@/api/session/external/security/validateDirectMachineSource';
import { readCredentials } from '@/persistence';
import { logger } from '@/utils/logger';

import { resolveDefaultCandidatesLimit } from './actionConfiguration';
import { resolveExternalSessionSurfaceOps } from './providerOpsResolution';
import { externalSessionsError, internalErrorResponse } from './responseErrors';

export async function executeExternalSessionCandidatesListAction(
    raw: unknown,
): Promise<ExternalSessionsCandidatesListResponse> {
    const parsed = ExternalSessionsCandidatesListRequestSchema.safeParse(raw);
    if (!parsed.success) return externalSessionsError('invalid_request') satisfies ExternalSessionsCandidatesListResponse;
    try {
        const validatedSource = await validateDirectMachineSource({
            providerId: parsed.data.providerId,
            source: parsed.data.source,
            env: process.env,
        });
        if (!validatedSource.ok) {
            return externalSessionsError('invalid_request', validatedSource.error) satisfies ExternalSessionsCandidatesListResponse;
        }
        const { providerId, cursor, searchTerm, searchMode } = parsed.data;
        const source = validatedSource.source;
        const limit = parsed.data.limit ?? resolveDefaultCandidatesLimit();
        const startedAtMs = Date.now();
        const startMemory = process.memoryUsage();
        const providerOps = await resolveExternalSessionSurfaceOps(providerId);
        if (!providerOps.listCandidates) {
            return externalSessionsError('provider_unavailable', 'candidates_list_not_supported') satisfies ExternalSessionsCandidatesListResponse;
        }
        const res = await providerOps.listCandidates({ source, cursor, limit, searchTerm, searchMode });
        logger.debug('[externalSessions.actions.candidates] list finished', {
            providerId,
            elapsedMs: Date.now() - startedAtMs,
            searchTermLength: typeof searchTerm === 'string' ? searchTerm.trim().length : 0,
            searchMode: searchMode ?? 'default',
            cursorPresent: Boolean(cursor),
            limit,
            returnedCandidates: res.candidates.length,
            hasNextCursor: Boolean(res.nextCursor),
            searchIncomplete: Boolean(res.searchIncomplete),
            heapDeltaBytes: process.memoryUsage().heapUsed - startMemory.heapUsed,
            rssBytes: process.memoryUsage().rss,
        });
        return {
            ok: true,
            candidates: [...res.candidates],
            nextCursor: res.nextCursor,
            ...(res.searchIncomplete ? { searchIncomplete: true } : {}),
        } satisfies ExternalSessionsCandidatesListResponse;
    } catch (error) {
        return internalErrorResponse(
            'external_sessions_candidates_list',
            error,
            'external_sessions_candidates_list_failed',
        ) satisfies ExternalSessionsCandidatesListResponse;
    }
}

export async function executeExternalSessionLinkEnsureAction(
    raw: unknown,
): Promise<ExternalSessionLinkEnsureResponse> {
    const parsed = ExternalSessionLinkEnsureRequestSchema.safeParse(raw);
    if (!parsed.success) return externalSessionsError('invalid_request') satisfies ExternalSessionLinkEnsureResponse;
    let validatedSource: Awaited<ReturnType<typeof validateDirectMachineSource>>;
    try {
        validatedSource = await validateDirectMachineSource({
            providerId: parsed.data.providerId,
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
        return externalSessionsError('invalid_request', validatedSource.error) satisfies ExternalSessionLinkEnsureResponse;
    }

    const credentials = await readCredentials().catch(() => null);
    if (!credentials) {
        return externalSessionsError('provider_unavailable', 'not_authenticated') satisfies ExternalSessionLinkEnsureResponse;
    }

    try {
        const codexBackendMode = normalizeCodexBackendMode(parsed.data.codexBackendMode) ?? undefined;
        const res = await ensureExternalSessionLink({
            credentials,
            machineId: parsed.data.machineId,
            providerId: parsed.data.providerId,
            remoteSessionId: parsed.data.remoteSessionId,
            codexBackendMode,
            runtimeDescriptor: parsed.data.runtimeDescriptorV1,
            titleHint: parsed.data.titleHint,
            directoryHint: parsed.data.directoryHint,
            source: validatedSource.source,
        });
        return { ok: true, sessionId: res.sessionId, created: res.created } satisfies ExternalSessionLinkEnsureResponse;
    } catch (error) {
        return internalErrorResponse(
            'external_session_link_ensure',
            error,
            'external_session_link_ensure_failed',
        ) satisfies ExternalSessionLinkEnsureResponse;
    }
}
