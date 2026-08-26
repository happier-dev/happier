import { describe, expect, it } from 'vitest';

import { AGENT_DEFINITION } from './definition.js';
import { PI_DIRECT_AUTH_ENV_KEYS } from './launchEnvironment.js';
import { PLUGIN_MANIFEST } from '../manifest.js';
import { PI_AGENT_RUNTIME_CONTRIBUTION as CATALOG_CONTRIBUTION } from './contributions/catalog.js';

describe('Pi AGENT_DEFINITION', () => {
  it('declares native-extension Happier tool delivery', () => {
    expect(AGENT_DEFINITION.core.tools).toEqual({ delivery: 'native_extension', support: 'experimental' });
  });
  it('advertises Claude subscription credentials as OAuth-or-token', () => {
    expect(AGENT_DEFINITION.core.connectedServices.supportedKindsByServiceId['claude-subscription']).toEqual([
      'oauth',
      'token',
    ]);
  });

  it('probes every direct Pi provider credential admitted by the launch environment', () => {
    expect(PLUGIN_MANIFEST.contributes.agents[0]?.cli?.auth.environmentVariables).toEqual(PI_DIRECT_AUTH_ENV_KEYS);
    expect(AGENT_DEFINITION).not.toHaveProperty('authProbeConfig');
  });

  it('binds the bundled catalog projection to its static catalog contribution leaf', () => {
    expect(AGENT_DEFINITION.runtimeContributions?.agentCatalogEntry).toEqual({
      importName: 'PI_AGENT_RUNTIME_CONTRIBUTION',
      source: './agent/contributions/catalog',
    });
  });

  it('does not retain Session preferences in the catalog contribution', () => {
    expect(CATALOG_CONTRIBUTION).not.toHaveProperty('sessionRuntimePreferences');
  });
});
