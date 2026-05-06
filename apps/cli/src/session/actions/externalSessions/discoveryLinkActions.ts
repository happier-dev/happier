import {
    DirectSessionLinkEnsureRequestSchema,
    DirectSessionsCandidatesListRequestSchema,
    normalizeCodexBackendMode,
    type DirectSessionLinkEnsureResponse,
    type DirectSessionsCandidatesListResponse,
} from '@happier-dev/protocol';

import { ensureDirectSessionLink } from '@/api/session/external/linking/ensureDirectSessionLink';
import { validateDirectMachineSource } from '@/api/session/external/security/validateDirectMachineSource';
import { readCredentials } from '@/persistence';

import { resolveDefaultCandidatesLimit } from './actionConfiguration';
import { getDirectSessionProviderOps } from './providerOpsResolution';
import { directSessionsError, internalErrorResponse } from './responseErrors';

export async function executeExternalSessionCandidatesListAction(
    raw: unknown,
): Promise<DirectSessionsCandidatesListResponse> {
    const parsed = DirectSessionsCandidatesListRequestSchema.safeParse(raw);
    if (!parsed.success) return directSessionsError('invalid_request') satisfies DirectSessionsCandidatesListResponse;
    try {
        const validatedSource = await validateDirectMachineSource({
            providerId: parsed.data.providerId,
            source: parsed.data.source,
            env: process.env,
        });
        if (!validatedSource.ok) {
            return directSessionsError('invalid_request', validatedSource.error) satisfies DirectSessionsCandidatesListResponse;
        }
        const { providerId, cursor, searchTerm } = parsed.data;
        const source = validatedSource.source;
        const limit = parsed.data.limit ?? resolveDefaultCandidatesLimit();
        const res = await (await getDirectSessionProviderOps(providerId)).listCandidates({ source, cursor, limit, searchTerm });
        return { ok: true, candidates: res.candidates, nextCursor: res.nextCursor } satisfies DirectSessionsCandidatesListResponse;
    } catch (error) {
        return internalErrorResponse(
            'direct_sessions_candidates_list',
            error,
            'direct_sessions_candidates_list_failed',
        ) satisfies DirectSessionsCandidatesListResponse;
    }
}

export async function executeExternalSessionLinkEnsureAction(
    raw: unknown,
): Promise<DirectSessionLinkEnsureResponse> {
    const parsed = DirectSessionLinkEnsureRequestSchema.safeParse(raw);
    if (!parsed.success) return directSessionsError('invalid_request') satisfies DirectSessionLinkEnsureResponse;
    let validatedSource: Awaited<ReturnType<typeof validateDirectMachineSource>>;
    try {
        validatedSource = await validateDirectMachineSource({
            providerId: parsed.data.providerId,
            source: parsed.data.source,
            env: process.env,
        });
    } catch (error) {
        return internalErrorResponse(
            'direct_session_link_ensure.validate_source',
            error,
            'direct_session_link_ensure_failed',
        ) satisfies DirectSessionLinkEnsureResponse;
    }
    if (!validatedSource.ok) {
        return directSessionsError('invalid_request', validatedSource.error) satisfies DirectSessionLinkEnsureResponse;
    }

    const credentials = await readCredentials().catch(() => null);
    if (!credentials) {
        return directSessionsError('provider_unavailable', 'not_authenticated') satisfies DirectSessionLinkEnsureResponse;
    }

    try {
        const codexBackendMode = normalizeCodexBackendMode(parsed.data.codexBackendMode) ?? undefined;
        const res = await ensureDirectSessionLink({
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
        return { ok: true, sessionId: res.sessionId, created: res.created } satisfies DirectSessionLinkEnsureResponse;
    } catch (error) {
        return internalErrorResponse(
            'direct_session_link_ensure',
            error,
            'direct_session_link_ensure_failed',
        ) satisfies DirectSessionLinkEnsureResponse;
    }
}
