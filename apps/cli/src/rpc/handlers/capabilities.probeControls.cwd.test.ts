import { describe, expect, it, vi } from 'vitest';
import axios, { type AxiosAdapter } from 'axios';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { configuration } from '@/configuration';
import { withTempDir } from '@/testkit/fs/tempDir';
import { resetInMemoryAccountSettingsContextForTests } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { resolveAcpSdkEntryFromCwd, writeFakeAcpAgentScript } from '@/capabilities/probes/agentModelsProbe.testkit';
import { createEncryptedRpcTestClient } from './encryptedRpc.testkit';
import { registerCapabilitiesHandlers } from './capabilities';

const methods = ['probeModes', 'probeModels', 'probeConfigOptions'] as const;
type ProbeMethod = typeof methods[number];
const nativeFixture = fileURLToPath(new URL('../../backends/codex/preflight/__fixtures__/fakeCodexAppServer.mjs', import.meta.url));

async function withProbeFixture(
  run: (fixture: {
    cwd: string;
    capturePath: string;
    invoke: (method: ProbeMethod, params?: Record<string, unknown>, agentId?: string) => Promise<unknown>;
    setSettings: (settings: Record<string, unknown>) => void;
    setPreparationMs: (ms: number) => void;
  }) => Promise<void>,
): Promise<void> {
  await withTempDir('capability-controls-cwd-', async (cwd) => {
    const overrides = {
      happyHomeDir: cwd, activeServerDir: cwd, privateKeyFile: join(cwd, 'access.key'),
      legacyPrivateKeyFile: join(cwd, 'legacy.key'), apiServerUrl: 'http://probe-settings.test',
      clientEncryptionRequirement: 'follow_account',
    };
    const descriptors = Object.fromEntries(Object.keys(overrides).map((key) => [key, Object.getOwnPropertyDescriptor(configuration, key)!]));
    Object.defineProperties(configuration, Object.fromEntries(Object.entries(overrides).map(([key, value]) => [key, { value, configurable: true }])));
    await writeFile(configuration.privateKeyFile, JSON.stringify({ token: 'probe-token', secret: Buffer.alloc(32, 7).toString('base64') }));
    const originalAdapter = axios.defaults.adapter;
    let settings: Record<string, unknown> = { schemaVersion: 6, codexBackendMode: 'appServer' };
    let preparationMs = 200;
    let now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const adapter: AxiosAdapter = async (config) => {
      const path = new URL(config.url!).pathname;
      expect(config.headers.get('Authorization')).toBe('Bearer probe-token');
      const data = path === '/v2/account/settings'
        ? (now += preparationMs, { content: { t: 'plain', v: settings }, version: 1 })
        : path === '/v1/account/encryption' ? { mode: 'plain', updatedAt: 0 } : null;
      if (!data) throw new Error(`Unexpected probe fixture request: ${path}`);
      return { config, status: 200, statusText: 'OK', headers: {}, data };
    };
    axios.defaults.adapter = adapter;
    resetInMemoryAccountSettingsContextForTests();
    vi.stubEnv('CODEX_HOME', join(cwd, 'native-codex-home'));
    vi.stubEnv('CODEX_SQLITE_HOME', join(cwd, 'native-codex-home'));
    const capturePath = join(cwd, 'native-process.json');
    const { call } = createEncryptedRpcTestClient({ scopePrefix: 'real-control-cwd', registerHandlers: registerCapabilitiesHandlers });
    try {
      // Resolve the real catalog's lazy imports outside the request deadline.
      await call(RPC_METHODS.CAPABILITIES_DESCRIBE, {});
      await run({
        cwd, capturePath,
        setSettings: (value) => { settings = { schemaVersion: 6, ...value }; },
        setPreparationMs: (value) => { preparationMs = value; },
        invoke: (method, params = {}, agentId = 'codex') => call(RPC_METHODS.CAPABILITIES_INVOKE, {
          id: `cli.${agentId}`, method, params: {
            cwd,
            environmentVariables: {
              HAPPIER_CODEX_APP_SERVER_BIN: nativeFixture,
              HAPPIER_FAKE_CODEX_APP_SERVER_DELAY_MS: '1',
              HAPPIER_TEST_CONTROL_PROCESS_CAPTURE_FILE: capturePath,
              HAPPIER_TEST_CONFIGURED_MODEL: 'fixture-default',
            },
            ...params,
          },
        }),
      });
    } finally {
      clock.mockRestore();
      axios.defaults.adapter = originalAdapter;
      vi.unstubAllEnvs();
      resetInMemoryAccountSettingsContextForTests();
      Object.defineProperties(configuration, descriptors);
    }
  });
}

function expectObservedControls(response: unknown, method: ProbeMethod): void {
  expect(response).toMatchObject({ ok: true, result: { provider: 'codex', source: 'dynamic' } });
  if (method === 'probeModes') expect(response).toMatchObject({ result: { availableModes: expect.arrayContaining([{ id: 'plan', name: 'Plan', description: 'Think first' }]) } });
  if (method === 'probeModels') expect(response).toMatchObject({ result: { availableModels: expect.arrayContaining([expect.objectContaining({ id: 'gpt-5.4' })]) } });
  if (method === 'probeConfigOptions') expect(response).toMatchObject({ result: { configOptions: [] } });
}

describe('capabilities.invoke control probes through the real catalog and native process', () => {
  it.each(methods)('%s preserves cwd and spends preparation from the containing deadline', async (method) => {
    await withProbeFixture(async ({ cwd, capturePath, invoke }) => {
      expectObservedControls(await invoke(method, { timeoutMs: 1234 }), method);
      expect(JSON.parse(await readFile(capturePath, 'utf8'))).toMatchObject({ cwd, rpcTimeoutMs: 1034 });
    });
  });

  it.each(methods)('%s falls back to the closest existing directory', async (method) => {
    await withProbeFixture(async ({ cwd, capturePath, invoke }) => {
      expectObservedControls(await invoke(method, { cwd: join(cwd, 'missing', 'child'), timeoutMs: 1234 }), method);
      expect(JSON.parse(await readFile(capturePath, 'utf8'))).toMatchObject({ cwd, rpcTimeoutMs: 1034 });
    });
  });

  it('reports the configured model only when discovery used the requested directory', async () => {
    await withProbeFixture(async ({ cwd, invoke }) => {
      await expect(invoke('probeModels', { includeConfiguredModel: true })).resolves.toMatchObject({
        ok: true, result: { configuredModelId: 'fixture-default' },
      });
      const fallback = await invoke('probeModels', { includeConfiguredModel: true, cwd: join(cwd, 'missing') });
      expectObservedControls(fallback, 'probeModels');
      expect(fallback).not.toHaveProperty('result.configuredModelId');
    });
  });

  it.each(methods)('%s uses the remaining default budget when timeoutMs is omitted', async (method) => {
    await withProbeFixture(async ({ cwd, capturePath, invoke }) => {
      expectObservedControls(await invoke(method), method);
      expect(JSON.parse(await readFile(capturePath, 'utf8'))).toMatchObject({ cwd, rpcTimeoutMs: 29_800 });
    });
  });

  it.each(methods)('%s refuses native startup when preparation consumes the containing deadline', async (method) => {
    await withProbeFixture(async ({ capturePath, invoke, setPreparationMs }) => {
      setPreparationMs(1234);
      await expect(invoke(method, { timeoutMs: 1234 })).resolves.toMatchObject({ ok: false, error: { code: 'preflight-catalog-unavailable' } });
      expect(existsSync(capturePath)).toBe(false);
    });
  });

  it('honors fetched account settings that select a non-app-server runtime', async () => {
    await withProbeFixture(async ({ capturePath, invoke, setSettings }) => {
      setSettings({ codexBackendMode: 'mcp' });
      await expect(invoke('probeModels', { timeoutMs: 1234 })).resolves.toMatchObject({ ok: true, result: { source: 'static' } });
      expect(existsSync(capturePath)).toBe(false);
    });
  });

  it('uses an explicit runtime-kind override over the fetched account settings', async () => {
    await withProbeFixture(async ({ capturePath, invoke, setSettings }) => {
      setSettings({ codexBackendMode: 'mcp' });
      expectObservedControls(await invoke('probeModels', { runtimeKindOverride: 'appServer', timeoutMs: 1234 }), 'probeModels');
      expect(JSON.parse(await readFile(capturePath, 'utf8'))).toMatchObject({ rpcTimeoutMs: 1034 });
    });
  });

  it.each(['probeModes', 'probeModels'] as const)('%s launches the selected configured ACP backend from fetched settings', async (method) => {
    await withProbeFixture(async ({ cwd, invoke, setSettings }) => {
      const agentPath = await writeFakeAcpAgentScript({
        dir: cwd, sdkEntry: resolveAcpSdkEntryFromCwd(process.cwd()),
        sessionPayloadSource: `{
          sessionId: randomUUID(),
          modes: { currentModeId: 'review-mode', availableModes: [{ id: 'review-mode', name: 'Review mode' }] },
          models: { currentModelId: 'review-model', availableModels: [{ id: 'review-model', name: 'Review model' }] },
        }`,
      });
      setSettings({ acpCatalogSettingsV1: { v: 2, backends: [{
        id: 'review-bot', name: 'review-bot', title: 'Review bot', command: process.execPath,
        args: [agentPath], env: {}, transportProfile: 'generic',
        capabilities: { supportsLoadSession: false, supportsModes: 'yes', supportsModels: 'yes', supportsConfigOptions: 'unknown', promptImageSupport: 'unknown' },
        createdAt: 1, updatedAt: 1,
      }] } });
      const response = await invoke(method, { timeoutMs: 10_000, backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' } }, 'customAcp');
      expect(response).toMatchObject({ ok: true, result: { source: 'dynamic',
        ...(method === 'probeModes'
          ? { availableModes: expect.arrayContaining([{ id: 'review-mode', name: 'Review mode' }]) }
          : { availableModels: expect.arrayContaining([{ id: 'review-model', name: 'Review model' }]) }),
      } });
    });
  });
});
