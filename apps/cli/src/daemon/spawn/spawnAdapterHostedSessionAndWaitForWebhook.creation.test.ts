import { access, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { reloadConfiguration } from '@/configuration';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { writeExecutableShim } from '@/testkit/fs/executableShim';
import { withHerdrApi } from '@/integrations/herdr/herdrApi.testkit';
import { ConnectedServiceRuntimeRegistry } from '../connectedServices/runtimeRegistry/registry';
import { prepareDaemonSpawnLifecycle } from './prepareDaemonSpawnLifecycle';
import { spawnAdapterHostedSessionAndWaitForWebhook } from './spawnAdapterHostedSessionAndWaitForWebhook';

describe('adapter creation resource custody', () => {
  it.skipIf(process.platform === 'win32').each([false, true])('retains accepted-but-unconfirmed inputs and cleans confirmed stopped inputs (stopped=%s)', async (stopped) => {
    await withTempDir('hosted-creation-', async (directory) => {
      await withHerdrApi(async (api) => {
        const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HERDR_BIN_PATH']);
        const resourcePath = join(directory, 'private-provider-input');
        await writeFile(resourcePath, 'private');
        const binary = await writeExecutableShim({
          dir: directory, fileName: 'herdr',
          contents: `#!/bin/sh\nif [ "$1" = "--version" ]; then printf 'herdr 0.9.2\\n'; else printf '%s\\n' '${JSON.stringify({ sessions: [{ name: 'work', socket_path: api.socketPath, running: true }] })}'; fi\n`,
        });
        env.patch({ HAPPIER_HOME_DIR: directory, HERDR_BIN_PATH: binary });
        reloadConfiguration();
        api.faults.set('pane.get', 'error');
        if (!stopped) api.faults.set('pane.close', 'error');
        const cleanupSpawnResources = async () => { await unlink(resourcePath); };
        let lifecycle: Awaited<ReturnType<typeof prepareDaemonSpawnLifecycle>> | undefined;
        let retainedForUntrackedChild = false;
        try {
          lifecycle = await prepareDaemonSpawnLifecycle({
            runnerAgentSessionBootstrap: null, normalizedExistingSessionId: 'existing-session',
            sessionAttachPayload: { v: 2, encryptionMode: 'plain' },
            extraEnv: {}, extraEnvForChild: {}, providerBindingLaunchHandoff: null, processEnv: {},
            effectiveConnectedServicesBindings: undefined, catalogAgentId: null,
            materializationKey: 'creation-test', hasConnectedServiceAuth: false,
            connectedServiceRefreshCoordinator: null, connectedServiceQuotasCoordinator: null,
            connectedServiceRuntimeRegistry: new ConnectedServiceRuntimeRegistry(),
            spawnResourceCleanupByKey: new Map(), sessionAttachCleanupByKey: new Map(),
            setPendingSessionAttachCleanup: () => {}, getSpawnResourceCleanupOnExit: () => cleanupSpawnResources,
            onSpawnResourceCleanupArmed: () => {},
          });
          const result = await spawnAdapterHostedSessionAndWaitForWebhook({
            terminalRequest: { requested: 'herdr', herdr: { sessionName: 'work' } },
            directory, trackedSpawnOptions: { directory }, normalizedExistingSessionId: 'existing-session',
            effectiveResume: 'native-session',
            effectiveBackendTargetV2: { kind: 'backend', sourceKind: 'configured', backendId: 'configured-agent', configuredBackendId: 'configured-agent' },
            sessionControlArgs: [], directoryCreated: false,
            extraEnvForChildWithMessage: lifecycle.extraEnvForChildWithMessage,
            processEnv: {}, happyHomeDir: directory, trackedSessionsByKey: new Map(), spawnAwaiterByKey: new Map(),
            spawnResultResolverByKey: new Map(), spawnWebhookTimeoutByKey: new Map(),
            onChildExited: async () => {}, spawnLifecycleCallbacks: lifecycle.spawnLifecycleCallbacks,
            cleanupSpawnResources, logDebug: () => {}, warn: () => {},
            onUntrackedHostedChild: () => { retainedForUntrackedChild = true; },
          });
          expect(result).toMatchObject({ type: 'error', errorCode: 'SPAWN_FAILED' });
          expect(retainedForUntrackedChild).toBe(!stopped);
          const attachPath = lifecycle.extraEnvForChildWithMessage.HAPPIER_SESSION_ATTACH_FILE!;
          if (stopped) {
            await expect(access(attachPath)).rejects.toMatchObject({ code: 'ENOENT' });
            await expect(access(resourcePath)).rejects.toMatchObject({ code: 'ENOENT' });
            expect([...api.panes]).toEqual([]);
          } else {
            await expect(readFile(attachPath, 'utf8')).resolves.toContain('plain');
            await expect(readFile(resourcePath, 'utf8')).resolves.toBe('private');
            expect([...api.panes]).toEqual(['managed']);
          }
        } finally {
          env.restore();
          reloadConfiguration();
          await lifecycle?.cleanupPendingSessionAttach();
        }
      });
    });
  });
});
