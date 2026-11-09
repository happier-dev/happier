import * as React from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { createSessionFixture, renderHook, standardCleanup } from '@/dev/testkit';
import type { SessionAwarenessProjectionV1 } from '@happier-dev/protocol/sessions/awareness/projectionV1';
import { projectUiSessionAwareness } from '@/sync/domains/session/awareness/sessionAwareness';
import { createReadOnlySessionTranscriptSource } from '../source/readOnlySessionTranscriptSource';
import { SessionTranscriptSourceProvider } from '../source/SessionTranscriptSourceContext';
import { useTranscriptNavigationSessionPresent } from './useTranscriptNavigationSessionPresent';

afterEach(standardCleanup);

const working = projectUiSessionAwareness(createSessionFixture({
    active: true, activeAt: 1_000, thinking: true, thinkingAt: 1_000,
    pendingPermissionRequestCount: 0, pendingUserActionRequestCount: 0,
}), 1_000);

async function present(awareness: SessionAwarenessProjectionV1) {
    const source = {
        ...createReadOnlySessionTranscriptSource({ sessionId: 'navigation', messages: [], reducerState: null, metadata: null, agentState: null }),
        useAwareness: () => awareness,
        useRuntimeLastObservedAt: () => 900,
    };
    const hook = await renderHook(useTranscriptNavigationSessionPresent, {
        wrapper: (props) => <SessionTranscriptSourceProvider source={source}>{props.children}</SessionTranscriptSourceProvider>,
    });
    return hook.getCurrent();
}

describe('Navigate session present', () => {
    it.each([
        { ...working, freshness: 'stale' as const },
        { ...working, lifecycle: 'archived' as const },
        { ...working, runtime: 'unknown' as const, operational: { primary: 'none' as const, reasons: [] } },
        { ...working, operational: { ...working.operational, reasons: ['resuming'] as SessionAwarenessProjectionV1['operational']['reasons'] } },
        { ...working, operational: { ...working.operational, reasons: ['runtime_unservable'] as SessionAwarenessProjectionV1['operational']['reasons'] } },
    ])('does not animate a turn whose presented state is no longer working', async (awareness) => {
        expect(await present(awareness)).toEqual({ newestTurn: null, offline: false, offlineSinceMs: null });
    });

    it('shows live working and waiting turns, and disconnects only when the presenter does', async () => {
        expect(await present(working)).toEqual({ newestTurn: 'working', offline: false, offlineSinceMs: null });
        // Runtime presence and current turn evidence are independent for externally followed Sessions.
        expect(await present({ ...working, runtime: 'unknown' }))
            .toEqual({ newestTurn: 'working', offline: false, offlineSinceMs: null });
        expect(await present({ ...working, operational: { ...working.operational, primary: 'permission_required' } }))
            .toEqual({ newestTurn: 'waiting', offline: false, offlineSinceMs: null });
        expect(await present({ ...working, runtime: 'offline' }))
            .toEqual({ newestTurn: null, offline: true, offlineSinceMs: 900 });
        expect(await present({ ...working, lifecycle: 'archived', runtime: 'offline' }))
            .toEqual({ newestTurn: null, offline: false, offlineSinceMs: null });
    });
});
