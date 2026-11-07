import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useFocusedSessionAddress } from '@/sync/domains/session/sessionSurfaceVisibility';
import { useSessionListPreferredMetadata } from '@/sync/store/hooks';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import {
    useVoiceTargetStore,
    resolveVoiceIdleTarget,
    type VoiceAssistantScope,
} from '@/voice/runtime/voiceTargetStore';
import { resolveVoiceAdapterSurfaceCapabilities } from '@/voice/session/voiceAdapterRegistry';
import { getVoiceSessionRestartTarget } from '@/voice/session/voiceSessionStore';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';

import type { VoiceSurfaceVariant } from './voiceSurfaceTypes';
import { normalizeSessionAddress, type SessionAddress } from '@/sync/domains/session/sessionAddress';

function resolveSessionIdFromPathname(pathname: string | null | undefined): string | null {
    const normalized = String(pathname ?? '').trim();
    const match = normalized.match(/^\/session\/([^/?#]+)/);
    const sessionId = typeof match?.[1] === 'string' ? decodeURIComponent(match[1]).trim() : '';
    return sessionId.length > 0 ? sessionId : null;
}

export function useVoiceSurfaceTargetState(params: Readonly<{
    pathname: string | null | undefined;
    providerId: string;
    sessionAddress?: SessionAddress | null;
    sessionId: string | null | undefined;
    serverId?: string | null;
    variant: VoiceSurfaceVariant;
    voice: any;
}>) {
    const ui = params.voice?.ui ?? {};
    const accountScope = useActiveServerAccountScope();
    const scopeDefault = ui.scopeDefault === 'session' ? 'session' : 'global';
    const activityFeedEnabled = params.voice?.ui?.activityFeedEnabled === true;
    const exactFocusedSessionAddress = useFocusedSessionAddress();
    const lastFocusedSessionAddress = useVoiceTargetStore((state) => state.lastFocusedSessionAddress);
    const routeSessionId = params.variant === 'sidebar' ? resolveSessionIdFromPathname(params.pathname) : null;
    const surfaceCapabilities = resolveVoiceAdapterSurfaceCapabilities(params.providerId, params.voice);
    const allowsGlobalStart = surfaceCapabilities?.allowsGlobalStart === true;
    const statedSessionAddress = normalizeSessionAddress(
        params.sessionAddress?.serverId,
        params.sessionAddress?.sessionId,
    );
    const target = resolveVoiceIdleTarget({
        intent: params.variant === 'session'
            ? { kind: 'session', sessionAddress: params.sessionAddress !== undefined
                ? statedSessionAddress : normalizeSessionAddress(params.serverId, params.sessionId) }
            : { kind: 'default' },
        scopeDefault, allowsGlobalStart,
        restartTarget: getVoiceSessionRestartTarget(params.providerId, accountScope),
        focusedSessionAddress: exactFocusedSessionAddress, lastFocusedSessionAddress,
    });
    const bindingScope: VoiceAssistantScope = target.kind;
    const startSessionAddress = target.kind === 'session' ? target.sessionAddress : null;
    const startSessionId = startSessionAddress?.sessionId ?? null;
    const displayedBindingSessionMetadata = useSessionListPreferredMetadata(startSessionAddress);
    const voiceAgentEnabled = useFeatureEnabled('voice.agent');
    const bargeInEnabled = surfaceCapabilities?.bargeInEnabled === true;
    const cancelResponseSupported = surfaceCapabilities?.cancelResponse === 'immediate';
    const daemonLocalVoiceUnavailable =
        surfaceCapabilities?.requiresVoiceAgentFeature === true
        && voiceAgentEnabled !== true;

    /*
     * What this device shows its own user: the target Session's display name, from the same
     * display-name owner as every other Session label. Voice privacy limits what is shared with the
     * provider (`resolveVoiceSessionLabel`, for the model); it never hides a name from the person
     * who owns it. A target whose row is not on this device has no name to show.
     */
    const targetLabel = startSessionAddress && displayedBindingSessionMetadata
        ? getSessionName({
            id: startSessionAddress.sessionId,
            serverId: startSessionAddress.serverId,
            metadata: displayedBindingSessionMetadata,
        }, startSessionAddress.serverId)
        : null;

    return {
        activityFeedEnabled,
        allowsGlobalStart,
        bargeInEnabled,
        bindingScope,
        cancelResponseSupported,
        agentRuntime: surfaceCapabilities?.agentRuntime ?? null,
        daemonLocalVoiceUnavailable,
        routeSessionId,
        startSessionId,
        startSessionAddress,
        targetLabel,
    };
}
