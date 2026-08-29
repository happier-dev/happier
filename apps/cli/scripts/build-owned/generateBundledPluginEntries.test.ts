import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  collectBundledPluginUiTranslations,
  shouldHoldGeneratorWorkspaceLockDuringGeneration,
  readExternalSessionSourceDeclaration,
  renderRetainedCliBundledPluginImplementationEntriesTs,
  renderGeneratedExternalSessionSourcesTs,
} from './generateBundledPluginEntries.ts';
import { BUNDLED_FIRST_PARTY_IMMUTABLE_ARTIFACTS } from '../../src/plugins/projection/registry/sources/generatedBundledPluginArtifacts';

const generatorSource = readFileSync(new URL('./generateBundledPluginEntries.ts', import.meta.url), 'utf8');
const RETIRED_CODEX_IMMUTABLE_GENERATION_ID = 'bundled-13457e22-f993-4eb8-9d67-77caad02eefe';

function sourceBetween(startMarker: string, endMarker: string): string {
  const start = generatorSource.indexOf(startMarker);
  const end = generatorSource.indexOf(endMarker, start);
  if (start < 0 || end < 0) {
    throw new Error(`Missing generator source range ${startMarker}…${endMarker}`);
  }
  return generatorSource.slice(start, end);
}

describe('generator workspace lock policy', () => {
  it('does not serialize a read-only drift check behind the CLI publication lock', () => {
    expect(shouldHoldGeneratorWorkspaceLockDuringGeneration('check')).toBe(false);
    expect(shouldHoldGeneratorWorkspaceLockDuringGeneration('write')).toBe(true);
  });

  it('publishes Plugin SDK API governance after generated inputs and before runtime staging', () => {
    const synchronization = sourceBetween(
      'async function synchronizeGeneratorAuthoringRuntimeClosure(',
      'type PluginAuthorRuntimeModules =',
    );

    expect(synchronization).toContain("if (mode === 'write') {");
    expect(synchronization).toContain('await publishPluginSdkApiGovernanceOutputs();');
    expect(synchronization).toContain(
      "await sync(false, GENERATOR_BUILD_PREP_STAMP_PATH, ['plugin-sdk']);",
    );
    expect(synchronization.indexOf('await publishPluginSdkApiGovernanceOutputs();'))
      .toBeLessThan(synchronization.indexOf('const hostWorkspaceNames ='));
  });

  it('prepares Plugin SDK vendored declarations before API governance materialization', () => {
    const publication = sourceBetween(
      'async function publishPluginSdkApiGovernanceOutputs()',
      '/**\n * `--mode check`',
    );

    expect(publication).toContain("'scripts/bundleWorkspaceDeps.mjs'");
    expect(publication).toContain("['--declarations', '--run-script=api-governance:prepared']");
    expect(publication).not.toContain("'scripts/apiSurfaceCli.mjs'");
    expect(publication).not.toContain("'scripts/workspaces/buildTypeScriptPackageDist.mjs'");
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
      'await synchronizeGeneratorAuthoringRuntimeClosure(options.mode, inheritedLockValue);',
    );
  });
});

describe('bundled plugin UI translation aggregation', () => {
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
  it('publishes a replacement Codex identity without a publisher-local retirement owner', () => {
    const codex = BUNDLED_FIRST_PARTY_IMMUTABLE_ARTIFACTS.find(
      (artifact) => artifact.record.pluginId === 'happier.agent.codex',
    );
    if (!codex) throw new Error('Expected the generated Codex immutable artifact');

    expect(codex.record.immutableGenerationId).not.toBe(RETIRED_CODEX_IMMUTABLE_GENERATION_ID);
    expect(generatorSource).not.toContain(RETIRED_CODEX_IMMUTABLE_GENERATION_ID);
    const assignment = sourceBetween(
      'function assignBundledImmutableArtifactGenerationIds(',
      'function createCanonicalWorkspacePackageRootsReader(',
    );
    expect(assignment).not.toContain('isRetiredBundledImmutableGenerationIdentity(');
  });

  it('keeps opaque publication identity independent from source-content equality', () => {
    const assignment = sourceBetween(
      'function assignBundledImmutableArtifactGenerationIds(',
      'function createCanonicalWorkspacePackageRootsReader(',
    );

    expect(assignment).toContain("mode: Mode;");
    expect(assignment).toContain("input.mode === 'check'");
    expect(assignment).not.toContain('sameBundledSourceArtifactIntegrity(');
    expect(generatorSource).not.toContain('function sameBundledSourceArtifactIntegrity(');
  });

  it('emits the contribution-identity owner subpath instead of the Protocol root barrel', () => {
    const registryRenderer = sourceBetween(
      'function renderCliBundledPluginManifestEntriesTs(',
      'function renderCliBundledPluginArtifactRecordsTs(',
    );

    expect(registryRenderer).toContain(
      "@happier-dev/protocol/plugins/contribution-identity",
    );
    expect(registryRenderer).toContain(
      "import type { PluginSourceSpecV1 } from '@happier-dev/protocol/plugins/source-spec';",
    );
    expect(registryRenderer).not.toContain(
      "from '@happier-dev/protocol';",
    );
  });

  it('keeps generated manifest locators data-only without target semantic sidecars', () => {
    const registryRenderer = sourceBetween(
      'function renderCliBundledPluginManifestEntriesTs(',
      'function renderCliBundledPluginArtifactRecordsTs(',
    );

    expect(registryRenderer).not.toContain('targeted-contributions');
    expect(registryRenderer).not.toContain('semanticPointRefs');
    expect(registryRenderer).not.toContain('@happier-dev/plugin-sdk');
  });

  it('keeps the source-integrity inventory in the build-owned publisher corridor', () => {
    const runtimeRenderer = sourceBetween(
      'function renderCliBundledPluginArtifactRecordsTs(',
      'function renderBundledPluginSourceIntegritiesJson(',
    );
    const buildInventoryRenderer = sourceBetween(
      'function renderBundledPluginSourceIntegritiesJson(',
      'function requireBundledPluginSourceArtifactIntegrity(',
    );

    expect(runtimeRenderer).not.toContain('BUNDLED_FIRST_PARTY_SOURCE_ARTIFACT_INTEGRITIES');
    expect(runtimeRenderer).not.toContain('digest: string');
    expect(buildInventoryRenderer).toContain('BUNDLED_FIRST_PARTY_SOURCE_ARTIFACT_INTEGRITIES');
    expect(generatorSource).toContain(
      'apps/cli/scripts/build-owned/generatedBundledPluginSourceIntegrities.json',
    );
  });

  it('publishes serialized manifest locators through the aggregate final-artifact owner', () => {
    const aggregatePublisher = sourceBetween(
      'async function publishBundledPluginUiArtifactProjection(',
      'function renderBundledAgentDefinitionsTs(',
    );

    expect(aggregatePublisher).toContain('renderCliBundledPluginManifestEntriesTs({ pluginPackages })');
    expect(aggregatePublisher).toContain('generatedBundledPluginManifests.ts');
    expect(aggregatePublisher).toContain('cliManifestOutPath');
  });

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
      'export function renderRetainedCliBundledPluginImplementationEntriesTs(',
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
  it('projects manifest JSON without a plugin manifest-module import and retains only executable UI imports', () => {
    const manifestProjection = sourceBetween(
      'function renderBundledVoiceManifestProjectionConstant(',
      'function renderBundledVoiceEntriesTs(',
    );
    const metadataRenderer = sourceBetween(
      'function renderBundledVoiceEntriesTs(',
      'function renderBundledVoiceRuntimeEntriesTs(',
    );
    const runtimeRenderer = sourceBetween(
      'function renderBundledVoiceRuntimeEntriesTs(',
      'async function generateBundledPluginEntries(',
    );

    expect(manifestProjection).toContain('Object.freeze(');
    expect(manifestProjection).toContain('renderJsonLiteral(source.manifest');
    expect(metadataRenderer).not.toContain('${source.packageName}/manifest');
    expect(metadataRenderer).toContain('renderBundledVoiceManifestProjectionConstant(source)');
    expect(metadataRenderer).toContain('VOICE_PROVIDER_PRESENTATIONS');
    expect(metadataRenderer).not.toContain('activate as');
    expect(runtimeRenderer).not.toContain('${source.packageName}/manifest');
    expect(runtimeRenderer).toContain('renderBundledVoiceManifestProjectionConstant(source)');
    expect(runtimeRenderer).toContain('activate as ${prefix}_BUNDLED_VOICE_ACTIVATE');
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
