import { basename } from 'node:path';
import { expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { DaemonLocalServiceInventorySnapshotResponseV1Schema } from '@happier-dev/protocol/local/services/inventory/v1';
import { startInstalledDaemonFixture } from './testkit/installedDaemon.composed.testkit';
import { createFirstConversationAgentFixture } from './testkit/firstConversationAgent.testkit';

const boundary = vi.hoisted(() => {
  let entered!: () => void;
  const pending = new Promise<void>(resolve => { entered = resolve; });
  return { entered, pending, bypass: false };
});
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: (...args: Parameters<typeof actual.readFile>) => {
    if (!boundary.bypass && basename(String(args[0])) === 'development-roots.v1.json') {
      boundary.entered();
      return new Promise(() => {});
    }
    return actual.readFile(...args);
  } };
});

it('serves Machine vitals while plugin initialization is pending and shuts down cleanly', async () => {
  // Filesystem boundary: hold the plugin owner's final development-root read.
  // Registry publication and the entire daemon/Machine/RPC composition stay real.
  let fixture: Awaited<ReturnType<typeof startInstalledDaemonFixture>> | undefined;
  try {
    fixture = await startInstalledDaemonFixture({ plugins: [createFirstConversationAgentFixture('ROUTE_STARTUP')] });
    await boundary.pending;
    const result = await fixture.invoke(RPC_METHODS.MACHINES_VITALS_GET,
      { machineId: fixture.machineId, serverId: fixture.home.homeId, view: 'summary' });
    expect(result).toHaveProperty('state');
    expect(DaemonLocalServiceInventorySnapshotResponseV1Schema.safeParse(await fixture.invoke(
      RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_SNAPSHOT, { machineId: fixture.machineId })).success).toBe(true);
    const reconnect = await fixture.home.pauseInstalledMachineNetwork();
    await reconnect();
    await fixture.home.waitForMachineRpc(fixture.machineId, RPC_METHODS.MACHINES_VITALS_GET);
    expect(await fixture.invoke(RPC_METHODS.MACHINES_VITALS_GET,
      { machineId: fixture.machineId, serverId: fixture.home.homeId })).toHaveProperty('state');
    await fixture.stop();
    fixture = undefined;
  } finally {
    await fixture?.stop();
  }
}, 120_000);

it('keeps Machine routes callable when plugin initialization settles normally', async () => {
  boundary.bypass = true;
  const fixture = await startInstalledDaemonFixture({ plugins: [createFirstConversationAgentFixture('ROUTE_STARTUP')] });
  try {
    await fixture.home.waitForMachineRpc(fixture.machineId, RPC_METHODS.MACHINES_VITALS_GET);
    expect(await fixture.invoke(RPC_METHODS.MACHINES_VITALS_GET,
      { machineId: fixture.machineId, serverId: fixture.home.homeId })).toHaveProperty('state');
  } finally { await fixture.stop(); }
}, 120_000);
