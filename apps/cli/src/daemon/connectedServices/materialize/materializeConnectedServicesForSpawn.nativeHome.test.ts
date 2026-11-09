import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
import { materializeConnectedServicesForSpawn } from './materializeConnectedServicesForSpawn';
import { resolveConnectedServiceMaterializedRootDir } from './resolveConnectedServiceMaterializedRootDir';
import { resolveConnectedServiceNativeHomeTargetRoot } from './resolveConnectedServiceNativeHomeTarget';

let runtime: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>>;
beforeAll(async () => {
  const contributes = createResolvedContributionRegistry(resolveSelectedBuiltInContributions({
    agentIdentity: { pluginId: 'happier.agent.kimi', localId: 'kimi' },
  }));
  runtime = await createAdmittedPluginRuntimeFixture({
    controller: pluginReloadController,
    runtimeOptions: { contributes, pluginIds: ['happier.agent.kimi'],
      scopedActionRuntime: { credentials: null, actionsSettingsProvider: createActionSettingsProvider() },
    },
  });
});
afterAll(async () => { await runtime?.dispose(); });

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), 'native-home-callback-order-'));
  const nativeHome = join(root, 'native');
  const nativeConfig = '[mcp.client.fixture]\ncommand = "fixture-tool"\n';
  await mkdir(nativeHome);
  await writeFile(join(nativeHome, 'config.toml'), nativeConfig);
  const declaration = resolveQualifiedPurposeDeclarationSnapshotForAgentSpawn({
    agentId: 'kimi', contributions: runtime.registry.contributes,
  })!;
  const scope = declaration.fileMaterializationPurposes[0]!;
  const descriptor = await runtime.registry.contributes.agentDefinitionsById.get('kimi')!.catalogEntry
    .getConnectedServiceStateSharingDescriptor!();
  if (!descriptor?.nativeHome) throw new Error('Native-home declaration missing');
  const leases: Array<{ dispose(): void }> = [];
  const results: Array<NonNullable<Awaited<ReturnType<typeof materializeConnectedServicesForSpawn>>>> = [];
  const launch = async (accountId: string, fail = false) => {
    const fixture = createForegroundPurposeOwnerFixture({
      consumer: scope.purpose.consumer, purpose: scope.purpose.purpose, service: scope.serviceRefs[0]!, accountId,
      // Account storage/materialization is the boundary; home preparation and file publication stay real.
      materializeAccount: async ({ request, existingFiles }) => {
        if (request.kind === 'environment') return { kind: 'environment', env: { HAPPIER_KIMI_ACCESS_TOKEN: 'fake-selected' } };
        if (fail) throw new Error('Credential callback failed');
        return { kind: 'files', files: { 'config.toml': Buffer.from(
          Buffer.from(existingFiles?.['config.toml'] ?? []).toString('utf8') + '\n# selected-account\n',
        ) } };
      },
    });
    const sessionId = `callback-${accountId}-${fail}`;
    leases.push(fixture.owner.activateSessionPurposeBindings({ sessionId, purposes: declaration.purposes, bindings: [fixture.binding] }));
    const result = await materializeConnectedServicesForSpawn({
      agentId: 'kimi', materializationKey: sessionId, purposeBindingSessionId: sessionId,
      activeServerDir: join(root, 'server'), baseDir: join(root, 'materialized'), recordsByServiceId: new Map(),
      connectedAccountsOwner: fixture.owner,
      connectedAccountMaterializationAuthority: { kind: 'qualified', purposeBindings: [fixture.binding], requestAuthPurposeBindings: [] },
      qualifiedPurposeBindingSnapshot: { ...declaration, bindings: [fixture.binding] },
      processEnv: { KIMI_CODE_HOME: nativeHome },
      accountSettings: { connectedServicesProviderStateSharingSettingsV1: { v: 1,
        defaults: { configMode: 'copied', stateMode: 'isolated' }, byAgentId: {}, acknowledgedRisksByAgentId: {},
      } },
    });
    if (!result) throw new Error('Native-home materialization missing');
    results.push(result);
    return result;
  };
  return {
    root, nativeHome, nativeConfig, launch,
    targetHome: (accountId: string) => resolveConnectedServiceNativeHomeTargetRoot({
      agentId: 'kimi', activeServerDir: join(root, 'server'), nativeHome: descriptor.nativeHome!,
      target: { kind: 'account', account: { service: scope.serviceRefs[0]!, accountId } },
    })!,
    async dispose() {
      for (const result of results) await result.cleanupOnExit?.();
      for (const lease of leases) lease.dispose();
      await rm(root, { recursive: true, force: true });
    },
  };
}

it('passes copied native configuration to the selected credential callback before publishing its bytes', async () => {
  const fixture = await createFixture();
  try {
    const result = await fixture.launch('selected');
    expect(await readFile(join(result.env.KIMI_CODE_HOME!, 'config.toml'), 'utf8'))
      .toBe(fixture.nativeConfig + '\n# selected-account\n');
    expect(await readFile(join(fixture.nativeHome, 'config.toml'), 'utf8')).toBe(fixture.nativeConfig);
  } finally { await fixture.dispose(); }
});

it.each([false, true])('cleans copied credentials after callback failure while preserving an existing home (%s)', async existing => {
  const fixture = await createFixture();
  try {
    if (existing) {
      await fixture.launch('selected');
      await writeFile(join(fixture.targetHome('selected'), 'retained-session'), 'retained-history');
    }
    await expect(fixture.launch('selected', true)).rejects.toThrow('Credential callback failed');
    if (existing) {
      expect(await readFile(join(fixture.targetHome('selected'), 'config.toml'), 'utf8'))
        .toBe(fixture.nativeConfig + '\n# selected-account\n');
      expect(await readFile(join(fixture.targetHome('selected'), 'retained-session'), 'utf8')).toBe('retained-history');
    } else await expect(lstat(fixture.targetHome('selected'))).rejects.toMatchObject({ code: 'ENOENT' });
    const runRoot = resolveConnectedServiceMaterializedRootDir({ baseDir: join(fixture.root, 'materialized'),
      agentId: 'kimi', materializationKey: 'callback-selected-true' });
    await expect(lstat(runRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await fixture.dispose(); }
});
