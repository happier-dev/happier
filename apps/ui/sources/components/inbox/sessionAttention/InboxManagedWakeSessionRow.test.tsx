import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSessionFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { activateStorageAccountScope } from '@/dev/testkit/runtime/storageRuntime';
import type { PendingMessage } from '@/sync/domains/state/storageTypes';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
// Boundaries: Action transport (Home and controller), the pending-list network read, and daemon presence.
const execute = vi.hoisted(() => vi.fn());
vi.mock('@/sync/ops/actions/defaultActionExecutor', () => ({ createDefaultActionExecutor: () => ({ execute }) }));
vi.mock('@/sync/sync', () => ({ sync: { fetchPendingMessages: vi.fn(async () => {}) } }));
vi.mock('@/components/sessions/model/useSessionMachineReachability', () => ({
    useSessionMachineReachability: () => ({ machineReachable: true, machineOnline: true, machineRpcTargetAvailable: true,
        machineReachability: 'reachable', machineLastSeenAt: null }),
}));

const { storage } = await import('@/sync/domains/state/storage');
const { InboxManagedWakeSessionRow } = await import('./InboxManagedWakeSessionRow');

const scope = { serverId: 'home-a', accountId: 'account-b' };
const controller = { machineId: 'controller', installationId: 'controller-installation' };
const target = { homeId: 'home-a', managedId: 'managed-guest', enrolledMachineId: 'm-target', expectedIntentRevision: 1, controller,
    reason: 'admitted-work', origin: { kind: 'session-input', session: { homeId: 'home-a', sessionId: 's1' },
        pendingRequestId: 'wake-message', requestedAt: 200 } } as const;
const runningGuest = { id: 'managed-guest', homeId: 'home-a', custodianAccountId: 'account-c',
    launch: { provider: { pluginId: 'custom.native', localId: 'vm' }, schemaVersion: 1, name: 'Build box', choices: {} },
    resource: { contributionRef: { pluginId: 'custom.native', localId: 'vm' }, schemaVersion: 1, value: {} },
    controller, enrolledMachineId: 'm-target', creationState: 'active', allocation: 'bound',
    desired: 'start', desiredWhen: 'now', intentRevision: 1, wakeOnAcceptedMessage: false,
    retention: { kind: 'unused', afterMs: 3600000, effect: 'stop' },
    observation: { observedAt: 10, availability: 'present', power: 'running', storage: 'retained' } };
const queued = { id: 'wake-message', localId: 'wake-message', messageRole: 'user', source: 'server_pending',
    pendingDeliveryStatus: 'server_queued', deliveryStatus: 'queued', createdAt: 200, updatedAt: 200,
    text: 'Run the tests', displayText: 'Run the tests' } as unknown as PendingMessage;
const session = createSessionFixture({ id: 's1', serverId: 'home-a', active: false, activeAt: 5,
    access: { level: 'edit', capabilities: { submitAgentInput: true } } as never,
    pendingActivationAuthorization: { status: 'failed', requestId: 'wake-message', requestedAt: 200,
        failureCode: 'runtime_start_failed', managedWakeTargetV1: target } as never });

let disposeScope: (() => void) | null = null;
afterEach(() => { disposeScope?.(); disposeScope = null; execute.mockReset(); standardCleanup(); });

async function renderRow(resumingAt: number | null) {
    disposeScope = (await activateStorageAccountScope(scope)).dispose;
    storage.setState(state => ({
        sessions: { ...state.sessions, s1: { ...session, resumingAt } },
        sessionPending: { ...state.sessionPending, s1: { messages: [queued], discarded: [], isLoaded: true } },
        // The Machine inventory has been read for this Home.
        machineListStatusByServerId: { ...state.machineListStatusByServerId, 'home-a': 'idle' },
    }) as never);
    execute.mockImplementation(async (actionId: string) => actionId === 'machines.managed.get'
        ? { ok: true, result: runningGuest } : { ok: true, result: { status: 'opened' } });
    const render = vi.fn((wake: Readonly<{ sentence: string | null; retry: React.ReactNode }>) =>
        <>{wake.sentence}{wake.retry}</>);
    const screen = await renderScreen(<InboxManagedWakeSessionRow session={storage.getState().sessions.s1!} serverId="home-a" render={render} />);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledWith('machines.managed.get', expect.anything(), expect.anything()));
    return screen;
}

describe('Inbox row for a failed managed wake', () => {
    it('offers one Retry that resumes the Session once through the shared wake recovery', async () => {
        const screen = await renderRow(null);
        await vi.waitFor(() => expect(screen.findHostByTestId('inbox.session.s1.wake_retry')).toBeTruthy());
        const button = screen.tree.root.findAll(node => node.props.testID === 'inbox.session.s1.wake_retry'
            && typeof node.props.action === 'function')[0]!;
        await act(async () => { await button.props.action(); });
        const opens = execute.mock.calls.filter(([actionId]) => actionId === 'session.open');
        expect(opens).toHaveLength(1);
        expect(opens[0]![1]).toMatchObject({ sessionId: 's1', intent: 'resume' });
    });

    it('offers no Retry while the Session is already resuming', async () => {
        const screen = await renderRow(1234);
        // Settled on the same running guest as above: the row states the resume instead of offering Retry.
        await vi.waitFor(() => expect(screen.getTextContent()).not.toContain('Loading'));
        expect(screen.getTextContent().length).toBeGreaterThan(0);
        expect(screen.findHostByTestId('inbox.session.s1.wake_retry')).toBeFalsy();
        expect(execute.mock.calls.some(([actionId]) => actionId === 'session.open')).toBe(false);
    });
});
