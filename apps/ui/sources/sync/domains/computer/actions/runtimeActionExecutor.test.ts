import { describe, expect, it, vi } from 'vitest';
import { createActionExecutor, createUnavailableRuntimeActionExecutor, type ActionExecutorDeps } from '@happier-dev/protocol';

import { createComputerRuntimeActionExecutor, type ComputerMachineRpc } from './runtimeActionExecutor';

const target = { kind: 'window', displayId: ':77', pid: 123, windowId: 456 } as const;
const selected = {
    consentGranted: false,
    selectedTarget: target,
    sourceId: 'computer:1',
    approvalDisplay: { machineDisplayName: 'Studio laptop', requiresTargetSelection: false, target: { kind: 'window', title: 'Sign in to Lumen' } },
};

function executorWith(machine: ComputerMachineRpc) {
    // Only the computer transport is used; other host-effect dependencies are outside this fixture.
    // The machine RPC is the network boundary; the canonical Action front door runs for real above it.
    return createActionExecutor({
        runtimeActionExecute: createComputerRuntimeActionExecutor({ executeOnMachine: machine, fallback: createUnavailableRuntimeActionExecutor() }),
    } as ActionExecutorDeps);
}

describe('computer runtime Actions from Happier', () => {
    it('sends the person’s choice to the named machine for this Session, through the Action front door', async () => {
        const machine = vi.fn<ComputerMachineRpc>(async () => selected);
        const result = await executorWith(machine).execute('computer.target.select', { machineId: 'machine_1', target }, {
            surface: 'ui', authority: 'present_user', defaultSessionId: 'session_1', serverId: 'home_1',
        });
        expect(result).toEqual({ ok: true, result: selected });
        expect(machine).toHaveBeenCalledWith(expect.objectContaining({
            serverId: 'home_1', machineId: 'machine_1', sessionId: 'session_1',
            actionId: 'computer.target.select', input: { machineId: 'machine_1', target },
        }));
    });

    it('never carries an agent’s or a Session-less request onto the person’s route', async () => {
        const machine = vi.fn<ComputerMachineRpc>(async () => selected);
        const executor = executorWith(machine);
        expect(await executor.execute('computer.control.status', { machineId: 'machine_1' }, {
            surface: 'ui', authority: 'account_automation', defaultSessionId: 'session_1',
        })).toMatchObject({ ok: false, errorCode: 'present_user_required' });
        expect(await executor.execute('computer.control.status', { machineId: 'machine_1' }, {
            surface: 'ui', authority: 'present_user',
        })).toMatchObject({ ok: false, errorCode: 'computer_session_required' });
        expect(machine).not.toHaveBeenCalled();
    });

    it('returns the computer owner’s refusal as a failure, not as a payload', async () => {
        const machine = vi.fn<ComputerMachineRpc>(async () => ({ ok: false, errorCode: 'computer_target_in_use', error: 'computer_target_in_use' }));
        expect(await executorWith(machine).execute('computer.target.select', { machineId: 'machine_1', target }, {
            surface: 'ui', authority: 'present_user', defaultSessionId: 'session_1',
        })).toMatchObject({ ok: false, errorCode: 'computer_target_in_use' });
    });
});
