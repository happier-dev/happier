import { storage } from '@/sync/domains/state/storage';
import {
    readLocalConversationVoiceSettings,
    voiceSettingsParse,
} from '@/sync/domains/settings/voiceSettings';
import { resolveVoiceOperationalSessionId } from '@/voice/binding/resolveVoiceOperationalSessionId';
import type { VoiceSessionBinding } from '@/voice/binding/voiceConversationBindingTypes';
import { isVoiceConversationSystemSessionMetadata } from '@/voice/persistence/voiceConversationSystemSessionLookup';
import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';
import { readVoiceSessionOwnerMetadataFromState } from '@/voice/shared/readVoiceSessionOwnerMetadata';
import { normalizeSessionAddress, type SessionAddress } from '@/sync/domains/session/sessionAddress';

import { resolveVoiceSessionReference } from '@/voice/tools/actionImpl/sessionReference';

import { useVoiceQaStore, type VoiceQaProvider } from './voiceQaStore';

type VoiceQaTargetState = Readonly<{
    primaryActionSessionAddress: SessionAddress | null;
    lastFocusedSessionAddress: SessionAddress | null;
}>;

type VoiceQaResolvedSessionsStore = Readonly<{
    getState: () => Readonly<{
        setResolvedSessions: (params: Readonly<{
            targetSessionAddress: SessionAddress | null;
            runtimeSessionId: string | null;
        }>) => void;
    }>;
}>;

type VoiceQaBindingLookupDeps = Readonly<{
    getVoiceTargetState: () => VoiceQaTargetState;
    getLocalBinding?: (controlSessionId: string) => VoiceSessionBinding | null;
    qaStore: VoiceQaResolvedSessionsStore;
}>;

export function normalizeVoiceQaText(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

export function formatVoiceQaPermissionModeLabel(mode: unknown): string {
    const normalized = normalizeVoiceQaText(mode);
    if (normalized === 'read-only') return 'Read Only';
    if (normalized === 'safe-yolo') return 'Safe YOLO';
    if (normalized === 'acceptEdits') return 'Accept Edits';
    if (normalized === 'bypassPermissions') return 'Bypass Permissions';
    if (normalized === 'yolo') return 'YOLO';
    if (normalized === 'plan') return 'Plan';
    if (normalized === 'default') return 'Default';
    return normalized || 'Unknown';
}

export function resolveConfiguredVoiceQaProvider(settings: any): VoiceQaProvider {
    const providerId = normalizeVoiceQaText(settings?.voice?.providerId);
    const provider = providerId ? createDefaultVoiceProviderRegistry().get(providerId) : null;
    if (provider?.kind === 'voice.conversation-provider.v1' && provider.roles.includes('realtime_conversation')) {
        return 'realtime_conversation';
    }
    return 'local_voice_agent';
}

export function isHiddenVoiceQaConversationSessionId(target: SessionAddress | string | null | undefined): boolean {
    const normalizedSessionId = normalizeVoiceQaText(typeof target === 'string' ? target : target?.sessionId);
    if (!normalizedSessionId) return false;
    const state = storage.getState() as any;
    return isVoiceConversationSystemSessionMetadata(
        readVoiceSessionOwnerMetadataFromState(state, target && typeof target === 'object' ? target : normalizedSessionId),
    );
}

export function resolveEffectiveVoiceQaSessionAddress(
    explicitTarget: SessionAddress | string | null | undefined,
    getVoiceTargetState: () => VoiceQaTargetState,
): SessionAddress | null {
    if (explicitTarget && typeof explicitTarget === 'object') {
        const address = normalizeSessionAddress(explicitTarget.serverId, explicitTarget.sessionId);
        if (!address) throw new Error('voice_qa_target_session_unresolved');
        return address;
    }
    const explicit = normalizeVoiceQaText(explicitTarget);
    if (explicit === '__voice_agent__') return null;
    if (explicit) {
        const resolution = resolveVoiceSessionReference({ sessionId: explicit }, storage.getState());
        if (resolution.kind !== 'unique') throw new Error('voice_qa_target_session_unresolved');
        return resolution.address;
    }
    const target = getVoiceTargetState();
    for (const address of [target.primaryActionSessionAddress, target.lastFocusedSessionAddress]) {
        if (address && !isHiddenVoiceQaConversationSessionId(address)) return address;
    }
    return null;
}

export function resolveEffectiveVoiceQaTargetSessionAddress(
    explicitTarget: SessionAddress | string | null | undefined,
    configuredProvider: VoiceQaProvider,
    getVoiceTargetState: () => VoiceQaTargetState,
    qaStore: typeof useVoiceQaStore,
): SessionAddress | null {
    if (explicitTarget) return resolveEffectiveVoiceQaSessionAddress(explicitTarget, getVoiceTargetState);
    const current = qaStore.getState();
    if (current.status !== 'idle' && current.provider === configuredProvider) return current.targetSessionAddress;
    return resolveEffectiveVoiceQaSessionAddress(null, getVoiceTargetState);
}

export function assertLocalVoiceAgentSupportedForQa(settings: any): void {
    const voice = voiceSettingsParse(settings?.voice);
    const providerId = String(voice.providerId ?? '').trim();
    const conversationMode = readLocalConversationVoiceSettings(voice).conversationMode;
    if (providerId !== 'local_conversation' || conversationMode !== 'agent') {
        throw new Error('voice_qa_local_agent_requires_local_conversation_agent_mode');
    }
}

export function resolveLocalVoiceQaControlSessionId(): string {
    return '__voice_agent__';
}

export function resolveLocalVoiceQaRuntimeSessionId(binding: VoiceSessionBinding | null, controlSessionId: string): string {
    return resolveVoiceOperationalSessionId(binding, controlSessionId);
}

export function resolveVoiceQaRuntimeSessionId(binding: VoiceSessionBinding | null, runtimeSessionId: string): string | null {
    return normalizeVoiceQaText(binding?.conversationSessionId) || normalizeVoiceQaText(runtimeSessionId) || null;
}

export function syncLatestLocalVoiceQaResolvedSessions(
    deps: VoiceQaBindingLookupDeps,
    controlSessionId: string,
    fallbackBinding: VoiceSessionBinding | null,
): VoiceSessionBinding | null {
    const normalizedControlSessionId = normalizeVoiceQaText(controlSessionId);
    const latestBinding = deps.getLocalBinding?.(normalizedControlSessionId || controlSessionId) ?? fallbackBinding;
    const latestTargetSessionAddress = latestBinding ? latestBinding.targetSessionAddress
        : resolveEffectiveVoiceQaSessionAddress(
            normalizedControlSessionId === '__voice_agent__' ? null : controlSessionId,
            deps.getVoiceTargetState,
        );
    const latestRuntimeSessionId = resolveLocalVoiceQaRuntimeSessionId(latestBinding, controlSessionId);
    deps.qaStore.getState().setResolvedSessions({
        targetSessionAddress: latestTargetSessionAddress,
        runtimeSessionId: resolveVoiceQaRuntimeSessionId(latestBinding, latestRuntimeSessionId),
    });
    return latestBinding;
}
