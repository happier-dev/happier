import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { DaemonState } from '@/api/types';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { setActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveConnectedServiceHomeDir, resolveConnectedServiceGroupHomeDir } from '@/daemon/connectedServices/homes/resolveConnectedServiceHomeDir';
import { resolveConnectedServiceMaterializedRootDir } from '@/daemon/connectedServices/materialize/resolveConnectedServiceMaterializedRootDir';
import { createProviderAccountSettingsController } from './providerAccountSettings';

it('applies actual scoped Agent preferences to existing homes and publishes only changed confirmed reports', async () => {
  const root = await mkdtemp(join(tmpdir(), 'provider-account-settings-'));
  const native = join(root, 'native');
  const materializationBaseDir = join(root, 'materialized');
  let policy: { mode: 'days'; days: number } | null = { mode: 'days', days: 365 };
  let hasScopedPolicy = true;
  let revision = 1;
  const hints = new Set<() => void>();
  const errors: unknown[] = [];
  // Account persistence and transport are boundaries; registry, service watches,
  // settings admission, home inventory and the Claude editor are real.
  const runtime = await createAdmittedPluginRuntimeFixture({
    controller: pluginReloadController,
    runtimeOptions: { pluginIds: ['happier.agent.claude'], accountSettingsRecordAdapter: {
      bindOperation: async () => ({
        readRecord: async () => ({ status: 'present', revision, values: hasScopedPolicy ? { claudeSessionRetentionV1: policy } : {} }),
        writeRecord: async () => { throw new Error('Policy application must not rewrite Account intent'); },
      }),
      watchRecord: (_model, listener) => { const hint = () => listener({ revision }); hints.add(hint); return () => { hints.delete(hint); }; },
    } },
  });
  let state: DaemonState = { status: 'running', startedAt: 101 };
  let publications = 0;
  const controller = createProviderAccountSettingsController({
    scopeKey: 'retention-account', processEnv: { CLAUDE_CONFIG_DIR: native }, materializationBaseDir, activeServerDir: root,
    apiMachine: { updateDaemonState: async handler => {
      const next = handler(state);
      if (next !== state) { publications++; state = next; return 'published'; }
      return 'unchanged';
    } },
    onError: error => { errors.push(error); },
  });
  try {
    const entry = await runtime.registry.acquireAgentCatalogEntry!('claude');
    const descriptor = await entry?.getConnectedServiceStateSharingDescriptor?.();
    const directoryName = descriptor?.nativeHome?.materializedDirectoryName;
    if (!directoryName) throw new Error(`Claude native-home descriptor unavailable: ${JSON.stringify(runtime.registry.pluginDiagnosticsByPluginId)}`);
    const managed = resolveConnectedServiceMaterializedRootDir({ baseDir: materializationBaseDir, agentId: 'claude', materializationKey: 'retained-run' });
    const profile = join(resolveConnectedServiceHomeDir({ activeServerDir: root, serviceId: 'anthropic', profileId: 'inactive-profile', agentId: 'claude' }), directoryName);
    const group = join(resolveConnectedServiceGroupHomeDir({ activeServerDir: root, serviceId: 'anthropic', groupId: 'inactive-group', agentId: 'claude' }), directoryName);
    const homes = [native, managed, profile, group];
    for (const home of homes) {
      await mkdir(home, { recursive: true });
      await writeFile(join(home, 'settings.json'), JSON.stringify({ cleanupPeriodDays: 7, theme: 'dark' }));
    }
    setActiveAccountSettingsSnapshot({ source: 'network', scopeKey: 'retention-account', settings: accountSettingsParse({}), rawSettings: {}, settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [] });
    await controller.refresh();
    for (const home of homes) expect(JSON.parse(await readFile(join(home, 'settings.json'), 'utf8')))
      .toEqual({ cleanupPeriodDays: 365, theme: 'dark' });
    const requesterSettings = runtime.registry.createPluginSettingsService?.({
      pluginId: 'happier.agent.claude', scope: { kind: 'account' },
      accountSettingsRecordAdapter: { bindOperation: async () => ({
        readRecord: async () => ({ status: 'present', revision: 1, values: { claudeSessionRetentionV1: { mode: 'days', days: 120 } } }),
        writeRecord: async () => { throw new Error('Requester materialization is read-only'); },
      }) },
    });
    expect((await requesterSettings?.snapshot())?.values.claudeSessionRetentionV1).toEqual({ mode: 'days', days: 120 });
    expect(JSON.parse(await readFile(join(native, 'settings.json'), 'utf8')).cleanupPeriodDays).toBe(365);
    expect(state.providerSettingsV1?.claude).toMatchObject({ policy, targets: expect.arrayContaining([
      expect.objectContaining({ id: 'native', status: 'applied', currentDays: 365 }),
    ]) });
    expect(state.providerSettingsSourceV1).toMatchObject({ pid: process.pid, startedAt: 101 });
    const before = publications;
    await controller.refresh();
    expect(publications).toBe(before);
    state = { ...state, startedAt: 102 };
    await controller.refresh();
    expect(state.providerSettingsSourceV1).toMatchObject({ pid: process.pid, startedAt: 102 });
    expect(publications).toBe(before + 1);
    policy = { mode: 'days', days: 36500 }; revision++;
    for (const hint of hints) hint();
    await vi.waitFor(async () => expect(JSON.parse(await readFile(join(native, 'settings.json'), 'utf8')).cleanupPeriodDays).toBe(36500));
    // A preference in the predecessor 0.2 root format remains readable until a scoped value
    // exists. An explicit scoped null stops management even with that root.
    hasScopedPolicy = false; revision++;
    setActiveAccountSettingsSnapshot({ source: 'network', scopeKey: 'retention-account', settings: accountSettingsParse({}),
      rawSettings: { claudeSessionRetentionV1: { mode: 'days', days: 120 } },
      settingsVersion: 2, loadedAtMs: 2, settingsSecretsReadKeys: [] });
    for (const hint of hints) hint();
    await controller.refresh();
    expect(JSON.parse(await readFile(join(native, 'settings.json'), 'utf8')).cleanupPeriodDays).toBe(120);
    hasScopedPolicy = true; policy = null; revision++;
    for (const hint of hints) hint();
    await controller.refresh();
    expect(state.providerSettingsV1?.claude).toMatchObject({ policy: null });
    expect(JSON.parse(await readFile(join(native, 'settings.json'), 'utf8')).cleanupPeriodDays).toBe(120);
    expect(errors).toEqual([]);
  } finally {
    await controller.stop();
    resetActiveAccountSettingsSnapshotForTests();
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
