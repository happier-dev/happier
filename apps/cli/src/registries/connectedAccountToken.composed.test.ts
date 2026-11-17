import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { accountSettingsParse, encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER,
  PluginConnectedAccountDescriptorContributionV2Schema, ScmHostingProviderContributionSchema,
  type QualifiedConnectedAccountPurposeBindingsV1 } from '@happier-dev/protocol';
import { GITHUB_SCM_HOSTING_PROVIDER_ID, PLUGIN_MANIFEST, githubHostingProviderAdapter } from '@happier-dev/plugins-scm-github';
import { createConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { readRegistryConnectedAccountTokenV1, readRegistryHostingTokenV1 } from './connectedAccountToken';
import { createRegistryHttpV1 } from './registryHttp';
import { materializeGithubCredential } from '../../../../packages/plugins/scm-github/src/auth/credentialMaterialization';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { getActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import * as gh from '@happier-dev/cli-common/agents/gh';
import { createLightSqliteHarness, type LightSqliteHarness } from '../../../server/sources/testkit/lightSqliteHarness';
import { db } from '../../../server/sources/storage/db';
import { inTx } from '../../../server/sources/storage/inTx';
import { resolveMachineAdmission, setMachineAccessGrantInTx } from '../../../server/sources/app/machines/machineAccess';
import { makeShareEligibleForTest } from '../../../server/sources/testkit/shareEligibility.testkit';
import { auth } from '../../../server/sources/app/auth/auth';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

it('checks GitHub with the selected Account credential and leaves an unbound inventory anonymous', async () => {
  const service = { pluginId: PLUGIN_MANIFEST.id, localId: 'github-account' };
  const account = { service, accountId: 'selected-github' };
  let bindings: QualifiedConnectedAccountPurposeBindingsV1 = { v: 1, bindings: [{
    purpose: { consumer: { pluginId: PLUGIN_MANIFEST.id, localId: 'github' }, purpose: 'authentication' },
    target: { kind: 'account', account },
  }] };
  const materializations: string[] = [];
  const owner = createConnectedAccountPurposeBindingOwner({
    // Persistence and credential acquisition are the system boundaries. Selection,
    // purpose authorization, forge routing, and HTTP admission stay real.
    store: { read: async () => bindings, update: async () => { throw new Error('Read cannot change defaults'); },
      subscribe: () => ({ dispose() {} }) },
    selectTarget: async () => { throw new Error('Read cannot select an Account'); },
    resolveTarget: async () => ({ displayName: 'Selected GitHub', account }),
    assertTargetAccountMaterializable: async () => undefined,
    projectTargetAccounts: async () => ({ status: 'complete', accounts: [{ account,
      displayName: 'Selected GitHub', state: 'connected', connectedAccountOrigins: ['https://github.com'],
      connectedAccountBases: ['https://github.com'] }] }),
    materializeAccount: async input => {
      expect(input.account).toEqual(account);
      if (input.request.kind !== 'httpHeaders') throw new Error('Expected HTTP credential request');
      materializations.push(input.request.origin);
      const unavailable = async (): Promise<never> => { throw new Error('Materialization cannot contact the provider'); };
      return materializeGithubCredential(input.request, { account,
        configuration: { target: { kind: 'account', account, modeId: 'native-import' }, revision: 'fixture',
          values: {}, getSecret: async () => null },
        credentials: { get: async key => key === 'token' ? 'connected-fixture' : null },
        signal: new AbortController().signal, invokedAtMs: 0, surface: 'cli',
        plugin: { id: PLUGIN_MANIFEST.id, version: PLUGIN_MANIFEST.version },
        contribution: { id: service.localId, qualifiedId: `${service.pluginId}/${service.localId}` },
        services: { http: { request: unavailable, requestStream: unavailable, prepareRead: unavailable, openWebSocket: unavailable } } });
    },
    materializeNative: async () => { throw new Error('An explicit Account must take precedence over native login'); },
  });
  const registry: Parameters<typeof readRegistryHostingTokenV1>[0]['registry'] = {
    contributes: {
      scmHostingProviders: [{ id: 'github', provenance: 'external', source: { kind: 'path' }, pluginId: PLUGIN_MANIFEST.id,
        definition: ScmHostingProviderContributionSchema.parse(PLUGIN_MANIFEST.contributes.scmHostingProviders![0]) }],
      connectedAccountDescriptors: [{ provenance: 'external', source: { kind: 'path' }, pluginId: PLUGIN_MANIFEST.id,
        definition: PluginConnectedAccountDescriptorContributionV2Schema.parse(PLUGIN_MANIFEST.contributes.connectedAccountDescriptors![0]) }],
    },
    scmHostingProvidersById: new Map([[GITHUB_SCM_HOSTING_PROVIDER_ID, { pluginId: PLUGIN_MANIFEST.id,
      occurrenceId: 'registry-auth-fixture', registration: { id: 'github', adapter: { routing: githubHostingProviderAdapter } } }]]),
    resolveConnectedAccountPurposeBindingOwner: () => owner,
  };
  const source = { id: 'linked', title: 'Linked', format: 'git' as const, kinds: ['skill' as const],
    url: 'https://github.com/anthropics/skills', enabled: true, addedAt: 0 };
  const observed: (string | null)[] = [];
  let allowNativeAccountCredentials = true;
  const http = createRegistryHttpV1({ resolveToken: selected => readRegistryHostingTokenV1({ registry, source: selected, allowNativeAccountCredentials }),
    fetch: async (_url, init) => { observed.push(new Headers(init?.headers).get('authorization')); return Response.json({ sha: 'current' }); } });
  await expect(http.getJson('https://api.github.com/repos/anthropics/skills/commits/main', { source }))
    .resolves.toMatchObject({ ok: true, value: { sha: 'current' } });
  expect(observed).toEqual(['Bearer connected-fixture']);
  expect(materializations).toEqual(['https://api.github.com']);
  bindings = { v: 1, bindings: [] };
  allowNativeAccountCredentials = false;
  await http.getJson('https://api.github.com/repos/anthropics/skills/commits/main', { source });
  expect(observed).toEqual(['Bearer connected-fixture', null]);
  expect(materializations).toHaveLength(1);
});

describe('registry native GitHub credentials after Machine admission', () => {
  let database: LightSqliteHarness;
  let plugins: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>>;
  beforeAll(async () => {
    database = await createLightSqliteHarness({ tempDirPrefix: 'happier-registry-native-admission-', initAuth: true, initEncrypt: true });
    plugins = await createAdmittedPluginRuntimeFixture({ runtimeOptions: { pluginIds: [PLUGIN_MANIFEST.id] } });
  }, 120_000);
  afterAll(async () => { await plugins?.dispose(); await database?.close(); });
  afterEach(() => { resetActiveAccountSettingsSnapshotForTests(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  // D2 / owner direction 2026-11-06: native Machine credentials serve the
  // custodian and admitted Managers, while Account bindings remain private.
  it.each(['custodian', 'custodian-missing-role', 'manage', 'use', 'missing-role', 'missing-admission', 'foreign-token', 'no-login', 'invalid-selection'] as const)(
    'uses the admitted %s identity through the real requester purpose runtime', async scenario => {
      const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
      const requester = scenario === 'custodian' || scenario === 'custodian-missing-role'
        ? owner : await db.account.create({ data: { encryptionMode: 'plain' } });
      const machine = await db.machine.create({ data: { id: `registry-${owner.id}`, accountId: owner.id, installationId: 'registry-installation', active: true,
        metadata: encodePlainMachineStoredContent({ host: 'registry-host', platform: 'linux', happyCliVersion: 'test',
          homeDir: plugins.happyHomeDir, happyHomeDir: plugins.happyHomeDir }),
        daemonState: encodePlainMachineStoredContent({ status: 'running' }),
        dataEncryptionKey: new Uint8Array(Buffer.from(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64')) } });
      if (requester.id !== owner.id) {
        await makeShareEligibleForTest(owner.id, requester.id);
        expect(await inTx(tx => setMachineAccessGrantInTx(tx, { actorAccountId: owner.id, machineId: machine.id,
          principal: { kind: 'account', accountId: requester.id }, level: scenario === 'use' ? 'view' : 'admin' })))
          .toMatchObject({ kind: 'saved' });
      }
      const admission = await resolveMachineAdmission({ actorAccountId: requester.id, machineId: machine.id,
        rpcMethod: RPC_METHODS.DAEMON_REGISTRIES_FETCH });
      expect(admission).toMatchObject({ kind: 'admitted', role: scenario === 'use' ? 'use' : 'manage' });
      if (admission.kind !== 'admitted') throw new Error('Expected real Machine admission');
      const tokenAccountId = scenario === 'foreign-token' ? owner.id : requester.id;
      const credentials = { token: await auth.createToken(tokenAccountId, undefined, { kind: 'account', authority: 'present_user' }), encryption: null };
      const home = 'https://registry-native-home.example.test';
      const purposeCatalog = { status: 'ready' as const, revision: 1, record: { key: 'purposes' as const, value: { v: 1 as const,
        bindings: scenario === 'invalid-selection' ? [{
          purpose: { consumer: { pluginId: PLUGIN_MANIFEST.id, localId: 'github' }, purpose: 'authentication' },
          target: { kind: 'account' as const, account: { service: { pluginId: 'com.acme.other', localId: 'account' }, accountId: 'unrelated' } },
        }] : [] } } };
      const operationContext = createInvocationSavedSecretOperationContextV1({ credentials, serverHttpBaseUrl: home,
        ...(scenario === 'missing-admission' ? {} : { machineAdmission: {
          actorAccountId: admission.actorAccountId, custodianAccountId: admission.custodianAccountId,
          ...(scenario === 'missing-role' || scenario === 'custodian-missing-role' ? {} : { role: admission.role }) } }),
        snapshot: { source: 'network', scopeKey: runWithServerHttpBaseUrl(home, () => resolveAccountSettingsScopeKey(credentials)),
          settings: accountSettingsParse({}), settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [],
          connectedPurposeCatalog: purposeCatalog },
        isCurrent: async () => true });
      const snapshot = operationContext.readSnapshot();
      if (!snapshot) throw new Error('Expected captured requester snapshot');
      const custodianCredentials = { token: await auth.createToken(owner.id, undefined, { kind: 'account', authority: 'present_user' }), encryption: null };
      const custodianCatalog = { status: 'ready' as const, revision: 1, record: { key: 'purposes' as const, value: { v: 1 as const, bindings: [{
        purpose: { consumer: { pluginId: PLUGIN_MANIFEST.id, localId: 'github' }, purpose: 'authentication' },
        target: { kind: 'account' as const, account: { service: { pluginId: PLUGIN_MANIFEST.id, localId: 'github-account' }, accountId: 'custodian-private' } },
      }] } } };
      setActiveAccountSettingsSnapshot({ ...snapshot, connectedPurposeCatalog: custodianCatalog,
        scopeKey: runWithServerHttpBaseUrl(home, () => resolveAccountSettingsScopeKey(custodianCredentials)) });
      // Native credential acquisition and HTTP are system boundaries. The real
      // admission, Account custody, runtime registry and purpose owner run below.
      const native = vi.spyOn(gh, 'resolveGhNativeToken').mockResolvedValue(scenario === 'no-login'
        ? { ok: false, reason: 'unavailable', remediation: 'sign in with gh CLI' }
        : { ok: true, token: 'native-registry-fixture' });
      vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (url, options) => {
        expect(String(url)).toBe(`${home}/v1/features/authenticated`);
        expect(new Headers(options?.headers).get('authorization')).toBe(`Bearer ${credentials.token}`);
        return Response.json({ features: {}, capabilities: {} });
      }));
      const source = { id: 'native', title: 'Native', format: 'git' as const, kinds: ['skill' as const],
        url: 'https://github.com/acme/private-skills', enabled: true, addedAt: 0 };
      const read = readRegistryConnectedAccountTokenV1({ source, operationContext, controller: plugins.controller });
      if (scenario === 'custodian' || scenario === 'custodian-missing-role' || scenario === 'manage') {
        await expect(read).resolves.toEqual({ value: 'native-registry-fixture', origin: 'https://api.github.com' });
        expect(native).toHaveBeenCalledWith({ hostname: 'github.com', signal: expect.any(AbortSignal) });
      } else if (scenario === 'foreign-token') {
        await expect(read).rejects.toMatchObject({ status: { state: 'auth_failed' } });
        expect(native).not.toHaveBeenCalled();
      } else if (scenario === 'invalid-selection') {
        await expect(read).rejects.toMatchObject({ status: { state: 'unreachable' } });
        expect(native).not.toHaveBeenCalled();
      } else if (scenario === 'no-login') {
        await expect(read).resolves.toBeNull();
        expect(native).toHaveBeenCalledOnce();
      } else {
        await expect(read).resolves.toBeNull();
        expect(native).not.toHaveBeenCalled();
      }
      expect(await db.userKVStore.count({ where: { accountId: owner.id } })).toBe(0);
      expect(operationContext.readSnapshot()?.connectedPurposeCatalog).toEqual(purposeCatalog);
      expect(getActiveAccountSettingsSnapshot()?.connectedPurposeCatalog).toEqual(custodianCatalog);
    });
});
