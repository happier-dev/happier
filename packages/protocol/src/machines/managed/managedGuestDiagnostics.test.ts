import { describe, expect, it } from 'vitest';
import { ManagedMachineActionInputSchemasV1 } from './actionsV1.js';
import { BugReportMachineDiagnosticsSnapshotSchema } from '../../bugs/reports/machineDiagnostics.js';

describe('explicit managed guest diagnostics read', () => {
  it('admits an opt-in diagnostics inspection without changing ordinary inspection', () => {
    const target = { homeId: 'home', managedId: 'guest' };
    expect(ManagedMachineActionInputSchemasV1['machines.managed.inspect'].parse(target)).toEqual(target);
    expect(ManagedMachineActionInputSchemasV1['machines.managed.inspect'].safeParse({ ...target, includeGuestDiagnostics: true }).success).toBe(true);
    expect(ManagedMachineActionInputSchemasV1['machines.managed.inspect'].safeParse({ ...target, command: 'arbitrary command' }).success).toBe(false);
  });
  it('retains the diagnostic daemon identity needed to bind a guest log to the enrolled Machine', () => {
    const snapshot = BugReportMachineDiagnosticsSnapshotSchema.parse({
      daemonState: { pid: 1, httpPort: 1, startedAt: 1, startedWithCliVersion: 'test', hasControlToken: false,
        daemonLogPath: null, machineId: 'enrolled-guest' },
      daemonLogs: [], doctorSnapshot: null, runtime: { cwd: '', platform: 'linux', nodeVersion: '' }, stackContext: null,
    });
    expect(snapshot.daemonState).toHaveProperty('machineId', 'enrolled-guest');
  });
});
