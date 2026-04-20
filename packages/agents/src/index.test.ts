import { describe, expect, expectTypeOf, it } from 'vitest';

import * as agents from './index.js';
import * as providerSettings from './providerSettings/index.js';
import {
  AGENTS_CORE,
  AGENT_MODEL_CONFIG,
  AGENT_AUTH_PROBE_CONFIG,
  AGENT_LOCAL_CLI_CONFIG,
  AGENT_SESSION_MODE_DESCRIPTORS,
  AGENT_SESSION_MODES,
  PROVIDER_CLI_RUNTIME_SPECS,
  CLAUDE_LOCAL_PERMISSION_BRIDGE_REQUEST_SOURCE,
  CANONICAL_AGENT_MODEL_CONFIG,
  CANONICAL_AGENT_AUTH_PROBE_CONFIG,
  CANONICAL_AGENT_LOCAL_CLI_CONFIG,
  CANONICAL_AGENT_SESSION_MODE_DESCRIPTORS,
  CANONICAL_AGENT_SESSION_MODES,
  CANONICAL_AGENTS_CORE,
  CANONICAL_PROVIDER_CLI_RUNTIME_SPECS,
  type AgentCoreRuntimeControlSurface,
  type EngineAdapter,
  isClaudeLocalPermissionBridgeAgentStateRequest,
  getProviderCliSetupRecommendedIds,
  getProviderCliSetupSupportedIds,
  getAllProviderDefinitions,
  getAllProviderDefinitionContracts,
  getAllBackendDefinitions,
  getAllBackendDefinitionContracts,
  getProviderDefinition,
  getProviderDefinitionContract,
  getBackendDefinition,
  getBackendDefinitionContract,
  readNormalizedRuntimeDescriptor,
  getProviderAuthAdapter,
  getProviderConnectedServicesAdapter,
  getAgentResumeConfig,
  getProviderRuntimePreferencesAdapter,
  getProviderMessageMetaEnricher,
  publishRuntimeCapabilities,
  type RuntimeCapabilities,
  type RuntimeControlSurface,
  type RuntimeFacets,
  type RuntimeTranscriptSourceFacet,
  type AgentId,
  type AgentAuthProbeConfig,
  type AgentLocalCliConfig,
  type CanonicalAgentId,
  type ProviderCliRuntimeSpec,
  legacyCustomAcpCompat,
} from './index.js';
import type { EngineSpec, RuntimeDiscovery, RuntimeKindSpec } from './index.js';
import type { AgentRuntimeKindOverrides } from './runtimeKinds.js';
import type { AgentCore } from './types.js';
import {
  CLAUDE_LOCAL_PERMISSION_BRIDGE_REQUEST_SOURCE as CLAUDE_LOCAL_PERMISSION_BRIDGE_REQUEST_SOURCE_FROM_CLAUDE_INDEX,
  isClaudeLocalPermissionBridgeAgentStateRequest as isClaudeLocalPermissionBridgeAgentStateRequestFromClaudeIndex,
} from './providers/claude/index.js';
import {
  getProviderCliSetupRecommendedIds as getProviderCliSetupRecommendedIdsFromProviderRuntime,
  getProviderCliSetupSupportedIds as getProviderCliSetupSupportedIdsFromProviderRuntime,
} from './providers/providerCliRuntime.js';

describe('agents package exports', () => {
  it('does not expose stale Codex runtime compatibility aliases from the package root', () => {
    expect('normalizeCodexRuntimeBackendMode' in agents).toBe(false);
    expect('CODEX_SESSION_CONTROL_ADAPTER_RUNTIME_HELPERS' in agents).toBe(false);
  });

  it('does not expose runtime helpers through the provider-settings facade', () => {
    expect('resolveCodexSpawnExtrasForRuntime' in providerSettings).toBe(false);
    expect('resolveCodexSpawnExtrasFromSettings' in providerSettings).toBe(false);
    expect('resolveCodexRuntimeBackendMode' in providerSettings).toBe(false);
    expect('buildClaudeRemoteOutgoingMessageMetaExtras' in providerSettings).toBe(false);
    expect('resolveProviderOutgoingMessageMetaExtras' in providerSettings).toBe(false);
  });

  it('re-exports the Claude local permission bridge helper from the package root', () => {
    expect(CLAUDE_LOCAL_PERMISSION_BRIDGE_REQUEST_SOURCE).toBe('claude_local_permission_bridge');
    expect(isClaudeLocalPermissionBridgeAgentStateRequest({ source: CLAUDE_LOCAL_PERMISSION_BRIDGE_REQUEST_SOURCE })).toBe(true);
    expect(isClaudeLocalPermissionBridgeAgentStateRequest({ source: 'other' })).toBe(false);
  });

  it('re-exports the Claude local permission bridge helper from the Claude provider entrypoint', () => {
    expect(CLAUDE_LOCAL_PERMISSION_BRIDGE_REQUEST_SOURCE_FROM_CLAUDE_INDEX).toBe('claude_local_permission_bridge');
    expect(isClaudeLocalPermissionBridgeAgentStateRequestFromClaudeIndex({
      source: CLAUDE_LOCAL_PERMISSION_BRIDGE_REQUEST_SOURCE_FROM_CLAUDE_INDEX,
    })).toBe(true);
    expect(isClaudeLocalPermissionBridgeAgentStateRequestFromClaudeIndex({ source: 'other' })).toBe(false);
  });

  it('re-exports the provider setup helper lists from the package root', () => {
    expect(getProviderCliSetupSupportedIds()).toEqual(getProviderCliSetupSupportedIdsFromProviderRuntime());
    expect(getProviderCliSetupRecommendedIds()).toEqual(getProviderCliSetupRecommendedIdsFromProviderRuntime());
  });

  it('re-exports canonical aggregates while keeping customAcp compat root exports narrowly scoped', () => {
    expectTypeOf<AgentId>().toEqualTypeOf<CanonicalAgentId>();
    expectTypeOf<(typeof agents.AGENT_IDS)[number]>().toEqualTypeOf<CanonicalAgentId>();
    expect(agents.AGENT_IDS).toEqual(agents.CANONICAL_AGENT_IDS);
    expect(agents.AGENT_IDS).not.toContain('customAcp');
    expect(AGENTS_CORE).not.toHaveProperty('customAcp');
    expect(AGENT_MODEL_CONFIG).not.toHaveProperty('customAcp');
    expect(AGENT_AUTH_PROBE_CONFIG).not.toHaveProperty('customAcp');
    expect(AGENT_LOCAL_CLI_CONFIG).not.toHaveProperty('customAcp');
    expect(AGENT_SESSION_MODE_DESCRIPTORS).not.toHaveProperty('customAcp');
    expect(AGENT_SESSION_MODES).not.toHaveProperty('customAcp');
    expect(PROVIDER_CLI_RUNTIME_SPECS).not.toHaveProperty('customAcp');
    expect(CANONICAL_AGENTS_CORE).not.toHaveProperty('customAcp');
    expect(CANONICAL_AGENT_MODEL_CONFIG).not.toHaveProperty('customAcp');
    expect(CANONICAL_AGENT_AUTH_PROBE_CONFIG).not.toHaveProperty('customAcp');
    expect(CANONICAL_AGENT_LOCAL_CLI_CONFIG).not.toHaveProperty('customAcp');
    expect(CANONICAL_AGENT_SESSION_MODE_DESCRIPTORS).not.toHaveProperty('customAcp');
    expect(CANONICAL_AGENT_SESSION_MODES).not.toHaveProperty('customAcp');
    expect(CANONICAL_PROVIDER_CLI_RUNTIME_SPECS).not.toHaveProperty('customAcp');
    expect('isAgentLookupId' in agents).toBe(false);
    expect('LEGACY_COMPAT_AGENT_IDS' in agents).toBe(false);
    expect('LEGACY_CUSTOM_ACP_AGENT_ID' in agents).toBe(false);
    expect('LEGACY_CUSTOM_ACP_AGENT_CORE' in agents).toBe(false);
    expect('LEGACY_CUSTOM_ACP_AGENT_MODEL_CONFIG' in agents).toBe(false);
    expect('LEGACY_CUSTOM_ACP_COMPAT_CONFIG' in agents).toBe(false);
    expect('LEGACY_CUSTOM_ACP_PROVIDER_CLI_RUNTIME_SPEC' in agents).toBe(false);
    expect('getProviderCliRuntimeSpecForLookupId' in agents).toBe(false);
    expect('isLegacyCustomAcpAgentId' in agents).toBe(false);
    expect(legacyCustomAcpCompat.LEGACY_COMPAT_AGENT_IDS).toEqual(['customAcp']);
    expect(legacyCustomAcpCompat.getLegacyCustomAcpAgentCore().id).toBe('customAcp');
    expect(legacyCustomAcpCompat.getLegacyCustomAcpAgentModelConfig().defaultMode).toBe('default');
    expect(legacyCustomAcpCompat.getLegacyCustomAcpAgentAuthProbeConfig().agentId).toBe('customAcp');
    expect(legacyCustomAcpCompat.getLegacyCustomAcpAgentLocalCliConfig().agentId).toBe('customAcp');
    expect(legacyCustomAcpCompat.getLegacyCustomAcpSessionModeDescriptor().runtimeSwitch).toBe('acp-setSessionMode');
    expect(legacyCustomAcpCompat.getLegacyCustomAcpProviderCliRuntimeSpec().id).toBe('customAcp');
  });

  it('re-exports the canonical provider and backend definition registry helpers from the package root', () => {
    expect(typeof getAllProviderDefinitions).toBe('function');
    expect(typeof getAllProviderDefinitionContracts).toBe('function');
    expect(typeof getAllBackendDefinitions).toBe('function');
    expect(typeof getAllBackendDefinitionContracts).toBe('function');
    expect(typeof getProviderDefinition).toBe('function');
    expect(typeof getProviderDefinitionContract).toBe('function');
    expect(typeof getBackendDefinition).toBe('function');
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
    // @ts-expect-error customAcp compat runtime specs must not satisfy the canonical ProviderCliRuntimeSpec contract.
    const invalidCompatRuntimeSpec: ProviderCliRuntimeSpec = legacyCustomAcpCompat.getLegacyCustomAcpProviderCliRuntimeSpec();
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
        providerId: 'codex',
        provider: {
          backendMode: 'appServer',
          vendorSessionId: 'thread_1',
        },
      },
    })).toEqual({
      providerId: 'codex',
      runtimeKind: 'appServer',
      vendorSessionId: 'thread_1',
      runtimeHandle: {
        backendMode: 'appServer',
        vendorSessionId: 'thread_1',
      },
      rawProvider: {
        backendMode: 'appServer',
        vendorSessionId: 'thread_1',
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
    expect(typeof getProviderMessageMetaEnricher).toBe('function');
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
    expect(getProviderMessageMetaEnricher('claude')).toEqual({
      buildOutgoingMessageMetaExtras: expect.any(Function),
    });
  });
});
