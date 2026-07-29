import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { reloadConfiguration } from '@/configuration';
import { createPluginStateStore } from '@/plugins/store/state.testkit';
import {
  SAMPLE_PLUGIN_BACKEND_ID,
  SAMPLE_PLUGIN_ID,
  materializeSamplePluginFixture,
} from '@/plugins/testkit/samplePackage';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import type { Credentials } from '@/persistence';

import { SessionHostBridge } from './SessionHostBridge';

const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH']);

function createTestCredentials(): Credentials {
  return {
    token: 'test-token',
    encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
  };
}

async function installSample(params: Readonly<{
  happyHomeDir: string;
  pluginRoot: string;
  trustPolicy: 'local_trusted' | 'prompt';
}>): Promise<void> {
  await materializeSamplePluginFixture(params.pluginRoot);
  await createPluginStateStore({ happyHomeDir: params.happyHomeDir }).write({
    t: 'happier_plugin_state_v1',
    schemaVersion: 1,
    plugins: {
      [SAMPLE_PLUGIN_ID]: {
        source: {
          kind: 'path',
          locator: params.pluginRoot,
          trustPolicy: params.trustPolicy,
          installPolicy: 'link',
          resolvedPath: params.pluginRoot,
          manifestPath: join(params.pluginRoot, '.happier-plugin', 'plugin.json'),
        },
        compatibility: { status: 'unknown', diagnostics: [] },
        install: {
          mode: 'link',
          manifestVersion: '1.0.0',
          manifestDigest: null,
          installedPath: null,
        },
        state: { enabled: true },
      },
    },
  });
}

afterEach(() => {
  envScope.restore();
  reloadConfiguration();
});

describe('SessionHostBridge current custom Agent (integration)', () => {
  it('creates and opens a native session through the generation-bound Agent runtime lease', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-session-bridge-current-home-'));
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-session-bridge-current-plugin-'));
    try {
      await installSample({ happyHomeDir, pluginRoot, trustPolicy: 'local_trusted' });
      envScope.patch({ HAPPIER_HOME_DIR: happyHomeDir, PATH: process.env.PATH ?? '' });
      reloadConfiguration();

      const plan = await new SessionHostBridge().createSessionRuntime(SAMPLE_PLUGIN_BACKEND_ID, {
        credentials: createTestCredentials(),
        directory: pluginRoot,
        happyHomeDir,
      });
      expect(plan.agentId).toBe(SAMPLE_PLUGIN_BACKEND_ID);
      expect(plan.config.createSessionRuntime).toBeTypeOf('function');

      const runtime = await plan.config.createSessionRuntime?.({
        directory: pluginRoot,
        metadata: {},
        machineId: 'machine-plugin',
        session: { sessionId: 'happy-session-1' },
        transcriptSession: {},
        messageBuffer: {},
        mcpServers: {},
        permissionHandler: {},
        getPermissionMode: () => 'default',
        setThinking: () => {},
        memoryRecallGuidanceEnabled: false,
      } as never);
      expect(runtime).toMatchObject({
        operations: {
          sendTurnPrompt: expect.any(Function),
          subscribeRuntimeEvents: expect.any(Function),
          resetOrDisposeRuntime: expect.any(Function),
        },
      });
    } finally {
      await rm(happyHomeDir, { recursive: true, force: true });
      await rm(pluginRoot, { recursive: true, force: true });
    }
  });

  it('fails before runtime creation when the current Agent plugin still requires trust approval', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-session-bridge-prompt-home-'));
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-session-bridge-prompt-plugin-'));
    try {
      await installSample({ happyHomeDir, pluginRoot, trustPolicy: 'prompt' });
      envScope.patch({ HAPPIER_HOME_DIR: happyHomeDir, PATH: process.env.PATH ?? '' });
      reloadConfiguration();

      await expect(new SessionHostBridge().createSessionRuntime(SAMPLE_PLUGIN_BACKEND_ID, {
        credentials: createTestCredentials(),
        directory: pluginRoot,
        happyHomeDir,
      })).rejects.toThrow(/trust approval/i);
    } finally {
      await rm(happyHomeDir, { recursive: true, force: true });
      await rm(pluginRoot, { recursive: true, force: true });
    }
  });
});
