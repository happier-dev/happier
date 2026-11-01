import { describe, expect, it } from 'vitest';

import { AGENT_DEFINITION } from './definition.js';
import { PI_DIRECT_AUTH_ENV_KEYS } from './launchEnvironment.js';
import { PLUGIN_MANIFEST } from '../manifest.js';

describe('Pi AGENT_DEFINITION', () => {
  it('projects the consumed default-off host compaction capability from one definition', () => {
    expect(AGENT_DEFINITION.core.sessionCapabilities).toMatchObject({ compaction: {
      events: true, manual: true, idle: { mode: 'host', defaultEnabled: false, defaultMinContextTokens: 100000 },
    } });
    expect(PLUGIN_MANIFEST.contributes.agents[0]?.capabilities.sessions?.compaction)
      .toEqual(AGENT_DEFINITION.core.sessionCapabilities.compaction);
  });
  it('declares native-extension Happier tool delivery', () => {
    expect(AGENT_DEFINITION.core.tools).toEqual({ delivery: 'native_extension', support: 'experimental',
      mcpToolControl: { off: 'hidden', approval: 'host' } });
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
