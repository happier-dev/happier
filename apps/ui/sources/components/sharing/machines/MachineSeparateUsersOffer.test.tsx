import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { createActionExecutor, type MachineAgentIsolationPreviewResultV1 } from '@happier-dev/protocol';
import { renderScreen } from '@/dev/testkit';
import { useMachineGuestExecution } from '@/hooks/machine/useMachineGuestExecution';
import { t } from '@/text';
import { MachineSeparateUsersOffer, SeparateUsersChangeStep, useSeparateUsersChange } from './MachineSeparateUsersOffer';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

describe('separate users reviewed setup', () => {
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
            return <MachineSeparateUsersOffer machine="Devbox" guestExecution={guestExecution} idPrefix="" />;
        }
        const screen = await renderScreen(<Surface />);
        try {
            await screen.pressByTestIdAsync('machine-share-separate-users-turn-on');
            await vi.waitFor(() => expect(screen.findAllByTestId('machine-share-separate-users-confirm').length).toBeGreaterThan(0));
            await screen.pressByTestIdAsync('machine-share-separate-users-confirm');
            await vi.waitFor(() => expect(admitted).toBe(true));
            await screen.unmount();
            release();
            await vi.waitFor(() => expect(applied).toBe(true));
        } finally { release(); }
    });

    const unavailable = { kind: 'unavailable', status: { kind: 'unavailable', code: 'provisioning_unavailable' } } as const;
    const refusals = [
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
            return <MachineSeparateUsersOffer machine="Devbox" guestExecution={guestExecution} idPrefix="" />;
        }
        const screen = await renderScreen(<Surface />);
        try {
            expect(reads).toBe(0);
            await screen.pressByTestIdAsync('machine-share-separate-users-turn-on');
            await vi.waitFor(() => expect(screen.getTextContent()).toContain(message()));
            expect(screen.findAllByTestId('machine-share-separate-users-result-action').length).toBeGreaterThan(0);
            expect(screen.findAllByTestId('machine-share-separate-users-confirm')).toHaveLength(0);
            expect(reads).toBe(1);
            await screen.pressByTestIdAsync('machine-share-separate-users-result-action');
            await vi.waitFor(() => expect(reads).toBe(2));
        } finally { await screen.unmount(); }
    });
});

describe('Security tab: how agents run, changed through the same review', () => {
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
            return <SeparateUsersChangeStep change={change} machine="vps-1" testID="machine-security-separate-users" presentation="section" />;
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
