import { describe, expect, it } from 'vitest';

import { AGENT_DEFINITION } from './definition.js';

describe('OpenCode AGENT_DEFINITION', () => {
  it('advertises Claude subscription OAuth and setup-token via the broker while the Anthropic Console key stays token-only', () => {
    // Both Claude Pro/Max browser-login OAuth and setup-token are accepted through the Happier broker
    // (materializer + broker wire path); the Anthropic Console API key (`anthropic`) stays token-only
    // (direct x-api-key).
    expect(AGENT_DEFINITION.core.connectedServices.supportedKindsByServiceId['claude-subscription'])
      .toEqual(['oauth', 'token']);
    expect(AGENT_DEFINITION.core.connectedServices.supportedKindsByServiceId.anthropic)
      .toEqual(['token']);
  });

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
        managedInstall: {
          kind: 'managed_package',
          packageName: 'opencode-ai',
          binaryName: 'opencode',
          packageBinarySetup: { kind: 'opencode_platform_binary' },
        },
        manualInstallKind: 'command',
      },
    });
  });

  it('declares plugin-owned A.16y.3 runtime projection contributions', () => {
    expect(AGENT_DEFINITION.runtimeContributions).toMatchObject({
      agentCatalogEntry: {
        importName: 'OPENCODE_AGENT_RUNTIME_CONTRIBUTION',
        source: './agent/contributions/runtime',
      },
      sessionControlAdapter: {
        kind: 'providerSessionControlAdapter',
        providerId: 'opencode',
        source: './agent/surfaces/sessions/controls/adapter',
        exportName: 'OPENCODE_SESSION_CONTROL_ADAPTER',
        generatedAdapter: expect.objectContaining({
          providerId: 'opencode',
          runtimeDescriptor: expect.objectContaining({ providerId: 'opencode' }),
        }),
      },
      runtimeDescriptorReader: {
        kind: 'providerRuntimeDescriptorReader',
        providerId: 'opencode',
        source: './agent/identity/runtimeDescriptor',
        exportName: 'readOpenCodeSessionMetadataRuntimeDescriptor',
        generatedReader: expect.objectContaining({
          providerId: 'opencode',
          backendModeKey: 'backendMode',
        }),
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
