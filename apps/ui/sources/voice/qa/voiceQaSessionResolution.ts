import { storage } from '@/sync/domains/state/storage';
import { resolveVoiceOperationalSessionId } from '@/voice/sessionBinding/resolveVoiceOperationalSessionId';
import { isVoiceConversationSystemSessionMetadata } from '@/voice/sessionBinding/voiceConversationSystemSessionLookup';
import type { VoiceSessionBinding } from '@/voice/sessionBinding/voiceSessionBindingTypes';

import { useVoiceQaStore, type VoiceQaProvider } from './voiceQaStore';

type VoiceQaTargetState = Readonly<{
    primaryActionSessionId: string | null;
    lastFocusedSessionId: string | null;
}>;

type VoiceQaResolvedSessionsStore = Readonly<{
    getState: () => Readonly<{
        setResolvedSessions: (params: Readonly<{
            targetSessionId: string;
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
    const providerId = String(settings?.voice?.providerId ?? 'off').trim();
    if (providerId === 'realtime_elevenlabs') return 'realtime_elevenlabs';
    return 'local_voice_agent';
}

export function isHiddenVoiceQaConversationSessionId(sessionId: string | null | undefined): boolean {
    const normalizedSessionId = normalizeVoiceQaText(sessionId);
    if (!normalizedSessionId) return false;
    const session = (storage.getState() as any)?.sessions?.[normalizedSessionId] ?? null;
    return isVoiceConversationSystemSessionMetadata(session?.metadata ?? null);
}

export function resolveEffectiveVoiceQaSessionId(
    explicitSessionId: string | null | undefined,
    getVoiceTargetState: () => VoiceQaTargetState,
): string {
    const explicit = normalizeVoiceQaText(explicitSessionId);
    if (explicit) return explicit;
    const target = getVoiceTargetState();
    const primaryActionSessionId = normalizeVoiceQaText(target.primaryActionSessionId);
    if (primaryActionSessionId && !isHiddenVoiceQaConversationSessionId(primaryActionSessionId)) {
        return primaryActionSessionId;
    }
    const lastFocusedSessionId = normalizeVoiceQaText(target.lastFocusedSessionId);
    if (lastFocusedSessionId && !isHiddenVoiceQaConversationSessionId(lastFocusedSessionId)) {
        return lastFocusedSessionId;
    }
    return '__voice_agent__';
}

export function resolveEffectiveVoiceQaTargetSessionId(
    explicitSessionId: string | null | undefined,
    configuredProvider: VoiceQaProvider,
    getVoiceTargetState: () => VoiceQaTargetState,
    qaStore: typeof useVoiceQaStore,
): string {
    const explicit = normalizeVoiceQaText(explicitSessionId);
    if (explicit) return explicit;
    const current = qaStore.getState();
    const currentTargetSessionId = normalizeVoiceQaText(current.targetSessionId);
    if (current.status !== 'idle' && current.provider === configuredProvider && currentTargetSessionId) {
        return currentTargetSessionId;
    }
    return resolveEffectiveVoiceQaSessionId(explicitSessionId, getVoiceTargetState);
}

export function assertLocalVoiceAgentSupportedForQa(settings: any): void {
    const providerId = String(settings?.voice?.providerId ?? '').trim();
    const conversationMode = String(settings?.voice?.adapters?.local_conversation?.conversationMode ?? '').trim();
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
    const latestBinding = deps.getLocalBinding?.(controlSessionId) ?? fallbackBinding;
    const targetState = deps.getVoiceTargetState();
    const activePrimaryTargetSessionId = normalizeVoiceQaText(targetState.primaryActionSessionId);
    const activeFocusedTargetSessionId = normalizeVoiceQaText(targetState.lastFocusedSessionId);
    const latestTargetSessionId =
        normalizeVoiceQaText(latestBinding?.targetSessionId)
        || (
            controlSessionId === '__voice_agent__'
                ? (
                    (activePrimaryTargetSessionId && !isHiddenVoiceQaConversationSessionId(activePrimaryTargetSessionId)
                        ? activePrimaryTargetSessionId
                        : '')
                    || (activeFocusedTargetSessionId && !isHiddenVoiceQaConversationSessionId(activeFocusedTargetSessionId)
                        ? activeFocusedTargetSessionId
                        : '')
                    || controlSessionId
                )
                : controlSessionId
        );
    const latestRuntimeSessionId = resolveLocalVoiceQaRuntimeSessionId(latestBinding, controlSessionId);
    deps.qaStore.getState().setResolvedSessions({
        targetSessionId: latestTargetSessionId,
        runtimeSessionId: resolveVoiceQaRuntimeSessionId(latestBinding, latestRuntimeSessionId),
    });
    return latestBinding;
}
