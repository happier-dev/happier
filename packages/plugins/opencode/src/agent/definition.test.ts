import { describe, expect, it } from 'vitest';

import { AGENT_DEFINITION } from './definition.js';
import { PLUGIN_MANIFEST } from '../manifest.js';

describe('OpenCode AGENT_DEFINITION', () => {
  it('advertises Claude subscription OAuth plus native setup-token while the Anthropic Console key stays token-only', () => {
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
    });
  });

  it('projects CLI/install/auth facts from the strict manifest without changing runtime ownership', () => {
    expect(PLUGIN_MANIFEST.contributes.agents[0]?.cli).toMatchObject({
      displayName: 'OpenCode CLI',
      executable: { binaryName: 'opencode', sourcePreference: 'system-first' },
      install: {
        managed: {
          kind: 'managed_package',
        },
        manual: { kind: 'command' },
      },
      auth: {
        support: 'login_terminal',
        probe: { statusArgs: ['auth', 'list'], parser: 'opencodeAuthList' },
      },
    });
    expect(AGENT_DEFINITION).not.toHaveProperty('agentCliRuntime');
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
