import axios from 'axios';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectAgentPreflightSessionControlsCatalogEntry } from '@/plugins/projection/registry/agentCatalogEntryHooks';
import { preflightCatalogEntryFixture } from './preflightSessionControlsProbeAdapter.testkit';
import { invokeCliPreflightMethod } from './agentPreflight';
import { writeExecutableShimSync } from '@/testkit/fs/executableShim';
import { OPENCODE_PREFLIGHT_SESSION_CONTROLS } from '../../../../../packages/plugins/opencode/src/agent/preflight/models';
import { OPEN_CODE_SYSTEM_TOOL_ID, OPEN_CODE_STABLE_SYSTEM_TOOL_ID, OPEN_CODE_V2_SYSTEM_TOOL_ID } from '../../../../../packages/plugins/opencode/src/agent/systemTool';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  accountSettingsParse,
  deriveAccountMachineKeyFromRecoverySecret,
  deriveSettingsSecretsKeyV1,
  encryptSecretStringV1,
  FeaturesResponseSchema,
  formatSharedSavedSecretRefV1,
  sealSavedSecretResourceStoredContentV1,
} from '@happier-dev/protocol';
import { ProfileRecordV1Schema } from '@happier-dev/protocol/profiles/profileRecordV1';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import { loadInstalledPlugins } from '@/plugins/discovery/load/installed';
import * as persistence from '@/persistence';

import { resolveProfileProbeEnvironment } from './resolveProfileProbeEnvironment';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { deriveSettingsSecretsReadKeysForCredentials } from '@/settings/secrets/settingsSecretsKey';
import { artifactListResponse } from '@/testkit/http/artifactHome';

function publishAccountSnapshot(request: Pick<Parameters<typeof resolveProfileProbeEnvironment>[0], 'accountSettings' | 'credentials' | 'profileCatalog'>) {
  if (!request.accountSettings || !request.credentials) throw new Error('Expected a credentialed Account fixture');
  setActiveAccountSettingsSnapshot({
    source: 'network', settings: accountSettingsParse(request.accountSettings), rawSettings: request.accountSettings,
    settingsVersion: 1, loadedAtMs: 1, scopeKey: resolveAccountSettingsScopeKey(request.credentials),
    settingsSecretsReadKeys: deriveSettingsSecretsReadKeysForCredentials(request.credentials), profileCatalog: request.profileCatalog,
  });
}
const predecessorCatalog = { status: 'ready' as const, source: 'legacy' as const, authority: 'inactive' as const, control: null,
  controlRevision: 'absent' as const, referenceGuardRevision: 'absent' as const, diagnostics: [], records: [] };

describe('resolveProfileProbeEnvironment', () => {
  afterEach(() => { resetActiveAccountSettingsSnapshotForTests(); vi.restoreAllMocks(); });
  it.each([
    { role: 'use', probe: 'materialize' },
    { role: 'manage', probe: 'materialize' },
    { role: 'manage', probe: 'static' },
    { role: 'use', probe: 'static' },
    { role: 'manage', probe: 'native' },
    { role: 'manage', probe: 'acp' },
    { role: 'use', probe: 'native' },
    { role: 'manage', probe: 'cancel' },
  ] as const)('consumes Profile material only when needed ($role, $probe)', async ({ role, probe }) => {
    let acquisitions = 0;
    const cancellation = new AbortController();
    let acquisitionStarted!: () => void;
    const started = new Promise<void>(resolve => { acquisitionStarted = resolve; });
    let acquisitionSignal: AbortSignal | undefined;
    const plugin = definePlugin({ id: 'acme.vault', version: '1.0.0', displayName: 'Vault', entrypoints: { daemon: './daemon.mjs' },
      secretSources: { main: { declaration: { title: 'Vault' }, runtime: {
        async acquire(_input, context) {
          acquisitions += 1;
          if (probe === 'cancel') {
            acquisitionSignal = context.signal;
            acquisitionStarted();
            await new Promise<void>((_resolve, reject) => {
              context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true });
            });
          }
          return { ok: true, value: 'vault-key' };
        },
      } } },
    });
    const fixture = await createAuthoredAdmittedPluginRuntimeFixture({
      plugins: [{ manifest: plugin.manifest, files: { 'daemon.mjs': 'export function activate() {}' },
        instantiateCommittedModule: () => ({ activate: plugin.activate }) }], coldStart: true,
      async resolveContributes(happyHomeDir) {
        return createResolvedContributionRegistry(projectLoadedPluginContributes({
          loadResult: await loadInstalledPlugins({ happyHomeDir }), provenance: 'external',
        }));
      },
    });
    try {
      const ref = formatSharedSavedSecretRefV1('profile-vault');
      const resource = { resourceId: 'profile-vault', encryptionMode: 'plain' as const, recipientEnvelope: null,
        entry: { ref, source: 'shared_resource', relationship: 'owner', name: 'Vault', kind: 'apiKey', ownerAccountId: 'owner',
          revision: 1, materialStatus: 'ready', capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } },
        storedContent: sealSavedSecretResourceStoredContentV1({ resourceId: 'profile-vault', mode: 'plain', content: {
          v: 2, name: 'Vault', kind: 'apiKey', source: { kind: 'external', contribution: { pluginId: 'acme.vault', localId: 'main' },
            account: 'account', reference: 'op://vault/item/field' },
        } }),
      };
      const profileRecord = ProfileRecordV1Schema.parse({ v: 1, id: 'work', enabled: true,
        promptStack: [], secretBindings: { PROFILE_KEY: ref },
        definition: { kind: 'inline', profile: { v: 2, id: 'work', name: 'Work', createdAt: 1, updatedAt: 1,
          extraEnvironmentVariables: [{ name: 'PROFILE_MODE', value: 'profile-mode' }, { name: 'PROFILE_ALIAS', value: '${PROFILE_KEY}' }],
          envVarRequirements: [{ name: 'PROFILE_KEY', kind: 'secret', required: true }],
        } },
      });
      const transferRecord = { v: 1 as const, phase: 'active' as const, sourceSettingsVersion: 1, migratedLogicalRevision: 1, inventory: [] };
      const transferControl = { status: 'present' as const, revision: 1, content: { t: 'plain' as const, v: transferRecord } };
      vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue({ token: 'token', encryption: null });
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(FeaturesResponseSchema.parse({
        features: { sharing: { enabled: true, savedSecrets: { enabled: true } }, encryption: { plaintextStorage: { enabled: true } } },
      })), { status: 200, headers: { 'content-type': 'application/json' } }));
      vi.spyOn(axios, 'get').mockImplementation(async url => {
        const path = new URL(String(url)).pathname;
        if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
          mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
        if (path === '/v1/account/entity-rows/profiles/reference-guard') return { status: 200, data: { status: 'ready', revision: 1 } };
        if (path === '/v1/account/entity-rows/profiles/transfer') return { status: 200, data: transferControl };
        if (path === '/v1/account/entity-rows/profiles') return { status: 200, data: { status: 'listed',
          rows: [{ id: 'work', revision: 1, content: { t: 'plain', v: profileRecord } }],
          nextCursor: null, complete: true, diagnostics: [], referenceGuardRevision: 1, transferControl } };
        if (path === '/v1/account/saved-secrets/resources/materials') return { status: 200, data: { resources: [resource] } };
        if (path === '/v1/artifacts') return { status: 200, data: artifactListResponse(String(url), []) };
        if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
        if (path === '/v1/account/authoring-memory/lastUsedProfile') return { status: 200, data: { status: 'absent' } };
        if (path === '/v2/account/settings') return { status: 200, data: { content: null, version: 1 } };
        throw new Error(`Unexpected profile probe HTTP path: ${path}`);
      });
      const request = {
        agentId: 'opencode', profileId: 'work', profileCatalog: predecessorCatalog,
        accountSettings: { profiles: [{ id: 'work', name: 'Work', environmentVariables: [
          { name: 'PROFILE_MODE', value: 'profile-mode' }, { name: 'PROFILE_ALIAS', value: '${PROFILE_KEY}' },
        ], envVarRequirements: [{ name: 'PROFILE_KEY', kind: 'secret', required: true }],
          compatibilityByTargetKey: { 'agent:opencode': true }, defaultEnabled: true, isBuiltIn: false }] },
        credentials: { token: 'token', encryption: null }, processEnv: {},
        secretReferenceOverlay: { v: 1 as const, bindings: { PROFILE_KEY: { ref, revision: 1 } } }, secretSources: fixture.registry.secretSources,
        machineAdmission: { actorAccountId: 'requester', custodianAccountId: 'custodian', role },
      };
      publishAccountSnapshot(request);
      if (probe !== 'materialize') {
        publishAccountSnapshot({ ...request, profileCatalog: { status: 'ready', source: 'destination', authority: 'active',
          control: { revision: 1, record: transferRecord }, controlRevision: 1, referenceGuardRevision: 1,
          records: [{ revision: 1, record: profileRecord }], diagnostics: [] } });
        const root = await mkdtemp(join(tmpdir(), 'happier-profile-preflight-'));
        try {
          const script = join(root, 'probe.cjs');
          const authenticationCapture = join(root, 'authentication.jsonl');
          await writeFile(script, probe === 'acp' ? `
            const fs=require('node:fs');
            require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
              const request=JSON.parse(line); if(request.id===undefined)return;
              let result={};
              if(request.method==='initialize')result={protocolVersion:1,agentCapabilities:{},authMethods:[{id:'profile-auth'},{id:'missing-auth'}]};
              if(request.method==='authenticate')fs.appendFileSync(${JSON.stringify(authenticationCapture)},JSON.stringify({
                params:request.params, environment:[process.env.PROFILE_KEY,process.env.PROFILE_ALIAS,process.env.PROFILE_MODE].join('|')
              })+'\\n');
              if(request.method==='session/new')result={sessionId:'profile-native',configOptions:[]};
              process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\\n');
            });
          ` : 'process.stdout.write([process.env.PROFILE_KEY, process.env.PROFILE_ALIAS, process.env.PROFILE_MODE].join("|"));');
          const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
          const executable = writeExecutableShimSync({ dir: root,
            fileName: process.platform === 'win32' ? 'profile.cmd' : 'profile',
            contents: process.platform === 'win32' ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`
              : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`,
          });
          const observed: string[] = [];
          const projected = projectAgentPreflightSessionControlsCatalogEntry({ agentId: 'opencode',
            systemTools: ['profile-env', OPEN_CODE_SYSTEM_TOOL_ID, OPEN_CODE_STABLE_SYSTEM_TOOL_ID, OPEN_CODE_V2_SYSTEM_TOOL_ID]
              .map(id => ({ id, title: 'Profile environment', executableNames: [executable] })),
            preflightSessionControls: probe === 'static' ? OPENCODE_PREFLIGHT_SESSION_CONTROLS : probe === 'acp' ? {
              catalogs: { kind: 'acp', command: { toolId: 'profile-env', args: [] },
                selectAuthentication: ({ probe: input }) => ({
                  methodId: input.nonblankEnvironment?.PROFILE_KEY ? 'profile-auth' : 'missing-auth',
                  metadata: { profileKeyPresent: input.nonblankEnvironment?.PROFILE_KEY === true },
                }),
              },
            } : {
              models: { command: { toolId: 'profile-env', args: [] }, parseOutput: () => [] },
              resolveProbeVariant: input => input.nonblankEnvironment?.PROFILE_MODE ? 'profile-mode' : 'missing-mode',
              probeConfigOptions: async context => {
                expect(context.nonblankEnvironment?.PROFILE_MODE).toBe(true);
                for (let attempt = 0; attempt < 2; attempt += 1) {
                  const result = await context.runDeclaredSystemToolCommand({ toolId: 'profile-env', args: [] });
                  if (result.ok) observed.push(result.stdout);
                }
                return { configOptions: [], source: 'dynamic' };
              },
            }, retirementSignal: new AbortController().signal, isCurrent: () => true,
          });
          const adapter = await projected.getPreflightSessionControlsProbeAdapter?.();
          if (!adapter) throw new Error('Missing projected Profile preflight');
          const catalogEntry = { ...preflightCatalogEntryFixture('opencode', adapter), ...projected };
          const runProbe = (cwd = root) => invokeCliPreflightMethod('opencode', 'probeConfigOptions', {
            cwd, profileId: request.profileId, secretReferenceOverlay: request.secretReferenceOverlay,
          }, { agentCatalogEntry: catalogEntry,
            accountContext: { credentials: request.credentials, accountSettings: request.accountSettings },
            secretSources: request.secretSources,
          }, { machineAdmission: request.machineAdmission, signal: cancellation.signal });
          const pending = runProbe();
          if (probe === 'cancel') { await started; cancellation.abort(); }
          const result = await pending;
          if (probe === 'cancel') {
            expect(result).toMatchObject({ ok: false, error: { code: 'profile-preflight-failed' } });
            expect(acquisitionSignal?.aborted).toBe(true);
            expect(acquisitions).toBe(1);
            expect(observed).toEqual([]);
          } else if (probe === 'static') {
            expect(result).toMatchObject({ ok: true, result: { source: 'static', configOptions: [] } });
            expect(acquisitions).toBe(0);
          } else if (probe === 'acp') {
            expect(result).toMatchObject({ ok: true, result: { source: 'dynamic', configOptions: [] } });
            expect((await readFile(authenticationCapture, 'utf8')).trim().split('\n').map(line => JSON.parse(line))).toEqual([{
              params: { methodId: 'profile-auth', _meta: { profileKeyPresent: true } },
              environment: 'vault-key|vault-key|profile-mode',
            }]);
            expect(acquisitions).toBe(1);
          } else if (role === 'use') {
            expect(result).toMatchObject({ ok: false, error: { code: 'profile-preflight-failed', failureCause: {
              phase: 'client_start', actionCause: { phase: 'capabilities.preflight.profile' },
            } } });
            expect(await runProbe()).toMatchObject({ ok: false, error: { code: 'profile-preflight-failed' } });
            expect(acquisitions).toBe(0);
            expect(observed).toEqual([]);
          } else {
            expect(result).toMatchObject({ ok: true, result: { source: 'dynamic', configOptions: [] } });
            expect(observed).toEqual(['vault-key|vault-key|profile-mode', 'vault-key|vault-key|profile-mode']);
            expect(acquisitions).toBe(1);
            const nextDirectory = await mkdtemp(join(root, 'next-operation-'));
            expect(await runProbe(nextDirectory)).toMatchObject({ ok: true, result: { source: 'dynamic' } });
            expect(acquisitions).toBe(2);
            expect(observed).toHaveLength(4);
          }
        } finally { await rm(root, { recursive: true, force: true }); }
      } else if (role === 'use') {
        await expect(resolveProfileProbeEnvironment(request)).rejects.toMatchObject({ reason: 'reference_forbidden' });
        expect(acquisitions).toBe(0);
      } else {
        await expect(resolveProfileProbeEnvironment(request)).resolves.toMatchObject({ env: { PROFILE_KEY: 'vault-key' } });
        expect(acquisitions).toBe(1);
      }
    } finally { await fixture.dispose(); }
  });
  it('probes the destination Profile row rather than a retained Settings definition', async () => {
    vi.spyOn(axios, 'get').mockImplementation(async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/artifacts') return { status: 200, data: artifactListResponse(String(url), []) };
      if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (path === '/v1/account/authoring-memory/lastUsedProfile') return { status: 200, data: { status: 'absent' } };
      if (path === '/v2/account/settings') return { status: 200, data: { content: null, version: 1 } };
      throw new Error(`Unexpected profile probe HTTP path: ${path}`);
    });
    const request = {
      agentId: 'codex', profileId: 'work', accountSettings: { profiles: [{ v: 2, id: 'work', name: 'Stale',
        extraEnvironmentVariables: [{ name: 'TEAM_FLAG', value: 'stale' }], createdAt: 1, updatedAt: 1 }] },
      credentials: { token: 'token', encryption: null }, processEnv: {},
      profileCatalog: { status: 'ready' as const, source: 'destination' as const, authority: 'active' as const, controlRevision: 1,
        control: { revision: 1, record: { v: 1 as const, phase: 'active' as const, sourceSettingsVersion: 1, migratedLogicalRevision: 1, inventory: [] } },
        referenceGuardRevision: 4, diagnostics: [], records: [{ revision: 4,
        record: { v: 1 as const, id: 'work', enabled: true, promptStack: [], skillSeeds: [], secretBindings: {},
          definition: { kind: 'inline' as const, profile: { v: 2 as const, id: 'work', name: 'Work',
            extraEnvironmentVariables: [{ name: 'TEAM_FLAG', value: 'destination' }],
            defaultPermissionModeByTargetKey: {}, defaultPersistenceModeByTargetKey: {}, compatibilityByTargetKey: {},
            createdAt: 1, updatedAt: 1 } } } }] },
    };
    publishAccountSnapshot(request);
    await expect(resolveProfileProbeEnvironment(request)).resolves.toEqual({ cacheKey: 'work',
      env: { TEAM_FLAG: 'destination', HAPPIER_SESSION_PROFILE_ID: 'work' } });
    await expect(resolveProfileProbeEnvironment({ ...request,
      profileCatalog: { ...request.profileCatalog, records: request.profileCatalog.records.map((row) => ({
        ...row, record: { ...row.record, enabled: false },
      })) },
    })).rejects.toThrow();
  });

  it('materializes a one-launch strict saved-secret reference for an otherwise unbound profile requirement', async () => {
    // Account HTTP transport is the system boundary; profile parsing and secret materialization stay real.
    vi.spyOn(axios, 'get').mockImplementation(async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/artifacts') return { status: 200, data: artifactListResponse(String(url), []) };
      if (path === '/v2/account/settings') return { status: 200, data: { content: null, version: 1 } };
      if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'e2ee', updatedAt: 1 } };
      if (path === '/v1/account/authoring-memory/lastUsedProfile') return { status: 200, data: { status: 'absent' } };
      if (path === '/v1/artifacts') return { status: 200, data: artifactListResponse(String(url), []) };
      throw new Error(`Unexpected account request: ${path}`);
    });
    const recoverySecret = new Uint8Array(32).fill(7);
    const settingsKey = deriveSettingsSecretsKeyV1(deriveAccountMachineKeyFromRecoverySecret(recoverySecret));
    const encryptedValue = encryptSecretStringV1('selected-secret', settingsKey, (length) => new Uint8Array(length).fill(3));
    const request = {
      agentId: 'codex', profileId: 'work',
      profileCatalog: predecessorCatalog,
      accountSettings: {
        profiles: [{ id: 'work', name: 'Work', environmentVariables: [{ name: 'OPENAI_API_KEY', value: '${PROFILE_KEY}' }],
          envVarRequirements: [{ name: 'PROFILE_KEY', kind: 'secret', required: true }],
          compatibilityByTargetKey: { 'agent:codex': true }, defaultEnabled: true, isBuiltIn: false }],
        secrets: [{ id: 'selected-key', name: 'Selected key', kind: 'apiKey', encryptedValue: { _isSecretValue: true, encryptedValue } }],
      },
      credentials: { token: 'token', encryption: { type: 'legacy' as const, secret: recoverySecret } },
      processEnv: { HOME: '/home/alice' },
      secretReferenceOverlay: { v: 1 as const, bindings: { PROFILE_KEY: { ref: 'selected-key' } } },
    };
    publishAccountSnapshot(request);
    await expect(resolveProfileProbeEnvironment(request)).resolves.toEqual({ cacheKey: 'work', env: {
      HAPPIER_SESSION_PROFILE_ID: 'work', OPENAI_API_KEY: 'selected-secret', PROFILE_KEY: 'selected-secret',
    } });
  });

  it('materializes the selected profile variables and Saved Secrets for every probe backend', async () => {
    // The current reader also observes Account mode and authoring memory. Keep
    // those owners real and provide only the exact Home HTTP responses.
    vi.spyOn(axios, 'get').mockImplementation(async (url, options) => {
      expect(options?.headers?.Authorization).toBe('Bearer token');
      const path = new URL(String(url)).pathname;
      if (path === '/v1/artifacts') return { status: 200, data: artifactListResponse(String(url), []) };
      if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'e2ee', updatedAt: 1 } };
      if (path === '/v1/account/authoring-memory/lastUsedProfile') return { status: 200, data: { status: 'absent' } };
      if (path === '/v2/account/settings') return { status: 200, data: { content: null, version: 1 } };
      if (path === '/v1/artifacts') return { status: 200, data: artifactListResponse(String(url), []) };
      throw new Error(`Unexpected profile probe HTTP path: ${path}`);
    });
    const post = vi.spyOn(axios, 'post').mockImplementation(async () => {
      throw new Error('A profile preflight with no legacy authoring memory must not write');
    });
    const recoverySecret = new Uint8Array(32).fill(7);
    const settingsKey = deriveSettingsSecretsKeyV1(
      deriveAccountMachineKeyFromRecoverySecret(recoverySecret),
    );
    const encryptedValue = encryptSecretStringV1(
      'profile-api-key',
      settingsKey,
      (length) => new Uint8Array(length).fill(3),
    );

    const accountSettings = {
        profiles: [{
          id: 'work',
          name: 'Work',
          environmentVariables: [
            { name: 'CODEX_HOME', value: '/profiles/work/codex' },
            { name: 'OPENAI_API_KEY', value: '${PROFILE_OPENAI_API_KEY}' },
          ],
          envVarRequirements: [{ name: 'PROFILE_OPENAI_API_KEY', kind: 'secret', required: true }],
          compatibilityByTargetKey: { 'agent:codex': true },
          defaultEnabled: true,
          isBuiltIn: false,
        }],
        secrets: [{
          id: 'personal-profile-key',
          name: 'Profile API key',
          kind: 'apiKey',
          encryptedValue: { _isSecretValue: true, encryptedValue },
        }],
        secretBindingsByProfileId: {
          work: { PROFILE_OPENAI_API_KEY: 'personal-profile-key' },
        },
      };
    const credentials = {
        token: 'token',
        encryption: { type: 'legacy' as const, secret: recoverySecret },
      };
    const expected = {
      cacheKey: 'work',
      env: {
        CODEX_HOME: '/profiles/work/codex',
        HAPPIER_SESSION_PROFILE_ID: 'work',
        OPENAI_API_KEY: 'profile-api-key',
        PROFILE_OPENAI_API_KEY: 'profile-api-key',
      },
    };

    publishAccountSnapshot({ accountSettings, credentials, profileCatalog: predecessorCatalog });
    for (const agentId of ['codex', 'acme.review/reviewer']) {
      await expect(resolveProfileProbeEnvironment({
        agentId,
        profileId: 'work',
        accountSettings,
        profileCatalog: predecessorCatalog,
        credentials,
        processEnv: { HOME: '/home/alice' },
      })).resolves.toEqual(expected);
    }
    expect(post).not.toHaveBeenCalled();
  });
});
