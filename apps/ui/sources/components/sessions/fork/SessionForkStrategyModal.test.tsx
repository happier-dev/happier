import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MACHINE_PLAIN_DATA_KEY_MARKER, SessionForkRpcResultSchema } from '@happier-dev/protocol';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installSessionActionFixture, installSessionActionRpcBoundary } from '@/dev/testkit/harness/sessionActionRpcBoundary';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const forkSessionMock = vi.hoisted(() => vi.fn());
const announceAccessibilityMessageMock = vi.hoisted(() => vi.fn());
const routerPushMock = vi.hoisted(() => vi.fn());

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        View: (props: any) => React.createElement('View', props, props.children),
        Pressable: (props: any) => React.createElement(
            'Pressable',
            props,
            typeof props.children === 'function' ? props.children({ pressed: false }) : props.children,
        ),
        Platform: { OS: 'web', select: (options: any) => options?.web ?? options?.default },
    });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});
vi.mock('@/components/ui/accessibility/announceAccessibilityMessage', () => ({
    announceAccessibilityMessage: (...args: unknown[]) => announceAccessibilityMessageMock(...args),
}));
vi.mock('expo-router', async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return { ...actual, router: { ...(actual.router as object), push: routerPushMock } };
});
let hydrateChild = true;
const outgoing = installSessionActionRpcBoundary(async request => {
    const result: unknown = await forkSessionMock(request.params);
    const fork = SessionForkRpcResultSchema.safeParse(result);
    if (hydrateChild && fork.success && fork.data.ok) installChild(fork.data.childSessionId);
    return result;
});
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
await loadSyncSingletonForTests();
const restoreExecutorLoader = await installRealActionExecutorModuleLoader();
afterAll(restoreExecutorLoader);
const { storage } = await import('@/sync/domains/state/storage');
const { createServerFetchAtEndpoint } = await import('@/sync/http/client');
const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
const { resetScopedMachineTransportCacheForTests } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool');
const { resetSessionDraftRepositoryForTests } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
const { SessionForkStrategyModal } = await import('./SessionForkStrategyModal');
const originalState = storage.getState();
let serverId = '';
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let webLocks: ReturnType<typeof installWebLockManagerMock> | undefined;

function installChild(sessionId: string) {
    installSessionActionFixture({ homes, storage, serverId, session: { id: sessionId,
        metadata: { path: '/repo', host: 'tester.local', machineId: 'machine_1', flavor: 'codex',
            forkV1: { v: 1, parentSessionId: 'parent_1', parentCutoffSeqInclusive: 12, createdAtMs: 1, strategy: 'replay' } } } });
}

const REQUEST = {
    parentSessionId: 'parent_1',
    serverId: 'server_1',
    machineId: 'machine_1',
    forkPoint: { type: 'seq', upToSeqInclusive: 12 },
} as const;

/**
 * The card's own subtitle, read off the row component rather than off a
 * composed accessibility label: only one of the two trees generates that label,
 * and the subtitle IS the rendered explanation in both.
 */
function readRowSubtitle(screen: { findAllByTestId: (testID: string) => Array<{ props?: Record<string, unknown> }> }, testID: string) {
    return screen.findAllByTestId(testID)
        .map((node) => node.props?.subtitle)
        .find((value) => typeof value === 'string') ?? null;
}

async function renderModal(overrides?: Partial<React.ComponentProps<typeof SessionForkStrategyModal>>) {
    const onClose = vi.fn();
    const onConfigureNewSession = vi.fn();
    const navigate = vi.fn();
    const screen = await renderScreen(
        <SessionForkStrategyModal
            onClose={onClose}
            request={{ ...REQUEST, serverId }}
            availability={{ native: true, replay: true, configure: true, nativeUnavailableReason: null }}
            navigate={navigate}
            navigation={{ push: routerPushMock }}
            onConfigureNewSession={onConfigureNewSession}
            {...overrides}
        />,
    );
    const availability = overrides?.availability ?? { native: true, replay: true, configure: true };
    const readyRoute = availability.native ? 'native' : availability.replay ? 'replay'
        : availability.configure && overrides?.onConfigureNewSession !== null ? 'configure' : null;
    if (readyRoute) await vi.waitFor(() => expect(screen.findByTestId(`session-fork-strategy-${readyRoute}`)?.props.disabled).not.toBe(true));
    return { screen, onClose, onConfigureNewSession, navigate };
}

beforeEach(async () => {
    webLocks = installWebLockManagerMock();
    storage.setState(originalState, true);
    await homes.reset();
    serverId = await homes.addHome({ name: 'Fork Home', serverUrl: 'https://fork-modal.test', accountId: 'alice' });
    connection = await restoreServerAccountForTest({ serverUrl: 'https://fork-modal.test', accountId: 'alice', request: async (url, init) => {
        const endpoint = new URL(String(url));
        const token = new Headers(init?.headers).get('Authorization')?.replace(/^Bearer /, '');
        return createServerFetchAtEndpoint({ endpointUrl: endpoint.origin, ...(token ? { credentials: { token } } : {}) })(`${endpoint.pathname}${endpoint.search}`, init);
    } });
    storage.getState().activateProfileScope({ serverId, accountId: 'alice' });
    await storage.getState().activateSettingsScope({ serverId, accountId: 'alice' });
    homes.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
    storage.getState().applySettingsLocal({ sessionReplayEnabled: true });
    const machine = createMachineFixture({ id: 'machine_1' });
    storage.setState({ machines: { [machine.id]: machine }, machineListByServerId: { [serverId]: [machine] } });
    homes.answer(serverId, '/v1/machines/machine_1', { body: { machine: { id: machine.id, kind: 'persistent', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER } } });
    installSessionActionFixture({ homes, storage, serverId, session: { id: 'parent_1' } });
    outgoing.length = 0;
    hydrateChild = true;
    forkSessionMock.mockReset();
    announceAccessibilityMessageMock.mockReset();
    routerPushMock.mockReset();
});

afterEach(async () => {
    await standardCleanup();
    resetSessionDraftRepositoryForTests();
    await connection?.dispose();
    connection = undefined;
    serverScopedRpcSocketPool.resetForTests();
    resetScopedMachineTransportCacheForTests();
    await homes.reset();
    storage.setState(originalState, true);
    webLocks?.restore();
    webLocks = undefined;
    vi.restoreAllMocks();
});

describe('SessionForkStrategyModal', () => {
    it('offers every available route before any fork effect', async () => {
        const { screen } = await renderModal();
        expect(screen.findByTestId('session-fork-strategy-native')).toBeTruthy();
        expect(screen.findByTestId('session-fork-strategy-replay')).toBeTruthy();
        expect(screen.findByTestId('session-fork-strategy-configure')).toBeTruthy();
        expect(screen.findByTestId('session-fork-strategy-status')).toBeNull();
        expect(forkSessionMock).not.toHaveBeenCalled();
    });

    it('presents the existing approval notice instead of an unknown fork and keeps routes inert', async () => {
        await homes.requireUiApproval(serverId, 'session.fork');
        const { screen, onClose, navigate } = await renderModal();
        await act(async () => { screen.findByTestId('session-fork-strategy-replay')?.props.onPress(); });
        await vi.waitFor(() => expect(screen.findByTestId('session-fork-strategy-approval')).toBeTruthy());
        expect(screen.findByTestId('session-fork-strategy-check')).toBeNull();
        expect(screen.findByTestId('session-fork-strategy-native')?.props.disabled).toBe(true);
        expect(screen.findByTestId('session-fork-strategy-replay')?.props.disabled).toBe(true);
        expect(screen.findByTestId('session-fork-strategy-configure')?.props.disabled).toBe(true);
        expect(outgoing).toEqual([]);
        expect(navigate).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();
    });

    it('keeps a long source quotation bounded so the strategy choices stay above the fold', async () => {
        const { screen } = await renderModal({ sourcePreview: 'q'.repeat(400) });
        const quote = screen.findByTestId('session-fork-strategy-source-preview');
        expect(quote).toBeTruthy();
        // Unbounded, a 200%-dynamic-type reader gets a wall of their own quoted
        // text before any choice is reachable.
        expect(quote?.props.numberOfLines).toBe(2);
        expect(String(quote?.props.children ?? '').length).toBeLessThanOrEqual(120);
    });

    it('disables the native route with its reason instead of omitting the card', async () => {
        const { screen } = await renderModal({
            availability: {
                native: false,
                replay: true,
                configure: true,
                nativeUnavailableReason: 'agent_unsupported',
            },
        });
        const native = screen.findByTestId('session-fork-strategy-native');
        // Omitting the card taught the reader nothing about why the route they
        // came for is missing, and the same omission logic deleted the entry
        // points themselves.
        expect(native).toBeTruthy();
        expect(native?.props.disabled).toBe(true);
        expect(readRowSubtitle(screen, 'session-fork-strategy-native'))
            .toBe('session.forking.strategy.unavailable.nativeAgent');
        expect(screen.findByTestId('session-fork-strategy-replay')?.props.disabled).toBeFalsy();
        expect(screen.findByTestId('session-fork-strategy-replay-settings')).toBeNull();
    });

    it('names the exact reason a Codex message cutoff cannot fork natively', async () => {
        const { screen } = await renderModal({
            availability: {
                native: false,
                replay: true,
                configure: true,
                nativeUnavailableReason: 'agent_conversation_only',
            },
        });
        expect(readRowSubtitle(screen, 'session-fork-strategy-native'))
            .toBe('session.forking.strategy.unavailable.nativeFromMessage');
    });

    it('keeps both same-engine cards, greyed with reasons, for a Claude Session with Replay off', async () => {
        // The plan's live-matrix case that had never been run: native fork
        // unsupported AND `sessionReplayEnabled` off. Every entry point used to
        // delete itself, so this modal could not be reached at all.
        const { screen } = await renderModal({
            availability: {
                native: false,
                replay: false,
                configure: true,
                nativeUnavailableReason: 'agent_unsupported',
            },
        });

        expect(screen.findByTestId('session-fork-strategy-native')?.props.disabled).toBe(true);
        expect(screen.findByTestId('session-fork-strategy-replay')?.props.disabled).toBe(true);
        expect(readRowSubtitle(screen, 'session-fork-strategy-replay'))
            .toBe('session.forking.strategy.unavailable.replayOff');
        // Configure is the one route left, and it must still be takeable.
        expect(screen.findByTestId('session-fork-strategy-configure')?.props.disabled).toBeFalsy();
        expect(forkSessionMock).not.toHaveBeenCalled();
    });

    it('sends the reader to the setting that is the only thing closing Replay', async () => {
        const { screen, onClose } = await renderModal({
            availability: {
                native: true,
                replay: false,
                configure: false,
                nativeUnavailableReason: null,
            },
        });
        const settings = screen.findByTestId('session-fork-strategy-replay-settings');
        expect(settings).toBeTruthy();

        await act(async () => { settings?.props.onPress(); });
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(routerPushMock).toHaveBeenCalledWith('/(app)/settings/session/resume');
    });

    it('shows progress on the chosen route and disables the others, without a fabricated percentage', async () => {
        let release: ((value: unknown) => void) | null = null;
        forkSessionMock.mockReturnValue(new Promise((resolve) => { release = resolve; }));
        const { screen, onClose } = await renderModal();

        await act(async () => {
            screen.findByTestId('session-fork-strategy-native')?.props.onPress();
            await Promise.resolve();
        });

        expect(screen.findByTestId('session-fork-strategy-native')?.props.accessibilityState?.busy)
            .toBe(true);
        expect(screen.findByTestId('session-fork-strategy-replay')?.props.disabled).toBe(true);
        expect(screen.findByTestId('session-fork-strategy-configure')?.props.disabled).toBe(true);
        expect(screen.findByTestId('session-fork-strategy-status')).toBeTruthy();
        // Indeterminate only: the client cannot know a percentage, so no node
        // may publish a determinate progress value.
        expect(screen.tree.root.findAll(
            (node) => node.props?.accessibilityValue?.now !== undefined,
        )).toHaveLength(0);

        await act(async () => {
            release?.({ ok: true, childSessionId: 'child_1' });
            await Promise.resolve();
        });
        await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    });

    it('announces progress and outcome through the canonical announcement owner on every platform', async () => {
        let release: ((value: unknown) => void) | null = null;
        forkSessionMock.mockReturnValue(new Promise((resolve) => { release = resolve; }));
        const { screen } = await renderModal();

        await act(async () => {
            screen.findByTestId('session-fork-strategy-native')?.props.onPress();
            await Promise.resolve();
        });
        // A visible-node live region is Android/web only, so the state a blind
        // user most needs — an in-flight effect, then an unconfirmed outcome —
        // would be silent on iOS without the canonical announcer.
        expect(announceAccessibilityMessageMock).toHaveBeenCalledWith(
            'session.forking.strategy.progress.creatingNative',
        );

        await act(async () => {
            release?.({ ok: false, errorCode: 'SESSION_WEBHOOK_TIMEOUT', errorMessage: 'timed out' });
            await Promise.resolve();
        });
        await vi.waitFor(() => expect(announceAccessibilityMessageMock).toHaveBeenCalledWith(
            expect.stringContaining('session.forking.strategy.unknown'),
        ));
    });

    it('announces a definite failure so it is not a sighted-only signal', async () => {
        forkSessionMock.mockResolvedValue({ ok: false, errorCode: 'SPAWN_FAILED', errorMessage: 'boom' });
        const { screen } = await renderModal();
        await act(async () => {
            await screen.findByTestId('session-fork-strategy-native')?.props.onPress();
        });
        await vi.waitFor(() => expect(announceAccessibilityMessageMock).toHaveBeenCalledWith('boom'));
    });

    it('ignores a duplicate press on the route already in flight', async () => {
        let release: ((value: unknown) => void) | undefined;
        forkSessionMock.mockReturnValue(new Promise(resolve => { release = resolve; }));
        const { screen } = await renderModal();
        await act(async () => {
            screen.findByTestId('session-fork-strategy-replay')?.props.onPress();
            await Promise.resolve();
        });
        await act(async () => {
            screen.findByTestId('session-fork-strategy-replay')?.props.onPress();
            await Promise.resolve();
        });
        await vi.waitFor(() => expect(forkSessionMock).toHaveBeenCalledTimes(1));
        release?.({ ok: false, errorCode: 'SPAWN_FAILED', errorMessage: 'failed' });
        await vi.waitFor(() => expect(screen.findByTestId('session-fork-strategy-failure')).toBeTruthy());
    });

    it('closes itself once the child has been navigated to', async () => {
        forkSessionMock.mockResolvedValue({ ok: true, childSessionId: 'child_1' });
        const { screen, onClose } = await renderModal();
        await act(async () => {
            await screen.findByTestId('session-fork-strategy-replay')?.props.onPress();
        });
        await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    });

    it('renders a definite failure inline and lets the user choose again', async () => {
        forkSessionMock.mockResolvedValue({ ok: false, errorCode: 'SPAWN_FAILED', errorMessage: 'boom' });
        const { screen } = await renderModal();
        await act(async () => {
            await screen.findByTestId('session-fork-strategy-native')?.props.onPress();
        });

        await vi.waitFor(() => expect(screen.findByTestId('session-fork-strategy-failure')).toBeTruthy());
        expect(screen.findByTestId('session-fork-strategy-native')?.props.disabled).toBeFalsy();
        expect(screen.findByTestId('session-fork-strategy-replay')?.props.disabled).toBeFalsy();
        expect(screen.findByTestId('session-fork-strategy-check')).toBeNull();
    });

    it('offers a check instead of a retry when the outcome is unknown', async () => {
        forkSessionMock.mockResolvedValue({
            ok: false, errorCode: 'SESSION_WEBHOOK_TIMEOUT', errorMessage: 'timed out',
        });
        const { screen } = await renderModal();
        await act(async () => {
            await screen.findByTestId('session-fork-strategy-replay')?.props.onPress();
        });

        await vi.waitFor(() => expect(screen.findByTestId('session-fork-strategy-check')).toBeTruthy());
        expect(screen.findByTestId('session-fork-strategy-status')).toBeTruthy();
        // Both same-engine routes stay inert: resubmitting could duplicate the fork.
        expect(screen.findByTestId('session-fork-strategy-native')?.props.disabled).toBe(true);
        expect(screen.findByTestId('session-fork-strategy-replay')?.props.disabled).toBe(true);

        await act(async () => {
            await screen.findByTestId('session-fork-strategy-check')?.props.onPress();
        });
        expect(forkSessionMock).toHaveBeenCalledTimes(1);
    });

    it('leaves for New Session and closes without starting a second progress surface', async () => {
        const { screen, onClose, onConfigureNewSession } = await renderModal();
        await act(async () => {
            screen.findByTestId('session-fork-strategy-configure')?.props.onPress();
        });
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(onConfigureNewSession).toHaveBeenCalledTimes(1);
        expect(forkSessionMock).not.toHaveBeenCalled();
    });

    it('offers the same-engine routes with no Configure item when continuation is not offered', async () => {
        // The closed `sessions.agentSwitching` state narrows this modal instead
        // of emptying it: the fork routes that predate the feature stay, so the
        // reader who opened it still has something to choose.
        const { screen } = await renderModal({ onConfigureNewSession: null });
        expect(screen.findByTestId('session-fork-strategy-configure')).toBeNull();
        expect(screen.findByTestId('session-fork-strategy-native')).toBeTruthy();
        expect(screen.findByTestId('session-fork-strategy-replay')).toBeTruthy();
    });

    it('keeps the created child openable when hydration has not caught up', async () => {
        forkSessionMock.mockResolvedValue({ ok: true, childSessionId: 'child_1' });
        hydrateChild = false;
        homes.answer(serverId, '/v2/sessions/child_1?accessProjectionVersion=1', { status: 404, body: { error: 'not_found' } });
        const { screen, onClose } = await renderModal();
        await act(async () => {
            await screen.findByTestId('session-fork-strategy-native')?.props.onPress();
        });

        expect(onClose).not.toHaveBeenCalled();
        await vi.waitFor(() => expect(screen.findByTestId('session-fork-strategy-open')).toBeTruthy());
        const openButton = screen.findByTestId('session-fork-strategy-open');
        expect(openButton).toBeTruthy();

        installChild('child_1');
        await act(async () => { await openButton?.props.onPress(); });
        await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    });
});
