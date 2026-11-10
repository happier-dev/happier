import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createActionExecutor, type ActionOperationSnapshotV1, type MachineAgentIsolationPreviewResultV1 } from '@happier-dev/protocol';
import { createMachineFixture, renderScreen } from '@/dev/testkit';
import { useMachineGuestExecution } from '@/hooks/machine/useMachineGuestExecution';
import { t } from '@/text';
import { MachineSeparateUsersOffer, SeparateUsersChangeStep, useSeparateUsersChange } from './MachineSeparateUsersOffer';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { actionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';
import { storage } from '@/sync/domains/state/storageStore';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';

const baseline = storage.getState();
afterEach(() => {
    actionOperationStore.reset();
    storage.setState(baseline, true);
});

const router = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router }).module;
});
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

describe('separate users reviewed setup', () => {
    it('explains a missing ACL tool when the reviewed Apply is refused', async () => {
        const remedy = 'Install the acl package on this Machine, then try again.';
        const preview = { kind: 'ready', policy: { enabled: false }, metadataVersion: 1, status: { kind: 'disabled' },
            plan: { roots: [], ancestorAcls: [], sessionsToReplace: 0, requiresAdmin: true, planDigest: 'reviewed' } } as const;
        const execute = createFrontDoorActionExecute(createActionExecutor({ presentUserActionConfirmation: async () => true,
            machineAgentIsolationAction: async ({ actionId }) => actionId === 'machines.agentIsolation.preview' ? preview
                : { kind: 'failed', code: 'denied', operationId: 'missing-acl', setup: { outcome: 'not_applied',
                    reasonCode: 'native_effect_failed', failure: { kind: 'native_effect_failed',
                        reason: 'required_fact_unavailable', requiredFact: 'commandExecutable', remedy } } },
        }));
        let change!: ReturnType<typeof useSeparateUsersChange>;
        function Surface() {
            const guestExecution = useMachineGuestExecution({ machineId: 'machine', scope: { serverId: 'home', accountId: 'owner' },
                canManage: true, execute });
            change = useSeparateUsersChange({ machine: 'Devbox', guestExecution, target: 'member' });
            return <SeparateUsersChangeStep change={change} machine="Devbox" testID="machine-security-separate-users" />;
        }
        const screen = await renderScreen(<Surface />);
        try {
            await act(async () => { await change.review(); });
            await screen.pressByTestIdAsync('machine-security-separate-users-confirm');
            await vi.waitFor(() => expect(screen.getTextContent()).toContain(remedy));
        } finally { await screen.unmount(); }
    });
    it('finishes confirmed setup when its policy publication retires the offer', async () => {
        let release!: () => void;
        const ready = new Promise<void>(resolve => { release = resolve; });
        let admitted = false, applied = false, cancelled = false;
        const preview: MachineAgentIsolationPreviewResultV1 = { kind: 'ready', policy: { enabled: false },
            metadataVersion: 1, status: { kind: 'disabled' }, plan: { roots: [], ancestorAcls: [],
                sessionsToReplace: 0, requiresAdmin: true, planDigest: 'reviewed' } };
        // The native Machine transport is the boundary; the Action and offer stay real.
        const executor = createActionExecutor({ presentUserActionConfirmation: async () => true,
            machineAgentIsolationAction: async ({ actionId, signal }) => {
            if (actionId === 'machines.agentIsolation.preview') return preview;
            admitted = true;
            signal?.addEventListener('abort', () => { cancelled = true; }, { once: true });
            await ready;
            applied = !cancelled;
            return { kind: 'accepted', operationId: 'setup', metadataVersion: 2,
                status: { kind: 'effective', platform: 'linux', agentUser: 'happier-agent' } };
        } });
        const execute = createFrontDoorActionExecute(executor);
        function Surface() {
            const guestExecution = useMachineGuestExecution({ machineId: 'machine', scope: { serverId: 'home', accountId: 'owner' },
                canManage: true, execute });
            change = useSeparateUsersChange({ machine: 'Devbox', guestExecution, target: 'member' });
            return <SeparateUsersChangeStep change={change} machine="Devbox" testID="machine-security-separate-users" />;
        }
        let change!: ReturnType<typeof useSeparateUsersChange>;
        const screen = await renderScreen(<Surface />);
        try {
            await act(async () => { await change.review(); });
            await vi.waitFor(() => expect(screen.findAllByTestId('machine-security-separate-users-confirm').length).toBeGreaterThan(0));
            await screen.pressByTestIdAsync('machine-security-separate-users-confirm');
            await vi.waitFor(() => expect(admitted).toBe(true));
            await screen.unmount();
            release();
            await vi.waitFor(() => expect(applied).toBe(true));
        } finally { release(); }
    });

    const unavailable = { kind: 'unavailable', status: { kind: 'unavailable', code: 'provisioning_unavailable' } } as const;
    const refusals = [
        { result: { ...unavailable, setup: { outcome: 'not_applied', reasonCode: 'native_check_unavailable',
            failure: { kind: 'native_check_unavailable', reason: 'required_fact_unavailable', requiredFact: 'commandExecutable',
                remedy: 'Install the acl package on this Machine, then try again.' } } },
            message: () => 'Install the acl package on this Machine, then try again.' },
        { result: { ...unavailable, setup: { outcome: 'not_applied', reasonCode: 'native_protocol_invalid' } },
            message: () => t('errors.machineNativeProtocolInvalid') },
        { result: { ...unavailable, setup: { outcome: 'not_applied', reasonCode: 'mode_none',
            recovery: { kind: 'configure_admin_access', mode: 'preauthorized' } } },
            message: () => t('machines.sharing.fallback.adminDisabled') },
        { result: { ...unavailable, setup: { outcome: 'not_applied', reasonCode: 'not_preauthorized' } },
            message: () => t('machines.sharing.fallback.adminCheckRequired') },
        { result: { ...unavailable, setup: { outcome: 'not_applied', reasonCode: 'managed_cli_unavailable',
            recovery: { kind: 'install_managed_cli', executablePath: '/opt/happier/current/happier' } } },
            message: () => t('machines.sharing.fallback.managedCliRequired') },
        { result: { kind: 'unavailable', status: { kind: 'unavailable', code: 'payload_not_accessible' } },
            message: () => t('machines.sharing.fallback.prerequisites.payload_not_accessible') },
    ] satisfies Array<{ result: MachineAgentIsolationPreviewResultV1; message: () => string }>;

    it.each(refusals)('shows the daemon prerequisite and remedy for $result and permits a read-only recheck', async ({ result, message }) => {
        // The Machine transport is the boundary. Action dispatch, wire parsing,
        // the guest-execution hook and the mounted offer stay real.
        let reads = 0;
        const executor = createActionExecutor({ machineAgentIsolationAction: async () => {
            reads++;
            return result;
        } });
        const execute = createFrontDoorActionExecute(executor);
        function Surface() {
            const guestExecution = useMachineGuestExecution({ machineId: 'machine', scope: { serverId: 'home', accountId: 'owner' },
                canManage: true, execute });
            change = useSeparateUsersChange({ machine: 'Devbox', guestExecution, target: 'member' });
            return <SeparateUsersChangeStep change={change} machine="Devbox" testID="machine-security-separate-users" />;
        }
        let change!: ReturnType<typeof useSeparateUsersChange>;
        const screen = await renderScreen(<Surface />);
        try {
            expect(reads).toBe(0);
            await act(async () => { await change.review(); });
            await vi.waitFor(() => expect(screen.getTextContent()).toContain(message()));
            expect(screen.findAllByTestId('machine-security-separate-users-result-action').length).toBeGreaterThan(0);
            expect(screen.findAllByTestId('machine-security-separate-users-confirm')).toHaveLength(0);
            expect(reads).toBe(1);
            await screen.pressByTestIdAsync('machine-security-separate-users-result-action');
            await vi.waitFor(() => expect(reads).toBe(2));
        } finally { await screen.unmount(); }
    });
});

describe('Security tab: how agents run, changed through the same review', () => {
    it.each([
        { target: 'sharedAgent' as const, state: 'succeeded' as const },
        { target: 'member' as const, state: 'succeeded' as const },
        { target: 'daemon' as const, state: 'succeeded' as const },
        { target: 'sharedAgent' as const, state: 'failed' as const },
        { target: 'sharedAgent' as const, state: 'cancelled' as const },
    ])('settles the accepted $target review from its pushed operation ($state)', async ({ target, state }) => {
        const serverId = getActiveServerSnapshot().serverId;
        const base = createMachineFixture({ id: 'settling-machine' });
        const machine = { ...base, metadata: { ...base.metadata!, platform: 'linux', agentIsolation: { enabled: true } },
            daemonState: { status: 'running', agentIsolation: { kind: 'applying', phase: 'runtime_replacement' } } };
        storage.getState().applyMachines([machine as typeof base], true, { sourceServerId: serverId });
        const operation: ActionOperationSnapshotV1 = { version: 1, operationId: 'accepted-isolation', revision: 1,
            actionId: 'machines.agentIsolation.set', state: 'running',
            scope: { accountId: 'owner', machineId: machine.id }, title: 'Change Agent isolation',
            createdAt: 100, startedAt: 100, cancellation: 'unsupported' };
        actionOperationStore.mergeSnapshots({ serverId, snapshots: [operation] });
        const preview: MachineAgentIsolationPreviewResultV1 = { kind: 'ready', policy: { enabled: true },
            metadataVersion: 1, status: { kind: 'applying', phase: 'runtime_replacement' },
            plan: { roots: [], ancestorAcls: [], sessionsToReplace: 1, requiresAdmin: true, planDigest: 'reviewed' } };
        let requests = 0, renders = 0;
        // Only the Machine transport is substituted. The Action, stores, hooks and rendered step stay real.
        const execute = createFrontDoorActionExecute(createActionExecutor({ presentUserActionConfirmation: async () => true,
            machineAgentIsolationAction: async ({ actionId }) => {
                requests++;
                return actionId === 'machines.agentIsolation.preview' ? preview
                    : { kind: 'accepted', operationId: operation.operationId, metadataVersion: 2,
                        status: { kind: 'applying', phase: 'runtime_replacement' } };
            } }));
        let change!: ReturnType<typeof useSeparateUsersChange>;
        let guest!: ReturnType<typeof useMachineGuestExecution>;
        function Surface() {
            renders++;
            guest = useMachineGuestExecution({ machineId: machine.id, scope: { serverId, accountId: 'owner' },
                canManage: true, execute });
            change = useSeparateUsersChange({ machine: 'Devbox', guestExecution: guest, target });
            return <SeparateUsersChangeStep change={change} machine="Devbox" testID="machine-security-separate-users" />;
        }
        const screen = await renderScreen(<Surface />);
        try {
            await act(async () => { await change.review(); });
            await screen.pressByTestIdAsync('machine-security-separate-users-confirm');
            expect(screen.findAllByTestId('machine-security-separate-users-result').length).toBeGreaterThan(0);
            expect(change.phase).toMatchObject({ tone: 'loading' });
            const waitingRenders = renders;
            await act(async () => {
                actionOperationStore.mergeSnapshots({ serverId, snapshots: [{ ...operation, operationId: 'unrelated',
                    revision: 2, state: 'succeeded', settledAt: 200 }] });
            });
            expect(renders).toBe(waitingRenders);
            expect(change.phase).toMatchObject({ tone: 'loading' });
            await act(async () => {
                if (state === 'succeeded') storage.getState().applyMachines([{ ...machine, metadataVersion: 2, daemonStateVersion: 2,
                    metadata: { ...machine.metadata, agentIsolation: { enabled: target !== 'daemon',
                        ...(target === 'member' ? { memberProvisioning: 'linuxUsersV1' } : {}) } },
                    daemonState: { status: 'running', agentIsolation: target === 'daemon' ? { kind: 'disabled' }
                        : { kind: 'effective', platform: 'linux', agentUser: 'happier-agent' } } } as typeof base],
                true, { sourceServerId: serverId });
                actionOperationStore.mergeSnapshots({ serverId, snapshots: [{ ...operation, revision: 2, state, settledAt: 200,
                    ...(state === 'failed' ? { error: { errorCode: 'native_effect_failed', error: 'Native setup is unavailable', details: { kind: 'machineSetup',
                        failure: { kind: 'native_effect_failed', reason: 'required_fact_unavailable', requiredFact: 'commandExecutable',
                            remedy: 'Install the acl package on this Machine, then try again.' } } } } : {}) }] });
            });
            if (state === 'failed') expect(change.phase).toMatchObject({ kind: 'settled', tone: 'error',
                message: 'Install the acl package on this Machine, then try again.' });
            else {
                expect(change.phase.kind).toBe('offer');
                expect(screen.findAllByTestId('machine-security-separate-users-result')).toHaveLength(0);
            }
            if (state === 'succeeded') {
                expect(guest.runAs).toBe(target);
                expect(guest.isolation?.kind).toBe(target === 'daemon' ? 'disabled' : 'effective');
            }
            expect(requests).toBe(2); // One review and one Apply; pushed settlement never reads or retries.
        } finally { await screen.unmount(); }
    });

    it.each([
        { target: 'daemon' as const, input: { enabled: false }, memberProvisioning: undefined, docker: 0 },
        { target: 'sharedAgent' as const, input: { enabled: true }, memberProvisioning: undefined, docker: 1 },
    ])('previews and applies $target, showing restarting Sessions and the after-state before the confirm', async ({ target, input, memberProvisioning, docker }) => {
        const calls: Array<{ actionId: string; input: unknown }> = [];
        const preview: MachineAgentIsolationPreviewResultV1 = { kind: 'ready',
            policy: { enabled: true, memberProvisioning: 'linuxUsersV1' }, metadataVersion: 4,
            status: { kind: 'effective', platform: 'linux', agentUser: 'happier-agent' },
            plan: { roots: [], ancestorAcls: [], sessionsToReplace: 2, requiresAdmin: true, planDigest: 'change-1' } };
        // The native Machine transport is the boundary; the Actions, the hook and the step stay real.
        const executor = createActionExecutor({ presentUserActionConfirmation: async () => true,
            machineAgentIsolationAction: async ({ actionId, input }) => {
                calls.push({ actionId, input });
                if (actionId === 'machines.agentIsolation.preview') return preview;
                return { kind: 'accepted', operationId: 'change', metadataVersion: 5, status: { kind: 'disabled' } };
            } });
        const execute = createFrontDoorActionExecute(executor);
        let change!: ReturnType<typeof useSeparateUsersChange>;
        function Surface() {
            const guestExecution = useMachineGuestExecution({ machineId: 'machine', scope: { serverId: 'home', accountId: 'owner' },
                canManage: true, execute });
            change = useSeparateUsersChange({ machine: 'vps-1', guestExecution, target });
            return <SeparateUsersChangeStep change={change} machine="vps-1" testID="machine-security-separate-users" />;
        }
        const screen = await renderScreen(<Surface />);
        try {
            await act(async () => { await change.review(); });
            await vi.waitFor(() => expect(screen.findAllByTestId('machine-security-separate-users-confirm').length).toBeGreaterThan(0));
            expect(calls).toEqual([{ actionId: 'machines.agentIsolation.preview', input: expect.objectContaining(input) }]);
            expect((calls[0]!.input as { memberProvisioning?: string }).memberProvisioning).toBe(memberProvisioning);
            expect(screen.findAllByTestId('action-operation-isolation-sessions').length).toBeGreaterThan(0);
            expect(screen.findAllByTestId('action-operation-isolation-after').length).toBeGreaterThan(0);
            expect(screen.findAllByTestId('action-operation-isolation-docker').length > 0).toBe(docker > 0);
            await screen.pressByTestIdAsync('machine-security-separate-users-confirm');
            await vi.waitFor(() => expect(calls).toHaveLength(2));
            expect(calls[1]).toEqual({ actionId: 'machines.agentIsolation.set',
                input: expect.objectContaining({ ...input, expectedPlanDigest: 'change-1', expectedMetadataVersion: 4 }) });
            expect((calls[1]!.input as { memberProvisioning?: string }).memberProvisioning).toBe(memberProvisioning);
            await vi.waitFor(() => expect(screen.getTextContent())
                .toContain(t('machineDetailPage.security.admin.agentsRunAsChanging', { machine: 'vps-1' })));
        } finally { await screen.unmount(); }
    });
});

describe('Sharing leads to the one review of how agents run', () => {
    it('opens the Machine\u2019s Security tab instead of reviewing in the share sheet', async () => {
        router.push.mockReset();
        const execute = createFrontDoorActionExecute(createActionExecutor({ machineAgentIsolationAction: async () => {
            throw new Error('Sharing must not preview');
        } }));
        function Surface() {
            const guestExecution = useMachineGuestExecution({ machineId: 'machine-1', scope: { serverId: 'home', accountId: 'owner' },
                canManage: true, execute });
            return <MachineSeparateUsersOffer machine="Devbox" guestExecution={guestExecution} idPrefix="" />;
        }
        const screen = await renderScreen(<Surface />);
        try {
            await screen.pressByTestIdAsync('machine-share-separate-users-turn-on');
            expect(router.push).toHaveBeenCalledTimes(1);
            const href = String(router.push.mock.calls[0]![0]);
            expect(href).toContain('/machine-1');
            expect(href).toContain('tab=security');
            expect(screen.findAllByTestId('machine-share-separate-users-review')).toHaveLength(0);
        } finally { await screen.unmount(); }
    });
});
