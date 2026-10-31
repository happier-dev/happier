import type { BackendTargetRefV1 } from '@happier-dev/protocol';
import { sessionExecutionRunStop } from '@/sync/ops/sessionExecutionRuns';
import { resolveSessionAddressFromLocalState } from '@/sync/domains/session/resolveSessionAddressFromLocalState';
import { normalizeSessionAddress, type SessionAddress } from '@/sync/domains/session/sessionAddress';
import { storage } from '@/sync/domains/state/storage';
import { findSessionListLookupSession } from '@/sync/domains/session/listing/sessionListLookupState';
import { resolveMachineForActiveServerFromState } from '@/sync/store/domains/machines/resolveMachinesForActiveServerFromState';
import { isMachineReachable, resolveMachineReachability } from '@/sync/domains/machines/reachability/machineReachability';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
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
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { captureActiveServerAccountScopeLifetime, selectActiveServerAccountScopeForServer } from '@/sync/domains/scope/activeServerAccountScope';

export type VoiceAgentSessionState = Readonly<{
    id?: string;
    serverId?: string;
    active?: boolean;
    presence?: string | number | null;
    modelMode?: unknown;
    metadataLayoutVersion?: number;
    metadata?: unknown;
    ownerMetadataView?: unknown;
}>;

/**
 * Resolves Voice's Session facts through one qualified Home-aware owner.
 * Bare IDs are accepted only when the local state has one unambiguous address;
 * direct hydrated state is used as a compatibility fallback only after its Home
 * matches that qualified address.
 */
export function resolveVoiceAgentSessionFromState(target: SessionAddress | string): VoiceAgentSessionState | null {
    const state = storage.getState() as any;
    const address = typeof target === 'string'
        ? resolveSessionAddressFromLocalState(state, target)
        : normalizeSessionAddress(target.serverId, target.sessionId);
    if (!address) return null;

    const listSession = findSessionListLookupSession(state, address)?.session;
    if (listSession) return listSession as VoiceAgentSessionState;

    const directSession = state.sessions?.[address.sessionId] as VoiceAgentSessionState | null | undefined;
    if (!directSession) return null;
    const directServerId = directSession.serverId ?? getActiveServerSnapshot().serverId;
    return areServerProfileIdentifiersEquivalent(directServerId, address.serverId)
        ? directSession
        : null;
}

export async function assertActiveDaemonTargetSession(target: SessionAddress | string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const sessionId = typeof target === 'string' ? target : target.sessionId;
    if (sessionId === VOICE_AGENT_GLOBAL_SESSION_ID) return;
    const state = storage.getState();
    const address = typeof target === 'string'
        ? resolveSessionAddressFromLocalState(state as any, sessionId)
        : normalizeSessionAddress(target.serverId, target.sessionId);
    const lookupTarget = address ?? sessionId;
    const session = resolveVoiceAgentSessionFromState(lookupTarget);
    if (!session) return;
    const metadata = readVoiceSessionOwnerMetadataFromState(state, lookupTarget);
    const machineId = normalizeNonEmptyString(metadata?.machineId);
    // The coding target supplies context, not a terminal attachment. The
    // carrier's Execution Run owner admits the selected Voice Agent runtime.
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
    const machine = machineId ? resolveMachineForActiveServerFromState(storage.getState(), machineId) : null;
    const reachability = machine ? resolveMachineReachability(selectActiveServerAccountScopeForServer(state.profileScope, address?.serverId ?? null), machine) : null;
    if (reachability && reachability !== 'reachable') {
        throw Object.assign(
            new Error('Target machine is not currently reachable.'),
            { code: reachability === 'unknown' ? 'VOICE_AGENT_TARGET_MACHINE_UNOBSERVED' : 'VOICE_AGENT_TARGET_MACHINE_OFFLINE' },
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
    const session = resolveVoiceAgentSessionFromState(sessionId);
    if (session?.active !== true) return false;

    const machineId = normalizeNonEmptyString(
        readVoiceSessionOwnerMetadataFromState(storage.getState() as any, sessionId)?.machineId,
    );
    if (!machineId) return true;

    const machine: any = resolveMachineForActiveServerFromState(storage.getState(), machineId);
    if (!machine) return false;

    return isMachineReachable(captureActiveServerAccountScopeLifetime()?.scope, machine);
}

/** The bound target keeps its Home: one resolution owner, projected for bare-id callers below. */
export function resolveBoundTargetSessionAddress(sessionId: string): SessionAddress | null {
    const address = voiceConversationBindingResolver.resolveByControlSessionId({ controlSessionId: sessionId })?.targetSessionAddress
        ?? voiceConversationBindingResolver.resolveByConversationSessionId({ conversationSessionId: sessionId })?.targetSessionAddress
        ?? null;
    return address ? normalizeSessionAddress(address.serverId, address.sessionId) : null;
}

export function resolveBoundTargetSessionId(sessionId: string): string | null {
    return resolveBoundTargetSessionAddress(sessionId)?.sessionId ?? null;
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
        accountLifetime?: ServerAccountScopeLifetime;
    }>,
): Promise<void> {
    if (!metadataSessionId) return;
    await writeVoiceAgentRunMetadataToSession({
        sessionId: metadataSessionId,
        runId: params.runId,
        backendTarget: params.backendTarget,
        resumeHandle: params.resumeHandle ?? null,
        updatedAtMs: Date.now(),
        accountLifetime: params.accountLifetime,
        ...(typeof params.welcomedEpoch === 'number' ? { welcomedEpoch: params.welcomedEpoch } : {}),
    });
}

export async function persistVoiceAgentWelcomedEpoch(
    metadataSessionId: string | null,
    welcomedEpoch: number,
    accountLifetime?: ServerAccountScopeLifetime,
): Promise<void> {
    if (!metadataSessionId) return;
    if (accountLifetime && !accountLifetime.isCurrent()) return;
    const existing = readVoiceAgentRunMetadataFromSession({ sessionId: metadataSessionId, serverId: accountLifetime?.scope.serverId });
    if (!existing?.backendTarget) return;
    await writeVoiceAgentRunMetadataToSession({
        sessionId: metadataSessionId,
        runId: existing.runId,
        backendTarget: existing.backendTarget,
        resumeHandle: existing.resumeHandle ?? null,
        updatedAtMs: Date.now(),
        welcomedEpoch,
        accountLifetime,
    });
}

export async function clearVoiceAgentRunMetadata(metadataSessionId: string | null, accountLifetime?: ServerAccountScopeLifetime): Promise<void> {
    if (!metadataSessionId) return;
    await clearVoiceAgentRunMetadataFromSession({ sessionId: metadataSessionId, accountLifetime });
}

export async function clearStaleDaemonRunState(
    sessionId: string,
    handle: VoiceAgentHandle | null,
): Promise<void> {
    const accountLifetime = handle?.accountLifetime ?? captureActiveServerAccountScopeLifetime();
    if (!accountLifetime) return;
    const persistedRuntimeState = readPersistedVoiceConversationRuntimeState({
        managedSessionId: sessionId,
        conversationSessionId: handle?.rpcSessionId,
    });
    const metadataSessionId = handle ? handle.metadataSessionId : persistedRuntimeState?.metadataSessionId ?? null;
    const persistedRunMeta = persistedRuntimeState?.runMetadata ?? null;
    const staleRunId = normalizeNonEmptyString(handle?.voiceAgentId ?? persistedRunMeta?.runId ?? null);
    const staleRpcSessionId =
        normalizeNonEmptyString(handle?.rpcSessionId)
        ?? normalizeNonEmptyString(metadataSessionId)
        ?? sessionId;

    if (staleRunId) {
        await sessionExecutionRunStop(staleRpcSessionId, { runId: staleRunId }, { scope: accountLifetime.scope }).catch(() => {});
    }
    await clearVoiceAgentRunMetadata(metadataSessionId, accountLifetime).catch(() => {});
}
