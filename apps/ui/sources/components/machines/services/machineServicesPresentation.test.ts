import { describe, expect, it } from 'vitest';
import type { MachineServiceRowV1 as Row } from '@happier-dev/protocol/actions/specs/machine/services';
import { machineServiceIdentityLine } from './machineServicesPresentation';

function row(name: string, patch: Partial<Row> = {}): Row {
  return {
    serviceId: name,
    name,
    authority: 'machine',
    lifecyclePurpose: 'development',
    generation: 'g1',
    state: 'running',
    capabilities: {
      start: true,
      stop: true,
      restart: true,
      logs: true,
      accounting: false,
    },
    watchId: `w-${name}`,
    watchRevision: 'r1',
    ...patch,
  };
}
describe('Machine services presentation', () => {
  it('presents the plugin native name independently of the watch label and opaque identity', () => {
    const instance = { adapter: { pluginId: 'happier.machine.services', localId: 'compose' },
      nativeResourceId: JSON.stringify(['engine-a', 'existing-production']) };
    const native = { phase: 'running' as const, readiness: 'ready' as const, displayName: 'Native project title' };
    const named = machineServiceIdentityLine(row('My production watch', { nativeInstance: instance, native }));
    expect(named).toContain('Native project title');
    expect(named).not.toContain('existing-production');
    expect(named).not.toContain('engine-a');
    expect(named).not.toContain('My production watch');
    const unnamed = machineServiceIdentityLine(row('My production watch', { nativeInstance: instance }));
    expect(unnamed).not.toContain(instance.nativeResourceId);
    expect(unnamed).not.toContain('existing-production');
  });

});
