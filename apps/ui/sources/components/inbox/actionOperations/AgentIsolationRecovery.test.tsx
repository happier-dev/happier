import * as React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, createMachineFixture, flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { publishMachineInventoryForTest } from '@/dev/testkit/harness/machinePresence';
import { MachineAgentIsolationPreviewResultV1Schema } from '@happier-dev/protocol';
import registeredPreviews from '../../../../../../packages/tests/fixtures/machines/agentIsolationRecoveryPreviews.json';

const rpc = vi.hoisted(() => ({ machine: vi.fn() }));
// Only Home HTTP/socket and the native daemon RPC are replaced. The modal,
// Action front door, scope admission, recovery push and projection remain real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    return createServerScopedMachineRpcBoundaryMock(rpc.machine);
});
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({ translate: key => key }));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ router: { push: vi.fn() } }).module);

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { actionOperationStore } = await import('@/sync/domains/actionOperations/actionOperationStore');
const { createActionOperationSelectors } = await import('@/sync/domains/actionOperations/actionOperationSelectors');
const { clearMachineRequestReachabilityForMachine } = await import('@/sync/domains/machines/reachability/machineReachability');
const { ActionOperationDetailModal } = await import('./ActionOperationDetailModal');

beforeEach(async () => { await homes.reset(); await loadSyncSingletonForTests(); rpc.machine.mockReset(); actionOperationStore.reset(); });
afterEach(async () => { standardCleanup(); vi.useRealTimers(); actionOperationStore.reset(); await homes.reset(); });

// agentIsolationRecoveryPreview.test.ts verifies these shared captures against the
// registered daemon producer; only the opaque plan digest is redacted.
it.each([
    ['qualificationPending', 'needs'],
    ['effective', 'satisfied'],
] as const)('CHECKs the registered %s successor once on reconnect, projects %s, and never polls or invents old-operation success', async (name, expected) => {
    const accountId = 'owner', machineId = 'isolated-machine';
    const serverId = await homes.addHome({ name: 'Isolation Home', serverUrl: 'https://isolation-recovery.test', accountId, currentAccount: true });
    const base = createMachineFixture();
    await publishMachineInventoryForTest({ serverId, accountId }, [createMachineFixture({ id: machineId, installationId: 'installation',
        metadata: { ...base.metadata!, agentIsolation: { enabled: true } },
        daemonState: { status: 'running', runtimeId: 'successor' }, active: true, activeAt: Date.now() })]);
    actionOperationStore.mergeSnapshots({ serverId, snapshots: [{ version: 1, operationId: 'refresh-operation', requestId: 'original-request',
        revision: 2, actionId: 'machines.agentIsolation.set', state: 'running', scope: { accountId, machineId },
        title: 'Change Agent isolation', createdAt: 1000, startedAt: 1100, cancellation: 'unsupported',
        observation: { kind: 'outcome_uncertain', code: 'action_outcome_unknown' } }] });
    const preview = MachineAgentIsolationPreviewResultV1Schema.parse(registeredPreviews[name]);
    let connected = false;
    rpc.machine.mockImplementation(async () => {
        if (!connected) throw Object.assign(new Error('Daemon restarting'), { rpcErrorCode: 'MACHINE_RPC_UNREACHABLE' });
        return preview;
    });
    const screen = await renderScreen(<ActionOperationDetailModal serverId={serverId} operationId="refresh-operation" onClose={vi.fn()} />);
    try {
        await flushHookEffects();
        const initialReads = rpc.machine.mock.calls.length;
        connected = true;
        clearMachineRequestReachabilityForMachine({ serverId, accountId: 'another-account' }, machineId);
        await flushHookEffects();
        expect(rpc.machine).toHaveBeenCalledTimes(initialReads);
        await act(async () => {
            for (let wake = 0; wake < 100; wake++) clearMachineRequestReachabilityForMachine({ serverId, accountId }, machineId);
            await vi.waitFor(() => expect(rpc.machine).toHaveBeenCalledTimes(initialReads + 1));
        });
        const retained = createActionOperationSelectors().selectById(actionOperationStore.getSnapshot(), { serverId, operationId: 'refresh-operation' });
        expect(retained).toMatchObject({ snapshot: { state: 'running', observation: { kind: 'outcome_uncertain' } },
            agentIsolationRecovery: { enabled: true, preview } });
        await flushHookEffects();
        expect(screen.findByTestId('action-operation-isolation-retry') !== null).toBe(expected === 'needs');
        expect(screen.getTextContent()).toContain(expected === 'needs'
            ? 'inbox.actionOperations.isolationRecovery.needsTitle' : 'inbox.actionOperations.isolationRecovery.onTitle');
        expect(screen.getTextContent()).not.toContain('inbox.actionOperations.isolationRecovery.unavailableTitle');
        expect(screen.getTextContent()).toContain('inbox.actionOperations.isolationRecovery.receiptChecked');
        const beforeEqual = actionOperationStore.getSnapshot();
        await act(async () => actionOperationStore.reobserveMachineAgentIsolation({ serverId, accountId, machineId, operationId: 'refresh-operation',
            recovery: { enabled: true, preview: structuredClone(preview) } }));
        expect(actionOperationStore.getSnapshot()).toBe(beforeEqual);
        await act(async () => actionOperationStore.mergeSnapshots({ serverId, snapshots: [{ ...retained!.snapshot, revision: 3 }] }));
        expect(createActionOperationSelectors().selectById(actionOperationStore.getSnapshot(), { serverId, operationId: 'refresh-operation' }))
            .toMatchObject({ snapshot: { revision: 3, observation: { kind: 'outcome_uncertain' } }, agentIsolationRecovery: { enabled: true, preview } });
        vi.useFakeTimers();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(rpc.machine).toHaveBeenCalledTimes(initialReads + 1);
        expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); await screen.unmount(); }
    clearMachineRequestReachabilityForMachine({ serverId, accountId }, machineId);
    await flushHookEffects();
    expect(rpc.machine).toHaveBeenCalledTimes(2);
});

// REVIEW-SIMPLICITY-1105: an admitted Account-bound CHECK finishes; Machine
// withdrawal is evaluated at the next admission, not again after the answer.
it.each(['revoked', 'locked', 'replaced', 'missing'] as const)('publishes the admitted CHECK when the Machine becomes %s while it is pending', async change => {
    const accountId = 'owner', machineId = 'revoked-isolation-machine';
    const serverId = await homes.addHome({ name: 'Revoked Home', serverUrl: 'https://isolation-revoked.test', accountId, currentAccount: true });
    const base = createMachineFixture();
    const machine = createMachineFixture({ id: machineId, installationId: 'installation',
        metadata: { ...base.metadata!, agentIsolation: { enabled: true } },
        daemonState: { status: 'running', runtimeId: 'successor' }, active: true, activeAt: Date.now() });
    await publishMachineInventoryForTest({ serverId, accountId }, [machine]);
    actionOperationStore.mergeSnapshots({ serverId, snapshots: [{ version: 1, operationId: 'late-refresh', requestId: 'late-request',
        revision: 2, actionId: 'machines.agentIsolation.set', state: 'running', scope: { accountId, machineId },
        title: 'Change Agent isolation', createdAt: 1000, startedAt: 1100, cancellation: 'unsupported',
        observation: { kind: 'outcome_uncertain', code: 'action_outcome_unknown' } }] });
    const preview = MachineAgentIsolationPreviewResultV1Schema.parse({ kind: 'ready', policy: { enabled: true }, metadataVersion: 5,
        plan: { roots: [], ancestorAcls: [], sessionsToReplace: 0, requiresAdmin: false, planDigest: 'late-check' },
        status: { kind: 'effective', platform: 'linux', agentUser: 'happier-agent' } });
    let finish: (value: typeof preview) => void = () => { throw new Error('RPC not started'); };
    rpc.machine.mockImplementation(() => new Promise<typeof preview>(resolve => { finish = resolve; }));
    const screen = await renderScreen(<ActionOperationDetailModal serverId={serverId} operationId="late-refresh" onClose={vi.fn()} />);
    try {
        await vi.waitFor(() => expect(rpc.machine).toHaveBeenCalledTimes(1));
        await act(async () => {
            await publishMachineInventoryForTest({ serverId, accountId }, change === 'missing' ? [] : [{
                ...machine,
                ...(change === 'revoked' ? { revokedAt: Date.now() } : {}),
                ...(change === 'locked' ? { availability: { kind: 'locked', reason: 'decryption_failed' } as const } : {}),
                ...(change === 'replaced' ? { installationId: 'successor-installation' } : {}),
            }]);
        });
        await act(async () => { finish(preview); });
        await flushHookEffects();
        const retained = createActionOperationSelectors().selectById(actionOperationStore.getSnapshot(), { serverId, operationId: 'late-refresh' });
        expect(retained?.agentIsolationRecovery).toEqual({ enabled: true, preview });
        expect(rpc.machine).toHaveBeenCalledTimes(1);
    } finally { await screen.unmount(); }
});

/** An unknown isolation operation on a reachable Machine; the CHECK's answer is what the test chooses. */
async function renderUnknownIsolation(name: string, answer: () => Promise<unknown>) {
    const accountId = 'owner', machineId = `${name}-machine`;
    const serverId = await homes.addHome({ name, serverUrl: `https://${name}.test`, accountId, currentAccount: true });
    const base = createMachineFixture();
    await publishMachineInventoryForTest({ serverId, accountId }, [createMachineFixture({ id: machineId, installationId: 'installation',
        metadata: { ...base.metadata!, agentIsolation: { enabled: true } },
        daemonState: { status: 'running', runtimeId: 'successor' }, active: true, activeAt: Date.now() })]);
    actionOperationStore.mergeSnapshots({ serverId, snapshots: [{ version: 1, operationId: `${name}-operation`, requestId: 'original-request',
        revision: 2, actionId: 'machines.agentIsolation.set', state: 'running', scope: { accountId, machineId },
        title: 'Change Agent isolation', createdAt: 1000, startedAt: 1100, cancellation: 'unsupported',
        observation: { kind: 'outcome_uncertain', code: 'action_outcome_unknown' } }] });
    rpc.machine.mockImplementation(answer);
    return renderScreen(<ActionOperationDetailModal serverId={serverId} operationId={`${name}-operation`} onClose={vi.fn()} />);
}

const readyPreview = (planDigest: string, status: unknown, roots: readonly string[] = []) => MachineAgentIsolationPreviewResultV1Schema.parse({
    kind: 'ready', policy: { enabled: true }, metadataVersion: 5, status,
    plan: { roots: roots.map((path, index) => ({ rootId: `root-${index}`, path, changes: ['group'] })), ancestorAcls: [],
        sessionsToReplace: 0, requiresAdmin: false, planDigest },
});

it('keeps the unknown receipt and shows a loading state until the reconnect CHECK answers', async () => {
    let answer: (value: unknown) => void = () => { throw new Error('CHECK not started'); };
    const screen = await renderUnknownIsolation('pending-check', () => new Promise(resolve => { answer = resolve; }));
    try {
        await vi.waitFor(() => expect(rpc.machine).toHaveBeenCalledTimes(1));
        // One quiet receipt in every recovery state; the CHECK's row carries where it stands.
        expect(screen.getTextContent()).toContain('inbox.actionOperations.isolationRecovery.receiptChecked');
        expect(screen.getTextContent()).toContain('inbox.actionOperations.isolationRecovery.checkingTitle');
        expect(screen.findByTestId('action-operation-isolation-retry')).toBeNull();
        await act(async () => { answer(readyPreview('settled', { kind: 'effective', platform: 'linux', agentUser: 'happier-agent' })); });
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('inbox.actionOperations.isolationRecovery.onTitle'));
        expect(screen.getTextContent()).not.toContain('inbox.actionOperations.isolationRecovery.checkingTitle');
        // The original receipt stays; nothing is left, so nothing offers to apply again.
        // The CHECK's result leads; the receipt is only a quiet fact and the one status is not stacked.
        expect(screen.getTextContent()).toContain('inbox.actionOperations.isolationRecovery.receiptChecked');
        expect(screen.findByTestId('action-operation-isolation-retry')).toBeNull();
    } finally { await screen.unmount(); }
});

it('shows what still needs applying from the CHECK and offers the retry only as a reviewed decision', async () => {
    const screen = await renderUnknownIsolation('needs-check', async () => readyPreview('needs', { kind: 'enable_required',
        reason: 'existing_machine_workspace_migration' }, ['/srv/shop']));
    try {
        await vi.waitFor(() => expect(screen.findByTestId('action-operation-isolation-retry')).not.toBeNull());
        expect(screen.getTextContent()).toContain('/srv/shop');
        expect(screen.getTextContent()).toContain('inbox.actionOperations.isolationRecovery.needsTitle');
        expect(screen.getTextContent()).toContain('inbox.actionOperations.isolationRecovery.receiptChecked');
        // Reading the CHECK never applies anything.
        expect(rpc.machine.mock.calls.every(([call]) => JSON.stringify(call).includes('preview') || !JSON.stringify(call).includes('agentIsolation.set'))).toBe(true);
    } finally { await screen.unmount(); }
});

it('says the CHECK is unavailable, with no way to apply, when the Machine cannot answer', async () => {
    const screen = await renderUnknownIsolation('unavailable-check', async () => {
        throw Object.assign(new Error('Daemon restarting'), { rpcErrorCode: 'MACHINE_RPC_UNREACHABLE' });
    });
    try {
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('inbox.actionOperations.isolationRecovery.unavailableTitle'));
        expect(screen.getTextContent()).not.toContain('inbox.actionOperations.isolationRecovery.checkingTitle');
        // The row says Happier checks again on reconnect; the receipt never adds a second, contradicting instruction.
        expect(screen.getTextContent()).toContain('inbox.actionOperations.isolationRecovery.receiptChecked');
        expect(screen.getTextContent()).not.toContain('inbox.actionOperations.isolationRecovery.receiptUnavailable');
        expect(screen.findByTestId('action-operation-isolation-retry')).toBeNull();
    } finally { await screen.unmount(); }
});
