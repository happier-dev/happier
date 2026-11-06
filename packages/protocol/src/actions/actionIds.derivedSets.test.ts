import { describe, expect, it } from 'vitest';
import { ACTION_IDS, isMachineDeploymentEnvironmentAccessActionIdV1 } from './actionIds.js';

// Migration vectors preserve the exact HTTP-purpose admission set.
describe('derived Action identity migration sets', () => {
  it('preserves the exact Machine deployment Environment access purposes', () => {
    expect([...ACTION_IDS, 'unknown.action'].filter(isMachineDeploymentEnvironmentAccessActionIdV1).sort()).toEqual([
      'machines.processes.check', 'machines.processes.get', 'machines.processes.list', 'machines.reboot',
      'machines.services.control', 'machines.services.detail', 'machines.services.exec', 'machines.services.list',
      'machines.services.logs.read',
    ]);
  });
});
