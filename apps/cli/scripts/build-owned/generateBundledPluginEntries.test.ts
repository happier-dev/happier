import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { runInNewContext } from 'node:vm';
import { ModuleKind, transpileModule } from 'typescript';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { INTERNAL_CLAUDE_EVENT_TYPES } from '../../../../packages/plugins/claude/src/agent/transcripts/internalEventTypes';
import * as piDefinition from '../../../../packages/plugins/pi/src/agent/definition';
import * as codexDefinition from '../../../../packages/plugins/codex/src/agent/definition';
import * as claudeDefinition from '../../../../packages/plugins/claude/src/agent/definition';
import * as ohMyPiDefinition from '../../../../packages/plugins/ohmypi/src/agent/definition';
import { AGENT_DEFINITION as CUSTOM_ACP_DEFINITION } from '../../../../packages/plugins/custom-acp/src/agent/definition';
import { PLUGIN_MANIFEST as CUSTOM_ACP_MANIFEST } from '../../../../packages/plugins/custom-acp/src/manifest';
import { collectBundledFirstPartyVoiceProjectionSources, collectBundledPluginUiTranslations, reconcileBundledPluginInstalledRuntime, readExternalSessionSourceDeclaration, renderRetainedCliBundledPluginImplementationEntriesTs, resolveGeneratorPackagedRuntimePreparation, selectCanonicalRuntimeWorkspacePackageRoots, publishBundledPluginSemanticProjection, readInheritedBundledPluginFailures } from './generateBundledPluginEntries.ts';
import { renderBundledAgentDefinitionsTs } from './bundledPlugins/agentFacts.ts';
import { renderBundledPluginTranslationsTs } from './bundledPlugins/agentUi.ts';
import { renderBundledVoiceEntriesTs, renderBundledVoiceRuntimeEntriesTs } from './bundledPlugins/voice.ts';
import { readBundledAgentNativeHomeEnvironmentKeys } from '../../../stack/scripts/utils/env/scrub_env.mjs';
import { readAgentNativeHomeEnvironmentKeys } from '../../src/plugins/authoring/agentNativeHomeEnvironmentKeys';
import { renderGeneratedExternalSessionSourcesTs } from './bundledPlugins/protocol.ts';
import { ingestPluginManifestV2 } from '@happier-dev/protocol/plugins/manifest';
import { parseGeneratorCliArgs } from './bundledPlugins/options.ts';
import { withWorkspaceBundleLock } from '../../../../packages/cli-common/workspaceBundleLock.mjs';
import { readBundledPluginPublicationFailures, writeBundledPluginPublicationFailures } from '../../../../scripts/workspaces/bundledPluginPublicationFailure.mjs';
import { requiresBundledPackagedRuntime } from './bundledPackagedRuntimeEligibility.ts';
import { createPackageLayoutSandbox, writeBundledPluginSourceInputs, writeCliBundledHostPackage, writeWorkspacePackageFixture } from '../__tests__/testkit/packageLayoutSandbox';
import { prepareBundledWorkspaceDependenciesForCli } from '../buildSharedDeps.mjs';
import { ensureWorkspacePackagesBuiltByName } from '../../../../scripts/workspaces/ensureWorkspacePackagesBuilt.mjs';
import { BUNDLED_AGENT_DEFINITIONS_BY_ID } from '../../../../packages/agents/src/generated/bundledAgentDefinitions';
import { AGENT_IDS, BUNDLED_AGENT_CONTRIBUTION_IDENTITIES } from '../../../../packages/agents/src/generated/agentIds';
import { collectBundledAgentContributionIdentities, importPluginAuthorRuntimeModules, main, runRuntimeConsumedAgentFactsPrivatePhase } from './generateBundledPluginEntries.ts';
import { renderAgentIdsTs } from './bundledPlugins/agentFacts.ts';
import { BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS } from '../../src/plugins/projection/registry/sources/generatedBundledPluginManifests';
import { collectBuiltInLegacyConnectedAccountCompatibility } from './generateBundledPluginEntries.ts';
import { ConnectedServiceIdSchema } from '../../../../packages/protocol/src/connect/connectedServiceBindings.ts';
import { BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY } from '../../../../packages/plugins/antigravity/src/connectedAccounts/builtInLegacyCompatibility.ts';
import type { BundledPluginPackage } from './bundledPlugins/projectionFacts.ts';

const generatorSource = readFileSync(new URL('./generateBundledPluginEntries.ts', import.meta.url), 'utf8');
const registryRendererSource = readFileSync(new URL('./bundledPlugins/registry.ts', import.meta.url), 'utf8');
const voiceRendererSource = readFileSync(new URL('./bundledPlugins/voice.ts', import.meta.url), 'utf8');

function sourceBetween(startMarker: string, endMarker: string, source = generatorSource): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  if (start < 0 || end < 0) {
    throw new Error(`Missing generator source range ${startMarker}…${endMarker}`);
  }
  return source.slice(start, end);
}

describe('built-in legacy Connected Account compatibility', () => {
  async function readAntigravityPackage(): Promise<BundledPluginPackage> {
    const source = await importPluginAuthorRuntimeModules(async sourceImport =>
      await sourceImport(new URL('../../../../packages/plugins/antigravity/src/manifest.ts', import.meta.url).href,
        import.meta.url)) as typeof import('../../../../packages/plugins/antigravity/src/manifest.ts');
    const ingestion = ingestPluginManifestV2(source.PLUGIN_MANIFEST);
    if (!ingestion.ok) throw new Error(JSON.stringify(ingestion.diagnostics));
    return {
      pluginPackageId: 'antigravity', pluginId: ingestion.manifest.id,
      packageName: '@happier-dev/plugins-antigravity', packageVersion: '0.0.0',
      manifest: ingestion.manifest,
      builtInLegacyConnectedAccountCompatibility: BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY,
    };
  }

  it('publishes real Antigravity storage ingress without expanding the closed peer vocabulary', async () => {
    const plugin = await readAntigravityPackage();
    const { repoRoot, cleanup } = createPackageLayoutSandbox('happier-legacy-storage-ingress-');
    try {
      const mapping = collectBuiltInLegacyConnectedAccountCompatibility(repoRoot, [plugin], {
        protocol: { ConnectedServiceIdSchema },
      });
      expect(ConnectedServiceIdSchema.safeParse('antigravity').success).toBe(false);
      expect(mapping).toEqual([{
        legacyServiceId: 'antigravity',
        service: { pluginId: 'happier.agent.antigravity', localId: 'antigravity-account' },
        peerOperations: { exactV0_2_1: [], revisionedV2V3: [] },
        exactV0_2_1ReaderQuotaProjection: false,
        defaultAuthenticationModeId: 'oauth-personal',
        authenticationModeByCredentialKind: { oauth: 'oauth-personal' },
        unsupportedAuthenticationModeByCredentialKind: { token: 'legacy-token-unsupported' },
      }]);
    } finally { cleanup(); }
  });

  it('keeps storage-only declarations behind peer, ownership and authentication guards', async () => {
    const plugin = await readAntigravityPackage();
    const { repoRoot, cleanup } = createPackageLayoutSandbox('happier-legacy-storage-guards-');
    const source = BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY[0];
    const collect = (packages: readonly BundledPluginPackage[]) =>
      collectBuiltInLegacyConnectedAccountCompatibility(repoRoot, packages, { protocol: { ConnectedServiceIdSchema } });
    try {
      const invalidSources = [
        { ...source, peerOperations: { exactV0_2_1: ['account_list'] as const, revisionedV2V3: [] } },
        { ...source, peerOperations: { exactV0_2_1: [], revisionedV2V3: ['credential_read'] as const } },
        { ...source, exactV0_2_1ReaderQuotaProjection: true },
        { ...source, serviceLocalId: 'missing-descriptor' },
        { ...source, defaultAuthenticationModeId: 'undeclared-mode' },
        { ...source, unsupportedAuthenticationModeByCredentialKind: { token: 'oauth-personal' } },
      ];
      for (const invalid of invalidSources) {
        expect(() => collect([{ ...plugin, builtInLegacyConnectedAccountCompatibility: [invalid] }])).toThrow();
      }
      expect(() => collect([plugin, { ...plugin }])).toThrow(/ambiguous/u);
      const bindingsPath = join(repoRoot, 'packages/protocol/src/connect/connectedServiceBindings.ts');
      mkdirSync(dirname(bindingsPath), { recursive: true });
      writeFileSync(bindingsPath, '');
      expect(() => collect([plugin])).toThrow(/Missing built-in legacy/u);
    } finally { cleanup(); }
  });
});

describe('generated output ownership', () => {
  it('projects a catalog-driven Agent without inventing native CLI metadata', async () => {
    const { repoRoot, happyCliDir, cleanup } = createPackageLayoutSandbox('happier-no-native-cli-');
    const packageRoot = writeBundledPluginSourceInputs({ repoRoot, pluginId: 'custom-acp' });
    writeCliBundledHostPackage({ happyCliDir, bundledDependencies: ['@happier-dev/plugins-custom-acp'] });
    const projectionPath = join(happyCliDir, 'src/plugins/projection/registry/sources/generatedBundledPluginManifests.ts');
    mkdirSync(dirname(projectionPath), { recursive: true });
    writeFileSync(projectionPath, `export const BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS = ${JSON.stringify([{
      pluginId: CUSTOM_ACP_MANIFEST.id, manifest: CUSTOM_ACP_MANIFEST,
      sourceSpec: { locator: '@happier-dev/plugins-custom-acp' },
    }])};`);
    mkdirSync(join(packageRoot, 'src/agent'), { recursive: true });
    writeFileSync(join(packageRoot, 'src/agent/definition.ts'), `export const AGENT_DEFINITION = ${JSON.stringify(CUSTOM_ACP_DEFINITION)};`);
    writeFileSync(join(packageRoot, 'src/manifest.ts'), `export const PLUGIN_MANIFEST = ${JSON.stringify(CUSTOM_ACP_MANIFEST)};`);
    try {
      await withWorkspaceBundleLock(async lease => {
        await runRuntimeConsumedAgentFactsPrivatePhase(repoRoot, lease);
      }, { lockPath: join(repoRoot, 'publication.lock') });
      const exports: Record<string, unknown> = {};
      runInNewContext(transpileModule(readFileSync(join(repoRoot, 'packages/agents/src/generated/bundledAgentDefinitions.ts'), 'utf8'),
        { compilerOptions: { module: ModuleKind.CommonJS } }).outputText, { exports });
      expect(exports.BUNDLED_AGENT_DEFINITIONS_BY_ID).toMatchObject({
        'custom-acp': { core: { id: 'custom-acp' } },
      });
      expect(exports.BUNDLED_AGENT_DEFINITIONS_BY_ID).not.toHaveProperty('custom-acp.cli');
    } finally { cleanup(); }
  });

  it('loads public SDK source facts through the author runtime without compiler declaration aliases', async () => {
    const { repoRoot, cleanup } = createPackageLayoutSandbox('happier-author-source-exports-');
    const entryPath = join(repoRoot, 'author-entry.ts');
    writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ name: 'author-source-fixture', type: 'module' }));
    writeFileSync(entryPath, [
      "import { ANTIGRAVITY_OAUTH_PROFILE } from '@happier-dev/plugin-sdk/first-party/connected-accounts';",
      "import { expandHomeDirPath } from '@/utils/path/expandHomeDirPath';",
      'export const PROFILE = ANTIGRAVITY_OAUTH_PROFILE;',
      "export const HOME_PATH = expandHomeDirPath('~/happier-loader-fixture');",
      '',
    ].join('\n'));
    try {
      const loaded = await importPluginAuthorRuntimeModules(async sourceImport => {
        const source = await sourceImport(new URL(
          '../../../../packages/plugin-sdk/src/first-party/connected-accounts/index.ts',
          import.meta.url,
        ).href, import.meta.url) as Readonly<{ ANTIGRAVITY_OAUTH_PROFILE: Readonly<{ callbackUrl: string }> }>;
        const entry = await sourceImport(pathToFileURL(entryPath).href, import.meta.url) as Readonly<{
          PROFILE: Readonly<{ callbackUrl: string }> | undefined; HOME_PATH: string;
        }>;
        return { source, entry };
      });
      expect(loaded.source.ANTIGRAVITY_OAUTH_PROFILE.callbackUrl).toBe('https://antigravity.google/oauth-callback');
      // Identity also discriminates a refreshed dist copy with equal values:
      // publication must use the same source graph, not compiler-only aliases.
      expect(loaded.entry.PROFILE).toBe(loaded.source.ANTIGRAVITY_OAUTH_PROFILE);
      expect(loaded.entry.HOME_PATH).toBe(join(homedir(), 'happier-loader-fixture'));
    } finally { cleanup(); }
  }, 30_000);

  it('rejects failed full preparation before replacing any Agent projection', async () => {
    const { repoRoot, happyCliDir, cleanup } = createPackageLayoutSandbox('happier-agent-projection-coherence-');
    // Authored membership is the input under test; generated locators may already
    // be incomplete after the defect this regression reproduces.
    const packageName = '@happier-dev/plugins-antigravity';
    const packageRoot = writeBundledPluginSourceInputs({ repoRoot, pluginId: 'antigravity' });
    writeCliBundledHostPackage({ happyCliDir, bundledDependencies: [packageName] });
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: packageName, version: '0.0.0' }));
    writeFileSync(join(packageRoot, 'src/manifest.ts'), 'throw new Error("Antigravity source preparation failed");');
    mkdirSync(join(packageRoot, 'src/agent'), { recursive: true });
    writeFileSync(join(packageRoot, 'src/agent/definition.ts'), `export const AGENT_DEFINITION = ${JSON.stringify(BUNDLED_AGENT_DEFINITIONS_BY_ID.antigravity)};`);
    const projections = [
      'apps/cli/src/plugins/projection/registry/sources/generatedBundledPluginManifests.ts',
      'packages/agents/src/generated/agentIds.ts',
      'packages/agents/src/generated/bundledAgentDefinitions.ts',
      'apps/ui/sources/agents/registry/generatedBundledPluginEntries.ts',
    ];
    const before = new Map(projections.map((relativePath) => [
      relativePath, readFileSync(new URL(`../../../../${relativePath}`, import.meta.url), 'utf8'),
    ]));
    for (const [relativePath, bytes] of before) {
      const outPath = join(repoRoot, relativePath);
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, bytes);
    }
    try {
      await expect(main(['--root', repoRoot, '--mode', 'write']))
        .rejects.toThrow(/Antigravity source preparation failed/u);
      for (const [relativePath, bytes] of before) {
        expect(readFileSync(join(repoRoot, relativePath), 'utf8'), relativePath).toBe(bytes);
      }
    } finally { cleanup(); }
  });

  it('publishes core and session-mode facts for every catalog Agent despite an unavailable executable manifest', async () => {
    const { repoRoot, happyCliDir, cleanup } = createPackageLayoutSandbox('happier-complete-agent-facts-');
    const locators = BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS.filter((entry) => entry.manifest.contributes.agents?.length);
    writeCliBundledHostPackage({ happyCliDir, bundledDependencies: locators.map((entry) => entry.sourceSpec.locator) });
    const projectionPath = join(happyCliDir, 'src/plugins/projection/registry/sources/generatedBundledPluginManifests.ts');
    mkdirSync(dirname(projectionPath), { recursive: true });
    writeFileSync(projectionPath, `export const BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS = ${JSON.stringify(locators)};`);
    for (const locator of locators) {
      const packageId = locator.sourceSpec.locator.replace('@happier-dev/plugins-', '');
      const packageRoot = writeBundledPluginSourceInputs({ repoRoot, pluginId: packageId });
      const agentId = AGENT_IDS.find((id) => BUNDLED_AGENT_CONTRIBUTION_IDENTITIES[id].pluginId === locator.pluginId);
      if (!agentId) throw new Error(`Missing catalog identity for ${locator.pluginId}`);
      mkdirSync(join(packageRoot, 'src/agent'), { recursive: true });
      writeFileSync(join(packageRoot, 'src/agent/definition.ts'), `export const AGENT_DEFINITION = ${JSON.stringify(BUNDLED_AGENT_DEFINITIONS_BY_ID[agentId])};`);
      writeFileSync(join(packageRoot, 'src/manifest.ts'), agentId === 'opencode'
        ? 'throw new Error("OpenCode executable manifest unavailable");'
        : `export const PLUGIN_MANIFEST = ${JSON.stringify(locator.manifest)};`);
    }
    try {
      await withWorkspaceBundleLock(async (lease) => {
        await runRuntimeConsumedAgentFactsPrivatePhase(repoRoot, lease);
      }, { lockPath: join(repoRoot, 'publication.lock') });
      const outPath = join(repoRoot, 'packages/agents/src/generated/bundledAgentDefinitions.ts');
      const exports: Record<string, unknown> = {};
      runInNewContext(transpileModule(readFileSync(outPath, 'utf8'), { compilerOptions: { module: ModuleKind.CommonJS } }).outputText, { exports });
      const definitions = exports.BUNDLED_AGENT_DEFINITIONS_BY_ID as typeof BUNDLED_AGENT_DEFINITIONS_BY_ID;
      for (const agentId of AGENT_IDS) {
        expect(definitions[agentId]?.core?.id, agentId).toBe(agentId);
        expect(definitions[agentId]?.sessionModeDescriptor, agentId).toEqual(BUNDLED_AGENT_DEFINITIONS_BY_ID[agentId]?.sessionModeDescriptor);
      }
      const published = readFileSync(outPath, 'utf8');
      rmSync(join(repoRoot, 'packages/plugins/opencode/src/agent/definition.ts'));
      await expect(withWorkspaceBundleLock(async (lease) => {
        await runRuntimeConsumedAgentFactsPrivatePhase(repoRoot, lease);
      }, { lockPath: join(repoRoot, 'publication.lock') })).rejects.toThrow(/Missing required agent definition/u);
      expect(readFileSync(outPath, 'utf8')).toBe(published);
    } finally { cleanup(); }
  }, 30_000);
  it('refreshes early Agent facts from source and tracked declarations without evaluating executable manifests', async () => {
    const { repoRoot, happyCliDir, cleanup } = createPackageLayoutSandbox('happier-bounded-agent-facts-');
    const packageRoot = writeBundledPluginSourceInputs({ repoRoot, pluginId: 'claude' });
    const unrelatedRoot = writeBundledPluginSourceInputs({ repoRoot, pluginId: 'unrelated' });
    writeCliBundledHostPackage({ happyCliDir, bundledDependencies: ['@happier-dev/plugins-claude', '@happier-dev/plugins-unrelated'] });
    const locator = BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS.find((entry) => entry.pluginId === 'happier.agent.claude');
    if (!locator) throw new Error('Missing Claude declaration fixture');
    const ingestion = ingestPluginManifestV2(locator.manifest);
    if (!ingestion.ok) throw new Error(JSON.stringify(ingestion.diagnostics));
    const agent = ingestion.manifest.contributes.agents?.[0];
    if (!agent?.cli) throw new Error('Missing Claude CLI metadata fixture');
    const manifest = { ...ingestion.manifest, contributes: { ...ingestion.manifest.contributes,
      agents: [{ ...agent, cli: { ...agent.cli, displayName: 'Current authored Agent' } }],
    } };
    const projectionPath = join(happyCliDir, 'src/plugins/projection/registry/sources/generatedBundledPluginManifests.ts');
    mkdirSync(dirname(projectionPath), { recursive: true });
    writeFileSync(projectionPath, `export const BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS = ${JSON.stringify([{ ...locator, manifest }])};`);
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: '@happier-dev/plugins-claude', version: '0.0.0' }));
    writeFileSync(join(packageRoot, 'src/manifest.ts'), `export const PLUGIN_MANIFEST = ${JSON.stringify(manifest)};`);
    mkdirSync(join(packageRoot, 'src/agent'), { recursive: true });
    writeFileSync(join(packageRoot, 'src/agent/definition.ts'), `export const AGENT_DEFINITION = ${JSON.stringify(claudeDefinition.AGENT_DEFINITION)}; export const AGENT_STATE_SHARING_DESCRIPTOR = ${JSON.stringify(claudeDefinition.AGENT_STATE_SHARING_DESCRIPTOR)};`);
    mkdirSync(join(packageRoot, 'src/ui'), { recursive: true });
    writeFileSync(join(packageRoot, 'src/ui/descriptor.ts'), 'throw new Error("UI is not an early Agent-facts input");');
    writeFileSync(join(unrelatedRoot, 'src/manifest.ts'), 'throw new Error("Non-Agent manifest is not an early Agent-facts input");');
    const outPath = join(repoRoot, 'packages/agents/src/generated/bundledAgentDefinitions.ts');
    try {
      await withWorkspaceBundleLock(async (lease) => {
        await runRuntimeConsumedAgentFactsPrivatePhase(repoRoot, lease);
      }, { lockPath: join(repoRoot, 'publication.lock') });
      const first = readFileSync(outPath, 'utf8');
      expect(first).toContain('Current authored Agent');
      expect(first).toContain('CLAUDE_CONFIG_DIR');
      writeFileSync(join(packageRoot, 'src/agent/definition.ts'), `export const AGENT_DEFINITION = ${JSON.stringify({ ...claudeDefinition.AGENT_DEFINITION, core: { ...claudeDefinition.AGENT_DEFINITION.core, cliSubcommand: 'updated-claude' } })}; export const AGENT_STATE_SHARING_DESCRIPTOR = ${JSON.stringify(claudeDefinition.AGENT_STATE_SHARING_DESCRIPTOR)};`);
      await withWorkspaceBundleLock(async (lease) => {
        await runRuntimeConsumedAgentFactsPrivatePhase(repoRoot, lease);
      }, { lockPath: join(repoRoot, 'publication.lock') });
      expect(readFileSync(outPath, 'utf8')).toContain('updated-claude');
      const published = readFileSync(outPath, 'utf8');
      writeFileSync(join(packageRoot, 'src/agent/definition.ts'), 'throw new Error("Required Agent definition failed");');
      await expect(withWorkspaceBundleLock(async (lease) => {
        await runRuntimeConsumedAgentFactsPrivatePhase(repoRoot, lease);
      }, { lockPath: join(repoRoot, 'publication.lock') })).rejects.toThrow(/Required Agent definition failed/u);
      expect(readFileSync(outPath, 'utf8')).toBe(published);
    } finally { cleanup(); }
  }, 30_000);
  it('does not retain previous Agent identities in a full source projection', () => {
    const identities = collectBundledAgentContributionIdentities([]);
    expect(identities).toEqual({});
    expect(() => renderAgentIdsTs({ agentIds: ['undeclared-agent'], contributionIdentities: identities }))
      .toThrow(/Missing bundled plugin contribution identity/u);
  });
  it('projects identities from the authored Agent routing id and manifest local id', () => {
    const locator = BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS.find((entry) => entry.pluginId === 'happier.agent.ohmypi');
    const ingestion = ingestPluginManifestV2(locator?.manifest);
    if (!ingestion.ok) throw new Error(JSON.stringify(ingestion.diagnostics));
    const identities = collectBundledAgentContributionIdentities([{
      pluginPackageId: 'ohmypi', pluginId: ingestion.manifest.id,
      packageName: '@happier-dev/plugins-ohmypi', packageVersion: '0.0.0',
      agentId: ohMyPiDefinition.AGENT_DEFINITION.id, manifest: ingestion.manifest,
    }]);
    expect(identities.ohMyPi).toEqual({ pluginId: 'happier.agent.ohmypi', localId: 'ohmypi' });
  });
  it.each([
    [piDefinition, 'PI_CODING_AGENT_DIR'],
    [codexDefinition, 'CODEX_HOME'],
    [claudeDefinition, 'CLAUDE_CONFIG_DIR'],
    [ohMyPiDefinition, 'PI_CODING_AGENT_DIR'],
  ] as const)('exposes native-home declarations from static Agent source before runtime publication (%s)', (definition, key) => {
    const exports: Readonly<Record<string, unknown>> = definition;
    expect(readAgentNativeHomeEnvironmentKeys(exports.AGENT_STATE_SHARING_DESCRIPTOR)).toEqual([key]);
  });
  it('re-evaluates prior UI publication failures instead of inheriting stale build exclusions', () => {
    const { repoRoot, happyCliDir, cleanup } = createPackageLayoutSandbox('happier-ui-recovery-');
    try {
      const failurePath = join(happyCliDir, '.project/tmp/bundled-plugin-publication/failures.json');
      mkdirSync(join(failurePath, '..'), { recursive: true });
      writeFileSync(failurePath, JSON.stringify([{
        packageName: '@happier-dev/plugins-inspector', pluginId: 'happier.inspector',
        diagnostic: { code: 'plugin_ui_artifact_invalid', message: 'previous UI build failed' },
      }]));
      expect(readInheritedBundledPluginFailures(false, repoRoot)).toEqual([]);
    } finally { cleanup(); }
  });
  it('publishes an empty native-home list for source without state-sharing declarations', () => {
    const output = renderBundledAgentDefinitionsTs({
      agentIds: [], agentDefinitionsById: {}, nativeHomeEnvironmentKeys: [],
    });
    expect(output).toContain('BUNDLED_AGENT_NATIVE_HOME_ENVIRONMENT_KEYS: readonly string[] = Object.freeze([])');
  });
  it('projects the released output reader declaration from the Claude private classifier', () => {
    expect(BUNDLED_AGENT_DEFINITIONS_BY_ID.claude?.releasedOutputTranscriptRecordReader?.nonTranscriptRecordTypes)
      .toEqual([...INTERNAL_CLAUDE_EVENT_TYPES]);
  });
  it('leaves the app-preseed byte registry to the apps/ui prebuild owner', () => {
    expect(generatorSource).not.toContain('generatedBundledPluginUiArtifacts');
    expect(generatorSource).not.toContain('collectBundledPluginUiAppArtifactSources');
    expect(generatorSource).not.toContain('renderBundledPluginUiAppArtifactInventoryTs');
  });

  it('carries native-home keys in the existing Agent facts projection as JSON-readable data', () => {
    const output = renderBundledAgentDefinitionsTs({
      agentIds: [],
      agentDefinitionsById: {},
      nativeHomeEnvironmentKeys: ['CUSTOM_AGENT_ROOT', 'ANOTHER_AGENT_ROOT'],
    });
    const keys = output.match(/BUNDLED_AGENT_NATIVE_HOME_ENVIRONMENT_KEYS[^=]*= Object\.freeze\((\[[\s\S]*?\])\);/u)?.[1];
    expect(keys).toBeDefined();
    expect(JSON.parse(keys!)).toEqual(['CUSTOM_AGENT_ROOT', 'ANOTHER_AGENT_ROOT']);
  });

  it('round-trips static native-home declarations to Stack and rejects missing projection authority', () => {
    const root = mkdtempSync(join(tmpdir(), 'happier-native-home-projection-'));
    const path = join(root, 'facts.ts');
    try {
      expect(() => readBundledAgentNativeHomeEnvironmentKeys(path)).toThrow(/native-home projection/u);
      writeFileSync(path, renderBundledAgentDefinitionsTs({
        agentIds: [], agentDefinitionsById: {},
        nativeHomeEnvironmentKeys: readAgentNativeHomeEnvironmentKeys({
          nativeHome: { environmentKey: 'CUSTOM_AGENT_ROOT' },
          config: { entries: [{ mode: 'env_redirect', envVar: 'CUSTOM_AGENT_ROOT' }] },
          state: { entries: [{ mode: 'env_redirect', envVar: 'CUSTOM_AGENT_STATE' }] },
        }),
      }));
      expect(readBundledAgentNativeHomeEnvironmentKeys(path)).toEqual(['CUSTOM_AGENT_ROOT', 'CUSTOM_AGENT_STATE']);
      writeFileSync(path, 'export const BUNDLED_AGENT_NATIVE_HOME_ENVIRONMENT_KEYS = Object.freeze(null);');
      expect(() => readBundledAgentNativeHomeEnvironmentKeys(path)).toThrow(/native-home projection/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('packaged runtime eligibility', () => {
  const declarativeOnlyOwner = {
    hasDaemonEntrypoint: false,
    hasResources: false,
    requiresSessionRunnerFactory: false,
    hasManagedProviderRuntime: false,
    hasConnectedAccountDescriptors: false,
  } as const;

  it.each([
    'hasDaemonEntrypoint',
    'hasResources',
    'requiresSessionRunnerFactory',
    'hasManagedProviderRuntime',
    'hasConnectedAccountDescriptors',
  ] as const)('requires packaged bytes for the independent %s owner', (owner) => {
    expect(requiresBundledPackagedRuntime({
      ...declarativeOnlyOwner,
      [owner]: true,
    })).toBe(true);
  });

  it('does not require packaged bytes for a declarative-only owner', () => {
    expect(requiresBundledPackagedRuntime(declarativeOnlyOwner)).toBe(false);
  });
});

describe('bundled plugin installed runtime publication', () => {
  it('replaces only marker-owned runtime outputs for declarative-only plugins', async () => {
    const packageRoot = mkdtempSync(join(tmpdir(), 'happier-declarative-runtime-reconcile-'));
    const runtimeRoot = join(packageRoot, '.happier-plugin');
    try {
      mkdirSync(join(packageRoot, 'assets'), { recursive: true });
      mkdirSync(join(runtimeRoot, '.happier-chunks'), { recursive: true });
      mkdirSync(join(runtimeRoot, 'agent/runtime'), { recursive: true });
      writeFileSync(join(packageRoot, 'assets/brand.png'), 'static package asset\n');
      writeFileSync(join(runtimeRoot, 'author-notes.txt'), 'author-owned runtime notes\n');
      writeFileSync(join(runtimeRoot, 'plugin.json'), '{"id":"happier.agent.declarative"}\n');
      writeFileSync(join(runtimeRoot, 'daemon.js'), 'stale daemon\n');
      writeFileSync(join(runtimeRoot, '.happier-chunks/retired.js'), 'retired chunk\n');
      writeFileSync(join(runtimeRoot, 'agent/runtime/factory.js'), 'retired runner\n');
      writeFileSync(join(runtimeRoot, '.happier-daemon-outputs.json'), JSON.stringify({
        version: 1,
        outputs: [
          '.happier-plugin/daemon.js',
          '.happier-plugin/.happier-chunks/retired.js',
          '.happier-plugin/agent/runtime/factory.js',
        ],
      }));

      const expectedFiles = new Map([
        ['.happier-plugin/plugin.json', Buffer.from('{"id":"happier.agent.declarative"}\n')],
        ['.happier-plugin/daemon.js', Buffer.from('current daemon\n')],
      ]);
      await expect(async () => await reconcileBundledPluginInstalledRuntime({
        packageRoot,
        pluginPackageId: 'declarative',
        daemonRelativePath: '.happier-plugin/daemon.js',
        expectedFiles,
        mode: 'check',
      })).rejects.toThrow(/generated runtime/u);

      await reconcileBundledPluginInstalledRuntime({
        packageRoot,
        pluginPackageId: 'declarative',
        daemonRelativePath: '.happier-plugin/daemon.js',
        expectedFiles,
        mode: 'write',
      });

      expect(readFileSync(join(runtimeRoot, 'daemon.js'), 'utf8')).toBe('current daemon\n');
      expect(existsSync(join(runtimeRoot, 'agent/runtime/factory.js'))).toBe(false);
      expect(existsSync(join(runtimeRoot, '.happier-chunks/retired.js'))).toBe(false);
      expect(readFileSync(join(runtimeRoot, 'plugin.json'), 'utf8'))
        .toBe('{"id":"happier.agent.declarative"}\n');
      expect(readFileSync(join(packageRoot, 'assets/brand.png'), 'utf8'))
        .toBe('static package asset\n');
      expect(readFileSync(join(runtimeRoot, 'author-notes.txt'), 'utf8'))
        .toBe('author-owned runtime notes\n');

      await expect(reconcileBundledPluginInstalledRuntime({
        packageRoot,
        pluginPackageId: 'declarative',
        daemonRelativePath: '.happier-plugin/daemon.js',
        expectedFiles,
        mode: 'check',
      })).resolves.toBeUndefined();
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it('keeps the current daemon, runner, and chunks while removing marker-owned retired siblings', async () => {
    const packageRoot = mkdtempSync(join(tmpdir(), 'happier-runtime-three-location-reconcile-'));
    const runtimeRoot = join(packageRoot, '.happier-plugin');
    try {
      mkdirSync(join(runtimeRoot, '.happier-chunks'), { recursive: true });
      mkdirSync(join(runtimeRoot, 'agent/runtime'), { recursive: true });
      writeFileSync(join(runtimeRoot, 'daemon.js'), 'old daemon\n');
      writeFileSync(join(runtimeRoot, '.happier-chunks/old.js'), 'old chunk\n');
      writeFileSync(join(runtimeRoot, 'agent/runtime/factory.js'), 'old runner\n');
      writeFileSync(join(runtimeRoot, '.happier-daemon-outputs.json'), JSON.stringify({
        version: 1,
        outputs: [
          '.happier-plugin/daemon.js',
          '.happier-plugin/.happier-chunks/old.js',
          '.happier-plugin/agent/runtime/factory.js',
        ],
      }));

      await reconcileBundledPluginInstalledRuntime({
        packageRoot,
        pluginPackageId: 'codex',
        daemonRelativePath: '.happier-plugin/daemon.js',
        expectedFiles: new Map([
          ['.happier-plugin/plugin.json', Buffer.from('{"id":"happier.agent.codex"}\n')],
          ['.happier-plugin/daemon.js', Buffer.from('new daemon\n')],
          ['.happier-plugin/.happier-chunks/current.js', Buffer.from('new chunk\n')],
          ['.happier-plugin/agent/runtime/engine.js', Buffer.from('new runner\n')],
        ]),
        mode: 'write',
      });

      expect(readFileSync(join(runtimeRoot, 'daemon.js'), 'utf8')).toBe('new daemon\n');
      expect(readFileSync(join(runtimeRoot, '.happier-chunks/current.js'), 'utf8')).toBe('new chunk\n');
      expect(readFileSync(join(runtimeRoot, 'agent/runtime/engine.js'), 'utf8')).toBe('new runner\n');
      expect(existsSync(join(runtimeRoot, '.happier-chunks/old.js'))).toBe(false);
      expect(existsSync(join(runtimeRoot, 'agent/runtime/factory.js'))).toBe(false);
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it('contracts only the exact unmarked runner leaves emitted for retired bundled runtimes', async () => {
    for (const pluginPackageId of ['antigravity', 'devin', 'kimi']) {
      const packageRoot = mkdtempSync(join(tmpdir(), `happier-retired-${pluginPackageId}-runtime-`));
      const runtimeRoot = join(packageRoot, '.happier-plugin');
      try {
        mkdirSync(join(runtimeRoot, 'agent/runtime'), { recursive: true });
        writeFileSync(join(runtimeRoot, 'plugin.json'), `{"id":"happier.agent.${pluginPackageId}"}\n`);
        writeFileSync(join(runtimeRoot, 'daemon.js'), 'current daemon\n');
        writeFileSync(join(runtimeRoot, 'agent/runtime/factory.js'), 'retired generated runner\n');
        writeFileSync(join(runtimeRoot, 'agent/runtime/author.js'), 'author-owned neighbor\n');
        writeFileSync(join(runtimeRoot, '.happier-daemon-outputs.json'), JSON.stringify({
          version: 1,
          outputs: ['.happier-plugin/daemon.js'],
        }));
        const expectedFiles = new Map([
          [
            '.happier-plugin/plugin.json',
            Buffer.from(`{"id":"happier.agent.${pluginPackageId}"}\n`),
          ],
          ['.happier-plugin/daemon.js', Buffer.from('current daemon\n')],
        ]);

        await expect(reconcileBundledPluginInstalledRuntime({
          packageRoot,
          pluginPackageId,
          daemonRelativePath: '.happier-plugin/daemon.js',
          expectedFiles,
          mode: 'check',
        })).rejects.toThrow(/retired generated runtime output/u);

        await reconcileBundledPluginInstalledRuntime({
          packageRoot,
          pluginPackageId,
          daemonRelativePath: '.happier-plugin/daemon.js',
          expectedFiles,
          mode: 'write',
        });

        expect(existsSync(join(runtimeRoot, 'agent/runtime/factory.js'))).toBe(false);
        expect(readFileSync(join(runtimeRoot, 'agent/runtime/author.js'), 'utf8'))
          .toBe('author-owned neighbor\n');
        await expect(reconcileBundledPluginInstalledRuntime({
          packageRoot,
          pluginPackageId,
          daemonRelativePath: '.happier-plugin/daemon.js',
          expectedFiles,
          mode: 'check',
        })).resolves.toBeUndefined();
      } finally {
        rmSync(packageRoot, { recursive: true, force: true });
      }
    }

    const packageRoot = mkdtempSync(join(tmpdir(), 'happier-author-owned-runner-runtime-'));
    const runtimeRoot = join(packageRoot, '.happier-plugin');
    try {
      mkdirSync(join(runtimeRoot, 'agent/runtime'), { recursive: true });
      writeFileSync(join(runtimeRoot, 'agent/runtime/factory.js'), 'author-owned runner\n');
      await reconcileBundledPluginInstalledRuntime({
        packageRoot,
        pluginPackageId: 'another-plugin',
        daemonRelativePath: '.happier-plugin/daemon.js',
        expectedFiles: new Map([
          ['.happier-plugin/plugin.json', Buffer.from('{"id":"happier.agent.other"}\n')],
          ['.happier-plugin/daemon.js', Buffer.from('current daemon\n')],
        ]),
        mode: 'write',
      });
      expect(readFileSync(join(runtimeRoot, 'agent/runtime/factory.js'), 'utf8'))
        .toBe('author-owned runner\n');
      await expect(reconcileBundledPluginInstalledRuntime({
        packageRoot,
        pluginPackageId: 'another-plugin',
        daemonRelativePath: '.happier-plugin/daemon.js',
        expectedFiles: new Map([
          ['.happier-plugin/plugin.json', Buffer.from('{"id":"happier.agent.other"}\n')],
          ['.happier-plugin/daemon.js', Buffer.from('current daemon\n')],
        ]),
        mode: 'check',
      })).resolves.toBeUndefined();
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it('contracts only the twelve proven unmarked predecessor chunks and preserves neighbors', async () => {
    const retiredChunksByPlugin = Object.freeze({
      auggie: 'chunk-VOUQT3FH.js',
      claude: 'chunk-N7PGJW44.js',
      codex: 'chunk-SHXPQNCY.js',
      copilot: 'chunk-K3Q3IMHF.js',
      cursor: 'chunk-GFYILV73.js',
      gemini: 'chunk-ZOTE3VST.js',
      grok: 'chunk-GMQD56SV.js',
      kilo: 'chunk-2FXVNKQ4.js',
      ohmypi: 'chunk-GRJXWIAP.js',
      opencode: 'chunk-HC5PJSTB.js',
      pi: 'chunk-GG7JGBJB.js',
      qwen: 'chunk-QU3FEF3D.js',
    });

    for (const [pluginPackageId, retiredChunk] of Object.entries(retiredChunksByPlugin)) {
      const packageRoot = mkdtempSync(join(tmpdir(), `happier-retired-${pluginPackageId}-chunk-`));
      const runtimeRoot = join(packageRoot, '.happier-plugin');
      try {
        mkdirSync(join(runtimeRoot, '.happier-chunks'), { recursive: true });
        writeFileSync(join(runtimeRoot, '.happier-chunks', retiredChunk), 'retired generated chunk\n');
        writeFileSync(join(runtimeRoot, '.happier-chunks', 'author-neighbor.js'), 'author-owned neighbor\n');
        writeFileSync(join(runtimeRoot, '.happier-chunks', 'current.js'), 'current generated chunk\n');
        writeFileSync(join(runtimeRoot, 'plugin.json'), `{"id":"happier.agent.${pluginPackageId}"}\n`);
        writeFileSync(join(runtimeRoot, 'daemon.js'), 'current daemon\n');
        writeFileSync(join(runtimeRoot, '.happier-daemon-outputs.json'), JSON.stringify({
          version: 1,
          outputs: [
            '.happier-plugin/daemon.js',
            '.happier-plugin/.happier-chunks/current.js',
          ],
        }));
        const expectedFiles = new Map([
          ['.happier-plugin/plugin.json', Buffer.from(`{"id":"happier.agent.${pluginPackageId}"}\n`)],
          ['.happier-plugin/daemon.js', Buffer.from('current daemon\n')],
          ['.happier-plugin/.happier-chunks/current.js', Buffer.from('current generated chunk\n')],
        ]);

        await expect(reconcileBundledPluginInstalledRuntime({
          packageRoot,
          pluginPackageId,
          daemonRelativePath: '.happier-plugin/daemon.js',
          expectedFiles,
          mode: 'check',
        })).rejects.toThrow(/retired generated runtime output/u);

        await reconcileBundledPluginInstalledRuntime({
          packageRoot,
          pluginPackageId,
          daemonRelativePath: '.happier-plugin/daemon.js',
          expectedFiles,
          mode: 'write',
        });

        expect(existsSync(join(runtimeRoot, '.happier-chunks', retiredChunk))).toBe(false);
        expect(readFileSync(join(runtimeRoot, '.happier-chunks', 'current.js'), 'utf8'))
          .toBe('current generated chunk\n');
        expect(readFileSync(join(runtimeRoot, '.happier-chunks', 'author-neighbor.js'), 'utf8'))
          .toBe('author-owned neighbor\n');
      } finally {
        rmSync(packageRoot, { recursive: true, force: true });
      }
    }

    expect(Object.keys(retiredChunksByPlugin)).toHaveLength(12);

    const unrelatedRoot = mkdtempSync(join(tmpdir(), 'happier-unrelated-unmarked-chunk-'));
    try {
      const runtimeRoot = join(unrelatedRoot, '.happier-plugin');
      mkdirSync(join(runtimeRoot, '.happier-chunks'), { recursive: true });
      writeFileSync(join(runtimeRoot, 'plugin.json'), '{"id":"happier.utility.other"}\n');
      writeFileSync(join(runtimeRoot, 'daemon.js'), 'current daemon\n');
      writeFileSync(join(runtimeRoot, '.happier-chunks/chunk-VOUQT3FH.js'), 'author-owned same-name chunk\n');
      writeFileSync(join(runtimeRoot, '.happier-daemon-outputs.json'), JSON.stringify({
        version: 1,
        outputs: ['.happier-plugin/daemon.js'],
      }));
      await reconcileBundledPluginInstalledRuntime({
        packageRoot: unrelatedRoot,
        pluginPackageId: 'other',
        daemonRelativePath: '.happier-plugin/daemon.js',
        expectedFiles: new Map([
          ['.happier-plugin/plugin.json', Buffer.from('{"id":"happier.utility.other"}\n')],
          ['.happier-plugin/daemon.js', Buffer.from('current daemon\n')],
        ]),
        mode: 'write',
      });
      expect(readFileSync(join(runtimeRoot, '.happier-chunks/chunk-VOUQT3FH.js'), 'utf8'))
        .toBe('author-owned same-name chunk\n');
    } finally {
      rmSync(unrelatedRoot, { recursive: true, force: true });
    }
  });

  it('does not resolve source staging through ignored plugin package outputs', () => {
    expect(selectCanonicalRuntimeWorkspacePackageRoots([
      {
        packageName: '@happier-dev/plugin-sdk',
        srcDir: '/repo/packages/plugin-sdk',
      },
      {
        packageName: '@happier-dev/plugins-codex',
        srcDir: '/repo/packages/plugins/codex',
      },
      {
        packageName: '@happier-dev/plugins-kimi',
        srcDir: '/repo/apps/cli/node_modules/@happier-dev/plugins-kimi',
      },
    ])).toEqual({
      '@happier-dev/plugin-sdk': '/repo/packages/plugin-sdk',
    });
  });

  it.each(['selected projection', 'full publication'] as const)(
    'prepares only the packaged-runtime roots consumed by %s, once across its phases',
    async (operation) => {
      const { repoRoot, happyCliDir, cleanup } = createPackageLayoutSandbox('happier-generator-preparation-');
      try {
        for (const appName of ['ui', 'server']) {
          mkdirSync(join(repoRoot, 'apps', appName), { recursive: true });
          writeFileSync(join(repoRoot, 'apps', appName, 'package.json'), JSON.stringify({ name: `@fixture/${appName}` }));
        }
        writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({
          private: true, workspaces: ['apps/*', 'packages/*', 'packages/plugins/*'],
        }));
        const pluginIds = operation === 'selected projection' ? ['selected', 'broken'] : ['selected', 'other'];
        writeCliBundledHostPackage({
          happyCliDir,
          bundledDependencies: pluginIds.map((id) => `@happier-dev/plugins-${id}`),
        });
        for (const id of ['protocol', ...pluginIds]) {
          const isPlugin = id !== 'protocol';
          writeWorkspacePackageFixture({
            repoRoot,
            workspacePath: isPlugin ? `packages/plugins/${id}` : `packages/${id}`,
            packageName: `@happier-dev/${isPlugin ? 'plugins-' : ''}${id}`,
            manifestOverrides: {
              scripts: { build: 'fixture compiler' },
              ...(isPlugin ? { dependencies: { '@happier-dev/protocol': 'workspace:*' } } : {}),
            },
            files: { 'src/index.ts': `export const value = '${id}';\n`, 'tsconfig.json': '{}\n' },
          });
          if (isPlugin) writeBundledPluginSourceInputs({ repoRoot, pluginId: id, writePackageJson: false });
        }
        const preparedPlugins = new Set<string>();
        const prepare = async (options: Parameters<typeof resolveGeneratorPackagedRuntimePreparation>[1]) => {
          const preparation = resolveGeneratorPackagedRuntimePreparation(
            ['protocol', ...pluginIds.map((id) => `plugins-${id}`)],
            options,
          );
          return await prepareBundledWorkspaceDependenciesForCli({
            repoRoot,
            ...preparation,
            quiet: true,
            // Only the compiler process is replaced; dependency discovery,
            // currentness, locks, staging, validation, and publication are real.
            ensureWorkspacePackagesBuiltByNameImpl: (...[root, names, buildOptions]: Parameters<typeof ensureWorkspacePackagesBuiltByName>) => (
              ensureWorkspacePackagesBuiltByName(root, names, {
                ...buildOptions,
                workspaceBuildBoundary: {
                  async prepareEnv(_packageDir, env) { return { ...env }; },
                  async runPackageBuild(packageDir, { env }) {
                    const { name } = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
                    if (name === '@happier-dev/plugins-broken') throw new Error('unrelated plugin cannot compile');
                    if (name.startsWith('@happier-dev/plugins-')) {
                      if (preparedPlugins.has(name)) throw new Error('packaged-runtime root forced twice in one publication');
                      preparedPlugins.add(name);
                      expect(readFileSync(join(repoRoot, 'packages/protocol/dist/index.js'), 'utf8'))
                        .toContain("value = 'protocol'");
                    }
                    const outputDir = env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR!;
                    writeFileSync(join(outputDir, 'index.js'), readFileSync(join(packageDir, 'src/index.ts')));
                    writeFileSync(join(outputDir, 'index.d.ts'), 'export declare const value: string;\n');
                  },
                },
              })
            ),
          });
        };
        if (operation === 'full publication') {
          await prepare({ preparePackagedRuntimes: false });
          expect(preparedPlugins.size).toBe(0);
          await prepare({});
          expect([...preparedPlugins].sort()).toEqual([
            '@happier-dev/plugins-other', '@happier-dev/plugins-selected',
          ]);
        } else {
          await prepare({ workspaceNames: ['plugins-selected'] });
          expect([...preparedPlugins]).toEqual(['@happier-dev/plugins-selected']);
        }
        expect(readFileSync(join(repoRoot, 'packages/plugins/selected/dist/index.js'), 'utf8'))
          .toContain("value = 'selected'");
      } finally {
        cleanup();
      }
    },
  );
});

describe('bundled plugin UI translation aggregation', () => {
  it('publishes a locale runtime payload without delivering other locale copy', () => {
    const translations = {
      en: { 'plugins.example.shared': 'English fallback', 'plugins.example.englishOnly': 'English only' },
      es: { 'plugins.example.shared': 'Español' },
      fr: { 'plugins.example.shared': 'Français' },
    };
    const emitted = renderBundledPluginTranslationsTs(translations, 'es');
    const exports: Record<string, unknown> = {};
    runInNewContext(transpileModule(emitted, { compilerOptions: { module: ModuleKind.CommonJS } }).outputText, { exports });
    expect(exports.BUNDLED_PLUGIN_TRANSLATIONS).toEqual(translations.es);
  });
  it('emits large translation declarations without serializing values or widening translation keys', () => {
    const root = mkdtempSync(join(tmpdir(), 'bundled-translations-declarations-'));
    const messages = Object.fromEntries(Array.from({ length: 600 }, (_, index) => [
      `plugins.example.message${index}`, `${index}: ${'translated text '.repeat(40)}`,
    ]));
    const source = renderBundledPluginTranslationsTs({ en: messages, fr: { 'plugins.example.frenchOnly': 'Bonjour' } });
    const generated = join(root, 'translations.ts');
    const consumer = join(root, 'consumer.ts');
    writeFileSync(generated, source);
    writeFileSync(consumer, [
      "import { BUNDLED_PLUGIN_TRANSLATIONS, type BundledPluginTranslationKey } from './translations';",
      'type Assert<T extends true> = T;',
      "type Known = Assert<'plugins.example.message599' extends BundledPluginTranslationKey ? true : false>;",
      "type OtherLocale = Assert<'plugins.example.frenchOnly' extends BundledPluginTranslationKey ? true : false>;",
      "type Unknown = Assert<'plugins.example.missing' extends BundledPluginTranslationKey ? false : true>;",
      "export const translated: string | undefined = BUNDLED_PLUGIN_TRANSLATIONS.en['plugins.example.message599'];",
      "export const missing: string | undefined = BUNDLED_PLUGIN_TRANSLATIONS.en['plugins.example.frenchOnly'];",
      '// @ts-expect-error A locale may omit a key present in another locale.',
      "export const required: string = BUNDLED_PLUGIN_TRANSLATIONS.en['plugins.example.frenchOnly'];",
    ].join('\n'));
    try {
      execFileSync(process.execPath, [
        'scripts/workspaces/runTypeScriptCli.mjs', '--strict', '--declaration', '--emitDeclarationOnly',
        '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'Bundler',
        '--skipLibCheck', '--outDir', join(root, 'declarations'), generated, consumer,
      ], {
        cwd: new URL('../../../../', import.meta.url), stdio: 'inherit',
        // This isolated declaration fixture runs within the admitted test suite,
        // not the full-workspace compiler's separate capacity reservation.
        env: { ...process.env, CI: 'true', GITHUB_ACTIONS: 'true',
          HAPPIER_DEV_TARGET_EXECUTION: '0', HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN: '' },
      });
      const declaration = readFileSync(join(root, 'declarations/translations.d.ts'), 'utf8');
      expect(declaration.length).toBeLessThan(source.length / 4);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  const sharedTriageTranslation = Object.freeze({
    contributes: {
      ui: {
        translations: [{
          locale: 'en',
          messages: {
            'plugins.triage.sourceSettings.connectAccount': 'Connect account',
          },
        }],
      },
    },
  });

  it('coalesces byte-identical shared translations independently of package order', () => {
    const posthog = {
      pluginPackageId: 'posthog',
      manifest: sharedTriageTranslation,
    };
    const azureDevOps = {
      pluginPackageId: 'scm-azure-devops',
      manifest: sharedTriageTranslation,
    };

    expect(collectBundledPluginUiTranslations([posthog, azureDevOps])).toEqual({
      en: {
        'plugins.triage.sourceSettings.connectAccount': 'Connect account',
      },
    });
    expect(collectBundledPluginUiTranslations([azureDevOps, posthog])).toEqual(
      collectBundledPluginUiTranslations([posthog, azureDevOps]),
    );
  });

  it('rejects conflicting translations with the locale, key, and both package owners', () => {
    expect(() => collectBundledPluginUiTranslations([
      {
        pluginPackageId: 'posthog',
        manifest: sharedTriageTranslation,
      },
      {
        pluginPackageId: 'scm-azure-devops',
        manifest: {
          contributes: {
            ui: {
              translations: [{
                locale: 'en',
                messages: {
                  'plugins.triage.sourceSettings.connectAccount': 'Link account',
                },
              }],
            },
          },
        },
      },
    ])).toThrow(
      "Conflicting bundled UI translation 'en:plugins.triage.sourceSettings.connectAccount' from posthog and scm-azure-devops",
    );
  });
});

describe('CLI bundled plugin registry projection', () => {
  it('does not publish a duplicate packaged-byte currentness authority', () => {
    expect(generatorSource).not.toContain('assignBundledImmutableArtifactGenerationIds');
    expect(generatorSource).not.toContain('renderCliBundledPluginArtifactRecordsTs');
    expect(generatorSource).not.toContain('generatedBundledPluginArtifacts.ts');
    expect(generatorSource).not.toContain('function sameBundledSourceArtifactIntegrity(');
  });

  it('emits the contribution-identity owner subpath instead of the Protocol root barrel', () => {
    const registrationRenderer = sourceBetween(
      'function renderCliBundledAgentRegistrationBindingsTs(',
      'function renderCliBundledPluginEntriesTs(',
      registryRendererSource,
    );

    expect(registrationRenderer).toContain(
      "@happier-dev/protocol/plugins/contribution-identity",
    );
    expect(registrationRenderer).not.toContain(
      "from '@happier-dev/protocol';",
    );
  });

  it('keeps generated manifest locators data-only without target semantic sidecars', () => {
    const registryRenderer = sourceBetween(
      'function renderCliBundledPluginManifestEntriesTs(',
      'function renderCliBundledAgentRegistrationBindingsTs(',
      registryRendererSource,
    );

    expect(registryRenderer).not.toContain('targeted-contributions');
    expect(registryRenderer).not.toContain('semanticPointRefs');
    expect(registryRenderer).not.toContain('@happier-dev/plugin-sdk');
  });

  it('does not emit a committed source-byte integrity ledger', () => {
    expect(generatorSource).not.toContain('BUNDLED_FIRST_PARTY_SOURCE_ARTIFACT_INTEGRITIES');
    expect(generatorSource).not.toContain('generatedBundledPluginSourceIntegrities.json');
    expect(generatorSource).not.toContain('renderBundledPluginSourceIntegritiesJson');
  });

  it('publishes serialized manifest locators through the aggregate final-artifact owner', () => {
    const aggregatePublisher = sourceBetween(
      'async function publishBundledPluginSemanticProjection(',
      'function collectBundledAgentContributionIdentities(',
    );

    expect(aggregatePublisher).toContain('renderCliBundledPluginManifestEntriesTs({ pluginPackages })');
    expect(aggregatePublisher).toContain('generatedBundledPluginManifests.ts');
    expect(aggregatePublisher).toContain('cliManifestOutPath');
  });

  it('keeps tracked projections independent of transient publication admission', () => {
    const aggregatePublisher = sourceBetween(
      'async function publishBundledPluginSemanticProjection(',
      'function collectBundledAgentContributionIdentities(',
    );
    const fullPublisher = sourceBetween(
      'async function generateBundledPluginEntries(',
      'async function withGeneratorPublicationLock<T>(',
    );
    expect(aggregatePublisher).not.toContain('if (failures.length > 0) return failures;');
    expect(fullPublisher).not.toContain('if (failures.length > 0) return failures;');
    expect(fullPublisher).toContain('renderBundledVoiceRuntimeProjectionOutputs(');
    expect(aggregatePublisher).toContain('renderBundledVoiceRuntimeProjectionOutputs(');
  });

  it('advances healthy serialized locators while retaining failed optional membership', async () => {
    const { repoRoot, happyCliDir, cleanup } = createPackageLayoutSandbox('happier-aggregate-failure-');
    try {
      const manifest = (id: string, displayName: string) => ({
        schemaVersion: 2, id: `happier.${id}`, version: '0.0.0', displayName,
        engines: { happier: '^0.0.0' }, runtime: { apiVersion: 1 },
        hostAccess: { required: [], optional: [] }, contributes: {},
      });
      for (const id of ['healthy', 'inspector']) {
        const packageDir = writeWorkspacePackageFixture({
          repoRoot, workspacePath: `packages/plugins/${id}`, packageName: `@happier-dev/plugins-${id}`,
        });
        writeBundledPluginSourceInputs({ repoRoot, pluginId: id, writePackageJson: false });
        mkdirSync(join(packageDir, '.happier-plugin'), { recursive: true });
        writeFileSync(join(packageDir, '.happier-plugin', 'plugin.json'), JSON.stringify(manifest(id, id)));
      }
      writeCliBundledHostPackage({ happyCliDir, bundledDependencies: ['@happier-dev/plugins-healthy', '@happier-dev/plugins-inspector'] });
      const failurePath = join(happyCliDir, '.project', 'tmp', 'bundled-plugin-publication', 'failures.json');
      mkdirSync(join(failurePath, '..'), { recursive: true });
      writeFileSync(failurePath, JSON.stringify([{
        packageName: '@happier-dev/plugins-inspector', pluginId: 'happier.inspector',
        diagnostic: { code: 'plugin_ui_artifact_invalid', message: 'optional UI bytes missing' },
      }]));
      writeFileSync(join(repoRoot, 'packages/plugins/healthy/.happier-plugin/plugin.json'), JSON.stringify(manifest('healthy', 'Healthy changed')));
      await withWorkspaceBundleLock(async (lease) => await publishBundledPluginSemanticProjection(
        parseGeneratorCliArgs(['--mode', 'write', '--root', repoRoot, '--aggregate']),
        { protocol: { ingestPluginManifestV2 } },
        lease,
        [],
        readBundledPluginPublicationFailures(repoRoot),
      ), { lockPath: join(repoRoot, 'publication.lock') });
      const output = readFileSync(join(happyCliDir, 'src/plugins/projection/registry/sources/generatedBundledPluginManifests.ts'), 'utf8');
      expect(output).toContain('Healthy changed');
      expect(output).toContain('happier.inspector');
      expect(output).not.toContain('optional UI bytes missing');
      expect(output).not.toContain('BUNDLED_FIRST_PARTY_PLUGIN_FAILURES');
      expect(JSON.parse(readFileSync(failurePath, 'utf8'))).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  it('aggregate publication preserves unrelated source failures while recording the current failed scope', async () => {
    const { repoRoot, cleanup } = createPackageLayoutSandbox('happier-aggregate-scope-');
    const failure = (id: string) => ({
      packageName: `@happier-dev/plugins-${id}`, pluginId: `happier.${id}`,
      diagnostic: { code: 'plugin_manifest_invalid' as const, message: `${id} source failed` },
    });
    try {
      for (const id of ['a', 'b']) {
        const packageDir = writeWorkspacePackageFixture({
          repoRoot, workspacePath: `packages/plugins/${id}`, packageName: `@happier-dev/plugins-${id}`,
        });
        writeBundledPluginSourceInputs({ repoRoot, pluginId: id, writePackageJson: false });
        mkdirSync(join(packageDir, '.happier-plugin'), { recursive: true });
        writeFileSync(join(packageDir, '.happier-plugin/plugin.json'), JSON.stringify({
          schemaVersion: 2, id: `happier.${id}`, version: '0.0.0', displayName: id,
          engines: { happier: '^0.0.0' }, runtime: { apiVersion: 1 },
          hostAccess: { required: [], optional: [] }, contributes: {},
        }));
      }
      writeBundledPluginPublicationFailures(repoRoot, [failure('a')]);
      await withWorkspaceBundleLock(async (lease) => await publishBundledPluginSemanticProjection(
        parseGeneratorCliArgs(['--mode', 'write', '--root', repoRoot, '--aggregate']),
        { protocol: { ingestPluginManifestV2 } }, lease, [], [failure('b')],
      ), { lockPath: join(repoRoot, 'publication.lock') });
      expect(readBundledPluginPublicationFailures(repoRoot)).toEqual([failure('a'), failure('b')]);
    } finally { cleanup(); }
  });

  describe('bundled voice runtime export', () => {
    async function collectVoiceExport(exportTarget: Readonly<Record<string, unknown>>) {
      const { repoRoot, cleanup } = createPackageLayoutSandbox('happier-voice-conditional-export-');
      try {
        writeWorkspacePackageFixture({
          repoRoot, workspacePath: 'packages/plugins/openai', packageName: '@happier-dev/plugins-openai',
          manifestOverrides: { exports: { './happier-plugin-ui/voice-runtime': exportTarget } },
        });
        const pluginPackage = {
          packageName: '@happier-dev/plugins-openai', packageVersion: '0.0.0', pluginPackageId: 'openai',
          pluginId: 'happier.voice.openai',
          manifest: {
            schemaVersion: 2 as const, id: 'happier.voice.openai', version: '0.0.0', displayName: 'OpenAI',
            runtime: { apiVersion: 1 as const }, contributes: { voiceProviders: [{
              id: 'openai', title: 'OpenAI', kind: 'conversation' as const,
              roles: ['realtime_conversation' as const], platforms: ['web' as const, 'ios' as const],
              capabilities: { turn: { cancelResponse: false, bargeIn: false }, tools: { effectCalls: 'none' as const } },
              client: { artifactId: 'voice-runtime', exportName: 'activate' },
            }] },
          },
        } satisfies Parameters<typeof collectBundledFirstPartyVoiceProjectionSources>[1][number];
        // Package exports are the filesystem boundary; collect the real runtime projection
        // without evaluating optional presentation modules unrelated to export admission.
        return await collectBundledFirstPartyVoiceProjectionSources(repoRoot, [pluginPackage], false);
      } finally { cleanup(); }
    }

    it.each([
      './dist/ui/voice/runtime.native.js',
      { 'happier-source': './src/ui/voice/runtime.native.ts', default: './dist/ui/voice/runtime.native.js' },
    ])('accepts a safe built React Native default while preserving conditional source exports (%j)', async (nativeTarget) => {
      const result = await collectVoiceExport({
        'happier-source': './src/ui/voice/runtime.ts',
        'react-native': nativeTarget,
        default: './dist/ui/voice/runtime.js',
      });
      expect(result.failures).toEqual([]);
      expect(result.sources[0]).toMatchObject({
        hasConversationProvider: true,
        conversationPlatforms: ['web', 'ios'],
        conversationClient: { artifactId: 'voice-runtime', exportName: 'activate' },
      });
    });

    it.each([
      { 'happier-source': './src/ui/voice/runtime.native.ts' },
      { 'happier-source': './src/ui/voice/runtime.native.ts', default: './dist/ui/voice/../runtime.native.js' },
      { 'happier-source': './src/ui/voice/runtime.native.ts', default: './dist/ui/runtime.native.js' },
      { 'happier-source': './src/ui/voice/runtime.native.ts', default: './dist/ui/voice/runtime.native.ts' },
      { default: './dist/ui/voice/runtime.native.js', 'happier-source': './src/ui/voice/runtime.native.ts' },
      { 'happier-source': './src/ui/voice/runtime.native.ts', browser: './dist/ui/voice/runtime.native.js', default: './dist/ui/voice/runtime.native.js' },
    ])('rejects unsafe, incomplete or unordered nested React Native exports (%j)', async (nativeTarget) => {
      await expect(collectVoiceExport({
        'happier-source': './src/ui/voice/runtime.ts',
        'react-native': nativeTarget,
        default: './dist/ui/voice/runtime.js',
      })).rejects.toThrow(/Invalid bundled voice export/u);
    });

    it.each([
      { 'react-native': './dist/ui/voice/runtime.native.js', default: './dist/ui/voice/../runtime.js' },
      { default: './dist/ui/voice/runtime.js', 'react-native': './dist/ui/voice/runtime.native.js' },
    ])('preserves default-path and top-level condition order fences (%j)', async (exportTarget) => {
      await expect(collectVoiceExport(exportTarget)).rejects.toThrow(/Invalid bundled voice export/u);
    });
  });

  it('does not inspect a failed Voice presentation leaf and reads repaired source on recovery', async () => {
    const { repoRoot, cleanup } = createPackageLayoutSandbox('happier-voice-presentation-failure-');
    try {
      const pluginPackages = ['openai', 'google'].map((id) => {
        writeWorkspacePackageFixture({
          repoRoot, workspacePath: `packages/plugins/${id}`, packageName: `@happier-dev/plugins-${id}`,
          files: { 'src/ui/voice/entries.ts': id === 'openai'
            ? "throw new Error('failed authored Voice leaf must not be inspected');\n"
            : "export const VOICE_PROVIDER_PRESENTATIONS = [{ providerId: 'google-source', settingsSectionId: 'google-settings' }];\n" },
        });
        return {
          packageName: `@happier-dev/plugins-${id}`, packageVersion: '0.0.0', pluginPackageId: id,
          pluginId: `happier.voice.${id}`,
          manifest: {
            schemaVersion: 2 as const, id: `happier.voice.${id}`, version: '0.0.0', displayName: id,
            runtime: { apiVersion: 1 as const }, contributes: {},
          },
        } satisfies Parameters<typeof collectBundledFirstPartyVoiceProjectionSources>[1][number];
      });
      const { sources, failures } = await collectBundledFirstPartyVoiceProjectionSources(
        repoRoot, pluginPackages, true, new Set(['@happier-dev/plugins-openai']),
      );
      expect(sources.map((source) => source.pluginId)).toEqual(['happier.voice.google', 'happier.voice.openai']);
      expect(failures).toEqual([]);
      expect(sources.find((source) => source.pluginPackageId === 'openai')?.presentations).toEqual([]);
      expect(sources.find((source) => source.pluginPackageId === 'google')?.presentations)
        .toEqual([{ providerId: 'google-source', settingsSectionId: 'google-settings' }]);
      expect(renderBundledVoiceEntriesTs(sources)).toContain('happier.voice.openai');
      writeFileSync(join(repoRoot, 'packages/plugins/openai/src/ui/voice/entries.ts'),
        "export const VOICE_PROVIDER_PRESENTATIONS = [{ providerId: 'openai-repaired', settingsSectionId: 'openai-settings' }];\n");
      const recovered = await collectBundledFirstPartyVoiceProjectionSources(repoRoot, pluginPackages);
      expect(recovered.sources.find((source) => source.pluginPackageId === 'openai')?.presentations)
        .toEqual([{ providerId: 'openai-repaired', settingsSectionId: 'openai-settings' }]);
      expect(recovered.failures).toEqual([]);
    } finally { cleanup(); }
  });

  it.each(['import', 'shape'] as const)('isolates an optional Voice presentation %s failure without dropping sibling source or failed manifests', async (failureKind) => {
    const { repoRoot, cleanup } = createPackageLayoutSandbox('happier-voice-presentation-invalid-');
    try {
      const pluginPackages = ['google', 'openai'].map((id) => {
        writeWorkspacePackageFixture({
          repoRoot, workspacePath: `packages/plugins/${id}`, packageName: `@happier-dev/plugins-${id}`,
          manifestOverrides: { exports: { './happier-plugin-ui/voice-runtime': {
            'happier-source': './src/ui/voice/runtime.ts',
            ...(id === 'openai' ? { 'react-native': './dist/ui/voice/runtime.native.js' } : {}),
            default: './dist/ui/voice/runtime.js',
          } } },
          files: { 'src/ui/voice/entries.ts': id === 'google'
            ? failureKind === 'import' ? "throw new Error('optional Voice source invalid');\n"
              : "export const VOICE_PROVIDER_PRESENTATIONS = [{ providerId: 123, settingsSectionId: 'invalid' }];\n"
            : "export const VOICE_PROVIDER_PRESENTATIONS = [{ providerId: 'openai-healthy', settingsSectionId: 'openai-settings' }];\n" },
        });
        return {
          packageName: `@happier-dev/plugins-${id}`, packageVersion: '0.0.0', pluginPackageId: id,
          pluginId: `happier.voice.${id}`,
          manifest: {
            schemaVersion: 2 as const, id: `happier.voice.${id}`, version: '0.0.0', displayName: id,
            runtime: { apiVersion: 1 as const }, contributes: { voiceProviders: [{
              id, title: id, kind: 'conversation' as const,
              roles: ['realtime_conversation' as const], platforms: ['web' as const],
              capabilities: { turn: { cancelResponse: false, bargeIn: false }, tools: { effectCalls: 'none' as const } },
              client: { artifactId: 'voice-runtime', exportName: 'activate' },
            }] },
          },
        } satisfies Parameters<typeof collectBundledFirstPartyVoiceProjectionSources>[1][number];
      });
      const { sources, failures } = await collectBundledFirstPartyVoiceProjectionSources(repoRoot, pluginPackages);
      expect(failures).toMatchObject([{
        packageName: '@happier-dev/plugins-google', pluginId: 'happier.voice.google',
        diagnostic: { code: 'plugin_ui_artifact_invalid' },
      }]);
      expect(failures[0]?.diagnostic.message).toBeTruthy();
      expect(sources.find((source) => source.pluginPackageId === 'google')?.presentations).toEqual([]);
      expect(sources.find((source) => source.pluginPackageId === 'openai')?.presentations)
        .toEqual([{ providerId: 'openai-healthy', settingsSectionId: 'openai-settings' }]);
      expect(renderBundledVoiceEntriesTs(sources)).toContain('happier.voice.google');
      const runtime = renderBundledVoiceRuntimeEntriesTs(sources, 'web', new Set(failures.map((failure) => failure.packageName)));
      expect(runtime).not.toContain('@happier-dev/plugins-google');
      expect(runtime).toContain('@happier-dev/plugins-openai/happier-plugin-ui/voice-runtime');
    } finally { cleanup(); }
  });

  it('keeps required Voice presentation failures fatal through the publication policy owner', async () => {
    const { repoRoot, cleanup } = createPackageLayoutSandbox('happier-required-voice-presentation-');
    try {
      writeWorkspacePackageFixture({
        repoRoot, workspacePath: 'packages/plugins/codex', packageName: '@happier-dev/plugins-codex',
        files: { 'src/ui/voice/entries.ts': 'export const VOICE_PROVIDER_PRESENTATIONS = null;\n' },
      });
      await expect(collectBundledFirstPartyVoiceProjectionSources(repoRoot, [{
        packageName: '@happier-dev/plugins-codex', packageVersion: '0.0.0', pluginPackageId: 'codex',
        pluginId: 'happier.agent.codex',
        manifest: {
          schemaVersion: 2, id: 'happier.agent.codex', version: '0.0.0', displayName: 'Codex',
          runtime: { apiVersion: 1 }, contributes: {},
        },
      }])).rejects.toThrow(/plugins-codex.*required by host code/u);
    } finally { cleanup(); }
  });

  it.each([['aggregate', ['--aggregate']], ['scoped', ['--workspace', 'plugins-inspector']]] as const)(
    '%s publication excludes a retained failed Voice import and scoped recovery restores its healthy bytes',
    async (_label, selector) => {
      const { repoRoot, happyCliDir, cleanup } = createPackageLayoutSandbox('happier-voice-failure-');
      try {
        const openaiPackage = writeWorkspacePackageFixture({
          repoRoot, workspacePath: 'packages/plugins/openai', packageName: '@happier-dev/plugins-openai',
        });
        writeBundledPluginSourceInputs({ repoRoot, pluginId: 'openai', writePackageJson: false });
        const packageJsonPath = join(openaiPackage, 'package.json');
        const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
        packageJson.exports = {
          './happier-plugin-ui/voice-runtime': { default: './dist/ui/voice/runtime.js' },
        };
        writeFileSync(packageJsonPath, JSON.stringify(packageJson));
        mkdirSync(join(openaiPackage, '.happier-plugin'), { recursive: true });
        writeFileSync(join(openaiPackage, '.happier-plugin/plugin.json'), JSON.stringify({
          schemaVersion: 2, id: 'happier.voice.openai', version: packageJson.version,
          displayName: 'OpenAI Voice', runtime: { apiVersion: 1 },
          contributes: { voiceProviders: [{
            id: 'realtime-openai', title: 'OpenAI Voice', kind: 'conversation',
            roles: ['realtime_conversation'], platforms: ['web', 'ios', 'android'],
            capabilities: { turn: { cancelResponse: false, bargeIn: false }, tools: { effectCalls: 'none' } },
            client: { artifactId: 'voice-runtime', exportName: 'activate' },
          }] },
        }));
        const inspectorPackage = writeWorkspacePackageFixture({
          repoRoot, workspacePath: 'packages/plugins/inspector', packageName: '@happier-dev/plugins-inspector',
        });
        writeBundledPluginSourceInputs({ repoRoot, pluginId: 'inspector', writePackageJson: false });
        mkdirSync(join(inspectorPackage, '.happier-plugin'), { recursive: true });
        writeFileSync(join(inspectorPackage, '.happier-plugin/plugin.json'), JSON.stringify({
          schemaVersion: 2, id: 'happier.inspector', version: '0.0.0', displayName: 'Inspector',
          runtime: { apiVersion: 1 },
        }));
        writeCliBundledHostPackage({ happyCliDir,
          bundledDependencies: ['@happier-dev/plugins-openai', '@happier-dev/plugins-inspector'] });
        const publish = async (args: readonly string[]) => await withWorkspaceBundleLock(
          async (lease) => await publishBundledPluginSemanticProjection(
            parseGeneratorCliArgs(['--mode', 'write', '--root', repoRoot, ...args]),
            { protocol: { ingestPluginManifestV2 } }, lease,
          ), { lockPath: join(repoRoot, 'publication.lock') },
        );
        const outputPath = join(repoRoot, 'apps/ui/sources/voice/registry/generatedBundledVoiceRuntimeEntries.ts');
        await publish(['--workspace', 'plugins-openai']);
        const healthy = readFileSync(outputPath, 'utf8');
        expect(healthy).toContain('@happier-dev/plugins-openai/happier-plugin-ui/voice-runtime');
        writeBundledPluginPublicationFailures(repoRoot, [{
          packageName: '@happier-dev/plugins-openai', pluginId: 'happier.voice.openai',
          diagnostic: { code: 'plugin_ui_artifact_invalid', message: 'Voice leaf missing' },
        }]);
        await publish(selector);
        expect(readFileSync(outputPath, 'utf8')).not.toContain('@happier-dev/plugins-openai');
        expect(readFileSync(join(happyCliDir, 'src/plugins/projection/registry/sources/generatedBundledPluginManifests.ts'), 'utf8'))
          .toContain('happier.voice.openai');
        await publish(['--workspace', 'plugins-openai']);
        expect(readFileSync(outputPath, 'utf8')).toBe(healthy);
      } finally { cleanup(); }
    },
  );

  it('migrates the legacy combined CLI registry during a scoped publication', () => {
    const scopedPublisher = sourceBetween(
      'if (options.workspaceNames.length > 0) {',
      '// Discover and validate every package before mutating host membership.',
    );

    expect(scopedPublisher).toContain('renderRetainedCliBundledPluginImplementationEntriesTs');
    expect(scopedPublisher).toContain('{ outPath: cliOutPath, out: cliOut }');
  });

  it('keeps retained Agent registration identities data-only', () => {
    const outputPath = join(mkdtempSync(join(tmpdir(), 'happier-cli-registry-')), 'generated.ts');
    writeFileSync(outputPath, [
      "import { createAgentRuntimeCatalogEntryHooks } from '../agentCatalogEntryHooks';",
      "import { PI_AGENT_RUNTIME_CONTRIBUTION } from '@happier-dev/plugins-pi/agent/contributions/catalog';",
      "import type { PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contribution-identity';",
      "import type { PluginSourceSpecV1 } from '@happier-dev/protocol/plugins/source-spec';",
      'export type BundledFirstPartyAgentRegistrationBinding = Readonly<{ identity: PluginContributionIdentityV1; }>;',
      'export const BUNDLED_FIRST_PARTY_PLUGIN_PACKAGE_NAMES = Object.freeze(["old"]);',
      'export const BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS = Object.freeze([{ pluginId: "old" }]);',
      'export const BUNDLED_FIRST_PARTY_AGENT_REGISTRATION_BINDINGS = Object.freeze([{',
      '  identity: createPluginContributionIdentity({ pluginId: "happier.agent.pi", localId: "pi" }),',
      '  implementationOwnerId: "pi",',
      "  registrationFamily: 'agents',",
      '  implementation: createAgentRuntimeCatalogEntryHooks({ contribution: PI_AGENT_RUNTIME_CONTRIBUTION }),',
      '}]);',
      '',
    ].join('\n'));

    const executableRenderer = sourceBetween(
      'function renderCliBundledPluginEntriesTs(',
      'function renderCliPromptAssetPluginDescriptorsTs(',
      registryRendererSource,
    );
    const output = renderRetainedCliBundledPluginImplementationEntriesTs(outputPath);

    expect(executableRenderer).not.toContain('./generatedBundledPluginManifests');
    expect(output).not.toContain('./generatedBundledPluginManifests');
    expect(output).toContain('BUNDLED_FIRST_PARTY_AGENT_REGISTRATION_BINDINGS: readonly BundledFirstPartyAgentRegistrationBinding[] = Object.freeze');
    expect(executableRenderer).not.toContain("pluginPackage.pluginPackageId === 'pi'");
    expect(executableRenderer).not.toContain('runtimeContributions');
    expect(output).not.toContain('implementation: createAgentRuntimeCatalogEntryHooks');
    expect(output).not.toContain('PI_AGENT_RUNTIME_CONTRIBUTION');
    expect(output).not.toContain('@happier-dev/plugins-pi');
    expect(output).not.toMatch(/plugins-(?:grok|kilo|ohmypi)\/agent\/contributions/u);
    expect(output).not.toContain('BUNDLED_FIRST_PARTY_PLUGIN_PACKAGE_NAMES = Object.freeze');
    expect(output).not.toContain('BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS = Object.freeze');
    expect(output).not.toContain('PluginSourceSpecV1');
  });
});

describe('readExternalSessionSourceDeclaration', () => {
  it('projects every public external-session source-instance kind without narrowing', () => {
    const declaration = readExternalSessionSourceDeclaration({
      sourceKind: 'externalPluginSource',
      schema: {
        fields: [
          { kind: 'literal', name: 'kind', value: 'externalPluginSource' },
          { kind: 'string', name: 'location', min: 1 },
        ],
      },
      key: {
        segments: [
          { kind: 'literal', value: 'externalPluginSource' },
          { kind: 'field', field: 'location' },
        ],
      },
      instances: [
        { kind: 'default', constants: { location: 'fallback' } },
        {
          kind: 'connectedServiceProfiles',
          serviceId: 'openai',
          constants: { location: 'connected' },
          fields: { serviceId: 'serviceId', profileId: 'profileId' },
        },
        {
          kind: 'agentSetting',
          settingId: 'endpoint',
          byServerIdSettingId: 'endpointByServer',
          field: 'location',
          normalization: 'httpOrigin',
          constants: { location: 'managed' },
        },
        {
          kind: 'agentSettingOverride',
          settingId: 'configuredDirectory',
          byServerIdSettingId: 'configuredDirectoryByServer',
          field: 'location',
          normalization: 'configuredPath',
          constants: { location: 'configured' },
        },
      ],
    }, 'externalPluginSource', 'external-plugin');

    expect(declaration).toMatchObject({
      agentId: 'external-plugin',
      sourceKind: 'externalPluginSource',
      schema: {
        fields: [
          { kind: 'literal', name: 'kind', value: 'externalPluginSource' },
          { kind: 'string', name: 'location', min: 1 },
        ],
      },
      key: {
        segments: [
          { kind: 'literal', value: 'externalPluginSource' },
          { kind: 'field', field: 'location' },
        ],
      },
      instances: [
        { kind: 'default', constants: { location: 'fallback' } },
        {
          kind: 'connectedServiceProfiles',
          serviceId: 'openai',
          constants: { location: 'connected' },
          fields: { serviceId: 'serviceId', profileId: 'profileId' },
        },
        {
          kind: 'agentSetting',
          settingId: 'endpoint',
          byServerIdSettingId: 'endpointByServer',
          field: 'location',
          normalization: 'httpOrigin',
          constants: { location: 'managed' },
        },
        {
          kind: 'agentSettingOverride',
          settingId: 'configuredDirectory',
          byServerIdSettingId: 'configuredDirectoryByServer',
          field: 'location',
          normalization: 'configuredPath',
          constants: { location: 'configured' },
        },
      ],
    });

    const projection = renderGeneratedExternalSessionSourcesTs([{
      agentId: 'external-plugin',
      declaration,
    }]);
    expect(projection).toContain('"kind": "agentSettingOverride"');
    expect(projection).toContain('"normalization": "configuredPath"');
  });

  it('projects an endpoint override without narrowing it to a configured path', () => {
    // Whether a configured source REPLACES the paired default is independent of
    // how its raw setting value is normalized. Narrowing the override kind to
    // `configuredPath` here made this projector a second, stricter owner of the
    // protocol declaration schema, so a declared server endpoint could not be an
    // override at all and every such Agent kept materializing its managed
    // default beside the server its operator named.
    const declaration = readExternalSessionSourceDeclaration({
      sourceKind: 'externalPluginServer',
      schema: {
        fields: [
          { kind: 'literal', name: 'kind', value: 'externalPluginServer' },
          { kind: 'unknown', name: 'baseUrl', optional: true },
        ],
      },
      key: {
        segments: [
          { kind: 'literal', value: 'externalPluginServer' },
          { kind: 'field', field: 'baseUrl' },
        ],
      },
      instances: [
        { kind: 'default', constants: {} },
        {
          kind: 'agentSettingOverride',
          settingId: 'serverBaseUrl',
          byServerIdSettingId: 'serverBaseUrlByServer',
          field: 'baseUrl',
          normalization: 'httpOrigin',
          constants: {},
        },
      ],
    }, 'externalPluginServer', 'external-plugin');

    expect(declaration.instances).toEqual([
      { kind: 'default', constants: {} },
      {
        kind: 'agentSettingOverride',
        settingId: 'serverBaseUrl',
        byServerIdSettingId: 'serverBaseUrlByServer',
        field: 'baseUrl',
        normalization: 'httpOrigin',
        constants: {},
      },
    ]);
  });
});

describe('bundled Voice UI declaration projection', () => {
  it('keeps qualified Voice presentation and speech settings available without resolving optional plugin modules', () => {
    const ingestion = ingestPluginManifestV2({
      schemaVersion: 2, id: 'happier.voice.google', version: '0.0.0', displayName: 'Google',
      runtime: { apiVersion: 1 },
    });
    if (!ingestion.ok) throw new Error(JSON.stringify(ingestion.diagnostics));
    const presentation = {
      providerId: 'happier.voice.google/gemini-stt',
      settingsSectionId: 'voice.stt.google_gemini',
      settingsSpec: {
        titleKey: 'speech.title', subtitleKey: 'speech.subtitle', detailKey: 'speech.detail',
        iconName: 'logo-google', fields: [], test: null,
      },
    };
    const output = renderBundledVoiceEntriesTs([{
      pluginPackageId: 'google', packageName: '@happier-dev/plugins-google', packageVersion: '0.0.0',
      pluginId: 'happier.voice.google', manifest: ingestion.manifest,
      hasConversationProvider: false, conversationClient: null, conversationPlatforms: [],
      presentations: [presentation],
    }]);
    expect(output).not.toMatch(/from ['"]@happier-dev\/plugins-/u);
    expect(output).toContain('speech.title');
    expect(output).toContain('createBundledVoiceProviderPresentations');
  });
  it('shares runtime bytes for equal platform membership and distinguishes a platform subset', () => {
    const ingestion = ingestPluginManifestV2({
      schemaVersion: 2, id: 'happier.agent.codex', version: '0.0.0', displayName: 'Codex',
      engines: { happier: '^0.0.0' }, runtime: { apiVersion: 1 },
    });
    if (!ingestion.ok) throw new Error(JSON.stringify(ingestion.diagnostics));
    const shared = {
      pluginPackageId: 'codex',
      packageName: '@happier-dev/plugins-codex',
      packageVersion: '0.0.0',
      pluginId: 'happier.agent.codex',
      manifest: ingestion.manifest,
      hasConversationProvider: true,
      conversationClient: { artifactId: 'voice-runtime-web', exportName: 'activate' },
      conversationPlatforms: ['web', 'ios', 'android'],
      presentations: [],
    } satisfies Parameters<typeof renderBundledVoiceRuntimeEntriesTs>[0][number];
    const sources = [shared];
    const web = renderBundledVoiceRuntimeEntriesTs(sources, 'web');
    const excluded = renderBundledVoiceRuntimeEntriesTs(sources, 'web', new Set([shared.packageName]));
    expect(excluded).not.toContain(shared.packageName);
    expect(excluded).not.toContain('CODEX_BUNDLED_VOICE_ACTIVATE');
    expect(renderBundledVoiceRuntimeEntriesTs(sources, 'web', new Set())).toBe(web);
    expect(renderBundledVoiceRuntimeEntriesTs(sources, 'ios')).toBe(web);
    expect(renderBundledVoiceRuntimeEntriesTs(sources, 'android')).toBe(web);
    const webOnly = [{ ...shared, conversationPlatforms: ['web'] as const }];
    expect(renderBundledVoiceRuntimeEntriesTs(webOnly, 'ios')).not.toContain('CODEX_BUNDLED_VOICE_ACTIVATE');
    expect(renderBundledVoiceRuntimeEntriesTs(webOnly, 'web')).toContain('CODEX_BUNDLED_VOICE_ACTIVATE');
  });
  it('projects manifest JSON without a plugin manifest-module import and retains only executable UI imports', () => {
    const manifestProjection = sourceBetween(
      'function renderBundledVoiceManifestProjectionConstant(',
      'function renderBundledVoiceEntriesTs(',
      voiceRendererSource,
    );
    const metadataRenderer = sourceBetween(
      'function renderBundledVoiceEntriesTs(',
      'function renderBundledVoiceRuntimeEntriesTs(',
      voiceRendererSource,
    );
    const runtimeRenderer = voiceRendererSource.slice(voiceRendererSource.indexOf('function renderBundledVoiceRuntimeEntriesTs('));

    expect(manifestProjection).toContain('Object.freeze(');
    expect(manifestProjection).toContain('renderJsonLiteral(source.manifest');
    expect(metadataRenderer).not.toContain('${source.packageName}/manifest');
    expect(metadataRenderer).toContain('renderBundledVoiceManifestProjectionConstant(source)');
    expect(metadataRenderer).toContain('createBundledVoiceProviderPresentations');
    expect(metadataRenderer).not.toContain('activate as');
    expect(runtimeRenderer).not.toContain('${source.packageName}/manifest');
    expect(runtimeRenderer).toContain('renderBundledVoiceManifestProjectionConstant(source)');
    expect(runtimeRenderer).toContain(
      '${source.conversationClient.exportName} as ${prefix}_BUNDLED_VOICE_ACTIVATE',
    );
  });

  it('reads committed manifest bytes through the canonical Protocol parser and reports invalid artifacts', () => {
    const manifestReader = sourceBetween(
      'function readCommittedBundledPluginManifest(',
      'async function synchronizeSerializedPluginManifest(',
    );
    const manifestNormalizer = sourceBetween(
      'function normalizePluginManifest(',
      'async function loadPluginManifest(',
    );

    expect(manifestReader).toContain('readFileSync(manifestPath)');
    expect(manifestReader).toContain('normalizePluginManifest(readFileSync(manifestPath), manifestPath, parser)');
    expect(manifestReader).toContain('Invalid bundled plugin manifest artifact');
    expect(manifestNormalizer).toContain('parser.ingestPluginManifestV2(rawManifest)');
  });

  it('reads every bundled plugin manifest through one isolated-module loader', () => {
    const manifestLoader = sourceBetween(
      'async function loadPluginManifest(',
      'function readCommittedBundledPluginManifest(',
    );

    expect(manifestLoader).toContain('await importTypescriptModule(manifestPath)');
    // A second, package-specific manifest reader is a split-brain owner: voice
    // packages are authored exactly like every other first-party plugin.
    expect(manifestLoader).not.toContain('isBundledFirstPartyVoicePackageId(pluginPackageId)');
    expect(generatorSource).not.toContain('readStaticVoiceManifest');
  });
});
