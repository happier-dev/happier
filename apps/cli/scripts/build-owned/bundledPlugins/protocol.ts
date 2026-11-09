/** Pure projection rendering; filesystem, preparation and publication stay in the generator. */
import {
  isRecord,
  readJsonObjectProperty,
  renderJsonLiteral,
  renderTsNullableStringLiteral,
  renderTsStringArrayLiteral,
  renderTsStringLiteral,
} from './literals.ts';
import {
  BUILT_IN_LEGACY_CONNECTED_ACCOUNT_OPERATION_IDS,
} from './projectionFacts.ts';
import type {
  BuiltInLegacyConnectedAccountCompatibilityProjection,
  JsonValue,
  ProtocolExternalSessionSourceProjectionDescriptor,
} from './projectionFacts.ts';

/** Static roots remain available to Protocol/SDK consumers without plugin activation. */
export function renderProtocolCodexNativeHomePolicyTs(nativeHome: Readonly<{
  environmentKey: string;
  defaultRelativePath: string;
  materializedDirectoryName: string;
}>): string {
  return [
    '/**',
    ' * GENERATED FILE. DO NOT EDIT.',
    ' * Codex owns these facts in its static Agent declaration. Protocol retains',
    ' * data-only exports for pet-root discovery and released SDK consumers.',
    ' */',
    'export const CODEX_NATIVE_HOME = Object.freeze({',
    `  environmentKey: ${JSON.stringify(nativeHome.environmentKey)},`,
    `  defaultRelativePath: ${JSON.stringify(nativeHome.defaultRelativePath)},`,
    '});',
    '',
    `export const CODEX_CONNECTED_SERVICE_HOME_DIRECTORY_NAME = ${JSON.stringify(nativeHome.materializedDirectoryName)};`,
    '',
  ].join('\n');
}

export function renderProtocolBuiltInLegacyConnectedAccountCompatibilityTs(
  entries: readonly BuiltInLegacyConnectedAccountCompatibilityProjection[],
): string {
  const lines = [
    '/**',
    ' * GENERATED FILE. DO NOT EDIT.',
    ' *',
    ' * Built-in-only host-private compatibility for supported legacy Connected Service ids.',
    ' * Public manifests and external plugins cannot add or claim entries in this projection.',
    ' * legacyConnectedServiceCompatibility and connected-service bindings consume these',
    ' * frozen peer-operation/authentication mappings at their released-data ingress.',
    ' *',
    ' * Immutable released bases: server-v0.2.1 at 4913c1e533c872a0712ba1c25b3104fd470aacc2',
    ' * and cli-v0.2.1 at b1d15a8a9c241737d1ca9b167459901e6259173a.',
    ' * The prospective Remote at e67f3751f1ab5dc13e40a583a28f3962111154aa is the',
    ' * legacy GitHub credential producer consumed during Dev activation. Dev preactivation at',
    ' * 877ee97a0df346a1daaa541632dc42643d533120 produced persisted Bitbucket credentials.',
    ' * Remove this compatibility projection only after exact 0.2.1 support ends, the Remote',
    ' * predecessor no longer produces a required shape, and persisted legacy rows no longer',
    ' * require migration or reverse projection.',
    ' */',
    '',
    'export type BuiltInLegacyConnectedAccountOperation =',
    ...BUILT_IN_LEGACY_CONNECTED_ACCOUNT_OPERATION_IDS.map(
      (operation) => `  | ${JSON.stringify(operation)}`,
    ),
    ';',
    '',
    'export type BuiltInLegacyConnectedAccountCompatibility = Readonly<{',
    '  service: Readonly<{',
    '    pluginId: string;',
    '    localId: string;',
    '  }>;',
    '  peerOperations: Readonly<{',
    '    exactV0_2_1: readonly BuiltInLegacyConnectedAccountOperation[];',
    '    revisionedV2V3: readonly BuiltInLegacyConnectedAccountOperation[];',
    '  }>;',
    '  exactV0_2_1ReaderQuotaProjection: boolean;',
    '  defaultAuthenticationModeId: string;',
    '  authenticationModeByCredentialKind: Readonly<Partial<Record<"oauth" | "token", string>>>;',
    '  unsupportedAuthenticationModeByCredentialKind: Readonly<Partial<Record<"oauth" | "token", string>>>;',
    '}>;',
    '',
    'export const BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID = Object.freeze({',
  ];
  for (const entry of entries) {
    lines.push(
      `  ${JSON.stringify(entry.legacyServiceId)}: Object.freeze({`,
      '    service: Object.freeze({',
      `      pluginId: ${JSON.stringify(entry.service.pluginId)},`,
      `      localId: ${JSON.stringify(entry.service.localId)},`,
      '    }),',
      '    peerOperations: Object.freeze({',
      `      exactV0_2_1: Object.freeze(${JSON.stringify(entry.peerOperations.exactV0_2_1)} as const),`,
      `      revisionedV2V3: Object.freeze(${JSON.stringify(entry.peerOperations.revisionedV2V3)} as const),`,
      '    }),',
      `    exactV0_2_1ReaderQuotaProjection: ${JSON.stringify(entry.exactV0_2_1ReaderQuotaProjection)},`,
      `    defaultAuthenticationModeId: ${JSON.stringify(entry.defaultAuthenticationModeId)},`,
      '    authenticationModeByCredentialKind: Object.freeze({',
      ...(entry.authenticationModeByCredentialKind.oauth
        ? [`      oauth: ${JSON.stringify(entry.authenticationModeByCredentialKind.oauth)},`]
        : []),
      ...(entry.authenticationModeByCredentialKind.token
        ? [`      token: ${JSON.stringify(entry.authenticationModeByCredentialKind.token)},`]
        : []),
      '    }),',
      '    unsupportedAuthenticationModeByCredentialKind: Object.freeze({',
      ...(entry.unsupportedAuthenticationModeByCredentialKind.oauth
        ? [`      oauth: ${JSON.stringify(entry.unsupportedAuthenticationModeByCredentialKind.oauth)},`]
        : []),
      ...(entry.unsupportedAuthenticationModeByCredentialKind.token
        ? [`      token: ${JSON.stringify(entry.unsupportedAuthenticationModeByCredentialKind.token)},`]
        : []),
      '    }),',
      '  }),',
    );
  }
  lines.push(
    '} as const satisfies Readonly<Record<string, BuiltInLegacyConnectedAccountCompatibility>>);',
    '',
    'export type BuiltInLegacyConnectedServiceId =',
    '  keyof typeof BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID;',
    '',
  );
  return lines.join('\n');
}

export function renderProtocolSessionPresentationCompatV1Ts(params: Readonly<{
  agentIds: readonly string[];
  agentDefinitionsById: Readonly<Record<string, JsonValue>>;
}>): string {
  const entries = params.agentIds.flatMap((agentId) => {
    const definition = params.agentDefinitionsById[agentId];
    if (!isRecord(definition)) return [];
    const core = readJsonObjectProperty(definition, 'core');
    if (!core) return [];
    const flavorAliases = Array.isArray(core.flavorAliases)
      ? core.flavorAliases.filter((value): value is string => typeof value === 'string')
      : [];
    const resume = readJsonObjectProperty(core, 'resume');
    const vendorResumeIdField = typeof resume?.vendorResumeIdField === 'string'
      ? resume.vendorResumeIdField
      : null;
    return [{
      agentId,
      flavorAliases: [...new Set([agentId, ...flavorAliases])],
      vendorResumeIdField,
    }];
  });

  const lines: string[] = [];
  lines.push('/**');
  lines.push(' * GENERATED FILE CONTRACT (C8.1-session-presentation-compat)');
  lines.push(' *');
  lines.push(' * Protocol-safe projection of canonical Agent flavor aliases and vendor resume-id fields.');
  lines.push(' * This file is emitted by:');
  lines.push(' * - `apps/cli/scripts/build-owned/generateBundledPluginEntries.ts`');
  lines.push(' */');
  lines.push('');
  lines.push('export const GENERATED_SESSION_PRESENTATION_COMPAT_V1 = Object.freeze([');
  for (const entry of entries) {
    lines.push('  Object.freeze({');
    lines.push(`    agentId: ${renderTsStringLiteral(entry.agentId)},`);
    lines.push(`    flavorAliases: Object.freeze(${renderTsStringArrayLiteral(entry.flavorAliases)}),`);
    lines.push(`    vendorResumeIdField: ${renderTsNullableStringLiteral(entry.vendorResumeIdField)},`);
    lines.push('  }),');
  }
  lines.push('] as const);');
  lines.push('');
  lines.push('function normalizePresentationIdentifier(value: unknown): string | null {');
  lines.push('  if (typeof value !== \'string\') return null;');
  lines.push('  const normalized = value.trim();');
  lines.push('  return normalized.length > 0 ? normalized : null;');
  lines.push('}');
  lines.push('');
  lines.push('export function resolveGeneratedSessionPresentationAgentIdV1(');
  lines.push('  metadata: Readonly<Record<string, unknown>>,');
  lines.push('): string | null {');
  lines.push('  const flavor = normalizePresentationIdentifier(metadata.flavor)?.toLowerCase() ?? null;');
  lines.push('  if (flavor) {');
  lines.push('    for (const entry of GENERATED_SESSION_PRESENTATION_COMPAT_V1) {');
  lines.push('      if (entry.flavorAliases.some((alias) => alias.trim().toLowerCase() === flavor)) {');
  lines.push('        return entry.agentId;');
  lines.push('      }');
  lines.push('    }');
  lines.push('  }');
  lines.push('  for (const entry of GENERATED_SESSION_PRESENTATION_COMPAT_V1) {');
  lines.push('    if (!entry.vendorResumeIdField) continue;');
  lines.push('    if (normalizePresentationIdentifier(metadata[entry.vendorResumeIdField])) return entry.agentId;');
  lines.push('  }');
  lines.push('  return null;');
  lines.push('}');
  lines.push('');
  return lines.join('\n');
}

export function renderProtocolAgentProviderIdsV1Ts(agentIds: readonly string[]): string {
  const lines: string[] = [];
  lines.push('/**');
  lines.push(' * GENERATED FILE CONTRACT (A.X-agent-ids-codegen)');
  lines.push(' *');
  lines.push(' * This file is emitted by:');
  lines.push(' * - `apps/cli/scripts/build-owned/generateBundledPluginEntries.ts`');
  lines.push(' *');
  lines.push(' * This protocol-owned V1 wire schema intentionally preserves the');
  lines.push(' * daemon-facing provider id subset while deriving it from the generated');
  lines.push(' * bundled agent id source. Protocol cannot import `@happier-dev/agents`');
  lines.push(' * because that would create a package dependency cycle.');
  lines.push(' */');
  lines.push('');
  lines.push('import { z } from \'zod/mini\';');
  lines.push('');
  lines.push('export const AGENT_PROVIDER_IDS_V1 = Object.freeze([');
  for (const agentId of agentIds) {
    lines.push(`  ${renderTsStringLiteral(agentId)},`);
  }
  lines.push('] as const);');
  lines.push('');
  lines.push('export type AgentProviderIdV1 = (typeof AGENT_PROVIDER_IDS_V1)[number];');
  lines.push('');
  lines.push('export const AgentProviderIdV1Schema = z.enum(AGENT_PROVIDER_IDS_V1);');
  lines.push('');
  return lines.join('\n');
}

/**
 * Protocol's copy of the bundled Agent routing id -> contribution identity
 * map. The Agent target key owner (`buildBackendTargetKeyV2`) needs it to key a
 * bundled Agent by its one canonical identity, and protocol cannot import
 * `@happier-dev/agents`.
 */
export function renderProtocolBundledAgentIdentitiesV1Ts(params: Readonly<{
  agentIds: readonly string[];
  contributionIdentities: Readonly<Record<string, Readonly<{ pluginId: string; localId: string }>>>;
}>): string {
  const lines: string[] = [];
  lines.push('/**');
  lines.push(' * GENERATED FILE CONTRACT (A.X-agent-ids-codegen)');
  lines.push(' *');
  lines.push(' * This file is emitted by:');
  lines.push(' * - `apps/cli/scripts/build-owned/generateBundledPluginEntries.ts`');
  lines.push(' *');
  lines.push(' * Bundled Agent routing id -> plugin contribution identity, derived from the');
  lines.push(' * same source as `@happier-dev/agents` `BUNDLED_AGENT_CONTRIBUTION_IDENTITIES`.');
  lines.push(' * Protocol cannot import `@happier-dev/agents` because that would create a');
  lines.push(' * package dependency cycle.');
  lines.push(' */');
  lines.push('');
  lines.push('export const BUNDLED_AGENT_CONTRIBUTION_IDENTITIES_V1: Readonly<Record<');
  lines.push('  string,');
  lines.push('  Readonly<{ pluginId: string; localId: string }>');
  lines.push('>> = Object.freeze({');
  for (const agentId of params.agentIds) {
    const contributionIdentity = params.contributionIdentities[agentId];
    if (!contributionIdentity) {
      throw new Error(`Missing bundled plugin contribution identity for Agent '${agentId}'`);
    }
    lines.push(`  ${renderTsStringLiteral(agentId)}: Object.freeze({`);
    lines.push(`    pluginId: ${renderTsStringLiteral(contributionIdentity.pluginId)},`);
    lines.push(`    localId: ${renderTsStringLiteral(contributionIdentity.localId)},`);
    lines.push('  }),');
  }
  lines.push('});');
  lines.push('');
  return lines.join('\n');
}

const PROTOCOL_PROVIDER_DEFAULT_SOURCE_PROJECTION_CONTRACT = 'A.16y.7-protocol-provider-default-and-source-projection';

function renderProtocolProviderProjectionHeader(lines: string[]): void {
  lines.push('/**');
  lines.push(` * GENERATED FILE CONTRACT (${PROTOCOL_PROVIDER_DEFAULT_SOURCE_PROJECTION_CONTRACT})`);
  lines.push(' *');
  lines.push(' * This file is emitted by:');
  lines.push(' * - `apps/cli/scripts/build-owned/generateBundledPluginEntries.ts`');
  lines.push(' */');
}

export function renderGeneratedExternalSessionSourcesTs(
  contributions: readonly ProtocolExternalSessionSourceProjectionDescriptor[],
): string {
  const lines: string[] = [];
  renderProtocolProviderProjectionHeader(lines);
  lines.push('');
  lines.push('export const GENERATED_EXTERNAL_SESSIONS_SOURCE_DECLARATIONS = [');
  for (const contribution of contributions) {
    lines.push(`${renderJsonLiteral(contribution.declaration, 2).split('\n').map((line) => `  ${line}`).join('\n')},`);
  }
  lines.push('] as const;');
  lines.push('');
  return lines.join('\n');
}
