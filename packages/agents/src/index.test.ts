import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, expectTypeOf, it } from 'vitest';

import * as agents from './index.js';
import {
  AGENTS_CORE,
  AGENT_MODEL_CONFIG,
  AGENT_AUTH_PROBE_CONFIG,
  AGENT_LOCAL_CLI_CONFIG,
  AGENT_SESSION_MODE_DESCRIPTORS,
  AGENT_SESSION_MODES,
  AGENT_CLI_RUNTIME_SPECS,
  CANONICAL_AGENT_MODEL_CONFIG,
  CANONICAL_AGENT_AUTH_PROBE_CONFIG,
  CANONICAL_AGENT_LOCAL_CLI_CONFIG,
  CANONICAL_AGENT_SESSION_MODE_DESCRIPTORS,
  CANONICAL_AGENT_SESSION_MODES,
  CANONICAL_AGENTS_CORE,
  CANONICAL_AGENT_CLI_RUNTIME_SPECS,
  type AgentCoreRuntimeControlSurface,
  type EngineAdapter,
  getAgentCliSetupRecommendedIds,
  getAgentCliSetupSupportedIds,
  getAllAgentCatalogDefinitions,
  getAllAgentDefinitionContracts,
  getAllBackendCatalogDefinitions,
  getAllBackendDefinitionContracts,
  getAgentCatalogDefinition,
  getAgentDefinitionContract,
  getBackendCatalogDefinition,
  getBackendDefinitionContract,
  readNormalizedRuntimeDescriptor,
  getProviderAuthAdapter,
  getProviderConnectedServicesAdapter,
  getAgentResumeConfig,
  getProviderRuntimePreferencesAdapter,
  publishRuntimeCapabilities,
  type RuntimeCapabilities,
  type RuntimeControlSurface,
  type RuntimeFacets,
  type RuntimeOutboundTranscriptDispatchFacetV1,
  type RuntimeTranscriptSourceFacet,
  type SessionStateFacet,
  type AgentId,
  type AgentAuthProbeConfig,
  type AgentLocalCliConfig,
  type CanonicalAgentId,
  type AgentCliRuntimeSpec,
  legacyCustomAcpCompat,
  CLAUDE_UNIFIED_TERMINAL_DIALOG_CHOICE_REQUEST_SOURCE,
  isClaudeUnifiedTerminalDialogChoiceAgentStateRequest,
} from './index.js';
import type { EngineSpec, RuntimeDiscovery, RuntimeKindSpec } from './index.js';
import type { AgentRuntimeKindOverrides } from './runtimeKinds.js';
import type { AgentCore } from './types.js';
import {
  getAgentCliSetupRecommendedIds as getAgentCliSetupRecommendedIdsFromProviderRuntime,
  getAgentCliSetupSupportedIds as getAgentCliSetupSupportedIdsFromProviderRuntime,
} from './cli/runtime.js';

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(packageDir, '..', '..');

const scanIgnoredDirectoryNames = new Set([
  '.git',
  '.next',
  '.turbo',
  'build',
  'coverage',
  'dist',
  'node_modules',
]);

function listProductionSourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (!scanIgnoredDirectoryNames.has(entry.name) && !entry.name.startsWith('.')) {
        files.push(...listProductionSourceFiles(path));
      }
      continue;
    }
    if (
      entry.isFile()
      && /\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(entry.name)
      && !/\.(?:test|spec)\./.test(entry.name)
      && statSync(path).size < 1_000_000
    ) {
      files.push(path);
    }
  }
  return files;
}

describe('agents package exports', () => {
  it('re-exports the Claude unified terminal dialog-choice provenance helper', () => {
    expect(CLAUDE_UNIFIED_TERMINAL_DIALOG_CHOICE_REQUEST_SOURCE)
      .toBe('claude_unified_terminal_dialog_choice');
    expect(isClaudeUnifiedTerminalDialogChoiceAgentStateRequest({
      source: CLAUDE_UNIFIED_TERMINAL_DIALOG_CHOICE_REQUEST_SOURCE,
    })).toBe(true);
    expect(isClaudeUnifiedTerminalDialogChoiceAgentStateRequest({ source: 'other' })).toBe(false);
  });

  it('does not expose writable session-state binding internals from the package root', () => {
    expect('runtimeDescriptorBinding' in agents).toBe(false);
    expect('applySessionStateFieldMetadataPatch' in agents).toBe(false);
    expect('buildSessionStateFieldMetadataPatch' in agents).toBe(false);
    expect('createSessionStateFieldMetadataUpdater' in agents).toBe(false);
  });

  it('does not expose callerless hosted-direct transcript helpers from the package root', () => {
    expect(agents).not.toHaveProperty('replayTranscriptSourceHistory');
    expect(agents).not.toHaveProperty('bridgeTranscriptSourceHandoffGap');
  });

  it('does not expose session-state metadata writer helpers from the package root', () => {
    const rootOnlyMetadataWriterNames = [
      'applyAcpConfigOptionIntentSessionMetadata',
      'applyAcpSessionModeIntentSessionMetadata',
      'applyDisplayTitleSessionMetadata',
      'applyModelIntentSessionMetadata',
      'applyPermissionModeIntentSessionMetadata',
      'applyRuntimeDescriptorSessionMetadata',
      'applyProviderSessionIdSessionMetadata',
      'buildRuntimeDescriptorSessionMetadata',
      'buildProviderSessionIdSessionMetadata',
      'clearSessionStateFieldFromMetadata',
      'hasSessionStateFieldMetadataBinding',
      'writeSessionStateFieldToMetadata',
      'publishSessionStateFieldMutationToMetadata',
      'publishSessionStateFieldToMetadata',
    ] as const;

    for (const exportName of rootOnlyMetadataWriterNames) {
      expect(exportName in agents).toBe(false);
    }
  });

  it('publishes session-state metadata writer helpers through an explicit narrow subpath', () => {
    const packageJson = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as {
      exports?: Record<string, unknown>;
    };
    expect(packageJson.exports).toHaveProperty('./session/state/metadataWriters', {
      types: './dist/session/state/metadataWriters.d.ts',
      default: './dist/session/state/metadataWriters.js',
    });
  });

  it('publishes permission helpers through an explicit narrow subpath', () => {
    const packageJson = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as {
      exports?: Record<string, unknown>;
    };
    expect(packageJson.exports).toHaveProperty('./permissions', {
      types: './dist/permissions/index.d.ts',
      default: './dist/permissions/index.js',
    });
  });

  it('does not publish the generic session-state metadata patch bypass subpath', () => {
    const packageJson = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as {
      exports?: Record<string, unknown>;
    };
    expect(packageJson.exports).not.toHaveProperty('./session/state/metadataPatch');
  });

  it('keeps production callers off the generic session-state metadata patch bypass subpath', () => {
    const offenders = [
      ...listProductionSourceFiles(join(repoRoot, 'apps')),
      ...listProductionSourceFiles(join(repoRoot, 'packages')),
    ].flatMap((path) => {
      const source = readFileSync(path, 'utf8');
      return source.includes('@happier-dev/agents/session/state/metadataPatch')
        ? [relative(repoRoot, path)]
        : [];
    });
    expect(offenders).toEqual([]);
  }, 30_000);

  it('does not expose stale Codex runtime compatibility aliases from the package root', () => {
    expect('normalizeCodexRuntimeBackendMode' in agents).toBe(false);
    expect('CODEX_SESSION_CONTROL_ADAPTER_RUNTIME_HELPERS' in agents).toBe(false);
    expect('buildCodexRuntimeDescriptorProviderExtra' in agents).toBe(false);
    expect('readCodexRuntimeDescriptorProviderExtra' in agents).toBe(false);
    expect('buildCodexSpawnRuntimeAffinityCompatFields' in agents).toBe(false);
    expect('resolvePersistedCodexRuntimeIdentity' in agents).toBe(false);
    expect('resolvePersistedCodexProviderSessionId' in agents).toBe(false);
  });

  it('does not keep the providers-level runtime descriptor registry compatibility shim', () => {
    expect(existsSync(join(packageDir, 'src/providers/runtimeDescriptorReaderRegistry.ts'))).toBe(false);
  });

  it('does not expose OpenCode runtime descriptor construction from the package root', () => {
    expect('buildOpenCodeAgentRuntimeDescriptor' in agents).toBe(false);
    expect('buildOpenCodeRuntimeDescriptorProviderExtra' in agents).toBe(false);
    expect('readOpenCodeRuntimeDescriptorProviderExtra' in agents).toBe(false);
  });

  it('does not expose OpenCode plugin-owned agent settings from the package root', () => {
    const openCodeAgentSettingsExports = [
      'OPENCODE_AGENT_SETTINGS_DEFINITION',
      'OPENCODE_AGENT_FIELDS',
      'OPENCODE_AGENT_SETTINGS_DEFAULTS',
      'buildOpenCodeAgentSettingsShape',
      'normalizeOpenCodeBackendMode',
      'normalizeOpenCodeServerBaseUrl',
      'normalizeOpenCodeServerBaseUrlExplicit',
      'readOpenCodeExplicitServerBaseUrl',
    ] as const;

    for (const exportName of openCodeAgentSettingsExports) {
      expect(exportName in agents).toBe(false);
    }
  });

  it('does not expose OpenCode plugin-owned runtime preference helpers from the package root', () => {
    expect('resolveOpenCodeSessionRuntimePreferences' in agents).toBe(false);
  });

  it('does not expose Kimi plugin-owned runtime preference helpers from the package root', () => {
    expect('resolveKimiSessionRuntimePreferences' in agents).toBe(false);
  });

  it('does not expose Pi plugin-owned thinking helpers through the provider namespace', () => {
    expect('providers' in agents).toBe(true);
    expect('pi' in agents.providers).toBe(false);
  });

  it('does not expose Kimi plugin-owned agent setting shims from the package root', () => {
    const kimiAgentSettingExports = [
      'KIMI_AGENT_SETTINGS_DEFINITION',
      'KIMI_AGENT_FIELDS',
      'KIMI_AGENT_SETTINGS_DEFAULTS',
      'buildKimiAgentSettingsShape',
      'normalizeKimiAcpPythonSelector',
      'resolveKimiSpawnExtrasFromSettings',
    ] as const;

    for (const exportName of kimiAgentSettingExports) {
      expect(exportName in agents).toBe(false);
    }
  });

  it('does not expose Claude plugin-owned agent setting helpers from the package root', () => {
    const claudeAgentSettingExports = [
      'CLAUDE_REMOTE_AGENT_SETTINGS_DEFINITION',
      'CLAUDE_REMOTE_AGENT_FIELDS',
      'CLAUDE_REMOTE_AGENT_SETTINGS_DEFAULTS',
      'CLAUDE_UNIFIED_TERMINAL_HOSTS',
      'MAX_CLAUDE_REMOTE_ADVANCED_OPTIONS_JSON_CHARS',
      'buildClaudeRemoteAgentSettingsShape',
      'isValidClaudeRemoteAdvancedOptionsJson',
      'normalizeClaudeUnifiedTerminalHost',
      'normalizeClaudeRemoteAdvancedOptionsJson',
    ] as const;

    for (const exportName of claudeAgentSettingExports) {
      expect(exportName in agents).toBe(false);
    }
  });

  it('does not expose Agent settings runtime helpers through the package root', () => {
    expect('buildClaudeRemoteOutgoingMessageMetaExtras' in agents).toBe(false);
    expect('resolveProviderOutgoingMessageMetaExtras' in agents).toBe(false);
    expect('getProviderMessageMetaEnricher' in agents).toBe(false);
  });

  it('does not expose Codex runtime-preference helpers from the package root', () => {
    const codexRuntimePreferenceExports = [
      'CodexBackendMode',
      'normalizeCodexBackendMode',
      'resolveCodexSessionBackendMode',
      'resolveCodexSessionRuntimePreferences',
      'resolveCodexRuntimeBackendMode',
      'resolveCodexSpawnExtrasForRuntime',
      'resolveCodexSpawnExtrasFromSettings',
      'buildCodexAgentRuntimeDescriptor',
    ] as const;
    const rootSource = readFileSync(join(packageDir, 'src/index.ts'), 'utf8');

    for (const exportName of codexRuntimePreferenceExports) {
      expect(exportName in agents).toBe(false);
      expect(rootSource).not.toMatch(new RegExp(`\\b${exportName}\\b`, 'u'));
    }
  });

  it('does not expose Claude plugin-owned permission bridge helpers from the package root', () => {
    expect('CLAUDE_LOCAL_PERMISSION_BRIDGE_REQUEST_SOURCE' in agents).toBe(false);
    expect('isClaudeLocalPermissionBridgeAgentStateRequest' in agents).toBe(false);
  });

  it('keeps the shared Claude dialog provenance source under the agents package', () => {
    expect(existsSync(join(packageDir, 'src/providers/claude/permissionRequestSource.ts'))).toBe(true);
  });

  it('does not keep a Codex provider source owner under the agents package', () => {
    expect(existsSync(join(packageDir, 'src/providers/codex'))).toBe(false);
  });

  it('keeps shared runtime descriptor types provider-open', () => {
    const runtimeDescriptorTypesSource = readFileSync(
      join(packageDir, 'src/runtime/identity/runtimeDescriptorTypes.ts'),
      'utf8',
    );

    expect(runtimeDescriptorTypesSource).not.toMatch(/SupportedRuntimeDescriptorProviderId\s*=\s*['"]/u);
    expect(runtimeDescriptorTypesSource).not.toMatch(/\b(Codex|OpenCode|Pi)SharedRuntimeDescriptor\b/u);
  });

  it('re-exports the provider setup helper lists from the package root', () => {
    expect(getAgentCliSetupSupportedIds()).toEqual(getAgentCliSetupSupportedIdsFromProviderRuntime());
    expect(getAgentCliSetupRecommendedIds()).toEqual(getAgentCliSetupRecommendedIdsFromProviderRuntime());
  });

  it('re-exports canonical aggregates while keeping customAcp compat root exports narrowly scoped', () => {
    expectTypeOf<AgentId>().toEqualTypeOf<CanonicalAgentId>();
    expectTypeOf<AgentId>().toEqualTypeOf<CanonicalAgentId>();
    expectTypeOf<(typeof agents.AGENT_IDS)[number]>().toEqualTypeOf<CanonicalAgentId>();
    expectTypeOf<(typeof agents.AGENT_IDS)[number]>().toEqualTypeOf<AgentId>();
    expect(agents.AGENT_IDS).toEqual(agents.CANONICAL_AGENT_IDS);
    expect(agents.AGENT_IDS).toEqual(agents.CANONICAL_AGENT_IDS);
    expect(agents.isAgentId('claude')).toBe(true);
    expect(agents.isAgentId('customAcp')).toBe(false);
    expect(agents.AGENT_IDS).not.toContain('customAcp');
    expect(AGENTS_CORE).not.toHaveProperty('customAcp');
    expect(AGENT_MODEL_CONFIG).not.toHaveProperty('customAcp');
    expect(AGENT_AUTH_PROBE_CONFIG).not.toHaveProperty('customAcp');
    expect(AGENT_LOCAL_CLI_CONFIG).not.toHaveProperty('customAcp');
    expect(AGENT_SESSION_MODE_DESCRIPTORS).not.toHaveProperty('customAcp');
    expect(AGENT_SESSION_MODES).not.toHaveProperty('customAcp');
    expect(AGENT_CLI_RUNTIME_SPECS).not.toHaveProperty('customAcp');
    expect(CANONICAL_AGENTS_CORE).not.toHaveProperty('customAcp');
    expect(CANONICAL_AGENT_MODEL_CONFIG).not.toHaveProperty('customAcp');
    expect(CANONICAL_AGENT_AUTH_PROBE_CONFIG).not.toHaveProperty('customAcp');
    expect(CANONICAL_AGENT_LOCAL_CLI_CONFIG).not.toHaveProperty('customAcp');
    expect(CANONICAL_AGENT_SESSION_MODE_DESCRIPTORS).not.toHaveProperty('customAcp');
    expect(CANONICAL_AGENT_SESSION_MODES).not.toHaveProperty('customAcp');
    expect(CANONICAL_AGENT_CLI_RUNTIME_SPECS).not.toHaveProperty('customAcp');
    expect('isAgentLookupId' in agents).toBe(false);
    expect('LEGACY_COMPAT_AGENT_IDS' in agents).toBe(false);
    expect('LEGACY_CUSTOM_ACP_AGENT_ID' in agents).toBe(false);
    expect('LEGACY_CUSTOM_ACP_AGENT_CORE' in agents).toBe(false);
    expect('LEGACY_CUSTOM_ACP_AGENT_MODEL_CONFIG' in agents).toBe(false);
    expect('LEGACY_CUSTOM_ACP_COMPAT_CONFIG' in agents).toBe(false);
    expect('LEGACY_CUSTOM_ACP_AGENT_CLI_RUNTIME_SPEC' in agents).toBe(false);
    expect('getAgentCliRuntimeSpecForLookupId' in agents).toBe(false);
    expect('isLegacyCustomAcpAgentId' in agents).toBe(false);
    expect(legacyCustomAcpCompat.LEGACY_COMPAT_AGENT_IDS).toEqual(['customAcp']);
    expect(legacyCustomAcpCompat.getLegacyCustomAcpAgentCore().id).toBe('customAcp');
    expect(legacyCustomAcpCompat.getLegacyCustomAcpAgentModelConfig().defaultMode).toBe('default');
    expect(legacyCustomAcpCompat.getLegacyCustomAcpAgentAuthProbeConfig().agentId).toBe('customAcp');
    expect(legacyCustomAcpCompat.getLegacyCustomAcpAgentLocalCliConfig().agentId).toBe('customAcp');
    expect(legacyCustomAcpCompat.getLegacyCustomAcpSessionModeDescriptor().runtimeSwitch).toBe('acp-setSessionMode');
    expect(legacyCustomAcpCompat.getLegacyCustomAcpAgentCliRuntimeSpec().id).toBe('customAcp');
  });

  it('declares Cursor as an experimental local ACP session backend', () => {
    const cursorCore = (AGENTS_CORE as Readonly<Record<string, AgentCore>>).cursor;

    expect(cursorCore).toEqual(expect.objectContaining({
      id: 'cursor',
      cliSubcommand: 'cursor',
      detectKey: 'cursor-agent',
      resume: {
        vendorResume: 'experimental',
        vendorResumeIdField: 'cursorSessionId',
        experimentalResumePolicy: 'runtime_checked',
      },
      sessionStorage: { direct: true, persisted: true },
      tools: { delivery: 'shell_bridge', support: 'experimental' },
    }));
  });

  it('re-exports the canonical provider and backend definition registry helpers from the package root', () => {
    expect(typeof getAllAgentCatalogDefinitions).toBe('function');
    expect(typeof getAllAgentDefinitionContracts).toBe('function');
    expect(typeof getAllBackendCatalogDefinitions).toBe('function');
    expect(typeof getAllBackendDefinitionContracts).toBe('function');
    expect(typeof getAgentCatalogDefinition).toBe('function');
    expect(typeof getAgentDefinitionContract).toBe('function');
    expect(typeof getBackendCatalogDefinition).toBe('function');
    expect(typeof getBackendDefinitionContract).toBe('function');
  });

  it('keeps legacy customAcp compat factories out of canonical shared contract types', () => {
    // @ts-expect-error the package root must not re-export compat lookup id unions.
    type InvalidPublicLookupId = import('./index.js').AgentLookupId;
    // @ts-expect-error the package root must not re-export compat-only id aliases.
    type InvalidPublicCompatId = import('./index.js').AgentCompatId;
    // @ts-expect-error the package root must not re-export legacy compat placeholder ids.
    type InvalidPublicLegacyCompatId = import('./index.js').LegacyCompatAgentId;
    // @ts-expect-error customAcp compat core must not satisfy the canonical AgentCore contract.
    const invalidCompatCore: AgentCore = legacyCustomAcpCompat.getLegacyCustomAcpAgentCore();
    // @ts-expect-error customAcp compat runtime specs must not satisfy the canonical AgentCliRuntimeSpec contract.
    const invalidCompatRuntimeSpec: AgentCliRuntimeSpec = legacyCustomAcpCompat.getLegacyCustomAcpAgentCliRuntimeSpec();
    // @ts-expect-error customAcp compat auth metadata must not satisfy the canonical AgentAuthProbeConfig contract.
    const invalidCompatAuthProbeConfig: AgentAuthProbeConfig = legacyCustomAcpCompat.getLegacyCustomAcpAgentAuthProbeConfig();
    // @ts-expect-error customAcp compat local CLI metadata must not satisfy the canonical AgentLocalCliConfig contract.
    const invalidCompatLocalCliConfig: AgentLocalCliConfig = legacyCustomAcpCompat.getLegacyCustomAcpAgentLocalCliConfig();

    expect([
      {} as InvalidPublicLookupId,
      {} as InvalidPublicCompatId,
      {} as InvalidPublicLegacyCompatId,
      invalidCompatCore,
      invalidCompatRuntimeSpec,
      invalidCompatAuthProbeConfig,
      invalidCompatLocalCliConfig,
    ]).toHaveLength(7);
  });

  it('re-exports the canonical runtime identity reader from the package root', () => {
    expect(readNormalizedRuntimeDescriptor({
      agentRuntimeDescriptorV1: {
        v: 1,
        agentId: 'codex',
        provider: {
          backendMode: 'appServer',
          providerSessionId: 'thread_1',
        },
      },
    })).toEqual({
      providerId: 'codex',
      runtimeKind: 'appServer',
      providerSessionId: 'thread_1',
      runtimeHandle: {
        backendMode: 'appServer',
        providerSessionId: 'thread_1',
      },
      rawProvider: {
        backendMode: 'appServer',
        providerSessionId: 'thread_1',
      },
    });
  });

  it('re-exports the canonical runtime descriptor registry entrypoints from the package root', () => {
    expect(agents.RUNTIME_DESCRIPTOR_PROVIDER_IDS).toEqual(['codex', 'opencode', 'pi']);
    expect(typeof agents.getRuntimeDescriptorReader).toBe('function');
    expect(agents.getRuntimeDescriptorReader('codex')).toBeDefined();
  });

  it('re-exports the canonical runtime-foundation types from the package root', () => {
    expectTypeOf<EngineSpec>().toEqualTypeOf<Readonly<{
      engineId: string;
      defaultRuntimeKind: string | null;
      runtimeKinds: Readonly<Record<string, RuntimeKindSpec>>;
    }>>();
    expectTypeOf<RuntimeKindSpec>().toEqualTypeOf<Readonly<{
      kind: string;
      declaredControlSurfaceSupport: AgentRuntimeKindOverrides | null;
    }>>();
    expectTypeOf<RuntimeDiscovery>().toEqualTypeOf<Readonly<{
      preflight?: Readonly<Record<string, unknown>>;
      authStatus?: Readonly<Record<string, unknown>>;
      listModels?: Readonly<Record<string, unknown>>;
      listModes?: Readonly<Record<string, unknown>>;
      listConfigOptions?: Readonly<Record<string, unknown>>;
    }>>();
    expectTypeOf<EngineAdapter['controlSurface']>().toEqualTypeOf<AgentCoreRuntimeControlSurface | undefined>();
    expectTypeOf<RuntimeControlSurface>().toEqualTypeOf<AgentCoreRuntimeControlSurface>();
    expectTypeOf<RuntimeFacets>().toEqualTypeOf<Readonly<{
      transcriptSource?: RuntimeTranscriptSourceFacet;
      sessionState?: SessionStateFacet;
      transcriptDispatch?: RuntimeOutboundTranscriptDispatchFacetV1;
    }>>();
    expectTypeOf<RuntimeCapabilities>().toEqualTypeOf<Readonly<{
      localControl?: AgentCoreRuntimeControlSurface['localControl'] | null;
      sessionStorage?: AgentCoreRuntimeControlSurface['sessionStorage'] | null;
      sessionCapabilities?: AgentCoreRuntimeControlSurface['sessionCapabilities'] | null;
      tools?: AgentCoreRuntimeControlSurface['tools'] | null;
      handoff?: AgentCoreRuntimeControlSurface['handoff'] | null;
      executionRun?: Readonly<{
        supported: boolean;
      }> | null;
    }>>();
    // @ts-expect-error RuntimeKindSpec should reject undeclared control-surface keys.
    const invalidRuntimeKindSpec: RuntimeKindSpec = { kind: 'broken', declaredControlSurfaceSupport: { unexpected: true } };
    // @ts-expect-error EngineAdapter.controlSurface should be the materialized runtime control surface, not an open record.
    const invalidControlSurface: NonNullable<EngineAdapter['controlSurface']> = { unexpected: true };
    // @ts-expect-error RuntimeCapabilities should stay aligned with the materialized runtime capability fields.
    const invalidRuntimeCapabilities: RuntimeCapabilities = { localControl: { unexpected: true } };
    // @ts-expect-error RuntimeCapabilities should not absorb transcript-source; that shared facet lives on RuntimeFacets.
    const invalidCapabilitiesFacetLeak: RuntimeCapabilities = {
      transcriptSource: {
        page: async () => ({ items: [], pageInfo: { hasMore: false } }),
        readAfter: async () => ({ items: [], nextCursor: null }),
      },
    };
    // @ts-expect-error RuntimeFacets should not absorb control-surface facets until they have concrete shared facet owners.
    const invalidRuntimeFacets: RuntimeFacets = { localControl: { supported: true } };
    expect([
      invalidRuntimeKindSpec,
      invalidControlSurface,
      invalidRuntimeCapabilities,
      invalidCapabilitiesFacetLeak,
      invalidRuntimeFacets,
    ]).toHaveLength(5);
    expect(typeof publishRuntimeCapabilities).toBe('function');
  });

  it('re-exports the canonical provider auth and connected-services adapters from the package root', () => {
    expect(typeof getProviderAuthAdapter).toBe('function');
    expect(typeof getProviderConnectedServicesAdapter).toBe('function');
    expect(typeof getAgentResumeConfig).toBe('function');
    expect(typeof getProviderRuntimePreferencesAdapter).toBe('function');
    expect(getProviderAuthAdapter('claude')).toEqual({
      supportKind: 'login_terminal',
      localCliAuth: expect.any(Object),
      loginLaunch: expect.any(Object),
    });
    expect(getProviderConnectedServicesAdapter('codex')).toEqual(
      expect.objectContaining({
        cloudConnect: expect.any(Object),
        connectedServices: expect.any(Object),
      }),
    );
    expect(getAgentResumeConfig('claude')).toEqual({
      vendorResume: 'supported',
      vendorResumeIdField: 'claudeSessionId',
    });
    expect(getProviderRuntimePreferencesAdapter('codex')).toEqual({
      sourcePreference: { default: 'system-first' },
      defaultRuntimeKind: { default: 'appServer' },
    });
  });
});
