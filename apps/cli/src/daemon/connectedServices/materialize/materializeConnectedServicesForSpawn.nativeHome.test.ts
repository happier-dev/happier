import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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

describe('native credential callbacks', () => {
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
  const launch = async (accountId: string, fail = false, mutateExisting = false) => {
    const fixture = createForegroundPurposeOwnerFixture({
      consumer: scope.purpose.consumer, purpose: scope.purpose.purpose, service: scope.serviceRefs[0]!, accountId,
      // Account storage/materialization is the boundary; home preparation and file publication stay real.
      materializeAccount: async ({ request, existingFiles }) => {
        if (request.kind === 'environment') return { kind: 'environment', env: { HAPPIER_KIMI_ACCESS_TOKEN: 'fake-selected' } };
        if (fail) throw new Error('Credential callback failed');
        if (mutateExisting) {
          const contents = existingFiles?.['config.toml'];
          if (!contents?.byteLength) throw new Error('Prepared native configuration missing');
          contents[0] = 35;
          return { kind: 'files', files: { 'config.toml': contents } };
        }
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

it('publishes credential callbacks that merge prepared bytes in place', async () => {
  const fixture = await createFixture();
  try {
    await chmod(join(fixture.nativeHome, 'config.toml'), 0o600);
    await fixture.launch('selected', false, true);
    expect(await readFile(join(fixture.targetHome('selected'), 'config.toml'), 'utf8'))
      .toBe('#' + fixture.nativeConfig.slice(1));
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

});

describe('fileless native home', () => {
  let runtimeFixture: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>>;
  beforeAll(async () => {
    const contributes = createResolvedContributionRegistry(resolveSelectedBuiltInContributions({
      agentIdentity: { pluginId: 'happier.agent.ohmypi', localId: 'ohmypi' },
    }));
    runtimeFixture = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
      runtimeOptions: { contributes, pluginIds: ['happier.agent.ohmypi'],
        scopedActionRuntime: { credentials: null, actionsSettingsProvider: createActionSettingsProvider() } },
    });
  });
  afterAll(async () => { await runtimeFixture?.dispose(); });

it.each([
  ['openai', undefined], ['openai', 'probe'], ['gemini', undefined],
] as const)('prepares the declared fileless native home for a selected %s Account (%s)', async (purpose, probePurpose) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-fileless-native-home-'));
  let result: Awaited<ReturnType<typeof materializeConnectedServicesForSpawn>> = null;
  let bindingLease: { dispose(): void } | undefined;
  try {
    const native = join(root, 'native');
    await mkdir(native);
    await writeFile(join(native, 'config.yml'), 'native: preserved\n');
    await writeFile(join(native, 'models.yml'), 'native-models');
    await writeFile(join(native, 'agent.db'), 'native-login-and-settings');
    const declaration = resolveQualifiedPurposeDeclarationSnapshotForAgentSpawn({
      agentId: 'ohMyPi', contributions: runtimeFixture!.registry.contributes,
    })!;
    const scope = declaration.environmentUses!.find(use => use.purpose.purpose === purpose)!;
    const fixture = createForegroundPurposeOwnerFixture({
      consumer: scope.purpose.consumer, service: scope.serviceRefs[0]!, purpose,
      // Account storage is the boundary; the declared native home and publication stay real.
      materializeAccount: async ({ request }) => request.kind === 'environment'
        ? { kind: 'environment', env: { [scope.environmentKey]: 'selected-key' } }
        : { kind: 'files', files: {} },
    });
    const sessionId = `fileless-${purpose}-${probePurpose ?? 'session'}`;
    bindingLease = fixture.owner.activateSessionPurposeBindings({
      sessionId, purposes: declaration.purposes, bindings: [fixture.binding],
    });
    const params = {
      agentId: 'ohMyPi', materializationKey: sessionId, purposeBindingSessionId: sessionId,
      activeServerDir: join(root, 'server'), baseDir: join(root, 'materialized'), recordsByServiceId: new Map(),
      connectedAccountsOwner: fixture.owner,
      connectedAccountMaterializationAuthority: { kind: 'qualified' as const, purposeBindings: [fixture.binding], requestAuthPurposeBindings: [] },
      qualifiedPurposeBindingSnapshot: { ...declaration, bindings: [fixture.binding] },
      processEnv: { PI_CODING_AGENT_DIR: native }, probePurpose,
      accountSettings: { connectedServicesProviderStateSharingSettingsV1: {
        v: 1, defaults: { configMode: 'isolated', stateMode: 'isolated' }, byAgentId: {}, acknowledgedRisksByAgentId: {},
      } },
    } satisfies Parameters<typeof materializeConnectedServicesForSpawn>[0];
    result = await materializeConnectedServicesForSpawn(params);
    expect(result?.env.PI_CODING_AGENT_DIR).toBeTruthy();
    expect(result?.env.PI_CODING_AGENT_DIR).not.toBe(native);
    expect((await lstat(result!.env.PI_CODING_AGENT_DIR!)).isDirectory()).toBe(true);
    expect(result?.env[scope.environmentKey]).toBe('selected-key');
    expect(await readFile(join(result!.env.PI_CODING_AGENT_DIR!, 'config.yml'), 'utf8')).toBe('native: preserved\n');
    await expect(lstat(join(result!.env.PI_CODING_AGENT_DIR!, 'agent.db'))).rejects.toMatchObject({ code: 'ENOENT' });
    await writeFile(join(result!.env.PI_CODING_AGENT_DIR!, 'models.yml'), '{"providers":{}}');
    expect(await readFile(join(native, 'models.yml'), 'utf8')).toBe('native-models');
    expect(await readFile(join(native, 'config.yml'), 'utf8')).toBe('native: preserved\n');
    const unbound = await materializeConnectedServicesForSpawn({ ...params,
      materializationKey: `${sessionId}-native`,
      connectedAccountMaterializationAuthority: { kind: 'qualified', purposeBindings: [], requestAuthPurposeBindings: [] },
      qualifiedPurposeBindingSnapshot: { ...declaration, bindings: [] },
    });
    try { expect(unbound?.env.PI_CODING_AGENT_DIR).toBeUndefined(); }
    finally { await unbound?.cleanupOnExit?.(); }
  } finally {
    bindingLease?.dispose();
    await result?.cleanupOnExit?.();
    await rm(root, { recursive: true, force: true });
  }
});

});
