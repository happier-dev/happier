import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { createForegroundPurposeOwnerFixture } from '@/daemon/agentRuntime/prepareForegroundAdmission.connectedServices.testkit';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { resolveSelectedBuiltInContributions } from '@/plugins/projection/registry/selected';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { resolveQualifiedPurposeDeclarationSnapshotForAgentSpawn } from '../requestAuth/prepareConnectedAccountRequestAuthForSpawn';
import { readConnectedServiceStateSharingManifest } from '../stateSharing/connectedServiceStateSharingManifest';
import { reconcileTeamCredentialNativeHomeCredentials } from '../stateSharing/reconcileTeamCredentialNativeHomeCredentials';
import { materializeConnectedServicesForSpawn } from './materializeConnectedServicesForSpawn';

let runtime: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>>;
beforeAll(async () => {
  const contributes = createResolvedContributionRegistry(resolveSelectedBuiltInContributions({
    agentIdentity: { pluginId: 'happier.agent.codex', localId: 'codex' },
  }));
  runtime = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
    runtimeOptions: { contributes, pluginIds: ['happier.agent.codex'],
      scopedActionRuntime: { credentials: null, actionsSettingsProvider: createActionSettingsProvider() } },
  });
});
afterAll(async () => { await runtime?.dispose(); });

it('removes untouched Team files on partial personal admission and preserves personal auth after withdrawal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'team-native-home-replacement-'));
  const results: NonNullable<Awaited<ReturnType<typeof materializeConnectedServicesForSpawn>>>[] = [];
  let lease: { dispose(): void } | undefined;
  try {
    const declaration = resolveQualifiedPurposeDeclarationSnapshotForAgentSpawn({
      agentId: 'codex', contributions: runtime.registry.contributes,
    })!;
    const scope = declaration.fileMaterializationPurposes[0]!;
    const account = { service: scope.serviceRefs[0]!, accountId: 'replacement-account' };
    let personal = false;
    const selected = createForegroundPurposeOwnerFixture({
      consumer: scope.purpose.consumer, purpose: scope.purpose.purpose, ...account,
      // Credential acquisition is the boundary; admission, home writes and withdrawal stay real.
      materializeAccount: async ({ request }) => request.kind === 'environment'
        ? { kind: 'environment', env: {} }
        : { kind: 'files', files: personal
          ? { 'auth.json': Buffer.from('synthetic-personal-auth') }
          : { 'auth.json': Buffer.from('synthetic-team-auth'), accounts: Buffer.from('synthetic-team-accounts') } },
    });
    const sessionId = 'replacement-session';
    lease = selected.owner.activateSessionPurposeBindings({ sessionId, purposes: declaration.purposes, bindings: [selected.binding] });
    const params = {
      agentId: 'codex', materializationKey: sessionId, purposeBindingSessionId: sessionId,
      activeServerDir: join(root, 'server'), baseDir: join(root, 'materialized'), recordsByServiceId: new Map(),
      connectedAccountsOwner: selected.owner,
      connectedAccountMaterializationAuthority: { kind: 'qualified', purposeBindings: [selected.binding], requestAuthPurposeBindings: [] },
      qualifiedPurposeBindingSnapshot: { ...declaration, bindings: [selected.binding], directMaterialOrigins: [{
        teamId: 'replacement-team', resourceId: 'replacement-share', purpose: scope.purpose, disclosedMember: account,
      }] },
      processEnv: { CODEX_HOME: join(root, 'personal') },
      accountSettings: { connectedServicesProviderStateSharingSettingsV1: {
        v: 1, defaults: { configMode: 'isolated', stateMode: 'isolated' }, byAgentId: {}, acknowledgedRisksByAgentId: {},
      } },
    } satisfies Parameters<typeof materializeConnectedServicesForSpawn>[0];
    const team = await materializeConnectedServicesForSpawn(params);
    if (!team?.env.CODEX_HOME) throw new Error('Missing Codex home');
    results.push(team);
    const home = team.env.CODEX_HOME;
    expect(await readFile(join(home, 'accounts'), 'utf8')).toBe('synthetic-team-accounts');
    expect((await readConnectedServiceStateSharingManifest(home)).teamCredentialDeliveries).toMatchObject([
      { credentialPaths: ['auth.json', 'accounts'] },
    ]);
    await writeFile(join(home, 'rollout.jsonl'), 'retained Session');
    personal = true;
    const replacement = await materializeConnectedServicesForSpawn({ ...params,
      qualifiedPurposeBindingSnapshot: { ...params.qualifiedPurposeBindingSnapshot, directMaterialOrigins: [] },
    });
    if (!replacement) throw new Error('Missing personal admission');
    results.push(replacement);
    expect(replacement.env.CODEX_HOME).toBe(home);
    expect((await readConnectedServiceStateSharingManifest(home)).teamCredentialDeliveries).toEqual([]);
    await reconcileTeamCredentialNativeHomeCredentials({ baseDir: params.baseDir,
      homeDomainAction: async () => ({ resources: [], nextCursor: null }),
    });
    await expect(readFile(join(home, 'accounts'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(home, 'auth.json'), 'utf8')).toBe('synthetic-personal-auth');
    expect(await readFile(join(home, 'rollout.jsonl'), 'utf8')).toBe('retained Session');
  } finally {
    for (const result of results) await result.cleanupOnExit?.();
    lease?.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
