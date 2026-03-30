import { DEFAULT_AGENT_ID, resolveAgentIdFromFlavor } from '@/agents/catalog/catalog';
import type { BackendTargetRefV1 } from '@happier-dev/protocol';
import { sessionExecutionRunStop } from '@/sync/ops/sessionExecutionRuns';
import { supportsEffectiveLocalControlForSession } from '@/sync/domains/session/control/effectiveRuntimeControlSurface';
import { storage } from '@/sync/domains/state/storage';
import { resolveMachineForActiveServerFromState } from '@/sync/store/domains/machines/resolveMachinesForActiveServerFromState';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';
import {
    findReusableVoiceConversationRuntimeSessionId,
    findVoiceConversationSessionId,
} from '@/voice/sessionBinding/voiceConversationSession';
import {
    resolveLatestVoiceSessionBinding,
    resolveVoiceSessionBindingByControlSessionId,
    resolveVoiceSessionBindingByConversationSessionId,
} from '@/voice/sessionBinding/resolveVoiceSessionBinding';
import {
    clearVoiceAgentRunMetadataFromSession,
    readVoiceAgentRunMetadataFromSession,
    writeVoiceAgentRunMetadataToSession,
} from '@/voice/persistence/voiceAgentRunMetadata';

import type { VoiceAgentHandle, VoiceAgentStartParams } from './types';

export function assertActiveDaemonTargetSession(sessionId: string): void {
    if (sessionId === VOICE_AGENT_GLOBAL_SESSION_ID) return;
    const state = storage.getState();
    const session: any = state.sessions?.[sessionId] ?? null;
    if (!session) return;
    const agentId = resolveAgentIdFromFlavor(session?.metadata?.flavor) ?? DEFAULT_AGENT_ID;
    if (!supportsEffectiveLocalControlForSession({
        agentId,
        metadata: session?.metadata,
        accountSettings: state.settings,
    })) {
        throw Object.assign(
            new Error('Target session provider does not support local voice control.'),
            { code: 'VOICE_AGENT_TARGET_SESSION_UNSUPPORTED' },
        );
    }
    if (session.active === false) {
        throw Object.assign(
            new Error('Target session is inactive. Resume it before starting local voice.'),
            { code: 'VOICE_AGENT_TARGET_SESSION_INACTIVE' },
        );
    }
    if (session.presence !== 'online') {
        throw Object.assign(
            new Error('Target session is offline. Reconnect it before starting local voice.'),
            { code: 'VOICE_AGENT_TARGET_SESSION_OFFLINE' },
        );
    }
    const machineId = normalizeNonEmptyString(session?.metadata?.machineId);
    const machine = machineId ? resolveMachineForActiveServerFromState(storage.getState(), machineId) : null;
    if (machine && isMachineOnline(machine) !== true) {
        throw Object.assign(
            new Error('Target machine daemon is offline. Start or reconnect the daemon before starting local voice.'),
            { code: 'VOICE_AGENT_TARGET_MACHINE_OFFLINE' },
        );
    }
}

export function resolveBoundConversationSessionId(controlSessionId: string): string | null {
    return normalizeNonEmptyString(
        resolveVoiceSessionBindingByControlSessionId({ controlSessionId })?.conversationSessionId ?? null,
    );
}

function isReusableDaemonConversationSessionId(sessionId: string | null): sessionId is string {
    if (!sessionId) return false;
    const session: any = storage.getState().sessions?.[sessionId] ?? null;
    if (session?.active !== true) return false;

    const machineId = normalizeNonEmptyString(session?.metadata?.machineId);
    if (!machineId) return true;

    const machine: any = resolveMachineForActiveServerFromState(storage.getState(), machineId);
    if (!machine) return false;

    return isMachineOnline(machine);
}

export function resolveBoundTargetSessionId(sessionId: string): string | null {
    return normalizeNonEmptyString(
        resolveVoiceSessionBindingByControlSessionId({ controlSessionId: sessionId })?.targetSessionId
        ?? resolveVoiceSessionBindingByConversationSessionId({ conversationSessionId: sessionId })?.targetSessionId
        ?? null,
    );
}

export function resolvePersistedDaemonConversationSessionId(): string | null {
    const boundConversationSessionId = resolveBoundConversationSessionId(VOICE_AGENT_GLOBAL_SESSION_ID);
    if (isReusableDaemonConversationSessionId(boundConversationSessionId)) {
        return boundConversationSessionId;
    }
    const latestBindingConversationSessionId = normalizeNonEmptyString(
        resolveLatestVoiceSessionBinding({
            adapterId: 'local_conversation',
            controlSessionIds: [VOICE_AGENT_GLOBAL_SESSION_ID],
        })?.conversationSessionId,
    );
    if (isReusableDaemonConversationSessionId(latestBindingConversationSessionId)) {
        return latestBindingConversationSessionId;
    }
    const persistedConversationSessionId =
        findReusableVoiceConversationRuntimeSessionId(storage.getState() as any)
        ?? findVoiceConversationSessionId(storage.getState() as any);
    if (isReusableDaemonConversationSessionId(persistedConversationSessionId)) {
        return persistedConversationSessionId;
    }
    return null;
}

export function resolveVoiceRunMetadataSessionId(
    managedSessionId: string,
    backend: 'daemon' | 'openai_compat',
    conversationSessionId?: string | null,
): string | null {
    if (backend !== 'daemon') return null;
    if (managedSessionId !== VOICE_AGENT_GLOBAL_SESSION_ID) return managedSessionId;
    return normalizeNonEmptyString(
        conversationSessionId
        ?? resolveBoundConversationSessionId(managedSessionId)
        ?? findVoiceConversationSessionId(storage.getState() as any)
        ?? resolvePersistedDaemonConversationSessionId(),
    );
}

export async function persistVoiceAgentRunMetadata(
    metadataSessionId: string | null,
    params: Readonly<{
        runId: string;
        backendId: string;
        backendTarget: BackendTargetRefV1;
        resumeHandle: VoiceAgentStartParams['resumeHandle'];
    }>,
): Promise<void> {
    if (!metadataSessionId) return;
    await writeVoiceAgentRunMetadataToSession({
        sessionId: metadataSessionId,
        runId: params.runId,
        backendId: params.backendId,
        backendTarget: params.backendTarget,
        resumeHandle: params.resumeHandle ?? null,
        updatedAtMs: Date.now(),
    });
}

export async function clearVoiceAgentRunMetadata(metadataSessionId: string | null): Promise<void> {
    if (!metadataSessionId) return;
    await clearVoiceAgentRunMetadataFromSession({ sessionId: metadataSessionId });
}

export async function clearStaleDaemonRunState(
    sessionId: string,
    handle: VoiceAgentHandle | null,
): Promise<void> {
    const metadataSessionId = resolveVoiceRunMetadataSessionId(sessionId, 'daemon', handle?.rpcSessionId);
    const persistedRunMeta = metadataSessionId
        ? readVoiceAgentRunMetadataFromSession({ sessionId: metadataSessionId })
        : null;
    const staleRunId = normalizeNonEmptyString(handle?.voiceAgentId ?? persistedRunMeta?.runId ?? null);
    const staleRpcSessionId =
        normalizeNonEmptyString(handle?.rpcSessionId)
        ?? normalizeNonEmptyString(metadataSessionId)
        ?? (sessionId === VOICE_AGENT_GLOBAL_SESSION_ID ? resolvePersistedDaemonConversationSessionId() : sessionId)
        ?? sessionId;

    if (staleRunId) {
        await sessionExecutionRunStop(staleRpcSessionId, { runId: staleRunId }).catch(() => {});
    }
    await clearVoiceAgentRunMetadata(metadataSessionId).catch(() => {});
}
