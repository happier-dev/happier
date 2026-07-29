/**
 * Identity-stability contract for the extracted viewport anchor capture host.
 *
 * ChatList passes a fresh deps object into this host on each render. The host
 * callbacks must stay stable when the individual dependency fields are unchanged.
 */
import { describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';

import { useTranscriptViewportAnchorCaptureHost } from './useTranscriptViewportAnchorCaptureHost';

type AnchorCaptureHostDeps = Parameters<typeof useTranscriptViewportAnchorCaptureHost>[0];

function createRef<T>(current: T): { current: T } {
    return { current };
}

function createStableMembers() {
    return {
        cancelScheduledViewportAnchorCapture: vi.fn(),
        currentSessionIdRef: createRef('s1'),
        emitViewportChange: vi.fn(),
        isEntryViewportCommandActive: vi.fn(() => false),
        listDataRef: createRef([]),
        listLayoutHeightRef: createRef(0),
        listRef: createRef(null),
        pinThresholdPx: 72,
        readCurrentNativeDistanceFromBottom: vi.fn(() => null),
        recordViewportTelemetryEvent: vi.fn(),
        resolveWebScrollMetrics: vi.fn(() => null),
        scheduledViewportAnchorCaptureRef: createRef(null),
        shouldSuppressGenericViewportStateForProtectedJumpSeq: vi.fn(() => false),
        viewportAnchorCaptureGenerationRef: createRef(0),
        wantsPinnedRef: createRef(false),
    };
}

function buildDeps(members: ReturnType<typeof createStableMembers>): AnchorCaptureHostDeps {
    return {
        ...members,
        debounceMs: 50,
    };
}

describe('useTranscriptViewportAnchorCaptureHost identity stability', () => {
    it('keeps host callbacks referentially stable across fresh deps object identities', async () => {
        const members = createStableMembers();
        const hook = await renderHook(
            (deps: AnchorCaptureHostDeps) => useTranscriptViewportAnchorCaptureHost(deps),
            { initialProps: buildDeps(members) },
        );

        const first = hook.getCurrent();

        await hook.rerender(buildDeps(members));
        await hook.rerender(buildDeps(members));

        const second = hook.getCurrent();
        expect(second.schedule).toBe(first.schedule);
        expect(second.flush).toBe(first.flush);

        await hook.unmount();
    });
});
