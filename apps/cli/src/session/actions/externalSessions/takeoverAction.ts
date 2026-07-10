import {
    ExternalSessionTakeoverInputV1Schema,
    removeLinkedExternalSessionMetadataV1,
    type ExternalSessionTakeoverErrorCodeV1,
    type ExternalSessionTakeoverResultV1,
} from '@happier-dev/protocol/sessions';

import { importExternalSessionTranscript } from '@/api/session/external/import/importExternalSessionTranscript';
import { validateDirectMachineSource } from '@/api/session/external/security/validateDirectMachineSource';
import { findTrustedExternalSessionOwner } from '@/api/session/external/takeover/findTrustedExternalSessionOwner';
import { loadLinkedExternalSession } from '@/api/session/external/takeover/loadLinkedExternalSession';
import { resolveDirectTakeoverSpawnOptions } from '@/api/session/external/takeover/resolveDirectTakeoverSpawnOptions';
import { listSessionMarkers } from '@/daemon/sessionRegistry';
import { readCredentials } from '@/persistence';
import { updateSessionMetadataWithRetry } from '@/session/metadata/updateSessionMetadataWithRetry';

import type { ExternalSessionActionContext, ExternalSessionTakeoverActionInput } from './externalSessionActionContext';
import { isPidAlive } from './processLiveness';
import { logExternalSessionsInternalError } from './responseErrors';

function mapLinkedExternalSessionErrorToExternalTakeoverError(
    errorCode: 'invalid_request' | 'agent_unavailable',
    error: string,
): ExternalSessionTakeoverResultV1 {
    const externalErrorCode: ExternalSessionTakeoverErrorCodeV1 =
        errorCode === 'invalid_request' && error === 'session_not_found'
            ? 'session_not_found'
            : 'invalid_external_source';
    return { ok: false, errorCode: externalErrorCode, error };
}

export async function executeExternalSessionTakeoverAction(
    raw: unknown,
    context: ExternalSessionActionContext,
): Promise<ExternalSessionTakeoverResultV1> {
    const parsed = ExternalSessionTakeoverInputV1Schema.safeParse(raw);
    if (!parsed.success) {
        return { ok: false, errorCode: 'takeover_not_available', error: 'invalid_request' };
    }
    const actionInput = parsed.data as ExternalSessionTakeoverActionInput;
    const machineId = typeof actionInput.machineId === 'string' && actionInput.machineId.trim().length > 0
        ? actionInput.machineId.trim()
        : null;
    if (!machineId) {
        return { ok: false, errorCode: 'machine_offline', error: 'machine_id_required' };
    }
    if (actionInput.targetRuntimeMode !== 'terminal') {
        return { ok: false, errorCode: 'capability_unsupported', error: 'target_runtime_mode_unsupported' };
    }
    if (!context.spawnSession || !context.stopSession) {
        return { ok: false, errorCode: 'capability_unsupported', error: 'takeover_not_supported' };
    }
    context.takeoverReadiness.invalidate(actionInput.linkedSessionId);

    const credentials = await readCredentials().catch(() => null);
    if (!credentials) {
        return { ok: false, errorCode: 'takeover_not_available', error: 'not_authenticated' };
    }

    const linked = await loadLinkedExternalSession({
        credentials,
        sessionId: actionInput.linkedSessionId,
        machineId,
    });
    if (!linked.ok) {
        return mapLinkedExternalSessionErrorToExternalTakeoverError(linked.errorCode, linked.error);
    }
    let validatedSource: Awaited<ReturnType<typeof validateDirectMachineSource>>;
    try {
        validatedSource = await validateDirectMachineSource({
            agentId: linked.session.agentId,
            source: linked.session.source,
            env: process.env,
        });
    } catch (error) {
        logExternalSessionsInternalError('external_session_takeover.validate_source', error);
        return { ok: false, errorCode: 'invalid_external_source', error: 'external_session_takeover_failed' };
    }
    if (!validatedSource.ok) {
        return { ok: false, errorCode: 'invalid_external_source', error: validatedSource.error };
    }
    const validatedLinkedSession = {
        ...linked.session,
        source: validatedSource.source,
    };

    const markers = await listSessionMarkers().catch(() => []);
    const trustedOwner = findTrustedExternalSessionOwner({
        markers,
        agentId: validatedLinkedSession.agentId,
        remoteSessionId: validatedLinkedSession.remoteSessionId,
        isPidAlive,
    });

    if (trustedOwner && trustedOwner.happySessionId === actionInput.linkedSessionId && actionInput.storageMode === 'external-linked') {
        return {
            ok: true,
            sessionId: actionInput.linkedSessionId,
            targetRuntimeMode: actionInput.targetRuntimeMode,
            storageMode: actionInput.storageMode,
            converted: false,
        };
    }

    if (trustedOwner && trustedOwner.happySessionId !== actionInput.linkedSessionId && actionInput.forceStop !== true) {
        return {
            ok: false,
            errorCode: 'force_stop_required',
            error: 'force_stop_required',
            trustedPid: trustedOwner.pid,
        };
    }

    if (trustedOwner && trustedOwner.happySessionId !== actionInput.linkedSessionId && actionInput.forceStop === true) {
        const stopped = await context.stopSession(trustedOwner.happySessionId);
        if (!stopped) {
            return { ok: false, errorCode: 'spawn_failed', error: 'trusted_process_stop_failed' };
        }
    }

    const spawnOptions = await resolveDirectTakeoverSpawnOptions({
        linked: validatedLinkedSession,
        sessionId: actionInput.linkedSessionId,
    });
    if (!spawnOptions) {
        return { ok: false, errorCode: 'takeover_not_available', error: 'external_session_directory_unavailable' };
    }

    if (actionInput.storageMode === 'persisted') {
        try {
            await importExternalSessionTranscript({
                linked: validatedLinkedSession,
                credentials,
                sessionId: actionInput.linkedSessionId,
            });
        } catch (error) {
            logExternalSessionsInternalError('external_session_takeover.import_transcript', error);
            return { ok: false, errorCode: 'transcript_import_failed', error: 'external_session_import_failed' };
        }
    }

    const spawnResult = await context.spawnSession({
        ...spawnOptions,
        ...(actionInput.storageMode === 'persisted' ? { transcriptStorage: 'persisted' as const } : {}),
    });
    if (spawnResult.type !== 'success') {
        return {
            ok: false,
            errorCode: 'spawn_failed',
            error: spawnResult.type === 'error' ? spawnResult.errorMessage : 'directory_approval_required',
        };
    }

    if (actionInput.storageMode === 'persisted') {
        try {
            await updateSessionMetadataWithRetry({
                token: credentials.token,
                credentials,
                sessionId: actionInput.linkedSessionId,
                rawSession: linked.session.rawSession,
                updater: (current) => {
                    const next = removeLinkedExternalSessionMetadataV1(current);
                    if (typeof next.path !== 'string' || !next.path.trim()) {
                        next.path = spawnOptions.directory;
                    }
                    next.externalHistoryImportV1 = {
                        v: 1,
                        agentId: validatedLinkedSession.agentId,
                        remoteSessionId: validatedLinkedSession.remoteSessionId,
                        importedAtMs: Date.now(),
                        source: validatedLinkedSession.source,
                    };
                    return next;
                },
            });
        } catch (error) {
            logExternalSessionsInternalError('external_session_takeover.persist_metadata', error);
            return { ok: false, errorCode: 'transcript_import_failed', error: 'external_session_persist_failed' };
        }
    }

    return {
        ok: true,
        sessionId: actionInput.linkedSessionId,
        targetRuntimeMode: actionInput.targetRuntimeMode,
        storageMode: actionInput.storageMode,
        converted: actionInput.storageMode === 'persisted',
    };
}
