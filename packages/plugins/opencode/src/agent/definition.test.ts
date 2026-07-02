import { describe, expect, it } from 'vitest';

import { AGENT_DEFINITION } from './definition.js';

describe('OpenCode AGENT_DEFINITION', () => {
  it('publishes the recovered OpenCode runtime capabilities from the plugin-owned definition', () => {
    expect(AGENT_DEFINITION).toMatchObject({
      id: 'opencode',
      core: {
        resume: { vendorResume: 'supported', vendorResumeIdField: 'opencodeSessionId' },
        sessionStorage: { direct: true, persisted: true },
        sessionCapabilities: {
          sessionListing: 'supported',
          sessionFork: { conversation: 'supported', fromMessage: 'supported' },
          usageLimitRecovery: { checkNow: 'supported' },
        },
        tools: { delivery: 'native_mcp', support: 'supported' },
      },
      authProbeConfig: {
        statusCommand: ['auth', 'list'],
        parser: 'opencodeAuthList',
      },
      localCli: {
        supportKind: 'login_terminal',
      },
      agentCliRuntime: {
        sourcePreferenceDefault: 'system-first',
        managedInstall: null,
        manualInstallKind: 'vendor_recipe',
      },
    });
  });

  it('declares plugin-owned A.16y.3 runtime projection contributions', () => {
    expect(AGENT_DEFINITION.runtimeContributions).toMatchObject({
      providerCatalogEntry: {
        importName: 'OPENCODE_PROVIDER_RUNTIME_CONTRIBUTION',
        source: './agent/contributions/runtime',
      },
      sessionControlAdapter: {
        kind: 'providerSessionControlAdapter',
        providerId: 'opencode',
        source: './agent/surfaces/sessions/controls/adapter',
        exportName: 'OPENCODE_SESSION_CONTROL_ADAPTER',
      },
      runtimeDescriptorReader: {
        kind: 'providerRuntimeDescriptorReader',
        providerId: 'opencode',
        source: './agent/identity/runtimeDescriptor',
        exportName: 'readOpenCodeSessionMetadataRuntimeDescriptor',
      },
      protocolRuntimeDescriptor: {
        kind: 'providerRuntimeDescriptorV1',
        providerId: 'opencode',
        buildFunction: 'buildOpenCodeAgentRuntimeDescriptorV1',
        canonicalReader: 'readCanonicalOpenCodeAgentRuntimeDescriptorV1',
      },
    });
  });
});
