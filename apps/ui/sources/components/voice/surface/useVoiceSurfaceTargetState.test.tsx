import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@/dev/testkit';
import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';
import {
    resetSessionSurfaceVisibilityForTests,
    setFocusedSessionId,
} from '@/sync/domains/session/sessionSurfaceVisibility';

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => true,
}));

vi.mock('@/voice/agent/getVoiceAgentSessionTeleportAvailability', () => ({
    getVoiceAgentSessionTeleportAvailability: () => ({ ok: false }),
}));

describe('useVoiceSurfaceTargetState', () => {
    beforeEach(() => {
        useVoiceTargetStore.setState({
            scope: 'global',
            primaryActionSessionId: null,
            trackedSessionIds: [],
            lastFocusedSessionId: 'voice-last-focused',
        } as any);
        resetSessionSurfaceVisibilityForTests();
    });

    it('prefers the focused visible session over the route session for sidebar targeting', async () => {
        setFocusedSessionId('split-focused-session');
        const { useVoiceSurfaceTargetState } = await import('./useVoiceSurfaceTargetState');

        const hook = await renderHook(() => useVoiceSurfaceTargetState({
            localConversationMode: null,
            pathname: '/session/route-session',
            providerId: 'realtime_elevenlabs',
            sessionId: null,
            sessionLabelById: new Map(),
            variant: 'sidebar',
            voice: null,
            voicePrivacy: {
                shareFilePaths: true,
                shareSessionSummary: true,
            },
        }));

        expect(hook.getCurrent().startSessionId).toBe('split-focused-session');
        await hook.unmount();
    });
});
