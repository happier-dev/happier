import * as React from 'react';

import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useFocusedSessionId } from '@/sync/domains/session/sessionSurfaceVisibility';
import { useSession } from '@/sync/store/hooks';
import { getVoiceAgentSessionTeleportAvailability } from '@/voice/agent/getVoiceAgentSessionTeleportAvailability';
import { resolveVoiceSessionLabel } from '@/voice/context/resolveVoiceSessionLabel';
import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';

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
    localConversationMode: string | null;
    pathname: string | null | undefined;
    providerId: string;
    sessionId: string | null | undefined;
    sessionLabelById: ReadonlyMap<string, string>;
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
    const primaryActionSessionId = useVoiceTargetStore((state) => state.primaryActionSessionId);
    const primaryActionSession = useSession(
        typeof primaryActionSessionId === 'string' ? primaryActionSessionId.trim() : '',
    );
    const voiceScope = useVoiceTargetStore((state) => state.scope);
    const routeSessionId = params.variant === 'sidebar' ? resolveSessionIdFromPathname(params.pathname) : null;
    const startSessionId =
        params.variant === 'session'
            ? (typeof params.sessionId === 'string' ? params.sessionId : null)
            : (
                (typeof focusedSessionId === 'string' ? focusedSessionId : null)
                ?? routeSessionId
                ?? (typeof lastFocusedSessionId === 'string' ? lastFocusedSessionId : null)
            );
    const voiceAgentEnabled = useFeatureEnabled('voice.agent');
    const allowsGlobalStart =
        params.providerId === 'realtime_elevenlabs'
        || (params.providerId === 'local_conversation' && params.localConversationMode === 'agent');
    const localAgentCfg = params.providerId === 'local_conversation' ? params.voice?.adapters?.local_conversation?.agent ?? null : null;
    const daemonLocalVoiceUnavailable =
        params.providerId === 'local_conversation'
        && params.localConversationMode === 'agent'
        && localAgentCfg?.backend === 'daemon'
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
        params.variant === 'sidebar' && voiceScope === 'global' && primaryActionSessionId
            ? (
                resolveVoiceSessionLabel(primaryActionSessionId, {
                    voiceShareSessionSummary: params.voicePrivacy.shareSessionSummary,
                    voiceShareFilePaths: params.voicePrivacy.shareFilePaths,
                }, primaryActionSession ? { metadata: primaryActionSession.metadata } : undefined)
            )
            : null;

    return {
        activityFeedEnabled,
        allowsGlobalStart,
        canTeleportToSessionRoot,
        daemonLocalVoiceUnavailable,
        locationAllowsVariant,
        routeSessionId,
        startSessionId,
        targetLabel,
    };
}
