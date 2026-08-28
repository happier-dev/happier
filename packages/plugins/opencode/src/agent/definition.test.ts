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
          usageLimitRecovery: { checkNow: 'unsupported' },
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
        loginLaunches: [{ kind: 'primary', args: ['auth', 'login'] }],
      },
    });
    expect(AGENT_DEFINITION).not.toHaveProperty('agentCliRuntime');
  });

  it('keeps only the released flat-metadata compatibility fact', () => {
    expect(AGENT_DEFINITION).toMatchObject({
      releasedFlatSessionMetadataRuntimeDescriptorReader: {
        kind: 'providerRuntimeDescriptorReader',
        providerId: 'opencode',
        generatedReader: expect.objectContaining({
          providerId: 'opencode',
          backendModeKey: 'backendMode',
        }),
      },
    });
    expect(AGENT_DEFINITION).not.toHaveProperty('sessionControlAdapter');
    expect(AGENT_DEFINITION).not.toHaveProperty('runtimeContributions');
    expect(AGENT_DEFINITION).not.toHaveProperty('protocolRuntimeDescriptor');
  });
});
