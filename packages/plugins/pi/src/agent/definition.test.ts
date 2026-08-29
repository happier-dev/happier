import { describe, expect, it } from 'vitest';

import { AGENT_DEFINITION } from './definition.js';
import { PI_DIRECT_AUTH_ENV_KEYS } from './launchEnvironment.js';
import { PLUGIN_MANIFEST } from '../manifest.js';

describe('Pi AGENT_DEFINITION', () => {
  it('declares native-extension Happier tool delivery', () => {
    expect(AGENT_DEFINITION.core.tools).toEqual({ delivery: 'native_extension', support: 'experimental' });
  });
  it('publishes Claude subscription credential eligibility through the public declaration', () => {
    expect(PLUGIN_MANIFEST.contributes.agents[0]?.connectedAccounts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        service: { pluginId: 'happier.agent.claude', localId: 'claude-subscription' },
        credentialKinds: ['oauth', 'token'],
      }),
    ]));
  });

  it('probes every direct Pi provider credential admitted by the launch environment', () => {
    expect(PLUGIN_MANIFEST.contributes.agents[0]?.cli?.auth.environmentVariables).toEqual(PI_DIRECT_AUTH_ENV_KEYS);
    expect(AGENT_DEFINITION).not.toHaveProperty('authProbeConfig');
  });

  it('keeps launch authority in the canonical plugin registration', () => {
    expect(AGENT_DEFINITION).not.toHaveProperty('runtimeContributions');
    expect(PLUGIN_MANIFEST.contributes.agents[0]).toMatchObject({
      connectedAccounts: expect.any(Array),
    });
  });

  it('does not advertise a usage-limit readiness probe without provider truth', () => {
    expect(AGENT_DEFINITION.core.sessionCapabilities.usageLimitRecovery).toEqual({
      checkNow: 'unsupported',
    });
    expect(PLUGIN_MANIFEST.contributes.agents[0]?.capabilities.sessions)
      .not.toHaveProperty('usageLimitRecovery');
  });
});
