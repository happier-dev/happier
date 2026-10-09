import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { createPluginStateStore, PluginStateFileV1Schema } from '@/plugins/store/state.testkit';
import type { PluginChangeRequestResult } from '@/plugins/daemon/changeContract';
import { ManagedResourceDispositionV1Schema } from '@happier-dev/protocol/machines/managed/managedDependencyV1';

import { setInstalledPluginEnabled } from './enabled';

// The daemon control transport and daemon process startup are external boundaries;
// the user-change client and registry reader remain real.
const daemonControl = vi.hoisted(() => ({
  requestDaemonPluginChange: vi.fn(async (): Promise<PluginChangeRequestResult> => ({
    kind: 'unavailable',
    code: 'unexpected_test_call',
  })),
}));

vi.mock('@/daemon/controlClient', () => daemonControl);
vi.mock('@/daemon/ensureDaemon', () => ({ ensureDaemonRunningForSessionCommand: vi.fn(async () => undefined) }));

const resource = {
  managedId: 'managed-review', homeId: 'home', custodianAccountId: 'account', intentRevision: 8,
  controller: { machineId: 'controller', installationId: 'installation' },
  provider: { pluginId: 'acme.example', localId: 'cloud' }, allocation: 'may-exist' as const,
  recovery: { reference: 'native-8', reason: 'credential_missing', consoleUrl: 'https://provider.example/native-8' },
};

async function withEnabledPlugin(run: (happyHomeDir: string) => Promise<void>): Promise<void> {
  const happyHomeDir = await createTempDir('happier-plugin-enabled-');
  const store = createPluginStateStore({ happyHomeDir });
  try {
    await store.write(PluginStateFileV1Schema.parse({
      t: 'happier_plugin_state_v1', schemaVersion: 1,
      plugins: {
        'acme.example': {
          source: { kind: 'path', locator: happyHomeDir, trustPolicy: 'local_trusted', installPolicy: 'link',
            resolvedPath: happyHomeDir, manifestPath: `${happyHomeDir}/.happier-plugin/plugin.json` },
          compatibility: { status: 'compatible', diagnostics: [] },
          install: { mode: 'link', manifestVersion: '1.0.0' }, state: { enabled: true },
        },
      },
    }));
    await run(happyHomeDir);
  } finally {
    await removeTempDir(happyHomeDir);
  }
}

describe('setInstalledPluginEnabled', () => {
  beforeEach(() => { daemonControl.requestDaemonPluginChange.mockClear(); });

  it('preserves the daemon removal review without changing local plugin state', async () => {
    const review = { kind: 'managedResourcesReviewRequired' as const, pluginId: 'acme.example', resources: [resource] };
    daemonControl.requestDaemonPluginChange.mockResolvedValueOnce(review);
    await withEnabledPlugin(async (happyHomeDir) => {
      await expect(setInstalledPluginEnabled({ happyHomeDir, pluginId: 'acme.example', enabled: false }))
        .resolves.toMatchObject({ ok: false, change: review });
      expect((await createPluginStateStore({ happyHomeDir }).read()).plugins['acme.example']?.state.enabled).toBe(true);
    });
  });

  it('replays exact reviewed responsibility through the daemon without inferring cleanup', async () => {
    const disposition = ManagedResourceDispositionV1Schema.parse({
      managedId: resource.managedId, expectedIntentRevision: resource.intentRevision,
      expectedAllocation: resource.allocation, expectedRecovery: resource.recovery, responsibility: 'manual',
    });
    const change = { kind: 'committed' as const, pluginId: 'acme.example', desiredGeneration: null,
      appliedGeneration: null, pendingSurfaces: [] };
    daemonControl.requestDaemonPluginChange.mockResolvedValueOnce(change);
    await withEnabledPlugin(async (happyHomeDir) => {
      await expect(setInstalledPluginEnabled({ happyHomeDir, pluginId: 'acme.example', enabled: false,
        managedResourceDispositions: [disposition] })).resolves.toMatchObject({ ok: true, change });
      expect(daemonControl.requestDaemonPluginChange).toHaveBeenCalledWith({
        kind: 'disable', pluginId: 'acme.example', managedResourceDispositions: [disposition],
      });
      expect((await createPluginStateStore({ happyHomeDir }).read()).plugins['acme.example']?.state.enabled).toBe(true);
    });
  });

  it.each([
    { change: { kind: 'outcomeUnknown', pluginId: 'acme.example' }, errorCode: 'outcome_unknown' },
    { change: { kind: 'dataRemovalPartial', pluginId: 'acme.example', completed: ['uninstall'],
        pending: ['daemonStorage', 'secrets'], causeCode: 'storage_unavailable' }, errorCode: 'plugin_data_removal_partial' },
  ] satisfies readonly { change: PluginChangeRequestResult; errorCode: string }[])(
    'preserves $change.kind with the canonical diagnostic code', async ({ change, errorCode }) => {
      daemonControl.requestDaemonPluginChange.mockResolvedValueOnce(change);
      await withEnabledPlugin(async (happyHomeDir) => {
        await expect(setInstalledPluginEnabled({ happyHomeDir, pluginId: 'acme.example', enabled: false }))
          .resolves.toMatchObject({ ok: false, errorCode, change });
      });
    },
  );

  it('routes a state change through the daemon without writing the registry locally', async () => {
    const happyHomeDir = await createTempDir('happier-plugin-enabled-');
    const store = createPluginStateStore({ happyHomeDir });
    await store.write(PluginStateFileV1Schema.parse({
      t: 'happier_plugin_state_v1',
      schemaVersion: 1,
      plugins: {
        'acme.example': {
          source: {
            kind: 'path',
            locator: happyHomeDir,
            trustPolicy: 'local_trusted',
            installPolicy: 'link',
            resolvedPath: happyHomeDir,
            manifestPath: `${happyHomeDir}/.happier-plugin/plugin.json`,
          },
          compatibility: { status: 'compatible', diagnostics: [] },
          install: { mode: 'link', manifestVersion: '1.0.0' },
          state: { enabled: true },
        },
      },
    }));
    daemonControl.requestDaemonPluginChange.mockResolvedValueOnce({
      kind: 'committed' as const,
      pluginId: 'acme.example',
      desiredGeneration: null,
      appliedGeneration: null,
      pendingSurfaces: [],
    });

    try {
      await expect(setInstalledPluginEnabled({
        happyHomeDir,
        pluginId: 'acme.example',
        enabled: false,
      })).resolves.toMatchObject({ ok: true, changed: true });

      expect(daemonControl.requestDaemonPluginChange).toHaveBeenCalledWith({ kind: 'disable', pluginId: 'acme.example' });
      expect((await store.read()).plugins['acme.example']?.state.enabled).toBe(true);
    } finally {
      await removeTempDir(happyHomeDir);
    }
  });
});
