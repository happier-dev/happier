import * as React from 'react';

import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useFocusedSessionId } from '@/sync/domains/session/sessionSurfaceVisibility';
import { useSessionListPreferredMetadata } from '@/sync/store/hooks';
import { getVoiceAgentSessionTeleportAvailability } from '@/voice/agent/getVoiceAgentSessionTeleportAvailability';
import { resolveVoiceSessionLabel } from '@/voice/context/resolveVoiceSessionLabel';
import {
    useVoiceTargetStore,
    type VoiceAssistantScope,
} from '@/voice/runtime/voiceTargetStore';
import { resolveVoiceAdapterSurfaceCapabilities } from '@/voice/session/voiceAdapterRegistry';

import type { VoiceSurfaceVariant } from './voiceSurfaceTypes';

function resolveSessionIdFromPathname(pathname: string | null | undefined): string | null {
    const normalized = String(pathname ?? '').trim();
    const match = normalized.match(/^\/session\/([^/?#]+)/);
    const sessionId = typeof match?.[1] === 'string' ? decodeURIComponent(match[1]).trim() : '';
    return sessionId.length > 0 ? sessionId : null;
}

type VoiceSurfacePrivacySettings = Readonly<{
    shareFilePaths: boolean;
    shareSessionSummary: boolean;
}>;

export function useVoiceSurfaceTargetState(params: Readonly<{
    pathname: string | null | undefined;
    providerId: string;
    sessionId: string | null | undefined;
    variant: VoiceSurfaceVariant;
    voice: any;
    voicePrivacy: VoiceSurfacePrivacySettings;
}>) {
    const ui = params.voice?.ui ?? {};
    const scopeDefault = ui.scopeDefault === 'session' ? 'session' : 'global';
    const surfaceLocation = ui.surfaceLocation === 'sidebar' || ui.surfaceLocation === 'session' ? ui.surfaceLocation : 'auto';
    const activityFeedEnabled = params.voice?.ui?.activityFeedEnabled === true;
    const focusedSessionId = useFocusedSessionId();
    const lastFocusedSessionId = useVoiceTargetStore((state) => state.lastFocusedSessionId);
    const routeSessionId = params.variant === 'sidebar' ? resolveSessionIdFromPathname(params.pathname) : null;
    const surfaceCapabilities = resolveVoiceAdapterSurfaceCapabilities(params.providerId, params.voice);
    const allowsGlobalStart = surfaceCapabilities?.allowsGlobalStart === true;
    const exactSessionId =
        params.variant === 'session'
            ? (typeof params.sessionId === 'string' ? params.sessionId : null)
            : (
                (typeof focusedSessionId === 'string' ? focusedSessionId : null)
                ?? routeSessionId
                ?? (typeof lastFocusedSessionId === 'string' ? lastFocusedSessionId : null)
            );
    // An in-session composer always starts against the exact session it is rendered for. The
    // global default controls Voice Home/sidebar starts only; applying it here would discard the
    // direct Codex target before the canonical attempt projection can admit it.
    const bindingScope: VoiceAssistantScope =
        params.variant === 'session'
            ? 'session'
            : scopeDefault === 'global' && allowsGlobalStart
                ? 'global'
                : 'session';
    const startSessionId = bindingScope === 'global' ? null : exactSessionId;
    const displayedBindingSessionMetadata = useSessionListPreferredMetadata(startSessionId);
    const voiceAgentEnabled = useFeatureEnabled('voice.agent');
    const bargeInEnabled = surfaceCapabilities?.bargeInEnabled === true;
    const cancelResponseSupported = surfaceCapabilities?.cancelResponse === 'immediate';
    const daemonLocalVoiceUnavailable =
        surfaceCapabilities?.requiresVoiceAgentFeature === true
        && voiceAgentEnabled !== true;
    const canTeleportToSessionRoot =
        params.variant === 'session'
        && getVoiceAgentSessionTeleportAvailability({ voice: params.voice, sessionId: params.sessionId ?? null }).ok;

    React.useEffect(() => {
        useVoiceTargetStore.getState().setScope(scopeDefault);
    }, [scopeDefault]);

    const locationAllowsVariant = (() => {
        if (surfaceLocation === 'sidebar') return params.variant === 'sidebar';
        if (surfaceLocation === 'session') return params.variant === 'session';
        return scopeDefault === 'global' ? params.variant === 'sidebar' : params.variant === 'session';
    })();

    const targetLabel =
        startSessionId
            ? (
                resolveVoiceSessionLabel(startSessionId, {
                    voiceShareSessionSummary: params.voicePrivacy.shareSessionSummary,
                    voiceShareFilePaths: params.voicePrivacy.shareFilePaths,
                }, displayedBindingSessionMetadata ? { metadata: displayedBindingSessionMetadata } : undefined)
            )
            : null;

    return {
        activityFeedEnabled,
        allowsGlobalStart,
        bargeInEnabled,
        bindingScope,
        cancelResponseSupported,
        agentRuntime: surfaceCapabilities?.agentRuntime ?? null,
        canTeleportToSessionRoot,
        daemonLocalVoiceUnavailable,
        locationAllowsVariant,
        routeSessionId,
        startSessionId,
        targetLabel,
    };
}
