import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { reloadConfiguration } from '@/configuration';
import { createPluginStateStore } from '@/plugins/store/state';
import {
  SAMPLE_PLUGIN_BACKEND_ID,
  SAMPLE_PLUGIN_ID,
  SAMPLE_PLUGIN_PROVIDER_ID,
  materializeSamplePluginFixture,
} from '@/plugins/testkit/samplePackage';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import type { AgentMessage } from '@/agent/core/AgentMessage';
import type { Credentials } from '@/persistence';

const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH']);

function createTestCredentials(): Credentials {
  return {
    token: 'test-token',
    encryption: {
      type: 'legacy',
      secret: new Uint8Array(32).fill(1),
    },
  };
}

function isAgentMessage(value: unknown): value is AgentMessage {
  if (!value || typeof value !== 'object') return false;
  const record = value as Readonly<Record<string, unknown>>;
  return typeof record.type === 'string';
}

describe('SessionHostBridge plugin runtimeCore (integration)', () => {
  it('defers plugin terminal runtime launch until the host runtime factory params exist', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-session-bridge-plugin-home-'));
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-session-bridge-plugin-root-'));
    const launchRecordPath = join(pluginRoot, 'launch-record.json');

    try {
      await materializeSamplePluginFixture(pluginRoot);
      await writeFile(
        join(pluginRoot, 'daemon.mjs'),
        [
          "import { writeFile } from 'node:fs/promises';",
          'function createRuntime() {',
          '  let sessionId = null;',
          '  return {',
          '    beginTurnLifecycle() {},',
          '    async startOrLoadSession(opts) { sessionId = opts?.resumeId ?? "integration-session"; },',
          '    async sendTurnPrompt() {},',
          '    async steerInFlightTurn() {},',
          '    async waitForTurnCompletion() {},',
          '    subscribeRuntimeEvents() { return () => undefined; },',
          '    async cancelTurn() {},',
          '    readSessionIdentity() { return { sessionId }; },',
          '    async updateSessionRuntimeConfig() {},',
          '    async resetOrDisposeRuntime() {},',
          '  };',
          '}',
          'export async function launch(params) {',
          `  await writeFile(${JSON.stringify(launchRecordPath)}, JSON.stringify({`,
          '    backendId: params?.backend?.id ?? null,',
          '    providerId: params?.backend?.providerId ?? null,',
          '    hasCredentials: Boolean(params?.credentials),',
          '    workingDirectory: params?.bootstrap?.workingDirectory ?? null,',
          '    hasSession: Boolean(params?.session),',
          '    hasPermissionHandler: Boolean(params?.permissionHandler),',
          '  }), "utf8");',
          '  return { runtime: createRuntime() };',
          '}',
        ].join('\n'),
        'utf8',
      );

      const store = createPluginStateStore({ happyHomeDir });
      await store.write({
        t: 'happier_plugin_state_v1',
        schemaVersion: 1,
        plugins: {
          [SAMPLE_PLUGIN_ID]: {
            source: {
              kind: 'path',
              locator: pluginRoot,
              trustPolicy: 'local_trusted',
              installPolicy: 'link',
              resolvedPath: pluginRoot,
              manifestPath: join(pluginRoot, '.happier-plugin', 'plugin.json'),
            },
            compatibility: {
              status: 'unknown',
              diagnostics: [],
            },
            install: {
              mode: 'link',
              manifestVersion: '1.0.0',
              manifestDigest: null,
              installedPath: null,
            },
            state: {
              enabled: true,
            },
          },
        },
      });

      envScope.patch({
        HAPPIER_HOME_DIR: happyHomeDir,
        PATH: process.env.PATH ?? '',
      });
      reloadConfiguration();
      vi.resetModules();

      const { SessionHostBridge } = await import('./SessionHostBridge');
      const bridge = new SessionHostBridge();
      const plan = await bridge.createSessionRuntime(SAMPLE_PLUGIN_BACKEND_ID, {
        credentials: createTestCredentials(),
        directory: pluginRoot,
        happyHomeDir,
      });

      await expect(stat(launchRecordPath)).rejects.toMatchObject({ code: 'ENOENT' });

      const createSessionRuntime = plan.config.createSessionRuntime;
      expect(createSessionRuntime).toBeTypeOf('function');
      if (!createSessionRuntime) {
        throw new Error('Expected plugin host session plan to expose createSessionRuntime');
      }

      await createSessionRuntime({
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

      await expect(readFile(launchRecordPath, 'utf8')).resolves.toBe(JSON.stringify({
        backendId: SAMPLE_PLUGIN_BACKEND_ID,
        providerId: SAMPLE_PLUGIN_PROVIDER_ID,
        hasCredentials: true,
        workingDirectory: pluginRoot,
        hasSession: false,
        hasPermissionHandler: false,
      }));
    } finally {
      envScope.restore();
      reloadConfiguration();
      await rm(happyHomeDir, { recursive: true, force: true });
      await rm(pluginRoot, { recursive: true, force: true });
    }
  });

  it('resolves non-ACP plugin terminal runtime launch surfaces through the unified session bridge', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-session-bridge-plugin-home-'));
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-session-bridge-plugin-root-'));

    try {
      await materializeSamplePluginFixture(pluginRoot);
      const store = createPluginStateStore({ happyHomeDir });
      await store.write({
        t: 'happier_plugin_state_v1',
        schemaVersion: 1,
        plugins: {
          [SAMPLE_PLUGIN_ID]: {
            source: {
              kind: 'path',
              locator: pluginRoot,
              trustPolicy: 'local_trusted',
              installPolicy: 'link',
              resolvedPath: pluginRoot,
              manifestPath: join(pluginRoot, '.happier-plugin', 'plugin.json'),
            },
            compatibility: {
              status: 'unknown',
              diagnostics: [],
            },
            install: {
              mode: 'link',
              manifestVersion: '1.0.0',
              manifestDigest: null,
              installedPath: null,
            },
            state: {
              enabled: true,
            },
          },
        },
      });

      envScope.patch({
        HAPPIER_HOME_DIR: happyHomeDir,
        PATH: process.env.PATH ?? '',
      });
      reloadConfiguration();
      vi.resetModules();

      const { SessionHostBridge } = await import('./SessionHostBridge');
      const bridge = new SessionHostBridge();
      const surfaces = await bridge.resolveExecutionSurfaces(SAMPLE_PLUGIN_BACKEND_ID);

      expect(surfaces.terminalRuntime?.launch).toEqual(expect.any(Function));
      await expect(surfaces.terminalRuntime?.launch?.({} as never)).resolves.toMatchObject({
        sessionId: 'integration-session',
        runtimeDescriptor: {
          backendId: SAMPLE_PLUGIN_BACKEND_ID,
          runtimeKind: 'native',
          source: 'plugin',
        },
        runtimeCapabilities: {
          executionRun: { supported: true },
          sessions: { supported: true },
        },
      });

      await expect(
        bridge.createSessionRuntime(SAMPLE_PLUGIN_BACKEND_ID, {
          credentials: createTestCredentials(),
          directory: pluginRoot,
          happyHomeDir,
        }),
      ).resolves.toEqual(expect.objectContaining({
        kind: 'hostSessionRuntimePlan',
        providerId: SAMPLE_PLUGIN_BACKEND_ID,
      }));
    } finally {
      envScope.restore();
      reloadConfiguration();
      await rm(happyHomeDir, { recursive: true, force: true });
      await rm(pluginRoot, { recursive: true, force: true });
    }
  });

  it('fails closed to the generic plugin descriptor when plugin session runtimeDescriptor is malformed', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-session-bridge-plugin-home-'));
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-session-bridge-plugin-root-'));

    try {
      await materializeSamplePluginFixture(pluginRoot);
      const store = createPluginStateStore({ happyHomeDir });
      await store.write({
        t: 'happier_plugin_state_v1',
        schemaVersion: 1,
        plugins: {
          [SAMPLE_PLUGIN_ID]: {
            source: {
              kind: 'path',
              locator: pluginRoot,
              trustPolicy: 'local_trusted',
              installPolicy: 'link',
              resolvedPath: pluginRoot,
              manifestPath: join(pluginRoot, '.happier-plugin', 'plugin.json'),
            },
            compatibility: {
              status: 'unknown',
              diagnostics: [],
            },
            install: {
              mode: 'link',
              manifestVersion: '1.0.0',
              manifestDigest: null,
              installedPath: null,
            },
            state: {
              enabled: true,
            },
          },
        },
      });

      envScope.patch({
        HAPPIER_HOME_DIR: happyHomeDir,
        PATH: process.env.PATH ?? '',
      });
      reloadConfiguration();
      vi.resetModules();

      const { SessionHostBridge } = await import('./SessionHostBridge');
      const bridge = new SessionHostBridge();
      const plan = await bridge.createSessionRuntime(SAMPLE_PLUGIN_BACKEND_ID, {
        credentials: createTestCredentials(),
        directory: pluginRoot,
        happyHomeDir,
      });

      const createSessionRuntime = plan.config.createSessionRuntime;
      expect(createSessionRuntime).toBeTypeOf('function');
      if (!createSessionRuntime) {
        throw new Error('Expected plugin host session plan to expose createSessionRuntime');
      }

      const created = await createSessionRuntime({
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

      const messages: AgentMessage[] = [];
      const unsubscribe = created.operations.subscribeRuntimeEvents((message) => {
        if (isAgentMessage(message)) {
          messages.push(message);
        }
      });
      unsubscribe();

      expect(messages).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: 'event',
          name: 'runtime.descriptor',
          payload: expect.objectContaining({
            v: 1,
            providerId: SAMPLE_PLUGIN_PROVIDER_ID,
            provider: expect.objectContaining({
              backendMode: 'custom',
              providerExtra: expect.objectContaining({
                runtimeHandle: expect.objectContaining({
                  backendId: SAMPLE_PLUGIN_BACKEND_ID,
                  providerId: SAMPLE_PLUGIN_PROVIDER_ID,
                  provenance: 'external',
                  source: { kind: 'path' },
                }),
              }),
            }),
          }),
        }),
      ]));
      expect(messages.filter((message) => message.type === 'event' && message.name === 'runtime.descriptor')).toHaveLength(1);
    } finally {
      envScope.restore();
      reloadConfiguration();
      await rm(happyHomeDir, { recursive: true, force: true });
      await rm(pluginRoot, { recursive: true, force: true });
    }
  });

  it('rejects plugin terminal runtime launch payloads that still use a native session adapter model', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-session-bridge-plugin-home-'));
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-session-bridge-plugin-root-'));

    try {
      await materializeSamplePluginFixture(pluginRoot);
      await writeFile(
        join(pluginRoot, 'daemon.mjs'),
        [
          "export default async function resolveTranscriptBinding() { return 'integration-bound'; }",
          'function createBackend() {',
          '  return {',
          "    async startSession() { return { sessionId: 'integration-session' }; },",
          '    async sendPrompt() {},',
          '    async cancel() {},',
          '    onMessage() {},',
          '    offMessage() {},',
          '    async waitForResponseComplete() {},',
          '    async dispose() {},',
          '  };',
          '}',
          'export async function launch() {',
          "  return { runtime: createBackend() };",
          '}',
        ].join('\n'),
        'utf8',
      );

      const store = createPluginStateStore({ happyHomeDir });
      await store.write({
        t: 'happier_plugin_state_v1',
        schemaVersion: 1,
        plugins: {
          [SAMPLE_PLUGIN_ID]: {
            source: {
              kind: 'path',
              locator: pluginRoot,
              trustPolicy: 'local_trusted',
              installPolicy: 'link',
              resolvedPath: pluginRoot,
              manifestPath: join(pluginRoot, '.happier-plugin', 'plugin.json'),
            },
            compatibility: {
              status: 'unknown',
              diagnostics: [],
            },
            install: {
              mode: 'link',
              manifestVersion: '1.0.0',
              manifestDigest: null,
              installedPath: null,
            },
            state: {
              enabled: true,
            },
          },
        },
      });

      envScope.patch({
        HAPPIER_HOME_DIR: happyHomeDir,
        PATH: process.env.PATH ?? '',
      });
      reloadConfiguration();
      vi.resetModules();

      const { SessionHostBridge } = await import('./SessionHostBridge');
      const bridge = new SessionHostBridge();
      const plan = await bridge.createSessionRuntime(SAMPLE_PLUGIN_BACKEND_ID, {
        credentials: createTestCredentials(),
        directory: pluginRoot,
        happyHomeDir,
      });
      const createSessionRuntime = plan.config.createSessionRuntime;
      expect(createSessionRuntime).toBeTypeOf('function');
      if (!createSessionRuntime) {
        throw new Error('Expected plugin host session plan to expose createSessionRuntime');
      }

      await expect(createSessionRuntime({
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
      } as never)).rejects.toThrow('terminal runtime launch payload must include RuntimeTurnOperations');
    } finally {
      envScope.restore();
      reloadConfiguration();
      await rm(happyHomeDir, { recursive: true, force: true });
      await rm(pluginRoot, { recursive: true, force: true });
    }
  });

  it('uses catalogAgentId as the built-in policy identity while preserving plugin backend identity in the host plan', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-session-bridge-plugin-home-'));
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-session-bridge-plugin-root-'));

    try {
      await materializeSamplePluginFixture(pluginRoot);
      const manifestPath = join(pluginRoot, '.happier-plugin', 'plugin.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
      const contributions = manifest.contributions as Record<string, unknown>;
      const providers = Array.isArray(contributions.providers) ? contributions.providers : [];
      providers[0] = {
        ...(providers[0] as Record<string, unknown>),
        catalogAgentId: 'claude',
      };
      contributions.providers = providers;
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

      const store = createPluginStateStore({ happyHomeDir });
      await store.write({
        t: 'happier_plugin_state_v1',
        schemaVersion: 1,
        plugins: {
          [SAMPLE_PLUGIN_ID]: {
            source: {
              kind: 'path',
              locator: pluginRoot,
              trustPolicy: 'local_trusted',
              installPolicy: 'link',
              resolvedPath: pluginRoot,
              manifestPath,
            },
            compatibility: {
              status: 'unknown',
              diagnostics: [],
            },
            install: {
              mode: 'link',
              manifestVersion: '1.0.0',
              manifestDigest: null,
              installedPath: null,
            },
            state: {
              enabled: true,
            },
          },
        },
      });

      envScope.patch({
        HAPPIER_HOME_DIR: happyHomeDir,
        PATH: process.env.PATH ?? '',
      });
      reloadConfiguration();
      vi.resetModules();

      const { SessionHostBridge } = await import('./SessionHostBridge');
      const bridge = new SessionHostBridge();
      const plan = await bridge.createSessionRuntime(SAMPLE_PLUGIN_BACKEND_ID, {
        credentials: createTestCredentials(),
        directory: pluginRoot,
        happyHomeDir,
      });

      expect(plan.agentId).toBe(SAMPLE_PLUGIN_BACKEND_ID);
      expect(plan.config.agentMessageType).toBe(SAMPLE_PLUGIN_BACKEND_ID);
      expect(plan.config.policyAgentId).toBe('claude');
    } finally {
      envScope.restore();
      reloadConfiguration();
      await rm(happyHomeDir, { recursive: true, force: true });
      await rm(pluginRoot, { recursive: true, force: true });
    }
  });

  it('fails closed when a plugin runtime lacks an exact built-in compatibility carrier', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-session-bridge-plugin-home-'));
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-session-bridge-plugin-root-'));

    try {
      await materializeSamplePluginFixture(pluginRoot);
      const manifestPath = join(pluginRoot, '.happier-plugin', 'plugin.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
      const contributions = manifest.contributions as Record<string, unknown>;
      const providers = Array.isArray(contributions.providers) ? contributions.providers : [];
      const backends = Array.isArray(contributions.backends) ? contributions.backends : [];
      providers[0] = {
        ...(providers[0] as Record<string, unknown>),
        id: 'openai',
        ownedBackendIds: ['openai.backend'],
        catalogAgentId: 'gpt',
      };
      backends[0] = {
        ...(backends[0] as Record<string, unknown>),
        id: 'openai.backend',
        providerId: 'openai',
      };
      contributions.providers = providers;
      contributions.backends = backends;
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

      const store = createPluginStateStore({ happyHomeDir });
      await store.write({
        t: 'happier_plugin_state_v1',
        schemaVersion: 1,
        plugins: {
          [SAMPLE_PLUGIN_ID]: {
            source: {
              kind: 'path',
              locator: pluginRoot,
              trustPolicy: 'local_trusted',
              installPolicy: 'link',
              resolvedPath: pluginRoot,
              manifestPath,
            },
            compatibility: {
              status: 'unknown',
              diagnostics: [],
            },
            install: {
              mode: 'link',
              manifestVersion: '1.0.0',
              manifestDigest: null,
              installedPath: null,
            },
            state: {
              enabled: true,
            },
          },
        },
      });

      envScope.patch({
        HAPPIER_HOME_DIR: happyHomeDir,
        PATH: process.env.PATH ?? '',
      });
      reloadConfiguration();
      vi.resetModules();

      const { SessionHostBridge } = await import('./SessionHostBridge');
      const bridge = new SessionHostBridge();
      await expect(bridge.createSessionRuntime('openai.backend', {
        credentials: createTestCredentials(),
        directory: pluginRoot,
        happyHomeDir,
      })).rejects.toThrow(/unsupported session runtime backend/i);
    } finally {
      envScope.restore();
      reloadConfiguration();
      await rm(happyHomeDir, { recursive: true, force: true });
      await rm(pluginRoot, { recursive: true, force: true });
    }
  });

  it('fails session startup with a trust-approval error for prompt-trust plugin runtime adapters', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-session-bridge-plugin-home-'));
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-session-bridge-plugin-root-'));

    try {
      await materializeSamplePluginFixture(pluginRoot);
      const store = createPluginStateStore({ happyHomeDir });
      await store.write({
        t: 'happier_plugin_state_v1',
        schemaVersion: 1,
        plugins: {
          [SAMPLE_PLUGIN_ID]: {
            source: {
              kind: 'archive',
              locator: 'https://example.com/acme-sample.tar.gz',
              trustPolicy: 'prompt',
              installPolicy: 'managed_install',
              resolvedPath: pluginRoot,
              manifestPath: join(pluginRoot, '.happier-plugin', 'plugin.json'),
            },
            compatibility: {
              status: 'unknown',
              diagnostics: [],
            },
            install: {
              mode: 'managed_install',
              manifestVersion: '1.0.0',
              manifestDigest: null,
              installedPath: pluginRoot,
            },
            state: {
              enabled: true,
            },
          },
        },
      });

      envScope.patch({
        HAPPIER_HOME_DIR: happyHomeDir,
        PATH: process.env.PATH ?? '',
      });
      reloadConfiguration();
      vi.resetModules();

      const { SessionHostBridge } = await import('./SessionHostBridge');
      const bridge = new SessionHostBridge();

      await expect(
        bridge.createSessionRuntime(SAMPLE_PLUGIN_BACKEND_ID, {
          directory: pluginRoot,
          happyHomeDir,
        }),
      ).rejects.toMatchObject({
        message: 'Plugin trust approval is required before this backend can run.',
      });
    } finally {
      envScope.restore();
      reloadConfiguration();
      await rm(happyHomeDir, { recursive: true, force: true });
      await rm(pluginRoot, { recursive: true, force: true });
    }
  });

  it('fails session startup with an untrusted-source error for untrusted plugin runtime adapters', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-session-bridge-plugin-home-'));
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-session-bridge-plugin-root-'));

    try {
      await materializeSamplePluginFixture(pluginRoot);
      const store = createPluginStateStore({ happyHomeDir });
      await store.write({
        t: 'happier_plugin_state_v1',
        schemaVersion: 1,
        plugins: {
          [SAMPLE_PLUGIN_ID]: {
            source: {
              kind: 'archive',
              locator: 'https://example.com/acme-sample.tar.gz',
              trustPolicy: 'untrusted',
              installPolicy: 'managed_install',
              resolvedPath: pluginRoot,
              manifestPath: join(pluginRoot, '.happier-plugin', 'plugin.json'),
            },
            compatibility: {
              status: 'unknown',
              diagnostics: [],
            },
            install: {
              mode: 'managed_install',
              manifestVersion: '1.0.0',
              manifestDigest: null,
              installedPath: pluginRoot,
            },
            state: {
              enabled: true,
            },
          },
        },
      });

      envScope.patch({
        HAPPIER_HOME_DIR: happyHomeDir,
        PATH: process.env.PATH ?? '',
      });
      reloadConfiguration();
      vi.resetModules();

      const { SessionHostBridge } = await import('./SessionHostBridge');
      const bridge = new SessionHostBridge();

      await expect(
        bridge.createSessionRuntime(SAMPLE_PLUGIN_BACKEND_ID, {
          directory: pluginRoot,
          happyHomeDir,
        }),
      ).rejects.toMatchObject({
        message: 'Refusing to load executable plugin daemon entry from an untrusted source.',
      });
    } finally {
      envScope.restore();
      reloadConfiguration();
      await rm(happyHomeDir, { recursive: true, force: true });
      await rm(pluginRoot, { recursive: true, force: true });
    }
  });
});
