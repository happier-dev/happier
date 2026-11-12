import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConnectedAccountRuntime } from '@happier-dev/plugin-sdk/connected-accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { museConnectedAccountRuntime } from '../../../../../../packages/plugins/muse/src/connectedAccounts/museAccountRuntime';
import { createForegroundPurposeOwnerFixture } from '@/daemon/agentRuntime/prepareForegroundAdmission.connectedServices.testkit';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { resolveSelectedBuiltInContributions } from '@/plugins/projection/registry/selected';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { resolveQualifiedPurposeDeclarationSnapshotForAgentSpawn } from '../requestAuth/prepareConnectedAccountRequestAuthForSpawn';
import { materializeConnectedServicesForSpawn } from './materializeConnectedServicesForSpawn';
import { resolveConnectedServiceMaterializedRootDir } from './resolveConnectedServiceMaterializedRootDir';
import { readConnectedServiceStateSharingManifest } from '../stateSharing/connectedServiceStateSharingManifest';
import { reconcileTeamCredentialNativeHomeCredentials } from '../stateSharing/reconcileTeamCredentialNativeHomeCredentials';

describe('Muse access-only native home', () => {
  let runtime: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>>;
  beforeAll(async () => {
    const contributes = createResolvedContributionRegistry(resolveSelectedBuiltInContributions({
      agentIdentity: { pluginId: 'happier.agent.muse', localId: 'muse' },
    }));
    runtime = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
      runtimeOptions: { contributes, pluginIds: ['happier.agent.muse'],
        scopedActionRuntime: { credentials: null, actionsSettingsProvider: createActionSettingsProvider() } },
    });
  });
  afterAll(async () => { await runtime?.dispose(); });

  it('launches in an isolated native home without inference or refresh credentials and refuses the next launch after expiry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'muse-access-only-native-home-'));
    let result: Awaited<ReturnType<typeof materializeConnectedServicesForSpawn>> = null;
    let lease: { dispose(): void } | undefined;
    const replacements: NonNullable<Awaited<ReturnType<typeof materializeConnectedServicesForSpawn>>>[] = [];
    try {
      const personalHome = join(root, 'personal-config');
      const personalAuth = JSON.stringify({ schema_version: 1, providers: { meta: {
        access_token: 'synthetic-personal-access', api_key: 'synthetic-personal-inference',
      } } });
      await mkdir(join(personalHome, 'muse'), { recursive: true });
      await writeFile(join(personalHome, 'muse', 'auth.json'), personalAuth);
      const declaration = resolveQualifiedPurposeDeclarationSnapshotForAgentSpawn({
        agentId: 'muse', contributions: runtime.registry.contributes,
      })!;
      const scope = declaration.fileMaterializationPurposes[0]!;
      const expiry = Date.now() + 60_000;
      const credentials = new Map<string, string>(Object.entries({
        credentialMode: 'native', accountToken: 'synthetic-member-access', expiresAtMs: String(expiry),
        nativeMechanism: '"oauth"', nativeExpiresAt: String(Math.floor(expiry / 1000)),
        nativeApiBaseUrl: 'https://api.meta.ai/v1', nativeObtainedVia: 'device_code',
      }));
      const account = { service: scope.serviceRefs[0]!, accountId: 'access-only-team-account' };
      const selected = createForegroundPurposeOwnerFixture({
        consumer: scope.purpose.consumer, purpose: scope.purpose.purpose, service: account.service, accountId: account.accountId,
        // Only Account storage is a boundary; admission, Muse materialization and native-home publication stay real.
        materializeAccount: async ({ request, existingFiles, signal }) => {
          const context: Parameters<ConnectedAccountRuntime['materialize']>[1] = {
            account, plugin: { id: account.service.pluginId, version: '0.0.0' },
            contribution: { id: account.service.localId, qualifiedId: `${account.service.pluginId}/${account.service.localId}` },
            surface: 'background', invokedAtMs: 0, signal, services: createUnavailablePluginServices(),
            credentials: { async get(key) { return credentials.get(key) ?? null; } },
            configuration: { target: { kind: 'account', account, modeId: 'device' }, revision: 'access-only-fixture',
              values: {}, async getSecret() { return null; } },
          };
          return museConnectedAccountRuntime.materialize(request, context, { existingFiles, signal });
        },
      });
      const sessionId = 'muse-access-only-session';
      lease = selected.owner.activateSessionPurposeBindings({ sessionId, purposes: declaration.purposes, bindings: [selected.binding] });
      const params = {
        agentId: 'muse', materializationKey: sessionId, purposeBindingSessionId: sessionId,
        activeServerDir: join(root, 'server'), baseDir: join(root, 'materialized'), recordsByServiceId: new Map(),
        connectedAccountsOwner: selected.owner,
        connectedAccountMaterializationAuthority: { kind: 'qualified', purposeBindings: [selected.binding], requestAuthPurposeBindings: [] },
        qualifiedPurposeBindingSnapshot: { ...declaration, bindings: [selected.binding], directMaterialOrigins: [{
          teamId: 'member-team', resourceId: 'member-share', purpose: scope.purpose, disclosedMember: account,
        }] },
        processEnv: { XDG_CONFIG_HOME: personalHome },
        accountSettings: { connectedServicesProviderStateSharingSettingsV1: {
          v: 1, defaults: { configMode: 'isolated', stateMode: 'isolated' }, byAgentId: {}, acknowledgedRisksByAgentId: {},
        } },
      } satisfies Parameters<typeof materializeConnectedServicesForSpawn>[0];
      result = await materializeConnectedServicesForSpawn(params);
      const targetHome = resolveConnectedServiceMaterializedRootDir({
        agentId: 'muse', baseDir: params.baseDir, materializationKey: sessionId,
      });
      expect(result?.env.XDG_CONFIG_HOME).toBe(targetHome);
      expect(result?.env.XDG_CONFIG_HOME).not.toBe(personalHome);
      expect(result?.env).not.toHaveProperty('MUSE_CODE_CREDENTIAL');
      expect(result?.env).not.toHaveProperty('META_API_KEY');
      const auth = JSON.parse(await readFile(join(result!.env.XDG_CONFIG_HOME!, 'muse', 'auth.json'), 'utf8'));
      expect(auth).toEqual({ schema_version: 1, providers: { meta: {
        access_token: 'synthetic-member-access', mechanism: 'oauth', expires_at: Math.floor(expiry / 1000),
        api_base_url: 'https://api.meta.ai/v1', obtained_via: 'device_code',
      } } });
      expect((await readConnectedServiceStateSharingManifest(targetHome)).teamCredentialDeliveries).toEqual([{
        teamId: 'member-team', resourceId: 'member-share', credentialPaths: ['muse/auth.json'],
      }]);
      expect(auth.providers.meta).not.toHaveProperty('api_key');
      expect(auth.providers.meta).not.toHaveProperty('refresh_token');
      expect(await readFile(join(personalHome, 'muse', 'auth.json'), 'utf8')).toBe(personalAuth);

      // The retained path is reused by a later admission. Withdrawing share A
      // must leave share B's current credential, then a personal selection, alone.
      const replacement = await materializeConnectedServicesForSpawn({ ...params,
        qualifiedPurposeBindingSnapshot: { ...params.qualifiedPurposeBindingSnapshot,
          directMaterialOrigins: [{ ...params.qualifiedPurposeBindingSnapshot.directMaterialOrigins[0]!, resourceId: 'replacement-share' }],
        },
      });
      if (replacement) replacements.push(replacement);
      await reconcileTeamCredentialNativeHomeCredentials({ baseDir: params.baseDir, homeDomainAction: async request => {
        expect(request.input).toMatchObject({ resourceId: 'replacement-share' });
        return { resources: [{ id: 'replacement-share', teamId: 'member-team', sourceOwnerDisplayName: null,
          displayName: 'Replacement Muse', resourceRevision: 1, readiness: { kind: 'available' }, recoveryAction: null,
          mayBroker: false, mayReceiveDirect: true, directMaterialState: 'current', sessionUsePolicy: null,
          providerModels: [], connectedServiceSelections: [], sourcePresentation: { kind: 'connected_service', service: account.service },
        }], nextCursor: null };
      } });
      expect((await readConnectedServiceStateSharingManifest(targetHome)).teamCredentialDeliveries?.map(row => row.resourceId))
        .toEqual(['replacement-share']);
      expect(await readFile(join(targetHome, 'muse/auth.json'), 'utf8')).toContain('synthetic-member-access');
      const personal = await materializeConnectedServicesForSpawn({ ...params,
        qualifiedPurposeBindingSnapshot: { ...params.qualifiedPurposeBindingSnapshot, directMaterialOrigins: [] },
      });
      if (personal) replacements.push(personal);
      await reconcileTeamCredentialNativeHomeCredentials({ baseDir: params.baseDir, homeDomainAction: async () => {
        throw new Error('Personal credentials do not need a Team entitlement read');
      } });
      expect((await readConnectedServiceStateSharingManifest(targetHome)).teamCredentialDeliveries).toBeUndefined();
      expect(await readFile(join(targetHome, 'muse/auth.json'), 'utf8')).toContain('synthetic-member-access');

      credentials.set('expiresAtMs', String(Date.now() - 1));
      await expect(materializeConnectedServicesForSpawn({ ...params, materializationKey: `${sessionId}-expired` }))
        .rejects.toMatchObject({ code: 'plugin_connected_account_credentials_unavailable' });
      expect(await readFile(join(personalHome, 'muse', 'auth.json'), 'utf8')).toBe(personalAuth);
    } finally {
      lease?.dispose();
      await result?.cleanupOnExit?.();
      for (const replacement of replacements) await replacement.cleanupOnExit?.();
      await rm(root, { recursive: true, force: true });
    }
  });
});
