import { describe, expect, it } from 'vitest';
import { getSerializedActionSpecForSurface } from './actionCatalog.js';
import type { ActionId } from './actionIds.js';

const clientOperations = [
  'machines.add.local.start', 'machines.add.local.cancel', 'machines.add.ssh.start', 'machines.add.ssh.status',
  'machines.add.ssh.respond', 'machines.add.ssh.cancel', 'machines.add.command',
  'machines.pairing.create', 'machines.managed.bootstrap.respond', 'homes.connect', 'homes.reconnect',
  'machines.local.service.status', 'machines.local.service.start', 'machines.local.service.stop',
  'machines.local.service.restart', 'machines.local.service.autostart.set', 'machines.local.service.update',
  'machines.local.service.disconnect', 'plugins.permissions.grants.list', 'plugins.permissions.grants.revoke',
  'plugins.sessionHooks.status.get',
] as const satisfies readonly ActionId[];

describe('CLI parity for existing UI operations', () => {
  it.each(clientOperations)('advertises %s through its canonical CLI projection', id => {
    expect(getSerializedActionSpecForSurface({ id, surface: 'cli' })).toMatchObject({ id, surfaces: { cli: true } });
  });
});
