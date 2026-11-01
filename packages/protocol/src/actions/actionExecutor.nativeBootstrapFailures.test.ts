import { describe, expect, it } from 'vitest';

import { createActionExecutor } from './actionExecutor.js';

describe('native bootstrap host trust failures', () => {
  it.each(['native_ssh_host_key_unavailable', 'host_key_evidence_mismatch', 'invalid_trusted_host_key', 'trusted_host_key_mismatch'])(
    'retains %s in the public Action failure without forwarding native diagnostics', async code => {
      // An installed controller is outside Protocol's process boundary.
      const executor = createActionExecutor({ managedMachineAction: async () => {
        throw Object.assign(new Error('private native diagnostic'), { code });
      } });
      const result = await executor.execute('machines.managed.acquire', {
        enrollmentIdentity: { kind: 'existingUser', role: 'adopted' },
        selection: {
          kind: 'one-off', homeId: 'home', controller: { machineId: 'controller', installationId: 'installation' },
          launch: { provider: { pluginId: 'machine.example', localId: 'vm' }, schemaVersion: 1, name: 'Work VM', choices: {} },
          retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
        },
      }, { surface: 'cli', authority: 'present_user', presentUserConfirmation: { actionId: 'machines.managed.acquire' } });
      expect(result).toEqual({ ok: false, errorCode: code, error: code });
    },
  );
});
