import { describe, expect, it } from 'vitest';
import { ACTION_IDS, isMachineDeploymentEnvironmentAccessActionIdV1 } from './actionIds.js';
import { isProjectWorkspaceSyncOpenActionV1 } from './projectActionIdsV1.js';
import { isMachineTerminalOpenOrRestartActionIdV1 } from './specs/machineTerminalActionIdsV1.js';
import { MACHINE_REACHABILITY_ACTION_IDS_V1 } from '../machines/reachability/actionIdsV1.js';

// Migration vectors capture the literal sets replaced by ACTIONID-DERIVE.
// A broadened predicate must not silently widen requester custody or Sync purpose.
describe('derived Action identity migration sets', () => {
  it('preserves the exact Machine deployment Environment access purposes', () => {
    expect([...ACTION_IDS, 'unknown.action'].filter(isMachineDeploymentEnvironmentAccessActionIdV1).sort()).toEqual([
      'machines.processes.check', 'machines.processes.get', 'machines.processes.list', 'machines.reboot',
      'machines.services.control', 'machines.services.detail', 'machines.services.exec', 'machines.services.list',
      'machines.services.logs.read',
    ]);
  });
  it('preserves the reachability transport set', () => {
    expect([...MACHINE_REACHABILITY_ACTION_IDS_V1].sort()).toEqual([
      'machines.reachability.configure', 'machines.reachability.inspect',
    ]);
  });

  it('preserves the Sync open purpose without admitting preparation roots', () => {
    expect([...ACTION_IDS, 'unknown.action', undefined].filter(isProjectWorkspaceSyncOpenActionV1)).toEqual(['projects.open']);
  });

  it('preserves terminal open/restart custody without admitting interactive IO', () => {
    expect([...ACTION_IDS, 'unknown.action'].filter(isMachineTerminalOpenOrRestartActionIdV1).sort()).toEqual([
      'machines.terminal.open', 'machines.terminal.restart',
    ]);
  });
});
