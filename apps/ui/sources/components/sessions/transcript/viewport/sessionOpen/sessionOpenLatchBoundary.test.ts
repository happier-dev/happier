import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const CHAT_LIST_SOURCE = readFileSync(new URL('../../ChatList.tsx', import.meta.url), 'utf8');
const ENTRY_HOST_SOURCE = readFileSync(new URL('../entryRestore/host/useTranscriptEntryHost.ts', import.meta.url), 'utf8');

describe('session-open latch source boundary', () => {
    it('keeps session-open one-shot guards inside the latch instead of ChatList effects', () => {
        expect(CHAT_LIST_SOURCE).not.toContain('initialPinSessionIdRef');
        expect(CHAT_LIST_SOURCE).not.toContain('didAutoExpandToolCallsGroupsForSessionRef');
        expect(CHAT_LIST_SOURCE).not.toContain('nativeInitialViewportAppliedSessionRef');
    });

    it('forbids render-phase session-entry viewport mutation in ChatList', () => {
        expect(CHAT_LIST_SOURCE).not.toMatch(/if\s*\(\s*sessionEntryViewportRef\.current\?\.sessionId\s*!==\s*props\.sessionId\s*\)\s*\{\s*const resolvedEntryViewport/);
        expect(CHAT_LIST_SOURCE).not.toMatch(/wantsPinnedRef\.current\s*=\s*shouldFollowBottom/);
        expect(CHAT_LIST_SOURCE).not.toMatch(/bottomFollowModeStateRef\.current\s*=\s*lifecycleEntry\.state\.bottomFollowState/);
    });

    it('keeps native first-paint placeholder policy behind the session-open latch', () => {
        expect(CHAT_LIST_SOURCE).not.toContain('shouldHoldNativeFirstPaintPlaceholderForMountSettle');
        expect(CHAT_LIST_SOURCE).not.toContain('shouldHoldNativeFirstPaintPlaceholderForPendingViewport');
        expect(CHAT_LIST_SOURCE).not.toContain('nativeWarmFirstPaintDistanceAppearsOffBottom');
    });

    it('keeps session-entry resets on latch arm/dispose plans instead of a second effect-time owner', () => {
        expect(CHAT_LIST_SOURCE).not.toContain('applyEffectTimeSessionReset');
        expect(ENTRY_HOST_SOURCE).toContain("case 'apply-arm-reset-plan'");
        expect(ENTRY_HOST_SOURCE).toContain("case 'apply-dispose-reset-plan'");
    });
});
