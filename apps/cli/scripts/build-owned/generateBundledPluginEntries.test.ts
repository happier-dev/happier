import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { INTERNAL_CLAUDE_EVENT_TYPES } from '../../../../packages/plugins/claude/src/agent/transcripts/internalEventTypes';
import * as piDefinition from '../../../../packages/plugins/pi/src/agent/definition';
import * as codexDefinition from '../../../../packages/plugins/codex/src/agent/definition';
import * as claudeDefinition from '../../../../packages/plugins/claude/src/agent/definition';
import * as ohMyPiDefinition from '../../../../packages/plugins/ohmypi/src/agent/definition';
import { collectBundledFirstPartyVoiceProjectionSources, collectBundledPluginUiTranslations, reconcileBundledPluginInstalledRuntime, readExternalSessionSourceDeclaration, renderRetainedCliBundledPluginImplementationEntriesTs, resolveGeneratorPackagedRuntimePreparation, selectCanonicalRuntimeWorkspacePackageRoots, publishBundledPluginSemanticProjection, readInheritedBundledPluginFailures, parsePreparedGeneratorPublication } from './generateBundledPluginEntries.ts';
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
import { collectBundledAgentContributionIdentities } from './generateBundledPluginEntries.ts';
import { renderAgentIdsTs } from './bundledPlugins/agentFacts.ts';
import { BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS } from '../../src/plugins/projection/registry/sources/generatedBundledPluginManifests';
import { readGeneratorAuthoringSourceFingerprint, readGeneratorHostProjectionCurrentness } from './generateBundledPluginEntries.ts';
import { readGeneratorCliPreparationFingerprint } from './bundledPlugins/authoringInputs.mjs';
import { withGeneratorSingleFlight } from './bundledPlugins/publication.ts';

const generatorSource = readFileSync(new URL('./generateBundledPluginEntries.ts', import.meta.url), 'utf8');
const registryRendererSource = readFileSync(new URL('./bundledPlugins/registry.ts', import.meta.url), 'utf8');
const voiceRendererSource = readFileSync(new URL('./bundledPlugins/voice.ts', import.meta.url), 'utf8');

describe('bundled generator preparation process boundary', () => {
  it('rejects changed authoring source without invalidating built outputs for unrelated daemon edits', () => {
    const root = mkdtempSync(join(tmpdir(), 'bundled-authoring-inputs-'));
    const author = join(root, 'src/plugins/authoring/sourceModule.ts');
    const daemon = join(root, 'src/daemon/daemon.ts');
    mkdirSync(join(root, 'src/plugins/authoring'), { recursive: true });
    mkdirSync(join(root, 'src/daemon'), { recursive: true });
    writeFileSync(author, 'export const author = 1;');
    writeFileSync(daemon, 'export const daemon = 1;');
    try {
      const first = readGeneratorAuthoringSourceFingerprint(root);
      writeFileSync(daemon, 'export const daemon = 2;');
      expect(readGeneratorAuthoringSourceFingerprint(root)).toBe(first);
      writeFileSync(author, 'export const author = 2;');
      expect(readGeneratorAuthoringSourceFingerprint(root)).not.toBe(first);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('does not invalidate completed generator preparation for an unrelated CLI resource edit', () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'bundled-cli-preparation-inputs-'));
    const root = join(repoDir, 'apps/cli');
    const author = join(root, 'src/plugins/authoring/sourceModule.ts');
    const resource = join(root, 'src/mcp/resources/watchSubscriptions.ts');
    mkdirSync(dirname(author), { recursive: true });
    mkdirSync(dirname(resource), { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@happier-dev/cli' }));
    writeFileSync(author, 'export const author = 1;');
    writeFileSync(resource, 'export const resource = 1;');
    try {
      const first = readGeneratorCliPreparationFingerprint(root);
      writeFileSync(resource, 'export const resource = 2;');
      expect(readGeneratorCliPreparationFingerprint(root)).toBe(first);
      writeFileSync(author, 'export const author = 2;');
      expect(readGeneratorCliPreparationFingerprint(root)).not.toBe(first);
      const authored = readGeneratorCliPreparationFingerprint(root);
      const missingOutputs = readGeneratorHostProjectionCurrentness(repoDir);
      const generated = join(root, 'src/plugins/projection/registry/sources/generatedBundledPlugins.ts');
      mkdirSync(dirname(generated), { recursive: true });
      writeFileSync(generated, 'export const generated = [];');
      expect(readGeneratorCliPreparationFingerprint(root)).toBe(authored);
      expect(readGeneratorHostProjectionCurrentness(repoDir)).not.toBe(missingOutputs);
      const ui = join(repoDir, 'apps/ui/sources/agents/registry/generatedBundledPluginEntries.ts');
      mkdirSync(dirname(ui), { recursive: true });
      const beforeUi = readGeneratorHostProjectionCurrentness(repoDir);
      writeFileSync(ui, 'export const generated = [];');
      expect(readGeneratorHostProjectionCurrentness(repoDir)).not.toBe(beforeUi);
      const beforeUiDependencies = readGeneratorHostProjectionCurrentness(repoDir);
      writeFileSync(join(repoDir, 'apps/ui/package.json'), JSON.stringify({ dependencies: {} }));
      expect(readGeneratorHostProjectionCurrentness(repoDir)).not.toBe(beforeUiDependencies);
    } finally { rmSync(repoDir, { recursive: true, force: true }); }
  });
  it('preserves optional-plugin exclusions and dependency currentness across child serialization', () => {
    const prepared = {
      dependencyCurrentness: 'prepared dependency signature',
      pluginFailures: [{
        packageName: '@happier-dev/plugins-channels', pluginId: 'happier.channels',
        diagnostic: { code: 'plugin_manifest_invalid', message: 'manifest rejected' },
      }],
    };
    expect(parsePreparedGeneratorPublication(JSON.parse(JSON.stringify(prepared)))).toEqual(prepared);
    expect(() => parsePreparedGeneratorPublication({ ...prepared, dependencyCurrentness: null })).toThrow();
    expect(() => parsePreparedGeneratorPublication({ ...prepared, pluginFailures: [{ packageName: 'not-a-plugin' }] })).toThrow();
  });
  it.each(['drift', 'compiler'] as const)('preserves terminal %s failure across a real private child without retrying it', async (mode) => {
    const root = mkdtempSync(join(tmpdir(), 'bundled-terminal-child-'));
    const source = join(root, 'source');
    writeFileSync(source, 'first');
    let children = 0;
    const childSource = `
      import { execFile } from 'node:child_process';
      import { writeFileSync } from 'node:fs';
      import { promisify } from 'node:util';
      import { BuildInputDriftError, WorkspacePackageBuildError, withSingleTrailingBuildPass, serializeTerminalBuildFailure }
        from ${JSON.stringify(new URL('../../../../scripts/workspaces/buildInputConvergence.mjs', import.meta.url).href)};
      const [source, mode] = process.argv.slice(1);
      try {
        await withSingleTrailingBuildPass({ run: async (trailing) => {
          writeFileSync(source, trailing ? 'third' : 'second');
          if (mode === 'drift') throw new BuildInputDriftError('inputs still moving');
          try { await promisify(execFile)(process.execPath, ['-e', 'throw new Error("compiler rejected current source")']); }
          catch (error) { throw new WorkspacePackageBuildError(error); }
        } });
      } catch (error) {
        process.send(serializeTerminalBuildFailure(error), () => { process.disconnect(); process.exitCode = 1; });
      }
    `;
    try {
      await expect(withGeneratorSingleFlight({
        readFingerprint: () => readFileSync(source, 'utf8'),
        stampPath: join(root, 'readiness.json'),
        lockOptions: { lockPath: join(root, 'publication.lock') },
        prepare: async () => {
          children++;
          await new Promise<void>((resolve, reject) => {
            let failure: unknown;
            const child = spawn(process.execPath, ['--input-type=module', '-e', childSource, source, mode], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
            child.on('message', (message: unknown) => {
              try { parsePreparedGeneratorPublication(message); }
              catch (error) { failure = error; }
            });
            child.once('error', reject);
            child.once('exit', (code) => code === 0 ? resolve() : reject(failure ?? new Error('child failed without its terminal result')));
          });
        },
        run: async () => { throw new Error('terminal preparation must not publish'); },
      })).rejects.toMatchObject(mode === 'drift'
        ? { code: 'BUILD_INPUTS_CHANGED', trailingPassExhausted: true }
        : { code: 'WORKSPACE_PACKAGE_BUILD_FAILED' });
      expect(children).toBe(1);
      expect(existsSync(join(root, 'readiness.json'))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

function sourceBetween(startMarker: string, endMarker: string, source = generatorSource): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  if (start < 0 || end < 0) {
    throw new Error(`Missing generator source range ${startMarker}…${endMarker}`);
  }
  return source.slice(start, end);
}

describe('generated output ownership', () => {
  it('retains source catalog identities when optional Agent publication is unavailable', () => {
    const identities = collectBundledAgentContributionIdentities([], {
      agents: { AGENT_IDS, BUNDLED_AGENT_CONTRIBUTION_IDENTITIES },
    });
    expect(identities.ohMyPi).toEqual({
      pluginId: 'happier.agent.ohmypi', localId: 'ohmypi',
    });
    expect(() => renderAgentIdsTs({ agentIds: AGENT_IDS, contributionIdentities: identities }))
      .not.toThrow();
    expect(() => renderAgentIdsTs({ agentIds: ['undeclared-agent'], contributionIdentities: identities }))
      .toThrow(/Missing bundled plugin contribution identity/u);
  });
  it('refreshes retained identities from the authored Agent routing id and manifest local id', () => {
    const locator = BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS.find((entry) => entry.pluginId === 'happier.agent.ohmypi');
    const ingestion = ingestPluginManifestV2(locator?.manifest);
    if (!ingestion.ok) throw new Error(JSON.stringify(ingestion.diagnostics));
    const identities = collectBundledAgentContributionIdentities([{
      pluginPackageId: 'ohmypi', pluginId: ingestion.manifest.id,
      packageName: '@happier-dev/plugins-ohmypi', packageVersion: '0.0.0',
      agentId: ohMyPiDefinition.AGENT_DEFINITION.id, manifest: ingestion.manifest,
    }], {
      agents: {
        AGENT_IDS,
        BUNDLED_AGENT_CONTRIBUTION_IDENTITIES: {
          ...BUNDLED_AGENT_CONTRIBUTION_IDENTITIES,
          ohMyPi: { pluginId: 'happier.agent.ohmypi', localId: 'stale' },
        },
      },
    });
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

describe('generator workspace lock policy', () => {
  it('keeps API governance in the SDK check and prepack lanes', () => {
    const synchronization = sourceBetween(
      'async function synchronizeGeneratorAuthoringRuntimeClosure(',
      'type PluginAuthorRuntimeModules =',
    );
    expect(synchronization).not.toContain('api-governance:prepared');
    expect(synchronization).toContain(
      "await sync(false, GENERATOR_BUILD_PREP_STAMP_PATH, ['plugin-sdk']);",
    );
    expect(generatorSource).not.toContain('publishPluginSdkApiGovernanceOutputs');
  });

  it('keeps check-mode generated compiler-input preparation read-only', () => {
    const synchronization = sourceBetween(
      'async function synchronizeGeneratorAuthoringRuntimeClosure(',
      'type PluginAuthorRuntimeModules =',
    );

    expect(synchronization).toContain(
      'generatedCompilerInputMode: preparationPolicy.generatedCompilerInputMode,',
    );
    expect(synchronization).not.toContain("generatedCompilerInputMode: 'write',");
  });

  it('admits the final combined authoring closure rather than an earlier partial preparation', () => {
    const synchronization = sourceBetween(
      'async function synchronizeGeneratorAuthoringRuntimeClosure(',
      'function captureGeneratorDependencyCurrentness(',
    );

    // The final host pass also prepares the SDK's transitive dependencies.
    // Its recorded publication must cover both scopes; the earlier SDK-only
    // stamp can be superseded by that same invocation's later package builds.
    expect(synchronization).toContain('workspaceNames: generatorPublicationDependencyNames(),');
    expect(synchronization).toContain('stampPath: GENERATOR_STAGE_PREP_STAMP_PATH,');
    expect(synchronization).not.toContain('[GENERATOR_BUILD_PREP_STAMP_PATH,');
    expect(synchronization).toContain('requireExactOutputs: true,');
    expect(synchronization).toContain('verifyMaterializedOutputs: true,');
  });

  it('carries the publication lease into packaged-runtime workspace preparation', () => {
    const synchronization = sourceBetween(
      'async function prepareSelectedBundledPluginWorkspaceOutputs(',
      'type PluginAuthorRuntimeModules =',
    );

    // A caller's authenticated inherited lease remains usable. The generator
    // no longer acquires a containing lease around this package preparation.
    expect(synchronization).toContain(
      `env: createWorkspaceChildBuildEnv({
      env: process.env,
      heldLockValue: input.inheritedLockValue,
    }),`,
    );
  });

  it('prepares the authoring runtime for scoped workspace publication too', () => {
    const mainSource = sourceBetween(
      'export async function main(',
      "if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href)",
    );

    expect(mainSource).toContain('if (!options.aggregateOnly) {');
    expect(mainSource).not.toContain(
      'options.workspaceNames.length === 0 && !options.aggregateOnly',
    );
    expect(mainSource).toContain(
      'await synchronizeGeneratorAuthoringRuntimeClosure(',
    );
    expect(mainSource.indexOf('await loadPluginAuthorRuntimeForScope(authorRuntimeLoadScope);'))
      .toBeGreaterThan(mainSource.indexOf('await withGeneratorPublicationLock('));
  });

  it('keeps source-synchronized projections read-only during target-owned publication', () => {
    const projectionPublisher = sourceBetween(
      'async function publishBundledPluginSemanticProjection(',
      'function collectBundledAgentContributionIdentities(',
    );
    const targetedPublisher = sourceBetween(
      'if (options.workspaceNames.length > 0) {',
      '// Discover and validate every package before mutating host membership.',
    );
    const packagedRuntimePublisher = sourceBetween(
      'async function prepareBundledPluginPackageArtifacts(',
      'const BUNDLED_PLUGIN_WORKSPACE_PACKAGE_PREFIX',
    );
    const mainSource = sourceBetween(
      'export async function main(',
      "if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href)",
    );

    expect(projectionPublisher).toContain('...(!options.targetOwnedOnly');
    expect(projectionPublisher).toContain('? [{ outPath: cliManifestOutPath, out: cliManifestOut }]');
    expect(targetedPublisher).toContain('? [{ outPath: cliOutPath, out: cliOut }]');
    expect(packagedRuntimePublisher).toContain(
      "params.mode === 'check' || params.targetOwnedOnly === true",
    );
    expect(mainSource).toContain('targetOwnedOnly: options.targetOwnedOnly,');
    expect(generatorSource).toContain('const mode: Mode = input.options.mode;');
    expect(generatorSource).not.toContain(
      "const mode: Mode = input.options.targetOwnedOnly ? 'check' : input.options.mode;",
    );
  });

  it('publishes generated compiler inputs under the canonical lock without the authoring closure', () => {
    // `--compiler-inputs` is the pre-build choke point `buildSharedDeps.mjs`
    // runs before `agents`/`cli-common`/`plugin-sdk` compile. Preparing the
    // authoring runtime closure here would compile the very packages this mode
    // exists to unblock. The existing publication lock is still required around
    // its read/compare/write transaction, and the inherited lease makes the
    // nested full-publication call safely reentrant.
    const mainSource = sourceBetween(
      'export async function main(',
      "if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href)",
    );

    expect(mainSource).toContain('if (options.compilerInputsOnly) {');
    expect(mainSource.indexOf('if (options.compilerInputsOnly) {'))
      .toBeLessThan(mainSource.indexOf('await synchronizeGeneratorAuthoringRuntimeClosure('));

    const dispatch = mainSource.slice(
      mainSource.indexOf('if (options.compilerInputsOnly) {'),
      mainSource.indexOf('const authorRuntimeLoadScope ='),
    );
    expect(dispatch).toContain('await withGeneratorPublicationLock(');
    expect(dispatch).toContain(
      'async (context) => await publishGeneratedCompilerInputs(options, context),',
    );
    expect(dispatch).toContain('inheritedLockValue,');
    expect(dispatch).toContain('return;');
    expect(dispatch).not.toContain('await synchronizeGeneratorAuthoringRuntimeClosure(');
    expect(dispatch).not.toContain('await withGeneratorWorkspaceLock(');
  });

  it('uses the prepared publication owner for dependency loading and commit', () => {
    const publicationLock = sourceBetween(
      'async function withGeneratorPublicationLock<T>(',
      'export async function main(',
    );
    const mainSource = sourceBetween(
      'export async function main(',
      "if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href)",
    );

    expect(publicationLock).toContain('return await withPreparedGeneratorPublication({');
    expect(publicationLock).toContain('prepare,');
    expect(publicationLock).toContain('heldLockValue,');
    expect(publicationLock).not.toContain('loadGeneratorWorkspaceDependencies');
    expect(mainSource).toContain('await withGeneratorPublicationLock(');
    expect(mainSource).toContain('const dependencies = await loadGeneratorWorkspaceDependencies();');
    expect(mainSource).toContain('inheritedLockValue,');
  });

  it('publishes runtime-consumed Agent facts in a private child before parent runtime loading', () => {
    const privatePhase = sourceBetween(
      'async function runRuntimeConsumedAgentFactsPrivatePhase(',
      'async function collectBundledPluginPackages(',
    );
    const mainSource = sourceBetween(
      'export async function main(',
      "if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href)",
    );
    const directEntry = generatorSource.slice(
      generatorSource.indexOf("if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href)"),
    );

    expect(generatorSource).not.toContain('beforeRuntimeStaging');
    expect(privatePhase).toContain('await collectBundledPluginSourcePackages({');
    expect(privatePhase.indexOf('throwBundledPluginPackageFailures('))
      .toBeLessThan(privatePhase.indexOf('publishCoherentProjectionOutputs('));
    expect(privatePhase.indexOf('collectBundledAgentDefinitionProjection('))
      .toBeLessThan(privatePhase.indexOf('publishCoherentProjectionOutputs('));
    expect(mainSource).toContain('await publishGeneratedCompilerInputs(options, publicationLease);');
    expect(mainSource).not.toContain('await runCanonicalPluginSdkGeneratedCompilerInputs({');
    expect(mainSource.indexOf('await publishGeneratedCompilerInputs(options, publicationLease);'))
      .toBeLessThan(mainSource.indexOf('await runRuntimeConsumedAgentFactsPrivateChild(argv, inheritedLockValue);'));
    expect(mainSource).toContain('await runRuntimeConsumedAgentFactsPrivateChild(argv, inheritedLockValue);');
    expect(privatePhase).not.toContain('await synchronizeGeneratorAuthoringRuntimeClosure(');
    expect(mainSource).not.toContain('inheritedLockValue: publicationLease.heldLockValue');
    expect(directEntry).toContain('async () => await synchronizeGeneratorAuthoringRuntimeClosure(');
    expect(directEntry).toContain('PRIVATE_RUNTIME_CONSUMED_AGENT_FACTS_PHASE_ENV');
    expect(directEntry.indexOf('delete process.env[PRIVATE_RUNTIME_CONSUMED_AGENT_FACTS_PHASE_ENV];'))
      .toBeLessThan(directEntry.indexOf('runRuntimeConsumedAgentFactsPrivatePhase('));
    expect(directEntry).toContain('runRuntimeConsumedAgentFactsPrivatePhase(');
  });

  it('loads compiler-input dependencies through bounded owner subpaths', () => {
    // This path runs before the shared workspace build and must stay cheap and
    // terminating on a cold source-dev filesystem. The package root barrels
    // pull in the complete Agent/Protocol runtime and may retain live handles.
    const loader = sourceBetween(
      'async function loadGeneratedCompilerInputDependencies()',
      'async function synchronizeGeneratorAuthoringRuntimeClosure(',
    );

    expect(loader).toContain("importCanonicalWorkspaceModule(");
    expect(loader).toContain("'@happier-dev/agents'");
    expect(loader).toContain("'agent-ids'");
    expect(loader).not.toContain("importCanonicalWorkspaceModule('@happier-dev/protocol'");
    expect(loader).not.toContain("importCanonicalWorkspaceModule('@happier-dev/agents'),");

    const publication = sourceBetween(
      'async function publishGeneratedCompilerInputs(',
      'function collectReleasedFlatSessionMetadataRuntimeDescriptorReaderContributions(',
    );
    expect(publication).not.toContain('readSerializedBundledPluginPackages');
  });

  it('loads the full generator dependency slice without package root barrels', () => {
    const loader = sourceBetween(
      'async function loadGeneratorWorkspaceDependencies()',
      '/**\n * Loads only the Agents runtime',
    );

    expect(loader).toContain("importCanonicalWorkspaceModule('@happier-dev/agents', 'manifest')");
    expect(loader).toContain("importCanonicalWorkspaceModule('@happier-dev/agents', 'definitions')");
    expect(loader).toContain("importCanonicalWorkspaceModule('@happier-dev/protocol', 'plugins/manifest')");
    expect(loader).not.toContain("importCanonicalWorkspaceModule('@happier-dev/protocol', 'plugins/ui')");
    expect(loader).not.toContain("importCanonicalWorkspaceModule('@happier-dev/agents'),");
    expect(loader).not.toContain("importCanonicalWorkspaceModule('@happier-dev/protocol'),");
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
      "export const translated: string = BUNDLED_PLUGIN_TRANSLATIONS.en['plugins.example.message599'];",
    ].join('\n'));
    try {
      execFileSync(process.execPath, [
        'scripts/workspaces/runTypeScriptCli.mjs', '--declaration', '--emitDeclarationOnly',
        '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'Bundler',
        '--skipLibCheck', '--outDir', join(root, 'declarations'), generated, consumer,
      ], { cwd: new URL('../../../../', import.meta.url), stdio: 'pipe' });
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
          manifestOverrides: { exports: { './happier-plugin-ui/voice-runtime': { default: './dist/ui/voice/runtime.js' } } },
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
