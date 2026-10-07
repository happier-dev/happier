import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSessionFixture, createTestSessionTranscriptSource, renderWithSessionTranscriptSource, standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { storage } from '@/sync/domains/state/storage';
import { installTranscriptCommonModuleMocks, resetTranscriptCommonModuleMockState } from './transcriptTestHelpers';

installTranscriptCommonModuleMocks();
installDisconnectedServerSocketBoundary();

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    initialWindowMetrics: null,
}));

// The native recycler is a platform boundary; the real footer, store selectors,
// local-control owner and transcript composition remain live beneath it.
vi.mock('@legendapp/list/react-native', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@legendapp/list/react-native')>();
    const { createCapturingLegendListMock } = await import('@/dev/testkit/mocks/legendList');
    return createCapturingLegendListMock({ original: actual }).module;
});

await loadSyncSingletonForTests();
const { ChatList } = await import('./ChatList');

beforeEach(() => {
    if (typeof globalThis.requestAnimationFrame !== 'function') {
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
            Number(setTimeout(() => callback(Date.now()), 0)));
        vi.stubGlobal('cancelAnimationFrame', (handle: number) => clearTimeout(handle));
    }
});

afterEach(() => {
    standardCleanup();
    resetTranscriptCommonModuleMockState();
    storage.setState(storage.getInitialState(), true);
    vi.unstubAllGlobals();
});

describe('ChatList footer control override', () => {
    it('uses the explicit Boolean override when no current local-control fact exists', async () => {
        const session = createSessionFixture({ metadata: null, active: false });
        storage.setState({ sessions: { [session.id]: session } });
        const source = createTestSessionTranscriptSource({ sessionId: session.id });
        const element = (controlledByUserOverride: boolean) => (
            <ChatList
                session={session}
                sessionSurfaceKey={JSON.stringify(['test-server', session.id])}
                controlledByUserOverride={controlledByUserOverride}
                externalControlFooter={null}
            />
        );
        const screen = await renderWithSessionTranscriptSource(element(true), source);

        expect(screen.findByTestId('session-chatFooter-localControl')).not.toBeNull();
        expect(screen.findByTestId('session-chatFooter-switchToRemote')).toBeNull();

        await screen.update(element(false));

        expect(screen.findByTestId('session-chatFooter-localControl')).toBeNull();
        expect(screen.findByTestId('session-chatFooter-switchToRemote')).toBeNull();
    });

    it('does not let a Boolean override hide a currently attached runner-owned terminal', async () => {
        const session = createSessionFixture({
            metadata: null,
            active: true,
            agentState: { controlledByUser: true },
        });
        storage.setState({ sessions: { [session.id]: session } });
        const screen = await renderWithSessionTranscriptSource(
            <ChatList
                session={session}
                sessionSurfaceKey={JSON.stringify(['test-server', session.id])}
                controlledByUserOverride={false}
                externalControlFooter={null}
            />,
            createTestSessionTranscriptSource({ sessionId: session.id, agentState: session.agentState }),
        );

        expect(screen.findByTestId('session-chatFooter-localControl')).not.toBeNull();
        expect(screen.findByTestId('session-chatFooter-switchToRemote')).toBeNull();
    });
});
