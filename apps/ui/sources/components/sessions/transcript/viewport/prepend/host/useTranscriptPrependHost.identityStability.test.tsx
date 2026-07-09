/**
 * Identity-stability contract for the extracted prepend host.
 *
 * ChatList currently memoizes the deps object, but the hook owns the callback
 * stability invariant. Fresh deps object identities with unchanged fields must
 * not churn returned host methods.
 */
import { describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';

import { createTranscriptViewportCommandController } from '@/components/sessions/transcript/viewport/createTranscriptViewportCommandController';
import { useTranscriptPrependHost } from './useTranscriptPrependHost';

type PrependHostDeps = Parameters<typeof useTranscriptPrependHost>[0];

function createRef<T>(current: T): { current: T } {
    return { current };
}

function createStableMembers() {
    return {
        commandHostRef: createRef(null),
        lastUserScrollIntentAtMsRef: createRef(Number.NEGATIVE_INFINITY),
        listContentHeightRef: createRef(0),
        listDataRef: createRef([]),
        listLayoutHeightRef: createRef(0),
        listRef: createRef(null),
        itemsRef: createRef([]),
        preemptEntryRestoreTransaction: vi.fn(),
        recordRestoreDecisionTelemetry: vi.fn(),
        recordViewportTelemetryEvent: vi.fn(),
        resolveWebScrollMetrics: vi.fn(() => null),
        viewportCommandController: createTranscriptViewportCommandController(),
        wantsPinnedRef: createRef(false),
    };
}

function buildDeps(members: ReturnType<typeof createStableMembers>): PrependHostDeps {
    return {
        ...members,
        currentSessionId: 's1',
        pinThresholdPx: 72,
        webPrependRestoreOwner: 'app',
    };
}

describe('useTranscriptPrependHost identity stability', () => {
    it('keeps host callbacks referentially stable across fresh deps object identities', async () => {
        const members = createStableMembers();
        const hook = await renderHook(
            (deps: PrependHostDeps) => useTranscriptPrependHost(deps),
            { initialProps: buildDeps(members) },
        );

        const first = hook.getCurrent();

        await hook.rerender(buildDeps(members));
        await hook.rerender(buildDeps(members));

        const second = hook.getCurrent();
        expect(second.applyNativeEffects).toBe(first.applyNativeEffects);
        expect(second.applyWebEffects).toBe(first.applyWebEffects);
        expect(second.runWebIndexRecovery).toBe(first.runWebIndexRecovery);

        await hook.unmount();
    });
});
