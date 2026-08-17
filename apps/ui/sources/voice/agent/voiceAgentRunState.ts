import { resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';
import { DEFAULT_AGENT_ID } from '@/agents/catalog/catalog';
import type { BackendTargetRefV1 } from '@happier-dev/protocol';
import { sessionExecutionRunStop } from '@/sync/ops/sessionExecutionRuns';
import { supportsEffectiveLocalControlForSession } from '@/sync/domains/session/control/effectiveRuntimeControlSurface';
import { storage } from '@/sync/domains/state/storage';
import { findSessionListLookupSession } from '@/sync/domains/session/listing/sessionListLookupState';
import { resolveMachineForActiveServerFromState } from '@/sync/store/domains/machines/resolveMachinesForActiveServerFromState';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import {
    readPersistedVoiceConversationRuntimeState,
    resolvePersistedVoiceConversationMetadataSessionId,
    resolvePersistedDaemonConversationSessionId as resolvePersistedDaemonConversationSessionIdFromBindingPersistence,
} from '@/voice/binding/voiceConversationBindingPersistence';
import { voiceConversationBindingResolver } from '@/voice/binding/VoiceConversationBindingResolver';
import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';
import {
    clearVoiceAgentRunMetadataFromSession,
    readVoiceAgentRunMetadataFromSession,
    writeVoiceAgentRunMetadataToSession,
} from '@/voice/persistence/voiceAgentRunMetadata';

import type { VoiceAgentHandle, VoiceAgentStartParams } from './types';
import { readVoiceSessionOwnerMetadataFromState } from '@/voice/shared/readVoiceSessionOwnerMetadata';

function resolvePreferredVoiceAgentSessionFromState(sessionId: string): Readonly<{
    active?: boolean;
    presence?: 'online' | number;
    metadata?: Readonly<{ flavor?: unknown; machineId?: unknown }> | null;
}> | null {
    const state = storage.getState() as any;
    return findSessionListLookupSession(state, sessionId)?.session ?? state.sessions?.[sessionId] ?? null;
}

export function assertActiveDaemonTargetSession(sessionId: string): void {
    if (sessionId === VOICE_AGENT_GLOBAL_SESSION_ID) return;
    const state = storage.getState();
    const session: any = resolvePreferredVoiceAgentSessionFromState(sessionId);
    if (!session) return;
    const metadata = readVoiceSessionOwnerMetadataFromState(state, sessionId);
    const agentId = resolveAgentIdFromSessionMetadata(metadata) ?? DEFAULT_AGENT_ID;
    if (!supportsEffectiveLocalControlForSession({
        agentId,
        metadata,
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
    const machineId = normalizeNonEmptyString(metadata?.machineId);
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
        voiceConversationBindingResolver.resolveByControlSessionId({ controlSessionId })?.conversationSessionId ?? null,
    );
}

function isReusableDaemonConversationSessionId(sessionId: string | null): sessionId is string {
    if (!sessionId) return false;
    const session: any = resolvePreferredVoiceAgentSessionFromState(sessionId);
    if (session?.active !== true) return false;

    const machineId = normalizeNonEmptyString(
        readVoiceSessionOwnerMetadataFromState(storage.getState() as any, sessionId)?.machineId,
    );
    if (!machineId) return true;

    const machine: any = resolveMachineForActiveServerFromState(storage.getState(), machineId);
    if (!machine) return false;

    return isMachineOnline(machine);
}

export function resolveBoundTargetSessionId(sessionId: string): string | null {
    return normalizeNonEmptyString(
        voiceConversationBindingResolver.resolveByControlSessionId({ controlSessionId: sessionId })?.targetSessionId
        ?? voiceConversationBindingResolver.resolveByConversationSessionId({ conversationSessionId: sessionId })?.targetSessionId
        ?? null,
    );
}

export function resolvePersistedDaemonConversationSessionId(): string | null {
    const persistedConversationSessionId = resolvePersistedDaemonConversationSessionIdFromBindingPersistence();
    return isReusableDaemonConversationSessionId(persistedConversationSessionId) ? persistedConversationSessionId : null;
}

export function resolveVoiceRunMetadataSessionId(
    managedSessionId: string,
    backend: 'daemon',
    conversationSessionId?: string | null,
): string | null {
    if (backend !== 'daemon') return null;
    return normalizeNonEmptyString(
        resolvePersistedVoiceConversationMetadataSessionId({
            managedSessionId,
            conversationSessionId,
        }) ?? null,
    );
}

export async function persistVoiceAgentRunMetadata(
    metadataSessionId: string | null,
    params: Readonly<{
        runId: string;
        backendTarget: BackendTargetRefV1;
        resumeHandle: VoiceAgentStartParams['resumeHandle'];
        welcomedEpoch?: number;
    }>,
): Promise<void> {
    if (!metadataSessionId) return;
    await writeVoiceAgentRunMetadataToSession({
        sessionId: metadataSessionId,
        runId: params.runId,
        backendTarget: params.backendTarget,
        resumeHandle: params.resumeHandle ?? null,
        updatedAtMs: Date.now(),
        ...(typeof params.welcomedEpoch === 'number' ? { welcomedEpoch: params.welcomedEpoch } : {}),
    });
}

export async function persistVoiceAgentWelcomedEpoch(
    metadataSessionId: string | null,
    welcomedEpoch: number,
): Promise<void> {
    if (!metadataSessionId) return;
    const existing = readVoiceAgentRunMetadataFromSession({ sessionId: metadataSessionId });
    if (!existing?.backendTarget) return;
    await writeVoiceAgentRunMetadataToSession({
        sessionId: metadataSessionId,
        runId: existing.runId,
        backendTarget: existing.backendTarget,
        resumeHandle: existing.resumeHandle ?? null,
        updatedAtMs: Date.now(),
        welcomedEpoch,
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
    const persistedRuntimeState = readPersistedVoiceConversationRuntimeState({
        managedSessionId: sessionId,
        conversationSessionId: handle?.rpcSessionId,
    });
    const metadataSessionId = persistedRuntimeState?.metadataSessionId ?? null;
    const persistedRunMeta = persistedRuntimeState?.runMetadata ?? null;
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
