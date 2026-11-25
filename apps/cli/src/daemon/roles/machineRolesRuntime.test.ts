import { describe, expect, it, vi } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { CORE_MACHINE_ROLE_IDS_V1 } from '@happier-dev/protocol/machines/roles/machineRolesV1';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createMachineRolesRuntime } from './machineRolesRuntime';

function machine(initial: Record<string, unknown> = {}) {
  let metadata = initial;
  let metadataVersion = 1;
  let available = true;
  return {
    port: {
      read: async () => available ? { status: 'ready' as const, metadata, metadataVersion } : { status: 'unavailable' as const },
      compareAndSwap: async (input: { metadata: Record<string, unknown>; expectedMetadataVersion: number }) => {
        if (input.expectedMetadataVersion !== metadataVersion) return { status: 'conflict' as const, metadata, metadataVersion };
        metadata = input.metadata; metadataVersion++;
        return { status: 'applied' as const, metadata, metadataVersion };
      },
    },
    edit(next: Record<string, unknown>) { metadata = next; metadataVersion++; },
    setAvailable(value: boolean) { available = value; },
    version: () => metadataVersion,
  };
}

describe('daemon machine roles runtime', () => {
  it('starts with every core role (today) and publishes only real active-set changes from metadata changes', async () => {
    const m = machine({ host: 'x' });
    const runtime = createMachineRolesRuntime({ port: m.port });
    let publications = 0;
    const release = runtime.subscribe(() => { publications++; });
    try {
      // Before the first read the daemon behaves as today.
      expect([...runtime.activeRoles()].sort()).toEqual([...CORE_MACHINE_ROLE_IDS_V1].sort());
      await runtime.reload();
      expect(publications).toBe(0);
      m.edit({ host: 'x', displayName: 'renamed' });
      await runtime.reload();
      expect(publications).toBe(0);
      m.edit({ host: 'x', rolesV1: { active: ['broker'] } });
      await runtime.reload();
      expect(publications).toBe(1);
      expect([...runtime.activeRoles()]).toEqual(['broker']);
      // An unreadable snapshot keeps the last applied set; it is not a role change.
      m.setAvailable(false);
      await runtime.reload();
      expect(publications).toBe(1);
      expect([...runtime.activeRoles()]).toEqual(['broker']);
    } finally { release(); runtime.stop(); }
  });

  it('writes through field CAS and publishes the acknowledged set without another read', async () => {
    const m = machine({ host: 'x' });
    const runtime = createMachineRolesRuntime({ port: m.port });
    await runtime.reload();
    const seen: string[][] = [];
    const release = runtime.subscribe(() => seen.push([...runtime.activeRoles()]));
    const result = await runtime.set({ expectedMetadataVersion: m.version(), expectedPolicy: { active: [...CORE_MACHINE_ROLE_IDS_V1] },
      policy: { active: ['sessions', 'devices'] } });
    expect(result).toMatchObject({ status: 'applied', policy: { active: ['sessions', 'devices'] } });
    expect(seen).toEqual([['sessions', 'devices']]);
    expect(runtime.read()).toMatchObject({ status: 'ready', source: 'stored', policy: { active: ['sessions', 'devices'] } });
    release(); runtime.stop();
  });

  it('resolves plugin roles from the admitted catalog through the same resolver', async () => {
    const m = machine({ rolesV1: { active: ['acme/tests'] } });
    let catalog = [{ id: 'acme/tests', requires: ['sessions'] }];
    const runtime = createMachineRolesRuntime({ port: m.port, readPluginCatalog: () => catalog });
    await runtime.reload();
    expect(runtime.isActive('acme/tests')).toBe(false);
    m.edit({ rolesV1: { active: ['acme/tests', 'sessions'] } });
    await runtime.reload();
    expect(runtime.isActive('acme/tests')).toBe(true);
    catalog = [];
    runtime.refreshCatalog();
    expect(runtime.isActive('acme/tests')).toBe(false);
    runtime.stop();
  });
});

describe('daemon machine roles boot from the last applied set', () => {
  it('restores the Home-confirmed set offline from role storage and ignores the former settings copy', async () => {
    await withTempDir('daemon-applied-machine-roles-', async home => {
      const env = createEnvKeyScope(['HAPPIER_HOME_DIR']);
      env.patch({ HAPPIER_HOME_DIR: home });
      vi.resetModules();
      try {
        const { configuration } = await import('@/configuration');
        const { createDaemonMachineRolesRuntime, writeAppliedMachineRoles } = await import('./machineRolesRuntime');
        const serverId = configuration.activeServerId;
        const machineId = 'machine-a';
        const settings = JSON.stringify({ schemaVersion: 6, machineRolesByServerIdByMachineId: {
          [serverId]: { [machineId]: ['sessions'], 'machine-b': [] },
        } });
        await writeFile(configuration.settingsFile, settings);
        await writeAppliedMachineRoles(serverId, machineId, []);
        expect(await readFile(configuration.settingsFile, 'utf8')).toBe(settings);

        const m = machine();
        m.setAvailable(false);
        const boot = (homeId: string, id: string) =>
          createDaemonMachineRolesRuntime({ port: m.port, serverId: homeId, resolveMachineId: () => id });
        const runtime = await boot(serverId, machineId);
        try {
          expect([...runtime.activeRoles()]).toEqual([]);
          await runtime.reload();
          expect([...runtime.activeRoles()]).toEqual([]);
          m.setAvailable(true);
          m.edit({ rolesV1: { active: ['broker'] } });
          await runtime.reload();
        } finally { runtime.stop(); }

        m.setAvailable(false);
        const restarted = await boot(serverId, machineId);
        const otherMachine = await boot(serverId, 'machine-b');
        const otherHome = await boot('other-home', machineId);
        try {
          expect([...restarted.activeRoles()]).toEqual(['broker']);
          expect(otherMachine.isActive('sessions')).toBe(true);
          expect(otherHome.isActive('sessions')).toBe(true);
        } finally { restarted.stop(); otherMachine.stop(); otherHome.stop(); }
      } finally { env.restore(); vi.resetModules(); }
    });
  });

  it('starts with the persisted set before any metadata read, revalidates, and persists only real changes', async () => {
    const m = machine({ rolesV1: { active: ['broker'] } });
    m.setAvailable(false);
    const persisted: (readonly string[] | null)[] = [];
    const runtime = createMachineRolesRuntime({ port: m.port, initialStoredRoles: ['broker'],
      persistApplied: active => { persisted.push(active); } });
    // Offline boot: Sessions stay off; nothing is persisted for an unchanged set.
    expect(runtime.isActive('sessions')).toBe(false);
    await runtime.reload();
    expect(runtime.isActive('sessions')).toBe(false);
    m.setAvailable(true);
    await runtime.reload();
    expect(persisted).toEqual([]);
    m.edit({ rolesV1: { active: ['broker', 'sessions'] } });
    await runtime.reload();
    expect(runtime.isActive('sessions')).toBe(true);
    m.edit({ host: 'x' });
    await runtime.reload();
    expect(persisted).toEqual([['broker', 'sessions'], null]);
    runtime.stop();
  });
});

it('keeps applying roles when recording the applied set rejects', async () => {
  const m = machine({ rolesV1: { active: ['sessions'] } });
  const runtime = createMachineRolesRuntime({ port: m.port,
    persistApplied: async () => { throw new Error('disk unavailable'); } });
  try {
    await runtime.reload();
    await Promise.resolve();
    expect([...runtime.activeRoles()]).toEqual(['sessions']);
    m.edit({ rolesV1: { active: ['deployments'] } });
    await runtime.reload();
    await Promise.resolve();
    expect([...runtime.activeRoles()]).toEqual(['deployments']);
  } finally { runtime.stop(); }
});
