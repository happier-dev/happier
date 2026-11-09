/**
 * F-UI-11 perf ship-gate host proof (L5 T1.3), on the REAL AgentInput.
 *
 * The claim: after the strip extraction, a usage tick (context snapshot change
 * in the store) re-renders ONLY the SessionInstrumentStrip — the memoized
 * 3k-line AgentInput body does NOT re-execute, because no per-tick prop exists.
 *
 * Probe: count the native TextInput renderer boundary under the real
 * MultiTextInput. The positive control proves a usage-bearing composer prop
 * reaches that boundary, while a strip-local tick leaves it unchanged.
 *
 * The second case is the permanent positive control (the RED mechanism): the
 * SAME tick delivered as an AgentInput prop DOES re-render the body, proving
 * the probe bites and the flat count in case one is not vacuous.
 */
import 'fake-indexeddb/auto';
import React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen as renderTestScreen, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installSessionActionFixture, installSessionActionRpcBoundary } from '@/dev/testkit/harness/sessionActionRpcBoundary';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installBrowserStorageLockBoundary } from '@/dev/testkit/harness/browserStorageLockBoundary';
import type { ComposerSuggestionKindId } from '@/components/autocomplete/composerSuggestionKinds';
import type { SessionContextUsageSnapshotV1 } from '@happier-dev/protocol/usage/contextUsage';
import type { Session } from '@/sync/domains/state/storageTypes';

const renderCounts = vi.hoisted(() => ({ multiTextInput: 0 }));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
// The composer input is the probe: count renders of the real editor component without replacing it.
vi.mock('@/components/ui/forms/MultiTextInput', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/components/ui/forms/MultiTextInput')>();
    const Measured = React.forwardRef<unknown, Record<string, unknown>>(function MeasuredMultiTextInput(props, ref) {
        renderCounts.multiTextInput += 1;
        return React.createElement(actual.MultiTextInput as React.ElementType, { ...props, ref });
    });
    return { ...actual, MultiTextInput: Measured };
});
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('react-native-keyboard-controller', () => ({ useFocusedInputHandler: () => {} }));

const { JSDOM } = await import('jsdom');
const browser = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://composer-perf.test' });
function installBrowserBoundary() {
    for (const name of ['window', 'document', 'HTMLElement', 'Node', 'MutationObserver', 'CustomEvent', 'navigator'] as const) {
        vi.stubGlobal(name, name === 'window' ? browser.window : browser.window[name]);
    }
}
installBrowserBoundary();
afterAll(() => browser.window.close());

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installSessionActionRpcBoundary(() => { throw new Error('Unexpected composer RPC'); });
const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
await loadSyncSingletonForTests();
const { AgentInput } = await import('./AgentInput');
const { getStorage, useSessionUsage } = await import('@/sync/domains/state/storage');
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
const { ModalProvider } = await import('@/modal');
const { sync } = await import('@/sync/sync');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');
const initialStorageState = getStorage().getState();
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let releaseLocks: (() => void) | undefined;

function ComposerAccountBoundary({ children }: React.PropsWithChildren) {
    if (!connection) throw new Error('Composer Account is not restored');
    return <InjectedAuthProvider credentials={connection.credentials}><ModalProvider>{children}</ModalProvider></InjectedAuthProvider>;
}

function renderScreen(element: React.ReactElement) {
    return renderTestScreen(element, {
        wrapper: ComposerAccountBoundary,
        createNodeMock: element => element.type === 'TextInput' ? {
            setNativeProps() {}, focus() {}, blur() {},
            measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => callback(0, 0, 300, 100),
        } : null,
    });
}

beforeEach(async () => {
    installBrowserBoundary();
    releaseLocks = installBrowserStorageLockBoundary();
    await homes.reset();
    getStorage().setState(initialStorageState, true);
    const serverId = await homes.addHome({ name: 'Composer perf', serverUrl: 'https://composer-perf.test', accountId: 'composer-account', currentAccount: true });
    const credentials = await TokenStorage.getCredentialsForServerUrl('https://composer-perf.test');
    if (!credentials) throw new Error('The composer Home did not restore its Account');
    connection = await restoreServerAccountForTest({ serverUrl: 'https://composer-perf.test', accountId: 'composer-account', credentials, request: homes.request });
    await sync.awaitBootstrapForegroundAcquisition();
    const scope = { serverId, accountId: 'composer-account' };
    getStorage().setState({ settingsScope: scope, profileScope: scope });
    const state = getStorage().getState();
    state.applySettingsForScope(scope, { ...state.settings, contextGaugeStyle: 'gauge',
        agentInputEnterToSend: true, agentInputActionBarLayout: 'wrap', agentInputChipDensity: 'labels' }, (state.settingsVersion ?? 0) + 1);
    installSessionActionFixture({ homes, storage: getStorage(), serverId,
        session: { id: 's-perf', latestUsage: usageTick(80_000) } });
    renderCounts.multiTextInput = 0;
});
afterEach(async () => {
    standardCleanup();
    await connection?.dispose();
    connection = undefined;
    await homes.reset();
    releaseLocks?.(); releaseLocks = undefined;
    getStorage().setState(initialStorageState, true);
});

function contextSnapshot(usedTokens: number): SessionContextUsageSnapshotV1 {
    return {
        v: 1,
        modelId: null,
        usedTokens,
        windowTokens: 200_000,
        totalProcessedTokens: null,
        baselineTokens: null,
        isAutoCompactEnabled: null,
        categories: null,
        observedAtMs: 1,
        source: 'provider_turn',
    };
}

function usageTick(usedTokens: number): NonNullable<Session['latestUsage']> {
    return {
        inputTokens: usedTokens,
        outputTokens: 0,
        cacheCreation: 0,
        cacheRead: 0,
        contextSize: usedTokens,
        contextSnapshot: contextSnapshot(usedTokens),
        contextSnapshotStale: false,
        timestamp: 1,
    };
}

function publishUsage(usedTokens: number) {
    getStorage().setState(state => {
        const session = state.sessions['s-perf'];
        if (!session) throw new Error('The performance Session fixture is not installed');
        return { sessions: { ...state.sessions, 's-perf': { ...session, latestUsage: usageTick(usedTokens) } } };
    });
}

const BASE_PROPS = {
    value: '',
    placeholder: 'Type',
    onChangeText: () => {},
    onSend: () => {},
    autocompleteKinds: [] as ComposerSuggestionKindId[],
    autocompleteSuggestions: async () => [],
} as const;

describe('AgentInput instrument-strip perf (F-UI-11 ship gate, host half)', () => {
    it('usage ticks update the strip WITHOUT re-executing the real AgentInput body', async () => {
        const screen = await renderScreen(
            <AgentInput sessionId="s-perf" {...BASE_PROPS} />,
        );

        // Sanity: the strip rendered the gauge from the store subscription.
        expect(screen.findByTestId('session-instrument-context-gauge')).toBeTruthy();
        const baseline = renderCounts.multiTextInput;
        expect(baseline).toBeGreaterThan(0); // probe wired

        // Two streaming token ticks through the REAL store seam.
        act(() => publishUsage(100_000)); // 50%
        act(() => publishUsage(120_000)); // 60%

        // The strip updated (fresh % visible)…
        const hasText = (needle: string) => screen.root.findAll((node) => {
            const children = node.props?.children;
            return children === needle
                || (Array.isArray(children) && children.some((child: unknown) => child === needle));
        }).length > 0;
        expect(hasText('60%')).toBe(true);
        // …while the 3k-line composer body never re-executed.
        expect(renderCounts.multiTextInput).toBe(baseline);
    });

    it('turn-state churn: a stable (useEventCallback) onSend keeps the body flat across parent re-renders', async () => {
        const { useEventCallback } = await import('@/hooks/ui/useEventCallback');

        // Mirrors the SessionView R1 fix: the parent re-renders on every
        // turn-state commit, but onSend is a permanently-stable wrapper that
        // forwards to the latest closure — so AgentInput's memo must hold.
        let commitTurnState: (() => void) | null = null;
        function TurnStateParent() {
            const [turnState, setTurnState] = React.useState('idle');
            commitTurnState = () => setTurnState((current) => (current === 'idle' ? 'streaming' : 'idle'));
            // The closure closes over changing turn state, yet the identity is stable.
            const onSend = useEventCallback(() => { void turnState; });
            return <AgentInput sessionId="s-perf" {...BASE_PROPS} onSend={onSend} />;
        }

        await renderScreen(<TurnStateParent />);
        const baseline = renderCounts.multiTextInput;
        expect(baseline).toBeGreaterThan(0);

        act(() => commitTurnState?.());
        act(() => commitTurnState?.());

        // Parent re-rendered on turn-state changes, but the composer body did not.
        expect(renderCounts.multiTextInput).toBe(baseline);
    });

    it('positive control: the SAME tick as an AgentInput prop DOES re-render the body (probe bites)', async () => {
        // Pre-fix shape: a parent subscribes and forwards a per-tick prop —
        // exactly what the removed `usageData` prop used to do.
        function LegacyPropPlumbing() {
            const usage = useSessionUsage('s-perf');
            return (
                <AgentInput
                    sessionId="s-perf"
                    {...BASE_PROPS}
                    placeholder={`ctx:${usage?.contextSize ?? 0}`}
                />
            );
        }

        await renderScreen(<LegacyPropPlumbing />);
        const baseline = renderCounts.multiTextInput;
        expect(baseline).toBeGreaterThan(0);

        act(() => publishUsage(120_000));

        expect(renderCounts.multiTextInput).toBeGreaterThan(baseline);
    });
});
