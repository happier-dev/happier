/** Pure projection rendering; filesystem, preparation and publication stay in the generator. */
import {
  renderJsonLiteral,
} from './literals.ts';
import type {
  BundledFirstPartyVoicePackageId,
  BundledFirstPartyVoiceProjectionSource,
  BundledVoiceRuntimePlatform,
  JsonValue,
} from './projectionFacts.ts';

function toBundledVoiceImportPrefix(packageId: BundledFirstPartyVoicePackageId): string {
  return packageId.toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

function renderBundledVoiceManifestProjectionConstant(
  source: BundledFirstPartyVoiceProjectionSource,
): readonly string[] {
  const prefix = toBundledVoiceImportPrefix(source.pluginPackageId);
  return [
    `const ${prefix}_BUNDLED_PLUGIN_MANIFEST = Object.freeze(`,
    `${renderJsonLiteral(source.manifest as unknown as JsonValue)} as const,`,
    ');',
  ];
}

export function renderBundledVoiceEntriesTs(
  sources: readonly BundledFirstPartyVoiceProjectionSource[],
): string {
  const lines: string[] = [];
  lines.push('/**');
  lines.push(' * GENERATED FILE CONTRACT (VOICE-FIRST-PARTY-PROJECTION)');
  lines.push(' *');
  lines.push(' * This file is emitted by:');
  lines.push(' * - `apps/cli/scripts/build-owned/generateBundledPluginEntries.ts`');
  lines.push(' *');
  lines.push(' * Normalized first-party manifest projection plus qualified presentation.');
  lines.push(' * Executable activation roots are emitted separately by host platform.');
  lines.push(' */');
  lines.push('');
  lines.push("import { projectBundledVoiceManifestContributions } from './bundledVoiceManifestProjection';");
  lines.push("import type { BundledVoiceManifestContribution } from './bundledVoiceManifestProjection';");
  lines.push("import type { VoiceProviderPresentation } from './voiceProviderPresentation';");
  lines.push("import { createBundledVoiceProviderPresentations } from './bundledVoiceManifestProjection';");
  lines.push('');
  if (sources.length > 0) {
    lines.push('');
    for (const source of sources) {
      lines.push(...renderBundledVoiceManifestProjectionConstant(source));
      lines.push('');
    }
  }
  lines.push('export const BUNDLED_FIRST_PARTY_VOICE_CONTRIBUTIONS = Object.freeze([');
  for (const source of sources) {
    lines.push(`  ...projectBundledVoiceManifestContributions(${toBundledVoiceImportPrefix(source.pluginPackageId)}_BUNDLED_PLUGIN_MANIFEST),`);
  }
  lines.push(']) satisfies readonly BundledVoiceManifestContribution[];');
  lines.push('');
  lines.push('export const BUNDLED_FIRST_PARTY_VOICE_PRESENTATIONS = createBundledVoiceProviderPresentations(');
  // Service marks are contribution semantics, supplied by the manifest owner.
  const presentations = sources.flatMap((source) => source.presentations)
    .map(({ mark: _mark, ...presentation }) => presentation);
  lines.push(`${renderJsonLiteral(presentations as JsonValue)} as const,`);
  lines.push(') satisfies readonly VoiceProviderPresentation[];');
  lines.push('');
  return lines.join('\n');
}

export function renderBundledVoiceRuntimeEntriesTs(
  sources: readonly BundledFirstPartyVoiceProjectionSource[],
  platform: BundledVoiceRuntimePlatform,
  excludedPackageNames: ReadonlySet<string> = new Set(),
): string {
  const applicableSources = sources.filter(
    (candidate): candidate is BundledFirstPartyVoiceProjectionSource & Readonly<{
      conversationClient: Readonly<{ artifactId: string; exportName: string }>;
    }> => !excludedPackageNames.has(candidate.packageName)
      && candidate.hasConversationProvider
      && candidate.conversationClient !== null
      && candidate.conversationPlatforms.includes(platform),
  );
  const lines: string[] = [];
  lines.push('/**');
  lines.push(' * GENERATED FILE CONTRACT (VOICE-FIRST-PARTY-RUNTIME-PROJECTION)');
  lines.push(' *');
  lines.push(' * This file is emitted by:');
  lines.push(' * - `apps/cli/scripts/build-owned/generateBundledPluginEntries.ts`');
  lines.push(' *');
  lines.push(' * Executable first-party Voice activation roots for the declared host platforms.');
  lines.push(' * Contributions that do not declare this host platform are absent.');
  lines.push(' */');
  lines.push('');
  lines.push(applicableSources.length > 0
    ? "import { createBundledConversationRuntimeEntries, type BundledConversationRuntimeEntry } from './bundledConversationRuntimeEntries';"
    : "import type { BundledConversationRuntimeEntry } from './bundledConversationRuntimeEntries';");
  for (const source of applicableSources) {
    const prefix = toBundledVoiceImportPrefix(source.pluginPackageId);
    lines.push(
      `import { ${source.conversationClient.exportName} as ${prefix}_BUNDLED_VOICE_ACTIVATE } from '${source.packageName}/happier-plugin-ui/${source.conversationClient.artifactId}';`,
    );
  }
  if (applicableSources.length > 0) {
    lines.push('');
    for (const source of applicableSources) {
      lines.push(...renderBundledVoiceManifestProjectionConstant(source));
      lines.push('');
    }
  }
  for (const source of applicableSources) {
    const prefix = toBundledVoiceImportPrefix(source.pluginPackageId);
    lines.push(`const ${prefix}_BUNDLED_PUBLIC_VOICE_ACTIVATIONS = createBundledConversationRuntimeEntries(`);
    lines.push(`  ${prefix}_BUNDLED_PLUGIN_MANIFEST,`);
    lines.push(`  ${prefix}_BUNDLED_VOICE_ACTIVATE,`);
    lines.push(');');
  }
  if (applicableSources.length > 0) lines.push('');
  lines.push('export const BUNDLED_FIRST_PARTY_VOICE_CONVERSATION_RUNTIME_ENTRIES = Object.freeze([');
  for (const source of applicableSources) {
    lines.push(`  ...${toBundledVoiceImportPrefix(source.pluginPackageId)}_BUNDLED_PUBLIC_VOICE_ACTIVATIONS,`);
  }
  lines.push(']) satisfies readonly BundledConversationRuntimeEntry[];');
  lines.push('');
  lines.push('/**');
  lines.push(' * Exact generated first-party entry identities admitted to the hosted');
  lines.push(' * conversation service. This is intentionally separate from provider ids and');
  lines.push(' * manifest metadata so copied or colliding external entries fail closed.');
  lines.push(' */');
  lines.push('export const BUNDLED_FIRST_PARTY_HOSTED_CONVERSATION_RUNTIME_ENTRIES = Object.freeze([');
  const elevenLabsSource = applicableSources.find(
    (candidate) => candidate.pluginPackageId === 'elevenlabs',
  );
  if (elevenLabsSource) {
    lines.push(`  ...${toBundledVoiceImportPrefix(elevenLabsSource.pluginPackageId)}_BUNDLED_PUBLIC_VOICE_ACTIVATIONS,`);
  }
  lines.push(']) satisfies readonly BundledConversationRuntimeEntry[];');
  lines.push('');
  return lines.join('\n');
}
