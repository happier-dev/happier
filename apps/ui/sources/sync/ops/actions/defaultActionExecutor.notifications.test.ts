import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import {
    createHomeGovernanceHarness,
    installHomeGovernanceBoundaries,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import type { StorageState } from '@/sync/store/types';

const rpc = vi.hoisted(() => ({ machine: vi.fn() }));

// Machine RPC is the genuine daemon network boundary. Account capture,
// settings, Action admission, relay selection and result validation stay real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: rpc.machine,
}));

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
let machineState: Pick<StorageState, 'machines' | 'machineListByServerId'>;

// Boundary installation above must run before loading the real Action graph;
// module preparation belongs to collection rather than the first hook timeout.
await import('@/sync/domains/state/storage');
await import('./defaultActionExecutor');

async function addHome() {
    const serverId = await harness.addHome({
        name: 'Notification Home',
        serverUrl: 'https://notifications-home.example',
        accountId: 'account-a',
    });
    const { storage } = await import('@/sync/domains/state/storage');
    const machine = createMachineFixture({ id: 'notification-relay', activeAt: Date.now() });
    storage.setState({
        machines: { [machine.id]: machine },
        machineListByServerId: { [serverId]: [machine] },
    });
    return serverId;
}

describe('default Action notification daemon transport', () => {
    beforeEach(async () => {
        await harness.reset();
        rpc.machine.mockReset();
        const { storage } = await import('@/sync/domains/state/storage');
        const state = storage.getState();
        machineState = { machines: state.machines, machineListByServerId: state.machineListByServerId };
    });

    afterEach(async () => {
        const { storage } = await import('@/sync/domains/state/storage');
        storage.setState(machineState);
        standardCleanup();
    });

    it('sends Notify me through the captured Account daemon without inventing a resource target', async () => {
        const serverId = await addHome();
        const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
        rpc.machine.mockResolvedValue({ attemptedChannels: 1, deliveredChannels: 1 });
        const input = { title: 'Review', message: 'Review did not converge', channels: ['builtin:expo_push'] };

        await expect(createDefaultActionExecutor().execute('notifications.notify_me', input, {
            surface: 'voice', serverId,
        })).resolves.toEqual({ ok: true, result: { attemptedChannels: 1, deliveredChannels: 1 } });
        expect(rpc.machine).toHaveBeenCalledWith(expect.objectContaining({
            serverId,
            accountId: 'account-a',
            machineId: 'notification-relay',
            method: 'notifications.notify_me',
            payload: input,
        }));
    });

    it('resolves Send to options from that same Account host through the declared Action route', async () => {
        const serverId = await addHome();
        const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
        const options = [{ value: 'plugin/channel', label: 'Plugin channel', disabled: true }];
        const result = {
            actionId: null, fieldPath: null, optionsSourceId: 'notifications.channels.available', options,
        };
        rpc.machine.mockResolvedValue(result);

        await expect(createDefaultActionExecutor().execute('action.options.resolve', {
            optionsSourceId: 'notifications.channels.available',
        }, { surface: 'ui', serverId })).resolves.toEqual({ ok: true, result });
        expect(rpc.machine).toHaveBeenCalledWith(expect.objectContaining({
            serverId,
            accountId: 'account-a',
            machineId: 'notification-relay',
            method: 'action.options.resolve',
            payload: { actionId: 'notifications.notify_me', fieldPath: 'channels' },
        }));
    });

    it('does not borrow the focused Home daemon for a notification Account on another Home', async () => {
        const serverId = await addHome();
        const otherServerId = await harness.addHome({
            name: 'Other Home', serverUrl: 'https://other-notifications-home.example', accountId: 'account-b',
        });
        const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
        await expect(createDefaultActionExecutor().execute('notifications.notify_me', { message: 'Private' }, {
            surface: 'voice', serverId,
        })).resolves.toMatchObject({ ok: false, errorCode: 'target_unavailable' });
        expect(otherServerId).not.toBe(serverId);
        expect(rpc.machine).not.toHaveBeenCalled();
    });

    it('withholds channel content when the captured Account changes while its daemon answers', async () => {
        const serverId = await addHome();
        const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
        rpc.machine.mockImplementation(async () => {
            await harness.switchAccount(serverId, 'account-b');
            return {
                optionsSourceId: 'notifications.channels.available',
                options: [{ value: 'private/channel', label: 'Private channel' }],
            };
        });
        await expect(createDefaultActionExecutor().execute('action.options.resolve', {
            optionsSourceId: 'notifications.channels.available',
        }, { surface: 'ui', serverId })).resolves.toMatchObject({
            ok: false, errorCode: 'action_account_scope_changed',
        });
    });

    it('preserves the daemon delivery failure rather than reporting a sent notification', async () => {
        const serverId = await addHome();
        const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
        const failure = { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' };
        rpc.machine.mockResolvedValue(failure);
        await expect(createDefaultActionExecutor().execute('notifications.notify_me', { message: 'Hi' }, {
            surface: 'voice', serverId,
        })).resolves.toEqual(failure);
    });
});
