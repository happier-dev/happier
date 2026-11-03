import { describe, expect, it } from 'vitest';

import { publishServerHttpRuntimeOrigin } from '@/api/client/serverHttpBaseUrl';

import { ConnectedServiceRuntimeRegistry } from '../connectedServices/runtimeRegistry/registry';
import { prepareDaemonSpawnLifecycle } from './prepareDaemonSpawnLifecycle';
import { configuration } from '@/configuration';
import { buildSpawnChildProcessEnv } from './buildSpawnChildProcessEnv';

describe('prepareDaemonSpawnLifecycle', () => {
  it('passes the daemon-owned spawn nonce to the runner through the protected control environment', async () => {
    const result = await prepareDaemonSpawnLifecycle({
      runnerAgentSessionBootstrap: null,
      normalizedExistingSessionId: '',
      sessionAttachPayload: null,
      extraEnv: {},
      extraEnvForChild: {},
      providerBindingLaunchHandoff: null,
      processEnv: {},
      effectiveConnectedServicesBindings: undefined,
      catalogAgentId: 'codex',
      materializationKey: 'materialization-1',
      hasConnectedServiceAuth: false,
      connectedServiceRefreshCoordinator: null,
      connectedServiceQuotasCoordinator: null,
      connectedServiceRuntimeRegistry: new ConnectedServiceRuntimeRegistry(),
      spawnResourceCleanupByPid: new Map(),
      sessionAttachCleanupByPid: new Map(),
      setPendingSessionAttachCleanup: () => {},
      getSpawnResourceCleanupOnExit: () => null,
      onSpawnResourceCleanupArmed: () => {},
      spawnNonce: 'creation-attempt-1',
    });

    expect(result.extraEnvForChildWithMessage).toMatchObject({
      HAPPIER_SESSION_STARTUP_SPAWN_NONCE: 'creation-attempt-1',
    });
    expect(result.unsetEnvKeys).not.toContain('HAPPIER_SESSION_STARTUP_SPAWN_NONCE');
    for (const processEnv of [{}, { HAPPIER_HOME_DIR: '/stale-home' }]) {
      const childEnv = buildSpawnChildProcessEnv({
        processEnv,
        extraEnv: result.extraEnvForChildWithMessage,
        unsetEnvKeys: result.unsetEnvKeys,
      });
      expect(childEnv.HAPPIER_HOME_DIR).toBe(configuration.happyHomeDir);
    }
  });
  describe('child server route', () => {
    const prepare = async () => (await prepareDaemonSpawnLifecycle({
      runnerAgentSessionBootstrap: null,
      normalizedExistingSessionId: '',
      sessionAttachPayload: null,
      extraEnv: {},
      extraEnvForChild: {},
      providerBindingLaunchHandoff: null,
      processEnv: {},
      effectiveConnectedServicesBindings: undefined,
      catalogAgentId: 'codex',
      materializationKey: 'materialization-route',
      hasConnectedServiceAuth: false,
      connectedServiceRefreshCoordinator: null,
      connectedServiceQuotasCoordinator: null,
      connectedServiceRuntimeRegistry: new ConnectedServiceRuntimeRegistry(),
      spawnResourceCleanupByPid: new Map(),
      sessionAttachCleanupByPid: new Map(),
      setPendingSessionAttachCleanup: () => {},
      getSpawnResourceCleanupOnExit: () => null,
      onSpawnResourceCleanupArmed: () => {},
    })).extraEnvForChildWithMessage;

    it('routes the child through the daemon verified origin while keeping the canonical Home identity', async () => {
      const release = publishServerHttpRuntimeOrigin('http://127.0.0.1:34353', 'https');
      try {
        const env = await prepare();
        expect(env.HAPPIER_LOCAL_SERVER_URL).toBe('http://127.0.0.1:34353');
        expect(env.HAPPIER_PUBLIC_SERVER_URL).toBe(configuration.publicServerUrl);
        expect(env.HAPPIER_SERVER_URL).toBe(configuration.serverUrl);
      } finally {
        release();
      }
    });

    it('routes the child through the configured API URL when the daemon publishes no origin', async () => {
      const env = await prepare();
      expect(env.HAPPIER_LOCAL_SERVER_URL).toBe(configuration.apiServerUrl);
    });
  });
});
