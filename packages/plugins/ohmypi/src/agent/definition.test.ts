import { describe, expect, it } from 'vitest';

import { AGENT_DEFINITION } from './definition.js';
import { PLUGIN_MANIFEST } from '../manifest.js';

describe('OhMyPi agent definition', () => {
  it('publishes token-only eligibility through public connected-account declarations', () => {
    expect(PLUGIN_MANIFEST.contributes.agents[0]?.connectedAccounts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        service: { pluginId: 'happier.agent.claude', localId: 'claude-subscription' },
        credentialKinds: ['token'],
      }),
      expect.objectContaining({
        service: { pluginId: 'happier.agent.gemini', localId: 'gemini-account' },
        credentialKinds: ['token'],
      }),
    ]));
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
