import { describe, expect, it } from 'vitest';

import { AGENT_DEFINITION } from './definition.js';
import { PLUGIN_MANIFEST } from '../manifest.js';

describe('OhMyPi agent definition', () => {
  it('advertises Claude subscription credentials as token-only', () => {
    expect(AGENT_DEFINITION.core.connectedServices.supportedKindsByServiceId['claude-subscription']).toEqual(['token']);
  });

  it('advertises Gemini connected-service credentials as token-only', () => {
    expect(AGENT_DEFINITION.core.connectedServices.supportedKindsByServiceId.gemini).toEqual(['token']);
  });

  it('projects CLI/install/auth facts from the strict manifest without changing runtime ownership', () => {
    expect(PLUGIN_MANIFEST.contributes.agents[0]?.cli).toMatchObject({
      displayName: 'oh-my-pi CLI',
      executable: { binaryName: 'omp', acceptsJavaScriptFileOverride: true },
      install: {
        managed: { kind: 'github_release_binary', githubRepo: 'can1357/oh-my-pi' },
        manual: { kind: 'vendor_recipe' },
      },
      auth: { support: 'manual_only', machineLoginKey: 'oh-my-pi' },
    });
    expect(AGENT_DEFINITION).not.toHaveProperty('agentCliRuntime');
  });

  it('does not retain a private catalog callback bag beside the public Agent declaration', () => {
    expect(AGENT_DEFINITION).not.toHaveProperty('runtimeContributions.agentCatalogEntry');
  });
});
