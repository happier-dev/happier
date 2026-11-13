import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { withTempDir } from '@/testkit/fs/tempDir';
import { writeExecutableShim } from '@/testkit/fs/executableShim';
import { McpServerCatalogV1Schema } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import type { DetectProviderMcpServersResult } from '@/mcp/providerDetection/detectProviderMcpServers';
import axios from 'axios';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { MachinePublishedMetadataV1Schema } from '@happier-dev/protocol/machines/machinePublishedContentV1';
import { createMachineContentCodec } from '@/api/machine/machineStoredContent';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';

const {
  fetchSessionById,
  resolveAvailableAccountSettings,
} = vi.hoisted(() => ({
  fetchSessionById: vi.fn(),
  resolveAvailableAccountSettings: vi.fn(),
}));

vi.mock('@/session/transport/http/sessionsHttp', () => ({
  fetchSessionById,
}));

vi.mock('@/settings/accountSettings/resolveAvailableAccountSettings', () => ({
  resolveAvailableAccountSettings,
}));


import { createCliActionInventoryDeps } from './createCliActionInventoryDeps';
import { resolveSessionMcpPreview } from '@/mcp/preview/resolveSessionMcpPreview';

describe('createCliActionInventoryDeps', () => {
  let admitted: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>>;
  beforeAll(async () => {
    admitted = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
      runtimeOptions: { pluginIds: ['happier.agent.codex'],
        scopedActionRuntime: { credentials: null, actionsSettingsProvider: createActionSettingsProvider() } },
    });
  });
  afterAll(async () => { await admitted?.dispose(); });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
  beforeEach(() => {
    fetchSessionById.mockReset();
    resolveAvailableAccountSettings.mockReset();
    resolveAvailableAccountSettings.mockResolvedValue(null);
  });

  it('preserves a machine preflight refusal in the public models Action', async () => {
    const inventory = createCliActionInventoryDeps({ token: 'fixture-token', sessionId: '', mode: 'plain', ctx: null,
      callMachineAction: async () => ({ ok: false,
        error: { code: 'connected-service-preflight-failed', message: 'Selected credential could not be prepared.' } }),
    });
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...inventory });
    expect(await executor.execute('agents.models.list', { agentId: 'codex', machineId: 'worker', probe: { cwd: '/repo' } },
      { surface: 'cli', authority: 'present_user' })).toMatchObject({ ok: false, errorCode: 'connected-service-preflight-failed' });
  });


  it('offers distinguishable canonical machine names through daemon input discovery without changing target identities', async () => {
    const codec = createMachineContentCodec({ encryptionMode: 'plain' });
    const machines = [
      { id: 'mac-machine', displayName: 'Studio', host: 'mac.local' },
      { id: 'linux-machine', displayName: 'Studio', host: 'linux.local' },
      { id: 'f98b0-machine', displayName: 'Build', host: 'worker.local' },
      { id: 'f98b1-machine', displayName: 'Build', host: 'worker.local' },
      { id: 'laptop-machine', displayName: 'Laptop', host: 'portable.local' },
    ];
    vi.spyOn(axios, 'get').mockResolvedValue({ data: machines.map(machine => ({
      id: machine.id, active: true, revokedAt: null, replacedByMachineId: null,
      storageMode: 'plain', dataEncryptionKey: null,
      metadata: codec.encodeStored(MachinePublishedMetadataV1Schema.parse({
        host: machine.host, displayName: machine.displayName, platform: 'linux', happyCliVersion: 'test',
        homeDir: '/home/worker', happyHomeDir: '/home/worker/.happier',
      })),
    })) });
    const inventory = createCliActionInventoryDeps({ token: 'token', credentials: { token: 'token', encryption: null },
      serverId: 'home', serverHttpBaseUrl: 'https://machine-names.test', sessionId: 'session', mode: 'plain', ctx: null });
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...inventory,
      widgetAccountScope: () => ({ serverId: 'home', accountId: 'viewer' }) });
    const result = await executor.execute('action.options.resolve', {
      consumer: { kind: 'widget', surface: { serverId: 'home', accountId: 'viewer', owner: { kind: 'home' } },
        definition: { kind: 'builtin', id: 'machine_vitals' } }, fieldPath: 'machine',
    }, { surface: 'ui', authority: 'present_user', serverId: 'home' });
    expect(result).toMatchObject({ ok: true, result: { options: machines.map((machine, index) => ({
      value: { serverId: 'home', machineId: machine.id },
      label: ['Studio · mac.local', 'Studio · linux.local', 'Build · f98b0', 'Build · f98b1', 'Laptop'][index],
    })) } });
  });

  async function withNativeInventory(
    run: (fixture: Readonly<{ directory: string; callsPath: string }>) => Promise<void>,
    unavailable = false,
  ) {
    await withTempDir('cli-action-native-inventory-', async directory => {
      const callsPath = join(directory, 'requests.jsonl');
      const script = join(directory, 'native.cjs');
      // Replace the vendor executable only: real plugin admission, catalog,
      // command resolution, JSON-RPC transport and inventory projection stay real.
      await writeFile(script, `
        const fs = require('node:fs');
        if (process.argv.includes('--version')) { console.log('codex-cli 0.162.1'); process.exit(0); }
        require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
          const request = JSON.parse(line);
          if (request.id === undefined) return;
          fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ method: request.method, cwd: process.cwd() }) + '\\n');
          if (${JSON.stringify(unavailable)}) { process.exit(1); }
          const result = request.method === 'model/list' ? { data: [{
            id: 'fixture-model', displayName: 'Native Model',
            defaultReasoningEffort: 'secret-current-value',
            supportedReasoningEfforts: [{ reasoningEffort: 'medium' }, { reasoningEffort: 'xhigh', description: 'Maximum reasoning' }],
          }] } : request.method === 'collaborationMode/list' ? { data: [
            { id: 'plan', name: 'Plan', description: 'Native planning mode' },
            { id: 'build', name: 'Build', description: 'Can edit files' },
          ] } : {};
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
        });
      `);
      const quote = (value: string) => `'${value.replace(/'/g, `'\''`)}'`;
      const executable = await writeExecutableShim({ dir: directory,
        fileName: process.platform === 'win32' ? 'codex-fixture.cmd' : 'codex-fixture',
        contents: process.platform === 'win32'
          ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`
          : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`,
      });
      vi.stubEnv('HAPPIER_CODEX_PATH', executable);
      vi.stubEnv('HAPPIER_JS_RUNTIME_PATH', process.execPath);
      await run({ directory, callsPath });
    });
  }

  it('lists unscoped built-in backend models through the canonical local dynamic probe', async () => {
    await withNativeInventory(async ({ directory, callsPath }) => {
      const deps = createCliActionInventoryDeps({ token: 'token', sessionId: 'sess-1', mode: 'plain', ctx: null,
        rawSession: { host: 'local-machine', path: directory, metadata: {} } });
      await expect(deps.agentsModelsList!({ agentId: 'codex',
        backendTargetKey: 'agent:happier.agent.codex/codex', limit: 10,
      })).resolves.toEqual({ agentId: 'codex', items: [
        { id: 'default', label: 'Default' }, { id: 'fixture-model', label: 'Native Model' },
      ], supportsFreeform: false, source: 'dynamic' });
      expect((await readFile(callsPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line)))
        .toContainEqual({ method: 'model/list', cwd: directory });
    });
  });

  it('keeps unscoped session metadata models when a local probe is unavailable', async () => {
    await withNativeInventory(async ({ directory, callsPath }) => {
      const deps = createCliActionInventoryDeps({ token: 'token', sessionId: 'sess-1', mode: 'plain', ctx: null,
        rawSession: { host: 'local-machine', path: directory, metadata: {
          sessionModelsV1: { provider: 'codex', availableModels: [{ id: 'metadata-model', name: 'Metadata Model' }] },
        } } });
      await expect(deps.agentsModelsList!({ agentId: 'codex',
        backendTargetKey: 'agent:happier.agent.codex/codex', limit: 10,
      })).resolves.toEqual({ agentId: 'codex', items: [
        { id: 'default', label: 'Default' }, { id: 'metadata-model', label: 'Metadata Model' },
      ], supportsFreeform: false, source: 'session_metadata' });
      expect(await readFile(callsPath, 'utf8')).toContain('initialize');
    }, true);
  });

  it('limits agent session modes read through the canonical runtime/plugin probe', async () => {
    await withNativeInventory(async ({ directory }) => {
      const deps = createCliActionInventoryDeps({ token: 'token', sessionId: 'sess-1', mode: 'plain', ctx: null,
        rawSession: { host: 'local-machine', path: directory, metadata: {} } });
      await expect(deps.agentsSessionModesList!({ agentId: 'codex',
        backendTargetKey: 'agent:happier.agent.codex/codex', machineId: 'local-machine', limit: 1,
      })).resolves.toEqual({ agentId: 'codex', items: [
        { id: 'plan', label: 'Plan', description: 'Native planning mode' },
      ], source: 'dynamic' });
    });
  });

  it('lists unscoped model config definitions without returning native current values', async () => {
    await withNativeInventory(async ({ directory, callsPath }) => {
      const deps = createCliActionInventoryDeps({ token: 'token', sessionId: 'sess-1', mode: 'plain', ctx: null,
        rawSession: { host: 'local-machine', path: directory, metadata: {} } });
      const result = await deps.agentsConfigOptionsList!({ agentId: 'codex',
        backendTargetKey: 'agent:happier.agent.codex/codex', modelId: 'fixture-model', limit: 10 });
      expect(result).toEqual({ agentId: 'codex', items: [{ id: 'reasoning_effort', label: 'Thinking', type: 'select',
        options: [{ value: 'medium', label: 'Medium' }, { value: 'xhigh', label: 'XHigh', description: 'Maximum reasoning' }],
      }], source: 'dynamic' });
      expect(JSON.stringify(result)).not.toContain('secret-current-value');
      expect(JSON.stringify(result)).not.toContain('currentValue');
      expect(await readFile(callsPath, 'utf8')).toContain('model/list');
    });
  });

  it('previews MCP spawn options through the existing MCP preview owner without returning secret env', async () => {
    const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'mcp-preview-account' })).toString('base64url')}.signature`, encryption: null };
    const catalog = McpServerCatalogV1Schema.parse({ v: 1,
      servers: [{ id: 'srv-1', name: 'repo-tools', title: 'Repo Tools', transport: 'stdio',
        stdio: { command: 'echo', args: [] }, env: { SECRET_TOKEN: { t: 'literal', v: 'must-not-return' } }, createdAt: 1, updatedAt: 1 }],
      bindings: [{ id: 'binding', serverId: 'srv-1', enabled: true, target: { t: 'allMachines' }, createdAt: 1, updatedAt: 1 }],
    });
    const detected: DetectProviderMcpServersResult = {
      servers: [{ provider: 'codex', name: 'detected-codex', transport: 'stdio', stdio: { command: 'codex', args: [] },
        envKeys: ['TOKEN'], source: { kind: 'user', path: '/config/codex' }, enabled: true }],
      warnings: [],
    };

    const deps = createCliActionInventoryDeps({
      token: credentials.token,
      credentials,
      sessionId: 'sess-1',
      mode: 'plain',
      ctx: null,
      rawSession: {
        host: 'local-machine',
        machineId: 'machine-1',
        path: '/repo',
        metadata: {},
      },
      // Machine transport is the boundary; its payload comes from the actual producer.
      callMachineAction: async request => {
        expect(request.machineId).toBe('machine-1');
        return resolveSessionMcpPreview({ settings: { ...catalog, strictMode: true }, machineId: request.machineId,
          directory: '/repo', agentId: 'codex', detectedServers: detected.servers });
      },
    });
    const spawnPreview = deps.spawnMcpServersPreview;
    if (!spawnPreview) throw new Error('MCP preview is not installed');

      const result = await spawnPreview({
        agentId: 'codex',
        machineId: 'machine-1',
        directory: '/repo',
      });

      expect(result).toMatchObject({
        ok: true,
        items: expect.arrayContaining([
          {
            value: 'managed:srv-1',
            label: 'Repo Tools',
            selected: true,
            selectable: true,
            sourceKind: 'managed',
            authMode: 'plainText',
            availability: 'active',
          },
        ]),
        preview: {
          ok: true,
          builtIn: [expect.objectContaining({ key: 'built-in:happier' })],
          managed: [
            expect.objectContaining({
              key: 'managed:srv-1',
              serverId: 'srv-1',
              name: 'repo-tools',
              title: 'Repo Tools',
              transport: 'stdio',
              authMode: 'plainText',
              selected: true,
              selectable: true,
              defaultSelected: true,
              availability: 'active',
              sourceKind: 'managed',
              scopeKind: 'allMachines',
            }),
          ],
          detected: [expect.objectContaining({ key: 'detected:codex:detected-codex', envKeyCount: 1 })],
        },
      });
      expect(JSON.stringify(result)).not.toContain('must-not-return');
  });

  it('reports opaque profile rows instead of calling the visible prefix complete', async () => {
    resolveAvailableAccountSettings.mockResolvedValue({
      profiles: [
        {
          v: 2, id: 'readable', name: 'Readable', extraEnvironmentVariables: [],
          defaultPermissionModeByTargetKey: {}, defaultPersistenceModeByTargetKey: {},
          compatibilityByTargetKey: {}, createdAt: 1, updatedAt: 1,
        },
        { v: 99, id: 'future', opaque: { untouched: true } },
      ],
    });
    const deps = createCliActionInventoryDeps({
      token: 'token',
      sessionId: 'sess-1',
      mode: 'plain',
      ctx: null,
      rawSession: { host: 'local-machine', path: '/repo', metadata: {} },
    });

    await expect(deps.spawnProfilesList?.({})).resolves.toMatchObject({
      coverage: 'unreadable',
      items: [expect.objectContaining({ id: 'readable' })],
    });
  });
});
