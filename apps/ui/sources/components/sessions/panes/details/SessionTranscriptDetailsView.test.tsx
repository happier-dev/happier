import * as React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The transcript a workflow agent's imported sidecar finally opens into.
 *
 * Two claims are load-bearing and neither can be read off the wiring:
 *
 * 1. **It renders through the transcript's own row stack.** The reducer stores a sidechain as flat
 *    records with no owning tool call, so the only alternatives were re-implementing a message
 *    renderer here — the split-brain — or reading the ONE conversion the reducer already owns.
 *    The discriminating assertion is that the imported text and tool call actually appear, which a
 *    props-only test would pass with any renderer at all.
 * 2. **It is a READ.** No composer, no live tail, no direct controls: this is a detail of work that
 *    already ran, reached from a roster, with no recipient of its own to address.
 */

const ensureSidechainSpy = vi.hoisted(() => vi.fn(async () => 'loaded' as const));
const loadOlderSidechainSpy = vi.hoisted(() => vi.fn(async () => ({ loaded: 0, hasMore: false, status: 'no_more' as const })));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ pathname: () => '/session/s1', router: { push: vi.fn() } }).module;
});

vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).installModalModuleMock()());

// Genuine system boundary: the sync façade. Everything below it — the reducer read, the conversion,
// the row stack — stays real, which is the only way the claims above can be observed.
vi.mock('@/sync/sync', () => ({
    sync: {
        ensureSidechainMessagesLoaded: ensureSidechainSpy,
        loadOlderSidechainMessages: loadOlderSidechainSpy,
        getSyncTuning: () => ({
            transcriptFlashListEstimatedItemSize: 120,
            transcriptBackwardPrefetchThresholdPx: 40,
            transcriptOlderLoadCooldownMs: 0,
            transcriptOlderLoadSpinnerDelayMs: 0,
            transcriptLegendListSpikeSurface: 'off' as const,
            sidechainDemandHydrationConcurrencyLimit: 2,
        }),
    },
}));

vi.mock('@shopify/flash-list', () => ({
    FlashList: (props: any) => {
        const data = Array.isArray(props.data) ? props.data : [];
        const header = props.ListHeaderComponent
            ? (typeof props.ListHeaderComponent === 'function' ? props.ListHeaderComponent() : props.ListHeaderComponent)
            : null;
        const footer = props.ListFooterComponent
            ? (typeof props.ListFooterComponent === 'function' ? props.ListFooterComponent() : props.ListFooterComponent)
            : null;
        return React.createElement(
            'FlashList',
            props,
            header,
            data.map((item: any, index: number) => React.createElement(
                'FlashListItem',
                { key: typeof props.keyExtractor === 'function' ? props.keyExtractor(item, index) : String(index) },
                typeof props.renderItem === 'function' ? props.renderItem({ item, index }) : null,
            )),
            footer,
        );
    },
}));

vi.mock('@legendapp/list/react-native', async () => {
    const { createCapturingLegendListMock } = await import('@/dev/testkit/mocks/legendList');
    return createCapturingLegendListMock().module;
});

const SESSION_ID = 's1';
const SIDECHAIN_ID = 'workflow_agent_sidechain:toolu_wf:a1';
const TEST_ID = 'session-details-transcript';

let testkit: typeof import('@/dev/testkit');
let storage: typeof import('@/sync/domains/state/storageStore')['storage'];
let SessionTranscriptDetailsView: typeof import('./SessionTranscriptDetailsView')['SessionTranscriptDetailsView'];
let previousStorageState: unknown = null;

function seedImportedSidechain(): void {
    const fixture = testkit.makeSessionAgentActivityFixture({ sessionId: SESSION_ID });
    fixture.reducerState.sidechains.set(SIDECHAIN_ID, [
        testkit.makeAgentActivitySidechainMessage({
            id: 'wf_a1_step',
            createdAt: 1_000,
            toolName: 'Read',
            toolDescription: 'auth.ts',
        }),
        testkit.makeAgentActivitySidechainMessage({
            id: 'wf_a1_line',
            createdAt: 1_001,
            text: 'Reviewed the auth flow',
        }),
    ]);
    storage.setState((state: any) => ({
        ...state,
        sessions: { ...state.sessions, [fixture.sessionId]: fixture.session },
        sessionMessages: { ...state.sessionMessages, ...fixture.storeSessionMessagesBySessionId },
    }));
}

describe('SessionTranscriptDetailsView', () => {
    beforeAll(async () => {
        testkit = await import('@/dev/testkit');
        ({ storage } = await import('@/sync/domains/state/storageStore'));
        ({ SessionTranscriptDetailsView } = await import('./SessionTranscriptDetailsView'));
    }, 300_000);

    beforeEach(() => {
        previousStorageState = storage.getState();
        ensureSidechainSpy.mockClear();
        loadOlderSidechainSpy.mockClear();
    });

    afterEach(() => {
        testkit.standardCleanup();
        if (previousStorageState) storage.setState(previousStorageState as never);
    });

    it('renders the imported sidechain through the transcript row stack, read-only', async () => {
        seedImportedSidechain();

        const screen = await testkit.renderScreen(
            <SessionTranscriptDetailsView
                scope={{ kind: 'sidechain', sessionId: SESSION_ID, sidechainId: SIDECHAIN_ID }}
                testID={TEST_ID}
            />,
        );
        await testkit.flushHookEffects();

        const text = screen.getTextContent();
        // The imported records, converted by the reducer's ONE converter and drawn by the same rows
        // the main transcript uses. A renderer of its own would have to reproduce both.
        expect(text).toContain('Reviewed the auth flow');
        expect(text).toContain('auth.ts');
        expect(screen.findByTestId(`${TEST_ID}:unsupported`)).toBeNull();

        // A READ: nothing here sends, approves, or tails.
        expect(screen.findByTestId('agent-input')).toBeNull();
        expect(screen.findByTestId('session-participant-composer')).toBeNull();
        expect(text).not.toContain('session.participants');

        await screen.unmount();
    }, 240_000);

    it('asks the one hydration owner exactly once for the sidechain it shows', async () => {
        seedImportedSidechain();

        const screen = await testkit.renderScreen(
            <SessionTranscriptDetailsView
                scope={{ kind: 'sidechain', sessionId: SESSION_ID, sidechainId: SIDECHAIN_ID }}
                testID={TEST_ID}
            />,
        );
        await testkit.flushHookEffects();

        const requested = ensureSidechainSpy.mock.calls.map((call) => String((call as unknown as unknown[])[1]));
        expect(requested).toEqual([SIDECHAIN_ID]);
        await screen.unmount();
    }, 240_000);

    it('refuses a main-transcript scope rather than drawing a second copy of the session', async () => {
        seedImportedSidechain();

        const screen = await testkit.renderScreen(
            <SessionTranscriptDetailsView
                scope={{ kind: 'main', sessionId: SESSION_ID }}
                testID={TEST_ID}
            />,
        );
        await testkit.flushHookEffects();

        expect(screen.findByTestId(`${TEST_ID}:unsupported`)).toBeTruthy();
        expect(ensureSidechainSpy).not.toHaveBeenCalled();
        await screen.unmount();
    }, 240_000);
});
