import { writeFile } from 'node:fs/promises';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { createDaemonMachineBootstrapRuntime } from './createDaemonMachineBootstrapRuntime';
import { applyEnvValues, restoreEnvValues, snapshotEnvValues } from '@/testkit/env/envSnapshot';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';

function createBaseRuntimeParams(
  overrides: Partial<Parameters<typeof createDaemonMachineBootstrapRuntime>[0]> = {},
) {
  return {
    // Test fixture boundary: the real Memory worker does not invoke the API client during startup.
    api: { machineSyncClient: vi.fn() } as never,
    credentials: { token: 'token-only', encryption: null },
    diagnosticSubsystemGates: {
      disableMachineSync: false,
      disableAutomationWorker: false,
    },
    runtimeId: 'runtime_1',
    publicReleaseChannel: 'dev' as const,
    startupSource: 'manual',
    serviceLabel: undefined,
    transferRuntimeStatePublisher: null,
    spawnSession: vi.fn(),
    stopSession: vi.fn(),
    awaitAgentSessionOpen: vi.fn(),
    isSessionAlreadyRunning: vi.fn(),
    loadLocalSessionMetadataForHandoff: vi.fn(),
    savePreparedTargetLocalMetadata: vi.fn(),
    beforeShutdown: vi.fn(),
    requestShutdown: vi.fn(),
    directPeerServerLifecycle: null,
    // Test fixture boundary: these pass-through runtime dependencies are not invoked by Memory startup.
    directTransferPromptAssetAdapterRegistry: {} as never,
    directTransferPromptRegistryRegistry: {} as never,
    daemonServerWorkScheduler: {} as never,
    setDaemonServerWorkOnline: vi.fn(),
    onMachineConnectionOnline: vi.fn(),
    reconcileConnectedServicesProjection: vi.fn(),
    isShuttingDown: () => false,
    ...overrides,
  } satisfies Parameters<typeof createDaemonMachineBootstrapRuntime>[0];
}

describe('createDaemonMachineBootstrapRuntime Memory startup', () => {
  const envBackup = snapshotEnvValues(['HAPPIER_HOME_DIR', 'HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL']);
  let homeDir: string | undefined;

  beforeEach(async () => {
    homeDir = await createTempDir('happier-daemon-memory-bootstrap-');
    applyEnvValues({
      HAPPIER_HOME_DIR: homeDir,
      HAPPIER_SERVER_URL: 'https://api.example.test',
      HAPPIER_WEBAPP_URL: 'https://app.example.test',
    });
    vi.resetModules();
  });

  afterEach(async () => {
    restoreEnvValues(envBackup);
    vi.resetModules();
    if (homeDir) await removeTempDir(homeDir);
  });

  it('starts the canonical Memory worker for token-only credentials and plaintext settings', async () => {
    const { writeCredentialsTokenOnly } = await import('@/persistence');
    const { writeMemorySettingsToDisk } = await import('@/settings/memorySettings');
    await writeCredentialsTokenOnly({ token: 'token-only' });
    await writeMemorySettingsToDisk({ v: 1, enabled: true, indexMode: 'hints' });

    const { createDaemonMachineBootstrapRuntime: createRuntime } = await import(
      './createDaemonMachineBootstrapRuntime'
    );
    const runtime = createRuntime(createBaseRuntimeParams());
    const worker = await runtime.startMemoryWorkerForMachine('machine_1');

    expect(worker).not.toBeNull();
    expect(worker?.getSettings().enabled).toBe(true);
    expect(worker?.getTier1DbPath()).toBeTruthy();
    worker?.stop();
  }, 60_000);

  it('keeps retained unreadable encrypted Memory settings typed unavailable instead of disabling Memory', async () => {
    const { configuration } = await import('@/configuration');
    const { writeCredentialsTokenOnly } = await import('@/persistence');
    const { writeMemorySettingsToDisk } = await import('@/settings/memorySettings');
    await writeCredentialsTokenOnly({ token: 'token-only' });
    await writeMemorySettingsToDisk({
      v: 1,
      enabled: true,
      indexMode: 'deep',
      embeddings: {
        mode: 'custom',
        custom: {
          kind: 'openai_compatible',
          baseUrl: 'https://example.test/v1',
          apiKey: { _isSecretValue: true, value: 'sk-device-sealed' },
          model: 'text-embedding-3-small',
        },
      },
    });
    await writeFile(
      configuration.deviceLocalSecretKeyFile,
      JSON.stringify({
        version: 1,
        key: Buffer.from(new Uint8Array(32).fill(9)).toString('base64url'),
      }),
      { encoding: 'utf8', mode: 0o600 },
    );

    vi.resetModules();
    const { createDaemonMachineBootstrapRuntime: createRuntime } = await import(
      './createDaemonMachineBootstrapRuntime'
    );
    const runtime = createRuntime(createBaseRuntimeParams());

    await expect(runtime.startMemoryWorkerForMachine('machine_1')).rejects.toMatchObject({
      code: 'memory_settings_secrets_unavailable',
    });
  });
});
