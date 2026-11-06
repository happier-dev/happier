import { describe, expect, it } from 'vitest';
import { getActionSpec } from '@happier-dev/protocol/actions';
import { applyMachineSetupEffectPlan, checkMachineSetupEffectPlan, createMachineSetupNativeBackend,
  machineSetupPlansRequireAdministratorV1, type MachineRecipeStepV1 } from '@happier-dev/cli-common/machineSetup';
import { createActionOperationRunner } from './actionOperationRunner';
import { createActionOperationStore } from './actionOperationStore';

describe('native setup cancellation custody', () => {
  it.each([true, false])('retains custody only when its nonroot package process stop is unconfirmed (%s)', async unconfirmed => {
    const controller = new AbortController();
    const refusal = Object.assign(new Error('Native tree termination is unconfirmed'), { code: 'plugin_exec_termination_incomplete' });
    const step: MachineRecipeStepV1 = { id: 'portable', kind: 'package', manager: 'winget', state: 'absent',
      packages: [{ name: 'Vendor.Portable', source: 'winget', scope: 'user' }] };
    // Only native process output/termination is substituted. Package authority,
    // plan admission, the interpreter and operation custody use their real owners.
    const backend = createMachineSetupNativeBackend({ signal: controller.signal, run: async command => {
      if (command.executable === 'whoami.exe') return { code: 0, stdout: '"user","S-1-5-21-1-2-3-1001"', stderr: '' };
      if (command.args[0] === '--version') return { code: 0, stdout: 'v1.10.0', stderr: '' };
      if (command.args[0] === 'list') return { code: 0,
        stdout: 'Portable [Vendor.Portable]\nVersion: 1.0\nInstalled Scope: user\nInstaller Category: portable\n', stderr: '' };
      expect(command.args[0]).toBe('uninstall');
      controller.abort();
      throw unconfirmed ? refusal : new Error('Native command aborted after confirmed stop');
    } });
    const plan = await checkMachineSetupEffectPlan({ basis: { kind: 'setup', machineId: 'machine-a', desiredRevision: 1 }, steps: [step], backend });
    expect(machineSetupPlansRequireAdministratorV1([plan])).toBe(false);
    const scope = { accountId: 'account-a', machineId: 'machine-a' };
    const store = createActionOperationStore();
    const spec = getActionSpec('machines.setup.remove');
    const runner = createActionOperationRunner({ store, generateOperationId: () => 'native-setup',
      resolveAction: () => ({ actionId: spec.id, title: spec.title, operation: spec.operation! }) });
    let thrown: unknown;
    try {
      await runner.observe({ actionId: spec.id, scope, requestId: 'remove-portable', input: {}, execute: async () => {
        const result = await applyMachineSetupEffectPlan({ plan, backend, signal: controller.signal });
        return result.status === 'applied' ? { ok: true, result } : { ok: false, errorCode: 'cancelled', error: 'Cancelled' };
      } });
    } catch (error) { thrown = error; }
    expect(store.get(scope, 'native-setup')).toMatchObject(unconfirmed ? { state: 'running',
      observation: { kind: 'outcome_uncertain', code: refusal.code } } : { state: 'cancelled' });
    expect(thrown).toBe(unconfirmed ? refusal : undefined);
  });
});
