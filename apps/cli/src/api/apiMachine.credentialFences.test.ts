import axios from 'axios';
import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { configuration, reloadConfiguration } from '@/configuration';
import { readOrCreateInstallationIdentity } from '@/daemon/identity/store';
import { writeStoredCredentialsForServerId, type StoredCredentials } from '@/persistence';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { ApiMachineClient } from './apiMachine';

const fileBoundary = vi.hoisted(() => ({ afterCredentialRead: undefined as (() => void | Promise<void>) | undefined }));
// Count actual credential-file I/O, retaining the real storage parser and identity checks.
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn(async (...args: Parameters<typeof actual.readFile>) => {
    const result = await actual.readFile(...args);
    if (String(args[0]).endsWith('access.key')) await fileBoundary.afterCredentialRead?.();
    return result;
  }) };
});

const envKeys = ['HAPPIER_HOME_DIR', 'HAPPIER_ACTIVE_SERVER_ID', 'HAPPIER_SERVER_URL',
  'HAPPIER_LOCAL_SERVER_URL', 'HAPPIER_PUBLIC_SERVER_URL', 'HAPPIER_WEBAPP_URL'] as const;
const envScope = createEnvKeyScope(envKeys);

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  fileBoundary.afterCredentialRead = undefined;
  envScope.restore();
  reloadConfiguration();
});

async function withInstalledAccount(run: (input: Readonly<{
  client: ApiMachineClient;
  credentials: StoredCredentials;
  credentialPath: string;
  installationId: string;
  reads(): number;
}>) => Promise<void>) {
  await withTempDir('happier-credential-fences-', async directory => {
    envScope.patch({ HAPPIER_HOME_DIR: directory, HAPPIER_ACTIVE_SERVER_ID: 'credential-fences',
      HAPPIER_SERVER_URL: 'https://credential-fences.test', HAPPIER_LOCAL_SERVER_URL: undefined,
      HAPPIER_PUBLIC_SERVER_URL: undefined, HAPPIER_WEBAPP_URL: undefined });
    reloadConfiguration();
    const installation = await readOrCreateInstallationIdentity();
    const credentials: StoredCredentials = { token: 'credential-fence-fixture', encryption: {
      type: 'dataKey', publicKey: new Uint8Array(32).fill(3), machineKey: new Uint8Array(32).fill(4),
    }, credentialProvenance: 'stored_session' };
    await writeStoredCredentialsForServerId(configuration.activeServerId, credentials);
    const credentialPath = join(configuration.serversDir, configuration.activeServerId, 'access.key');
    const client = new ApiMachineClient(credentials.token, { id: 'credential-machine', encryptionMode: 'plain',
      metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 });
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { id: 'credential-account' } });
    vi.mocked(readFile).mockClear();
    await run({ client, credentials, credentialPath, installationId: installation.installationId,
      reads: () => vi.mocked(readFile).mock.calls.filter(([path]) => path === credentialPath).length });
  });
}

describe('installed Account credential fences', () => {
  it('opens once at admission with local later checks and no cross-operation reuse', async () => {
    await withInstalledAccount(async ({ client, reads }) => {
      const signal = new AbortController().signal;
      const runtime = await client.resolveInstalledAccountObservationRuntime(signal);
      if (!runtime?.isCurrent) throw new Error('Missing installed Account runtime');
      expect(reads()).toBe(1);
      for (let fence = 1; fence <= 16; fence += 1) {
        expect(await runtime.isCurrent()).toBe(true);
        expect(reads()).toBe(1);
      }
      vi.useFakeTimers();
      await vi.advanceTimersByTimeAsync(300_000);
      expect(reads()).toBe(1);
      vi.useRealTimers();
      expect(await client.resolveInstalledAccountObservationRuntime(signal)).not.toBeNull();
      expect(reads()).toBe(2);
    });
  });

  it.each(['token', 'key', 'revoked'] as const)('finishes admitted work after %s replacement and freshly admits the next operation', async change => {
    await withInstalledAccount(async ({ client, credentials, credentialPath, reads }) => {
      const signal = new AbortController().signal;
      const runtime = await client.resolveInstalledAccountObservationRuntime(signal);
      if (!runtime?.isCurrent) throw new Error('Missing installed Account runtime');
      // Exercise a real consumer: it checks this runtime immediately before HTTP and after the response.
      const { readCurrentMountedAccountPluginExecutionSelection } = await import('@/plugins/runtime/accountPluginActivationSource');
      const post = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: {
        availabilityCursor: 1, hostingCapability: { enabled: false }, intent: null, release: null, uiArtifacts: [], packageAssets: [],
      } });
      const read = () => readCurrentMountedAccountPluginExecutionSelection({ pluginId: 'happier.fixture',
        runtime: { ...runtime, isCurrent: runtime.isCurrent! }, signal });
      await read();
      expect(post).toHaveBeenCalledTimes(1);
      const before = reads();
      if (change === 'revoked') await unlink(credentialPath);
      else await writeStoredCredentialsForServerId(configuration.activeServerId, change === 'token'
        ? { ...credentials, token: 'replacement-fixture' }
        : { ...credentials, encryption: { type: 'dataKey', publicKey: new Uint8Array(32).fill(3), machineKey: new Uint8Array(32).fill(5) } });
      await read();
      expect(post).toHaveBeenCalledTimes(2);
      expect(reads() - before).toBe(0);
      const next = await client.resolveInstalledAccountObservationRuntime(signal);
      if (change === 'key') {
        expect(next?.credentials.encryption).not.toEqual(credentials.encryption);
      } else expect(next).toBeNull();
    });
  });

  it('keeps Machine admission and local activity checks without reopening admitted credentials', async () => {
    await withInstalledAccount(async ({ client, credentials, installationId, reads }) => {
      const signal = new AbortController().signal;
      const runtime = await client.resolveOwnSessionRuntime({ signal,
        machineAdmission: { actorAccountId: 'credential-account', custodianAccountId: 'credential-account',
          machineId: 'credential-machine', installationId, role: 'manage', encryptionMode: 'plain' },
        verifyMachineAdmissionCurrent: async () => true });
      if (!runtime?.isCurrent) throw new Error('Missing installed Machine runtime');
      expect(reads()).toBe(1);
      const post = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: {
        availabilityCursor: 1, hostingCapability: { enabled: false },
        intent: { pluginId: 'happier.fixture', desiredVersion: null, enabled: false,
          offlineUiHosting: 'disabled', writableCollections: [], revision: '1' },
        release: null, uiArtifacts: [], packageAssets: [],
      } });
      await expect(client.resolveAccountPluginExecutionSelection('happier.fixture', signal)).resolves.not.toEqual({
        kind: 'unavailable', code: 'plugin_account_execution_unavailable',
      });
      expect(post).toHaveBeenCalledTimes(1);
      const admittedReads = reads();
      expect(await runtime.isCurrent()).toBe(true);
      expect(reads() - admittedReads).toBe(0);
      await writeStoredCredentialsForServerId(configuration.activeServerId, { ...credentials, token: 'rotated-at-admission' });
      expect(await runtime.isCurrent()).toBe(true);
      expect(reads() - admittedReads).toBe(0);
      await expect(client.resolveAccountPluginExecutionSelection('happier.fixture', signal)).resolves.toEqual({
        kind: 'unavailable', code: 'plugin_account_execution_unavailable',
      });
      expect(post).toHaveBeenCalledTimes(1);
      expect(reads() - admittedReads).toBe(1);
    });
  });

  it.each(['cancelled', 'installation-retired'] as const)('refuses entry when %s during physical credential opening', async change => {
    await withInstalledAccount(async ({ client }) => {
      const lifetime = new AbortController();
      fileBoundary.afterCredentialRead = async () => {
        if (change === 'cancelled') lifetime.abort();
        else await unlink(configuration.installationIdentityFile);
      };
      await expect(client.resolveInstalledAccountObservationRuntime(lifetime.signal)).resolves.toBeNull();
    });
  });

  it('retains fresh credential custody for setup effects and local cancellation for admitted reads', async () => {
    await withInstalledAccount(async ({ client, credentials, installationId }) => {
      const lifetime = new AbortController();
      const runtime = await client.resolveMachineSetupRuntime({ signal: lifetime.signal,
        machineAdmission: { actorAccountId: 'credential-account', custodianAccountId: 'credential-account',
          machineId: 'credential-machine', installationId, role: 'manage', encryptionMode: 'plain' },
        verifyMachineAdmissionCurrent: async () => true });
      expect(await runtime?.isCustodyCurrent()).toBe(true);
      await writeStoredCredentialsForServerId(configuration.activeServerId, { ...credentials, token: 'next-owner' });
      expect(await runtime?.isCustodyCurrent()).toBe(false);
      expect(await runtime?.isCurrent?.()).toBe(true);
      lifetime.abort();
      expect(await runtime?.isCurrent?.()).toBe(false);
    });
  });

  it('finishes an admitted response when credentials rotate during HTTP and refuses the next admission', async () => {
    await withInstalledAccount(async ({ client, credentials, reads }) => {
      const signal = new AbortController().signal;
      const runtime = await client.resolveInstalledAccountObservationRuntime(signal);
      if (!runtime?.isCurrent) throw new Error('Missing installed Account runtime');
      const { readCurrentMountedAccountPluginExecutionSelection } = await import('@/plugins/runtime/accountPluginActivationSource');
      let rotate = false;
      const post = vi.spyOn(axios, 'post').mockImplementation(async () => {
        if (rotate) await writeStoredCredentialsForServerId(configuration.activeServerId, { ...credentials, token: 'rotated-during-http' });
        return { status: 200, data: { availabilityCursor: 1, hostingCapability: { enabled: false },
          intent: { pluginId: 'happier.fixture', desiredVersion: null, enabled: false,
            offlineUiHosting: 'disabled', writableCollections: [], revision: '1' },
          release: null, uiArtifacts: [], packageAssets: [] } };
      });
      const read = () => readCurrentMountedAccountPluginExecutionSelection({ pluginId: 'happier.fixture',
        runtime: { ...runtime, isCurrent: runtime.isCurrent! }, signal });
      const current = await read();
      expect(current).not.toEqual({ kind: 'unavailable', code: 'plugin_account_execution_unavailable' });
      const before = reads();
      rotate = true;
      await expect(read()).resolves.toEqual(current);
      expect(post).toHaveBeenCalledTimes(2);
      expect(reads() - before).toBe(0);
      expect(await client.resolveInstalledAccountObservationRuntime(signal)).toBeNull();
    });
  });
});
