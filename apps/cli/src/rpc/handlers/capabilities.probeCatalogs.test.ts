import { describe, expect, it, vi } from 'vitest';
import axios, { type AxiosAdapter } from 'axios';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile } from 'node:fs/promises';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join, sep } from 'node:path';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';

import { createEncryptedRpcTestClient } from './encryptedRpc.testkit';
import { registerCapabilitiesHandlers } from './capabilities';
import { withTempDir } from '@/testkit/fs/tempDir';
import { configuration } from '@/configuration';
import { resetInMemoryAccountSettingsContextForTests } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { resolveAccountSettingsCachePath } from '@/settings/accountSettings/accountSettingsCache';
import { writeExecutableShim } from '@/testkit/fs/executableShim';

const processListBoundary = vi.hoisted(() => ({ startupPath: null as string | null }));
vi.mock('ps-list', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ps-list')>();
  return {
    ...actual,
    default: async () => {
      if (!processListBoundary.startupPath) return await actual.default();
      // The standalone fixture has no descendants. Scope its OS snapshot so unrelated
      // host processes cannot exhaust the short catalog request budget in teardown.
      return [{ pid: Number(await readFile(processListBoundary.startupPath, 'utf8')),
        ppid: process.pid, name: 'fake-codex-app-server' }];
    },
  };
});

describe('capabilities.invoke pre-session catalogs', () => {
  it('reports connected-service launch support from the registered materializer and lifecycle', async () => {
    const { call } = createEncryptedRpcTestClient({ scopePrefix: 'actual-auth-support', registerHandlers: registerCapabilitiesHandlers });
    await expect(call(RPC_METHODS.CAPABILITIES_INVOKE, { id: 'cli.agy', method: 'connectedServiceAuthSupport' }))
      .resolves.toMatchObject({ ok: true, result: { supportedServiceIds: ['antigravity'] } });
    await expect(call(RPC_METHODS.CAPABILITIES_INVOKE, { id: 'cli.cursor', method: 'connectedServiceAuthSupport' }))
      .resolves.toMatchObject({ ok: true, result: { supportedServiceIds: [] } });
  });
  it.each(['probeModels', 'probeModes', 'probeConfigOptions'])('refuses selected auth for an adapter without materialization: %s', async (method) => {
    const { call } = createEncryptedRpcTestClient({ scopePrefix: `unsupported-auth-${method}`, registerHandlers: registerCapabilitiesHandlers });
    await expect(call(RPC_METHODS.CAPABILITIES_INVOKE, {
      id: 'cli.cursor', method, params: {
        connectedServices: { v: 1, bindingsByServiceId: {
          'openai-codex': { source: 'connected', selection: 'profile', profileId: 'fixture' },
        } },
      },
    })).resolves.toMatchObject({ ok: false, error: { code: 'connected-service-preflight-failed' } });
  });
  it.each(['mkdir', 'write', 'promote', 'credential-http'] as const)('settles acquired selected-account artifacts before returning a catalog deadline: %s', async (boundary) => {
    await withTempDir('catalog-auth-custody-', async (cwd) => {
      const overrides = {
        happyHomeDir: cwd, activeServerDir: cwd,
        privateKeyFile: join(cwd, 'access.key'), legacyPrivateKeyFile: join(cwd, 'legacy.key'),
        apiServerUrl: 'http://catalog-auth-boundary.test', clientEncryptionRequirement: 'follow_account',
      };
      const descriptors = Object.fromEntries(Object.keys(overrides).map((key) => [key, Object.getOwnPropertyDescriptor(configuration, key)!]));
      Object.defineProperties(configuration, Object.fromEntries(Object.entries(overrides).map(([key, value]) => [key, { value, configurable: true }])));
      await writeFile(configuration.privateKeyFile, JSON.stringify({ token: 'catalog-auth-fixture', secret: Buffer.alloc(32, 7).toString('base64') }));
      vi.stubEnv('CODEX_HOME', join(cwd, 'native-codex-home'));
      vi.stubEnv('CODEX_SQLITE_HOME', join(cwd, 'native-codex-home'));
      resetInMemoryAccountSettingsContextForTests();
      const record = buildConnectedServiceCredentialRecord({
        now: Date.now(), serviceId: 'openai-codex', profileId: 'work', kind: 'oauth', expiresAt: null,
        oauth: { accessToken: 'fixture-access', refreshToken: 'fixture-refresh', idToken: 'fixture-id',
          scope: null, tokenType: null, providerAccountId: 'fixture-account', providerEmail: null },
      });
      const originalAdapter = axios.defaults.adapter;
      let releaseFilesystem!: () => void;
      const heldFilesystem = new Promise<void>((resolve) => { releaseFilesystem = resolve; });
      let acquiredAttempt: string | undefined;
      let held = false;
      let armed = false;
      const requests: string[] = [];
      const adapter: AxiosAdapter = async (config) => {
        const path = new URL(config.url!).pathname;
        requests.push(path);
        if (armed && boundary === 'credential-http' && path === '/v3/connect/openai-codex/profiles/work/credential') {
          held = true;
          await heldFilesystem;
        }
        const data = path === '/v2/account/settings'
          ? { content: { t: 'plain', v: { schemaVersion: 6, codexBackendMode: 'appServer' } }, version: 1 }
          : path === '/v1/account/encryption' ? { mode: 'plain', updatedAt: 0 }
          : path === '/v3/connect/openai-codex/profiles/work/credential'
            ? { content: { t: 'plain', v: record }, credentialRevision: 'csr_1123456789ABCDEFGHJKMNPQRS' }
          : path === '/v2/connect/openai-codex/profiles' ? { serviceId: 'openai-codex', profiles: [{ profileId: 'work', status: 'connected' }] }
          : null;
        if (!data) throw new Error(`Unexpected fixture HTTP request: ${path}`);
        return { config, status: 200, statusText: 'OK', headers: {}, data };
      };
      axios.defaults.adapter = adapter;
      const originalMkdir = fsPromises.mkdir;
      const mkdir = vi.spyOn(fsPromises, 'mkdir').mockImplementation(async (path, options) => {
        const result = await originalMkdir(path, options);
        const location = String(path);
        if (armed && !held && boundary === 'mkdir' && location.includes(`${join('materialized', '.attempts')}${sep}`)) {
          acquiredAttempt = location;
          held = true;
          await heldFilesystem;
        }
        return result;
      });
      const originalWriteFile = fsPromises.writeFile;
      const write = vi.spyOn(fsPromises, 'writeFile').mockImplementation(async (path, data, options) => {
        await originalWriteFile(path, data, options);
        const location = String(path);
        if (armed && !held && boundary === 'write' && location.includes(`${join('materialized', '.attempts')}${sep}`) && String(data).includes('fixture-access')) {
          acquiredAttempt = dirname(dirname(location));
          held = true;
          await heldFilesystem;
        }
      });
      const originalRename = fsPromises.rename;
      const rename = vi.spyOn(fsPromises, 'rename').mockImplementation(async (source, target) => {
        await originalRename(source, target);
        if (armed && !held && boundary === 'promote' && String(source).includes(`${join('materialized', '.attempts')}${sep}`)
          && !String(target).includes(`${join('materialized', '.attempts')}${sep}`)) {
          acquiredAttempt = String(target);
          held = true;
          await heldFilesystem;
        }
      });
      syncBuiltinESMExports();
      const startupPath = join(cwd, 'native-startups');
      const { call } = createEncryptedRpcTestClient({ scopePrefix: 'catalog-auth-custody', registerHandlers: registerCapabilitiesHandlers });
      let response: unknown;
      let pending: Promise<unknown> | undefined;
      try {
        await call(RPC_METHODS.CAPABILITIES_DESCRIBE, {});
        // Resolve lazy provider imports and establish that the external credential fixture is valid.
        const warm = await call(RPC_METHODS.CAPABILITIES_INVOKE, { id: 'cli.codex', method: 'probeCatalogs', params: {
          cwd, timeoutMs: 10_000, runtimeKindOverride: 'appServer',
          connectedServices: { v: 1, bindingsByServiceId: { 'openai-codex': { source: 'connected', selection: 'profile', profileId: 'work' } } },
          environmentVariables: {
            HAPPIER_CODEX_APP_SERVER_BIN: fileURLToPath(new URL('../../backends/codex/preflight/__fixtures__/fakeCodexAppServer.mjs', import.meta.url)),
          },
        } });
        expect(warm, JSON.stringify({ warm, requests })).toMatchObject({ ok: true });
        armed = true;
        pending = call(RPC_METHODS.CAPABILITIES_INVOKE, { id: 'cli.codex', method: 'probeCatalogs', params: {
          cwd, timeoutMs: 1_000, runtimeKindOverride: 'appServer',
          connectedServices: { v: 1, bindingsByServiceId: { 'openai-codex': { source: 'connected', selection: 'profile', profileId: 'work' } } },
          environmentVariables: {
            HAPPIER_CODEX_APP_SERVER_BIN: fileURLToPath(new URL('../../backends/codex/preflight/__fixtures__/fakeCodexAppServer.mjs', import.meta.url)),
            HAPPIER_TEST_CATALOG_START_FILE: startupPath,
          },
        } }).then((value) => { response = value; return value; });
        await vi.waitFor(() => expect(held).toBe(true), { timeout: 5_000 });
        if (acquiredAttempt) expect(existsSync(acquiredAttempt)).toBe(true);
        await new Promise<void>((resolve) => setTimeout(resolve, 1_250));
        // Only acquired OS work delays the response; unknown credential HTTP does not.
        if (boundary === 'credential-http') expect(response).toMatchObject({ ok: false, error: { code: 'preflight-catalog-unavailable' } });
        else expect(response).toBeUndefined();
        releaseFilesystem();
        await expect(pending).resolves.toMatchObject({ ok: false, error: { code: 'preflight-catalog-unavailable' } });
        if (acquiredAttempt) {
          expect(existsSync(acquiredAttempt)).toBe(false);
          expect(await fsPromises.readdir(dirname(acquiredAttempt))).toEqual([]);
        }
        expect(existsSync(startupPath)).toBe(false);
        armed = false;
        await expect(call(RPC_METHODS.CAPABILITIES_INVOKE, { id: 'cli.codex', method: 'probeCatalogs', params: {
          cwd, timeoutMs: 5_000, runtimeKindOverride: 'appServer',
          connectedServices: { v: 1, bindingsByServiceId: { 'openai-codex': { source: 'connected', selection: 'profile', profileId: 'work' } } },
          environmentVariables: {
            HAPPIER_CODEX_APP_SERVER_BIN: fileURLToPath(new URL('../../backends/codex/preflight/__fixtures__/fakeCodexAppServer.mjs', import.meta.url)),
            HAPPIER_TEST_CATALOG_START_FILE: startupPath,
          },
        } })).resolves.toMatchObject({ ok: true });
        const pid = Number((await readFile(startupPath, 'utf8')).trim());
        expect(() => process.kill(pid, 0)).toThrow();
        if (acquiredAttempt) expect(await fsPromises.readdir(dirname(acquiredAttempt))).toEqual([]);
      } finally {
        releaseFilesystem();
        await pending;
        // The unfixed owner can return early; let its already-started OS work finish before teardown.
        if (acquiredAttempt) await vi.waitFor(() => expect(existsSync(acquiredAttempt!)).toBe(false), { timeout: 5_000 });
        mkdir.mockRestore();
        write.mockRestore();
        rename.mockRestore();
        syncBuiltinESMExports();
        axios.defaults.adapter = originalAdapter;
        vi.unstubAllEnvs();
        resetInMemoryAccountSettingsContextForTests();
        Object.defineProperties(configuration, descriptors);
      }
    });
  }, 30_000);

  it.each(['connected', 'native'] as const)('admits only native authentication when the catalog adapter cannot materialize a selected account: %s', async (source) => {
    await withTempDir('catalog-unsupported-account-', async (cwd) => {
      const credentialKeys = ['privateKeyFile', 'legacyPrivateKeyFile'] as const;
      const credentialDescriptors = credentialKeys.map((key) => Object.getOwnPropertyDescriptor(configuration, key)!);
      credentialKeys.forEach((key) => Object.defineProperty(configuration, key, { value: join(cwd, key), configurable: true }));
      try {
        const startupPath = join(cwd, 'native-startup');
        const executable = await writeExecutableShim({
          dir: cwd, fileName: 'cursor-fixture.mjs', contents: `#!${process.execPath}\n
            import {writeFileSync} from 'node:fs';
            writeFileSync(${JSON.stringify(startupPath)}, String(process.pid));
            const send = message => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...message})+'\\n');
            let buffer = '';
            process.stdin.on('data', chunk => {
              buffer += chunk;
              const lines = buffer.split('\\n'); buffer = lines.pop() || '';
              for (const line of lines) {
                if (!line.trim()) continue;
                const request = JSON.parse(line);
                if (request.method === 'initialize') send({id:request.id,result:{protocolVersion:1,
                  agentCapabilities:{sessionCapabilities:{close:{}}},authMethods:[{id:'cursor_login',name:'Native login'}]}});
                else if (request.method === 'session/new') {
                  send({method:'session/update',params:{sessionId:'native-session',update:{sessionUpdate:'available_commands_update',
                    availableCommands:[{name:'review',description:'Review the project'}]}}});
                  send({id:request.id,result:{sessionId:'native-session'}});
                } else if (request.id !== undefined) send({id:request.id,result:{}});
              }
            });
          `,
        });
        const { call } = createEncryptedRpcTestClient({ scopePrefix: 'catalog-unsupported-account', registerHandlers: registerCapabilitiesHandlers });
        const result = await call(RPC_METHODS.CAPABILITIES_INVOKE, {
          id: 'cli.cursor', method: 'probeCatalogs', params: {
            cwd, timeoutMs: 5_000,
            connectedServices: { v: 1, bindingsByServiceId: {
              'openai-codex': source === 'connected'
                ? { source, selection: 'profile', profileId: 'selected-fixture' }
                : { source },
            } },
            environmentVariables: { HAPPIER_CURSOR_PATH: executable },
          },
        });
        if (source === 'connected') {
          expect(result).toMatchObject({ ok: false, error: { code: 'connected-service-preflight-failed' } });
          expect(existsSync(startupPath)).toBe(false);
        } else {
          expect(result).toMatchObject({ ok: true, result: { commands: { supported: true, items: [{ command: 'review' }] } } });
          const pid = Number(await readFile(startupPath, 'utf8'));
          expect(() => process.kill(pid, 0)).toThrow();
        }
      } finally {
        credentialKeys.forEach((key, index) => Object.defineProperty(configuration, key, credentialDescriptors[index]));
      }
    });
  }, 30_000);

  it.each([false, true])('cancels a native catalog waiter and preserves a shared healthy waiter: %s', async (shared) => {
    await withTempDir('catalog-cancellation-', async (cwd) => {
      const credentialKeys = ['privateKeyFile', 'legacyPrivateKeyFile'] as const;
      const credentialDescriptors = credentialKeys.map((key) => Object.getOwnPropertyDescriptor(configuration, key)!);
      credentialKeys.forEach((key) => Object.defineProperty(configuration, key, { value: join(cwd, key), configurable: true }));
      const controller = new AbortController();
      const startupPath = join(cwd, 'native-startups');
      const { manager } = createEncryptedRpcTestClient({ scopePrefix: 'catalog-cancellation', registerHandlers: registerCapabilitiesHandlers });
      const request = {
        id: 'cli.codex', method: 'probeCatalogs', params: {
          cwd, timeoutMs: 5_000, runtimeKindOverride: 'appServer',
          environmentVariables: {
            HAPPIER_CODEX_APP_SERVER_BIN: fileURLToPath(new URL('../../backends/codex/preflight/__fixtures__/fakeCodexAppServer.mjs', import.meta.url)),
            HAPPIER_TEST_CATALOG_START_FILE: startupPath,
            HAPPIER_TEST_CATALOG_DELAY_MS: '1000',
            HAPPIER_TEST_CATALOG_SHUTDOWN_DELAY_MS: '250',
          },
        },
      };
      let pending: Promise<unknown> | undefined;
      let other: Promise<unknown> | undefined;
      try {
        pending = manager.invokeLocal(RPC_METHODS.CAPABILITIES_INVOKE, request, { signal: controller.signal });
        if (shared) other = manager.invokeLocal(RPC_METHODS.CAPABILITIES_INVOKE, request);
        await vi.waitFor(() => expect(existsSync(startupPath)).toBe(true));
        const startedPids = (await readFile(startupPath, 'utf8')).trim().split('\n').map(Number);
        controller.abort();
        // A new request arriving during the old launch's shutdown needs a fresh launch.
        if (!shared) other = manager.invokeLocal(RPC_METHODS.CAPABILITIES_INVOKE, request);
        await expect(pending).resolves.toMatchObject({ ok: false, error: { code: 'preflight-catalog-unavailable' } });
        if (shared) expect(() => process.kill(startedPids[0], 0)).not.toThrow();
        else expect(() => process.kill(startedPids[0], 0)).toThrow();
        if (other) await expect(other).resolves.toMatchObject({ ok: true, result: { skills: { supported: true } } });
        const pids = (await readFile(startupPath, 'utf8')).trim().split('\n').map(Number);
        expect(pids).toHaveLength(shared ? 1 : 2);
        for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
      } finally {
        controller.abort();
        await Promise.allSettled([pending, other]);
        credentialKeys.forEach((key, index) => Object.defineProperty(configuration, key, credentialDescriptors[index]));
      }
    });
  }, 30_000);

  it('bounds account-settings preparation by the catalog request budget', async () => {
    await withTempDir('catalog-settings-budget-', async (cwd) => {
      const overrides = {
        happyHomeDir: cwd, activeServerDir: cwd,
        privateKeyFile: join(cwd, 'access.key'), legacyPrivateKeyFile: join(cwd, 'legacy.key'),
        apiServerUrl: 'http://catalog-settings-boundary.test',
        clientEncryptionRequirement: 'follow_account',
      };
      const descriptors = Object.fromEntries(Object.keys(overrides).map((key) => [key, Object.getOwnPropertyDescriptor(configuration, key)!]));
      Object.defineProperties(configuration, Object.fromEntries(Object.entries(overrides).map(([key, value]) => [key, { value, configurable: true }])));
      await writeFile(configuration.privateKeyFile, JSON.stringify({ token: 'catalog-fixture', secret: Buffer.alloc(32, 7).toString('base64') }));
      resetInMemoryAccountSettingsContextForTests();
      const originalAdapter = axios.defaults.adapter;
      const startupPath = join(cwd, 'native-startups');
      const rpcLogPath = join(cwd, 'catalog-rpc.log');
      const cacheLockPath = `${resolveAccountSettingsCachePath({ token: 'catalog-fixture' })}.lock`;
      let settingsWriteCompleted!: () => void;
      const settingsWrite = new Promise<void>((resolve) => { settingsWriteCompleted = resolve; });
      const originalUnlink = fsPromises.unlink;
      // The cache lock's release is the final asynchronous preparation effect.
      // Wait for real filesystem completion before checking for a late native launch.
      const unlink = vi.spyOn(fsPromises, 'unlink').mockImplementation(async (path) => {
        await originalUnlink(path);
        if (path === cacheLockPath) settingsWriteCompleted();
      });
      syncBuiltinESMExports();
      let releaseHttp!: () => void;
      const httpHeld = new Promise<void>((resolve) => { releaseHttp = resolve; });
      let httpEntered = false;
      // Hold only the real HTTP adapter; settings/cache/profile/RPC owners remain real.
      const adapter: AxiosAdapter = async (config) => {
        if (config.url !== 'http://catalog-settings-boundary.test/v2/account/settings') throw new Error('Unexpected fixture HTTP request');
        httpEntered = true;
        await httpHeld;
        return { config, status: 200, statusText: 'OK', headers: {}, data: {
          content: { t: 'plain', v: { schemaVersion: 6, codexBackendMode: 'appServer' } }, version: 1,
        } };
      };
      axios.defaults.adapter = adapter;
      const { call } = createEncryptedRpcTestClient({ scopePrefix: 'catalog-settings-budget', registerHandlers: registerCapabilitiesHandlers });
      let response: unknown;
      let pending: Promise<unknown> | undefined;
      try {
        await call(RPC_METHODS.CAPABILITIES_DESCRIBE, {});
        const request = {
          id: 'cli.codex', method: 'probeCatalogs', params: {
            cwd, timeoutMs: 500, runtimeKindOverride: 'appServer',
            environmentVariables: {
              HAPPIER_CODEX_APP_SERVER_BIN: fileURLToPath(new URL('../../backends/codex/preflight/__fixtures__/fakeCodexAppServer.mjs', import.meta.url)),
              HAPPIER_TEST_CATALOG_START_FILE: startupPath,
              HAPPIER_CODEX_APP_SERVER_RPC_LOG_PATH: rpcLogPath,
            },
          },
        };
        pending = call(RPC_METHODS.CAPABILITIES_INVOKE, request).then((value) => { response = value; return value; });
        await vi.waitFor(() => expect(httpEntered).toBe(true));
        await new Promise<void>((resolve) => setTimeout(resolve, 750));
        expect(response).toMatchObject({ ok: false, error: { code: 'preflight-catalog-unavailable' } });
        releaseHttp();
        await pending;
        await settingsWrite;
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(existsSync(startupPath)).toBe(false);
        processListBoundary.startupPath = startupPath;
        const retry = await call(RPC_METHODS.CAPABILITIES_INVOKE, request);
        expect(retry, JSON.stringify({ retry, nativeStarted: existsSync(startupPath),
          rpcLog: await readFile(rpcLogPath, 'utf8').catch(() => null) })).toMatchObject({ ok: true });
        expect((await readFile(startupPath, 'utf8')).trim().split('\n')).toHaveLength(1);
      } finally {
        processListBoundary.startupPath = null;
        releaseHttp();
        await pending;
        if (httpEntered) await settingsWrite;
        axios.defaults.adapter = originalAdapter;
        unlink.mockRestore();
        syncBuiltinESMExports();
        resetInMemoryAccountSettingsContextForTests();
        Object.defineProperties(configuration, descriptors);
      }
    });
  }, 30_000);

  it('rejects a malformed selected-account scope before launching with ambient authentication', async () => {
    await withTempDir('catalog-invalid-account-', async (cwd) => {
      const credentialKeys = ['privateKeyFile', 'legacyPrivateKeyFile'] as const;
      const credentialDescriptors = credentialKeys.map((key) => Object.getOwnPropertyDescriptor(configuration, key)!);
      credentialKeys.forEach((key) => Object.defineProperty(configuration, key, { value: join(cwd, key), configurable: true }));
      try {
        const startupPath = join(cwd, 'native-startups');
        const { call } = createEncryptedRpcTestClient({ scopePrefix: 'catalog-invalid-account', registerHandlers: registerCapabilitiesHandlers });
        const result = await call(RPC_METHODS.CAPABILITIES_INVOKE, {
          id: 'cli.codex', method: 'probeCatalogs', params: {
            cwd, timeoutMs: 5_000, runtimeKindOverride: 'appServer',
            connectedServices: { v: 1, bindingsByServiceId: { 'openai-codex': { source: 'connected', selection: 'profile' } } },
            environmentVariables: {
              HAPPIER_CODEX_APP_SERVER_BIN: fileURLToPath(new URL('../../backends/codex/preflight/__fixtures__/fakeCodexAppServer.mjs', import.meta.url)),
              HAPPIER_TEST_CATALOG_START_FILE: startupPath,
            },
          },
        });
        expect(result).toMatchObject({ ok: false, error: { code: 'invalid-request' } });
        expect(existsSync(startupPath)).toBe(false);
      } finally {
        credentialKeys.forEach((key, index) => Object.defineProperty(configuration, key, credentialDescriptors[index]));
      }
    });
  }, 30_000);

  it('does not probe Gemini with ambient auth when its selected connected account is unavailable', async () => {
    await withTempDir('gemini-preflight-catalogs-', async (cwd) => {
      const { call } = createEncryptedRpcTestClient({ scopePrefix: 'gemini-catalog-test', registerHandlers: registerCapabilitiesHandlers });
      const response = await call(RPC_METHODS.CAPABILITIES_INVOKE, {
        id: 'cli.gemini', method: 'probeCatalogs', params: {
          cwd, timeoutMs: 5_000,
          environmentVariables: { HAPPIER_GEMINI_PATH: join(cwd, 'missing-native-cli') },
          connectedServices: { v: 1, bindingsByServiceId: {
            'gemini': { source: 'connected', selection: 'group', groupId: 'fixture', profileId: 'fixture' },
          } },
        },
      });
      expect(response).toMatchObject({ ok: false, error: { code: 'connected-service-preflight-failed' } });
    });
  }, 180_000);

  it('discovers cwd-scoped Codex skills without creating a provider thread or Happier session', async () => {
    await withTempDir('preflight-catalogs-', async (cwd) => {
      const { call } = createEncryptedRpcTestClient({
        scopePrefix: 'machine-catalog-test',
        encryptionKey: new Uint8Array(32).fill(7),
        logger: () => undefined,
        registerHandlers: registerCapabilitiesHandlers,
      });
      const startupPath = join(cwd, 'native-startups');
      const environmentPath = join(cwd, 'native-environment.json');
      const request = {
        id: 'cli.codex', method: 'probeCatalogs', params: {
          cwd, timeoutMs: 5_000, runtimeKindOverride: 'appServer', profileId: 'gui-materialized-fixture',
          environmentVariables: {
            HAPPIER_CODEX_APP_SERVER_BIN: fileURLToPath(new URL('../../backends/codex/preflight/__fixtures__/fakeCodexAppServer.mjs', import.meta.url)),
            HAPPIER_TEST_CATALOG_START_FILE: startupPath,
            HAPPIER_TEST_CATALOG_ENV_FILE: environmentPath,
            HAPPIER_HOME_DIR: join(cwd, 'caller-controlled-daemon-home'),
          },
        },
      };
      const results = await Promise.all(Array.from({ length: 3 }, () => call(RPC_METHODS.CAPABILITIES_INVOKE, request)));
      const result = results[0];
      expect(result).toMatchObject({ ok: true, result: {
        commands: { supported: false, items: [] },
        skills: { supported: true, items: [{ name: 'review', path: `${cwd}/SKILL.md` }] },
      } });
      expect(results[1]).toEqual(result);
      expect(results[2]).toEqual(result);
      expect((await readFile(startupPath, 'utf8')).trim().split('\n')).toHaveLength(1);
      expect(JSON.parse(await readFile(environmentPath, 'utf8'))).toMatchObject({ HAPPIER_HOME_DIR: process.env.HAPPIER_HOME_DIR });
      const fresh = await call(RPC_METHODS.CAPABILITIES_INVOKE, request);
      expect(fresh).toEqual(result);
      expect((await readFile(startupPath, 'utf8')).trim().split('\n')).toHaveLength(2);
    });
  }, 180_000);
});
