import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import axios from 'axios';

import {
  buildConnectedServiceCredentialRecord,
  sealAccountScopedBlobCiphertext,
  QualifiedConnectedAccountListResponseV4Schema,
  QualifiedConnectedAccountCredentialSnapshotV4Schema,
  type TeamResourceConnectedServiceSelectionV2,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import type { ApiClient } from '@/api/api';
import type { StoredCredentials } from '@/persistence';
import type {
  ConnectedAccountPurposeBindingOwner,
} from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';

type ActivatePurposeBindingsInput = Parameters<
  ConnectedAccountPurposeBindingOwner['activatePurposeBindings']
>[0];

const originalEnv = { ...process.env };
let tempDir: string | null = null;
let releaseRuntime: (() => Promise<void>) | null = null;

afterEach(async () => {
  await releaseRuntime?.();
  releaseRuntime = null;
  vi.restoreAllMocks();
  vi.doUnmock('@/persistence');
  vi.doUnmock('@/settings/accountSettings/bootstrapAccountSettingsContext');
  vi.doUnmock('@/daemon/connectedServices/resolveConnectedServiceAuthForSpawn');
  vi.resetModules();
  process.env = { ...originalEnv };
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe('capabilities.invoke connected-service preflight', () => {
  it.each([
    { source: 'team_resource', resourceId: 'team-resource-brokered', deliveryMode: 'brokered' },
    {
      source: 'team_resource', resourceId: 'team-resource-direct', deliveryMode: 'direct',
      disclosedMember: {
        service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
        accountId: 'disclosed-team-member',
      },
    },
  ] satisfies TeamResourceConnectedServiceSelectionV2[])(
    'refuses $deliveryMode Team operation probes before accessing personal credentials',
    async (selection) => {
      vi.resetModules();
      tempDir = mkdtempSync(join(tmpdir(), 'happier-capability-team-preflight-'));
      process.env = {
        ...originalEnv,
        HAPPIER_HOME_DIR: tempDir,
        OPENAI_API_KEY: 'ambient-key-must-not-be-used',
      };
      // The credential store and Account API are external boundaries. Team probes
      // have no admitted Session authority and must not read or mutate either.
      const readStoredCredentials = vi.fn(async () => null);
      const createApiClient = vi.fn(async () => { throw new Error('unexpected Account API access'); });
      vi.doMock('@/persistence', async (importOriginal) => ({
        ...(await importOriginal<typeof import('@/persistence')>()),
        readStoredCredentials,
      }));

      const { reloadConfiguration } = await import('@/configuration');
      reloadConfiguration();
      const { registerCapabilitiesHandlers } = await import('./capabilities');
      const { createEncryptedRpcTestClient } = await import('./encryptedRpc.testkit');
      const { call } = createEncryptedRpcTestClient({
        scopePrefix: 'machine-test', encryptionKey: new Uint8Array(32).fill(7),
        logger: () => undefined,
        registerHandlers: (manager) => registerCapabilitiesHandlers(manager, { createApiClient }),
      });
      for (const method of ['probeModels', 'probeConfigOptions', 'probeModes', 'probeCatalogs']) {
        const response = await call(RPC_METHODS.CAPABILITIES_INVOKE, {
          id: 'cli.codex', method,
          params: {
            cwd: tempDir,
            connectedServices: { v: 2, bindingsByServiceId: { 'happier.agent.codex/openai-codex': selection } },
          },
        });
        expect(response, method).toMatchObject({ ok: false, error: { code: 'connected-service-preflight-failed' } });
      }
      expect(readStoredCredentials).not.toHaveBeenCalled();
      expect(createApiClient).not.toHaveBeenCalled();
    },
  );

  it('materializes the selected personal Codex account and isolates history despite an explicit shared-state setting before the model probe', async () => {
    vi.resetModules();
    tempDir = mkdtempSync(join(tmpdir(), 'happier-capability-connected-preflight-'));
    const nativeHome = join(tempDir, 'native-codex');
    mkdirSync(join(nativeHome, 'sessions'), { recursive: true });
    const fixture = join(tempDir, 'codex.mjs');
    const fixtureSource = readFileSync(fileURLToPath(new URL('./__fixtures__/fakeCodexPreflightAppServer.mjs', import.meta.url)), 'utf8');
    // The real declared-tool launch clears PATH; the simulated OS executable
    // must name this test runtime directly, as native catalog fixtures do.
    writeFileSync(fixture, fixtureSource.replace(/^#![^\n]*/, `#!${process.execPath}`)
      .replace("existsSync, writeFileSync", "existsSync, mkdirSync, writeFileSync")
      .replace("    captureMaterializedEnvironment();", `    captureMaterializedEnvironment();
    mkdirSync(join(process.env.CODEX_HOME, 'sessions'), { recursive: true });
    writeFileSync(join(process.env.CODEX_HOME, 'sessions', 'probe.jsonl'), 'probe');`));
    chmodSync(fixture, 0o755);
    const captureFile = join(tempDir, 'captured-env.json');
    process.env = {
      ...originalEnv,
      HAPPIER_HOME_DIR: tempDir,
      HAPPIER_CODEX_PATH: fixture,
      OPENAI_API_KEY: undefined,
      CODEX_API_KEY: undefined,
      CODEX_HOME: nativeHome,
      CODEX_SQLITE_HOME: undefined,
    };

    const credentials: StoredCredentials = {
      token: 'test-happier-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
    };
    const record = buildConnectedServiceCredentialRecord({
      now: 1_800_000_000_000,
      serviceId: 'openai-codex',
      profileId: 'leeroy',
      kind: 'oauth',
      expiresAt: null,
      oauth: {
        accessToken: 'selected-access-token',
        refreshToken: 'selected-refresh-token',
        idToken: null,
        scope: null,
        tokenType: 'Bearer',
        providerAccountId: 'acct_selected',
        providerEmail: null,
      },
    });
    if (credentials.encryption.type !== 'legacy') throw new Error('test expects legacy credentials');
    const ciphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });
    const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' } as const;
    const account = { service, accountId: 'leeroy' };
    const revision = 'csr_0123456789ABCDEFGHJKMNPQRS';
    const accounts = QualifiedConnectedAccountListResponseV4Schema.parse({
      service,
      accounts: [{ ref: account, authenticationModeId: 'oauth', status: 'connected',
        revisionSemantics: 'revisioned', credentialRevision: revision,
        configurationReady: true, configurationRevision: null, scopes: [] }],
    });
    const snapshot = QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({
      ref: account, authenticationModeId: 'oauth', revisionSemantics: 'revisioned',
      credentialRevision: revision, configurationRevision: null,
      content: { t: 'encrypted', c: ciphertext }, metadata: { scopes: [] },
    });
    // HTTP is the external boundary. V4 parsing, encrypted credential opening,
    // purpose authority, plugin invocation and launch-file materialization stay real.
    const credentialReads: string[] = [];
    vi.spyOn(axios, 'get').mockImplementation(async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === '/v2/account/settings') return { status: 200, data: { version: 1, content: { t: 'plain', v: {
        schemaVersion: 6, connectedServicesProviderStateSharingSettingsV1: {
          v: 1, defaults: { configMode: 'linked', stateMode: 'shared' }, byAgentId: { codex: { stateMode: 'shared' } },
        },
      } } } };
      if (path === '/v4/connect/qualified/accounts') return { status: 200, data: accounts };
      if (path === '/v4/connect/qualified/credential') {
        credentialReads.push(path);
        return { status: 200, data: snapshot };
      }
      throw new Error(`Unexpected capability HTTP read: ${path}`);
    });
    const api = {
      getAccountEncryptionMode: async () => 'e2ee' as const,
    } as unknown as ApiClient;

    vi.doMock('@/persistence', async (importOriginal) => ({
      ...(await importOriginal<typeof import('@/persistence')>()),
      readStoredCredentials: vi.fn(async () => credentials),
    }));
    const { reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();
    const { pluginReloadController } = await import('@/plugins/runtime/reload/singleton');
    const { resolveExecutablePluginRuntimeRegistry } = await import('@/plugins/runtime/resolveExecutablePluginRuntimeRegistry');
    const { getResolvedContributionRegistry } = await import('@/plugins/projection/registry/createResolvedContributionRegistry');
    const { createQualifiedConnectedAccountEstablishedRuntimeOwner } = await import('@/daemon/connectedServices/qualifiedConnectedAccountEstablishedRuntimeOwner');
    const { createDaemonConnectedAccountPurposeBindingRuntime } = await import('@/daemon/connectedServices/purposeBindings/createDaemonConnectedAccountPurposeBindingRuntime');
    const established = createQualifiedConnectedAccountEstablishedRuntimeOwner({
      reloadController: pluginReloadController, credentials,
      getAccountEncryptionMode: async () => 'e2ee',
      configuration: {
        read: async () => null,
        secrets: { admit: async () => undefined, has: async () => false, read: async () => null },
      },
    });
    const purposeRuntime = createDaemonConnectedAccountPurposeBindingRuntime({
      reloadController: pluginReloadController, establishedRuntimeOwner: established,
      resolveQualifiedConnectedAccountV4Support: () => 'advertised',
      qualifiedApi: {
        listAccounts: async () => accounts,
        listGroups: async () => ({ groups: [] }), readGroup: async () => null,
      },
      store: {
        read: async () => ({ v: 1, bindings: [] }),
        update: async (mutate) => mutate({ v: 1, bindings: [] }),
        subscribe: () => ({ dispose() {} }),
      },
    });
    const lease = await pluginReloadController.acquireRuntimeRegistry({
      resolveRuntimeRegistry: () => resolveExecutablePluginRuntimeRegistry({
        contributes: getResolvedContributionRegistry(), pluginIds: ['happier.agent.codex'],
        // Account plugin settings are persistent storage. An absent record uses
        // the real declaration defaults without attempting a real Account read.
        accountSettingsRecordAdapter: {
          async bindOperation() {
            return {
              async readRecord() { return { status: 'absent' }; },
              async writeRecord() { return { status: 'unavailable' }; },
            };
          },
        },
        resolveDevelopmentSourceAuthority: ({ pluginId, rootPath }) => ({
          kind: 'development', registeredRootId: `capability-account:${pluginId}`, canonicalRoot: rootPath, observedRevision: 1,
        }),
        connectedAccounts: purposeRuntime.owner, qualifiedConnectedAccountEstablishedRuntimeOwner: established,
      }),
    });
    releaseRuntime = async () => {
      await lease.release();
      await pluginReloadController.shutdown();
    };
    const { registerCapabilitiesHandlers } = await import('./capabilities');
    const { createEncryptedRpcTestClient } = await import('./encryptedRpc.testkit');
    const { call } = createEncryptedRpcTestClient({
      scopePrefix: 'machine-test',
      encryptionKey: new Uint8Array(32).fill(7),
      logger: () => undefined,
      registerHandlers: (manager) => registerCapabilitiesHandlers(manager, {
        createApiClient: async () => api,
        activatePurposeBindings: purposeRuntime.activatePurposeBindings,
      }),
    });

    const response = await call(RPC_METHODS.CAPABILITIES_INVOKE, {
      id: 'cli.codex',
      method: 'probeModels',
      params: {
        cwd: tempDir,
        timeoutMs: 5_000,
        runtimeKindOverride: 'appServer',
        connectedServices: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': {
              source: 'connected',
              selection: 'profile',
              profileId: 'leeroy',
            },
          },
        },
      },
    });

    expect(response).toMatchObject({
      ok: true,
      result: { source: 'dynamic', availableModels: expect.arrayContaining([expect.objectContaining({ id: 'gpt-5.4' })]) },
    });
    expect(credentialReads).not.toHaveLength(0);
    const captured = JSON.parse(readFileSync(captureFile, 'utf8')) as Record<string, unknown>;
    expect(captured.CODEX_HOME).toEqual(expect.any(String));
    expect(captured.CODEX_AUTH_FILE_PRESENT).toBe(true);
    expect(readdirSync(join(nativeHome, 'sessions'))).toEqual([]);
    expect(captured.CODEX_HOME).not.toBe(nativeHome);
    const methods = JSON.parse(readFileSync(join(tempDir, 'captured-methods.json'), 'utf8')) as string[];
    expect(methods).toContain('model/list');
    expect(methods.some((method) => method.startsWith('thread/') || method.startsWith('realtime/'))).toBe(false);
  }, 90_000);

  it('threads the canonical purpose owner into a qualified capability preflight and disposes its exact lease', async () => {
    vi.resetModules();
    tempDir = mkdtempSync(join(tmpdir(), 'happier-capability-qualified-purpose-'));
    const fixture = fileURLToPath(new URL('./__fixtures__/fakeCodexPreflightAppServer.mjs', import.meta.url));
    chmodSync(fixture, 0o755);
    process.env = {
      ...originalEnv,
      HAPPIER_HOME_DIR: tempDir,
      HAPPIER_CODEX_PATH: fixture,
      OPENAI_API_KEY: undefined,
      CODEX_API_KEY: undefined,
      CODEX_HOME: undefined,
      CODEX_SQLITE_HOME: undefined,
    };

    const credentials: StoredCredentials = {
      token: 'test-happier-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
    };
    vi.doMock('@/persistence', async (importOriginal) => ({
      ...(await importOriginal<typeof import('@/persistence')>()),
      readStoredCredentials: vi.fn(async () => credentials),
    }));
    vi.doMock('@/settings/accountSettings/bootstrapAccountSettingsContext', () => ({
      bootstrapAccountSettingsContext: vi.fn(async () => ({
        settings: { codexBackendMode: 'appServer' },
      })),
    }));

    const disposePurposeLease = vi.fn();
    const activatePurposeBindings = vi.fn((_input: ActivatePurposeBindingsInput) => ({
      subjectId: 'operation:capability-probe/consumer:happier.agent.codex/codex',
      isCurrent: () => true,
      resolvePurposeBinding: () => null,
      listPurposeBindings: () => [],
      dispose: disposePurposeLease,
    }));
    const purpose = {
      consumer: { pluginId: 'happier.agent.codex', localId: 'codex' },
      purpose: 'codex-native-auth',
    } as const;
    const binding = {
      purpose,
      target: {
        kind: 'account',
        account: {
          service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
          accountId: 'leeroy',
        },
      },
    } as const;
    const resolveAuthForSpawn = vi.fn(async (input: Readonly<{
      activateQualifiedPurposeBindings?: (snapshot: unknown) => Readonly<{
        subjectId: string;
        dispose(): void | Promise<void>;
      }>;
      connectedServicesBindingsRaw: unknown;
    }>) => {
      const snapshot = {
        purposes: [purpose],
        bindings: [binding],
        authorizedPurposes: [],
        fileMaterializationPurposes: [],
        requestAuthUses: [],
        fileEnvironmentUses: [],
        environmentUses: [],
      } as const;
      const materializationPurposeLease = input.activateQualifiedPurposeBindings?.(snapshot);
      if (!materializationPurposeLease) {
        throw new Error('qualified capability purpose activation missing');
      }
      return {
        env: { CODEX_HOME: tempDir! },
        cleanupOnFailure: null,
        cleanupOnExit: null,
        connectedServicesBindings: input.connectedServicesBindingsRaw,
        qualifiedPurposeBindingSnapshot: snapshot,
        requestAuthPurposeBindings: [],
        materializationPurposeLease,
      };
    });
    vi.doMock('@/daemon/connectedServices/resolveConnectedServiceAuthForSpawn', () => ({
      resolveConnectedServiceAuthForSpawn: resolveAuthForSpawn,
    }));

    const { reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();
    const { registerCapabilitiesHandlers } = await import('./capabilities');
    const { createEncryptedRpcTestClient } = await import('./encryptedRpc.testkit');
    const { call } = createEncryptedRpcTestClient({
      scopePrefix: 'machine-test',
      encryptionKey: new Uint8Array(32).fill(7),
      logger: () => undefined,
      registerHandlers: (manager) => registerCapabilitiesHandlers(manager, {
        createApiClient: async () => ({} as ApiClient),
        activatePurposeBindings,
        isAgentRegistryCurrent: () => true,
      }),
    });

    const response = await call(RPC_METHODS.CAPABILITIES_INVOKE, {
      id: 'cli.codex',
      method: 'probeModels',
      params: {
        cwd: tempDir,
        timeoutMs: 5_000,
        connectedServices: {
          v: 1,
          bindingsByServiceId: {
            'happier.agent.codex/openai-codex': {
              source: 'connected',
              selection: 'profile',
              profileId: 'leeroy',
            },
          },
        },
      },
    });

    expect(response).toMatchObject({ ok: true });
    expect(resolveAuthForSpawn).toHaveBeenCalledOnce();
    expect(activatePurposeBindings).toHaveBeenCalledWith(expect.objectContaining({
      subject: expect.objectContaining({
        kind: 'operation',
        consumer: { pluginId: 'happier.agent.codex', localId: 'codex' },
      }),
      purposes: [purpose],
      bindings: [binding],
    }));
    const activationSubject = activatePurposeBindings.mock.calls[0]?.[0].subject;
    // The capability probe owns one correlation-scoped operation subject; its
    // currentness must be live rather than a constant.
    if (activationSubject?.kind !== 'operation') {
      throw new Error(`capability_probe_subject_kind:${activationSubject?.kind ?? 'missing'}`);
    }
    expect(activationSubject.isCurrent()).toBe(true);
    expect(disposePurposeLease).toHaveBeenCalledOnce();
  }, 90_000);

  it('fails closed instead of probing ambient auth when selected credentials are unavailable', async () => {
    vi.resetModules();
    tempDir = mkdtempSync(join(tmpdir(), 'happier-capability-connected-preflight-no-credentials-'));
    process.env = {
      ...originalEnv,
      HAPPIER_HOME_DIR: tempDir,
      OPENAI_API_KEY: 'ambient-key-must-not-be-used',
    };
    vi.doMock('@/persistence', async (importOriginal) => ({
      ...(await importOriginal<typeof import('@/persistence')>()),
      readStoredCredentials: vi.fn(async () => null),
    }));
    vi.doMock('@/settings/accountSettings/bootstrapAccountSettingsContext', () => ({
      bootstrapAccountSettingsContext: vi.fn(async () => null),
    }));

    const { reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();
    const { registerCapabilitiesHandlers } = await import('./capabilities');
    const { createEncryptedRpcTestClient } = await import('./encryptedRpc.testkit');
    const { call } = createEncryptedRpcTestClient({
      scopePrefix: 'machine-test',
      encryptionKey: new Uint8Array(32).fill(7),
      logger: () => undefined,
      registerHandlers: (manager) => registerCapabilitiesHandlers(manager),
    });

    const response = await call(RPC_METHODS.CAPABILITIES_INVOKE, {
      id: 'cli.codex',
      method: 'probeModels',
      params: {
        cwd: tempDir,
        connectedServices: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': {
              source: 'connected',
              selection: 'group',
              groupId: 'happier',
            },
          },
        },
      },
    });

    expect(response).toEqual({
      ok: false,
      error: {
        code: 'connected-service-preflight-failed',
        message: 'Could not prepare the selected connected-service account for this probe.',
      },
    });
  }, 90_000);
});
