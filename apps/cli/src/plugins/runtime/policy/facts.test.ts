import { describe, expect, it } from 'vitest';

import { evaluatePluginFinalPolicy } from '@happier-dev/protocol';

import {
  resolvePluginFinalPolicyAuthorizationFacts,
  resolveRequiredPluginNetworkOrigins,
} from './facts';

const current = Object.freeze({
  immutableGenerationId: 'generation-7',
  desiredImmutableGenerationId: 'generation-7',
  appliedImmutableGenerationId: 'generation-7',
  distribution: Object.freeze({ kind: 'npm', packageName: '@acme/plugin', channel: 'latest' }),
  applied: true,
  selectedAccess: Object.freeze([]),
});

describe('resolvePluginFinalPolicyAuthorizationFacts', () => {
  it('binds every consumer to the direct applied generation without digest-era currentness copies', () => {
    const authorization = resolvePluginFinalPolicyAuthorizationFacts({
      pluginId: 'acme.plugin',
      current,
    });

    expect(evaluatePluginFinalPolicy({
      ...authorization,
      serviceAvailability: [],
      currentIntent: 'notRequired',
    })).toMatchObject({ outcome: 'visible', code: 'plugin_final_available' });
    expect(JSON.stringify(authorization.packageTrust)).not.toContain('sha256:');
  });

  it('keeps a retained target generation distinct from durable desired and applied facts', () => {
    const authorization = resolvePluginFinalPolicyAuthorizationFacts({
      pluginId: 'acme.plugin',
      current: {
        ...current,
        desiredImmutableGenerationId: 'generation-8',
        appliedImmutableGenerationId: 'generation-7',
      },
      targetGenerationMode: 'retained',
    });

    expect(authorization.generation).toEqual({
      targetGeneration: 'generation-7',
      desiredGeneration: 'generation-8',
      appliedGeneration: 'generation-7',
      targetGenerationMode: 'retained',
    });
    expect(evaluatePluginFinalPolicy({
      ...authorization,
      serviceAvailability: [],
      currentIntent: 'notRequired',
    })).toMatchObject({ outcome: 'visible', code: 'plugin_final_available' });
  });

  it('fails closed when a direct current generation is unavailable', () => {
    const authorization = resolvePluginFinalPolicyAuthorizationFacts({
      pluginId: 'acme.plugin',
      current: null,
    });

    expect(evaluatePluginFinalPolicy({
      ...authorization,
      serviceAvailability: [],
      currentIntent: 'notRequired',
    })).toMatchObject({ outcome: 'denied', code: 'plugin_final_package_untrusted' });
  });

  it('projects network disclosure only from required manifest configuration', () => {
    const required = [{
      id: 'model-download',
      capability: 'network' as const,
      reason: 'Download the selected model',
      scope: { targets: [{ kind: 'fixedOrigin' as const, origin: 'https://models.example.test' }] },
    }];

    expect(resolveRequiredPluginNetworkOrigins({
      required,
    })).toEqual(['https://models.example.test']);
  });
});
