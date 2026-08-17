import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const forkSessionMock = vi.hoisted(() => vi.fn());
const announceAccessibilityMessageMock = vi.hoisted(() => vi.fn());
const completeSessionForkNavigationMock = vi.hoisted(() => vi.fn());
const refreshSessionsMock = vi.hoisted(() => vi.fn());
const sessionsRef = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));

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
vi.mock('@/sync/ops', () => ({ forkSession: forkSessionMock }));
vi.mock('@/components/ui/accessibility/announceAccessibilityMessage', () => ({
    announceAccessibilityMessage: (...args: unknown[]) => announceAccessibilityMessageMock(...args),
}));
vi.mock('@/sync/domains/sessionFork/completeSessionForkNavigation', () => ({
    completeSessionForkNavigation: completeSessionForkNavigationMock,
}));
vi.mock('@/sync/sync', () => ({ sync: { refreshSessions: refreshSessionsMock } }));
vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        storage: { getState: () => ({ sessions: sessionsRef.current }) } as any,
        useLocalSetting: () => null,
        useSetting: () => null,
    });
});

import { SessionForkStrategyModal } from './SessionForkStrategyModal';

const REQUEST = {
    parentSessionId: 'parent_1',
    serverId: 'server_1',
    machineId: 'machine_1',
    forkPoint: { type: 'seq', upToSeqInclusive: 12 },
} as const;

async function renderModal(overrides?: Partial<React.ComponentProps<typeof SessionForkStrategyModal>>) {
    const onClose = vi.fn();
    const onConfigureNewSession = vi.fn();
    const navigate = vi.fn();
    const screen = await renderScreen(
        <SessionForkStrategyModal
            onClose={onClose}
            request={REQUEST as any}
            availability={{ native: true, replay: true }}
            navigate={navigate}
            onConfigureNewSession={onConfigureNewSession}
            {...(overrides as any)}
        />,
    );
    return { screen, onClose, onConfigureNewSession, navigate };
}

beforeEach(() => {
    forkSessionMock.mockReset();
    announceAccessibilityMessageMock.mockReset();
    completeSessionForkNavigationMock.mockReset();
    completeSessionForkNavigationMock.mockResolvedValue(undefined);
    refreshSessionsMock.mockReset();
    refreshSessionsMock.mockResolvedValue(undefined);
    sessionsRef.current = {};
});

afterEach(async () => {
    await standardCleanup();
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

    it('keeps a long source quotation bounded so the strategy choices stay above the fold', async () => {
        const { screen } = await renderModal({ sourcePreview: 'q'.repeat(400) });
        const quote = screen.findByTestId('session-fork-strategy-source-preview');
        expect(quote).toBeTruthy();
        // Unbounded, a 200%-dynamic-type reader gets a wall of their own quoted
        // text before any choice is reachable.
        expect(quote?.props.numberOfLines).toBe(2);
        expect(String(quote?.props.children ?? '').length).toBeLessThanOrEqual(120);
    });

    it('hides the native route when this Session and cutoff cannot fork natively', async () => {
        const { screen } = await renderModal({ availability: { native: false, replay: true } });
        expect(screen.findByTestId('session-fork-strategy-native')).toBeNull();
        expect(screen.findByTestId('session-fork-strategy-replay')).toBeTruthy();
    });

    it('shows progress on the chosen route and disables the others, without a fabricated percentage', async () => {
        let release: ((value: unknown) => void) | null = null;
        forkSessionMock.mockReturnValue(new Promise((resolve) => { release = resolve; }));
        const { screen } = await renderModal();

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
        expect(announceAccessibilityMessageMock).toHaveBeenCalledWith(
            expect.stringContaining('session.forking.strategy.unknown'),
        );
    });

    it('announces a definite failure so it is not a sighted-only signal', async () => {
        forkSessionMock.mockResolvedValue({ ok: false, errorCode: 'SPAWN_FAILED', errorMessage: 'boom' });
        const { screen } = await renderModal();
        await act(async () => {
            await screen.findByTestId('session-fork-strategy-native')?.props.onPress();
        });
        expect(announceAccessibilityMessageMock).toHaveBeenCalledWith('boom');
    });

    it('ignores a duplicate press on the route already in flight', async () => {
        forkSessionMock.mockReturnValue(new Promise(() => {}));
        const { screen } = await renderModal();
        await act(async () => {
            screen.findByTestId('session-fork-strategy-replay')?.props.onPress();
            await Promise.resolve();
        });
        await act(async () => {
            screen.findByTestId('session-fork-strategy-replay')?.props.onPress();
            await Promise.resolve();
        });
        expect(forkSessionMock).toHaveBeenCalledTimes(1);
    });

    it('closes itself once the child has been navigated to', async () => {
        forkSessionMock.mockResolvedValue({ ok: true, childSessionId: 'child_1' });
        const { screen, onClose } = await renderModal();
        await act(async () => {
            await screen.findByTestId('session-fork-strategy-replay')?.props.onPress();
        });
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('renders a definite failure inline and lets the user choose again', async () => {
        forkSessionMock.mockResolvedValue({ ok: false, errorCode: 'SPAWN_FAILED', errorMessage: 'boom' });
        const { screen } = await renderModal();
        await act(async () => {
            await screen.findByTestId('session-fork-strategy-native')?.props.onPress();
        });

        expect(screen.findByTestId('session-fork-strategy-failure')).toBeTruthy();
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

        expect(screen.findByTestId('session-fork-strategy-check')).toBeTruthy();
        expect(screen.findByTestId('session-fork-strategy-status')).toBeTruthy();
        // Both same-engine routes stay inert: resubmitting could duplicate the fork.
        expect(screen.findByTestId('session-fork-strategy-native')?.props.disabled).toBe(true);
        expect(screen.findByTestId('session-fork-strategy-replay')?.props.disabled).toBe(true);

        await act(async () => {
            await screen.findByTestId('session-fork-strategy-check')?.props.onPress();
        });
        expect(refreshSessionsMock).toHaveBeenCalledTimes(1);
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
        completeSessionForkNavigationMock.mockRejectedValueOnce(new Error('not visible locally'));
        const { screen, onClose } = await renderModal();
        await act(async () => {
            await screen.findByTestId('session-fork-strategy-native')?.props.onPress();
        });

        expect(onClose).not.toHaveBeenCalled();
        const openButton = screen.findByTestId('session-fork-strategy-open');
        expect(openButton).toBeTruthy();

        completeSessionForkNavigationMock.mockResolvedValueOnce(undefined);
        await act(async () => { await openButton?.props.onPress(); });
        expect(onClose).toHaveBeenCalledTimes(1);
    });
});
