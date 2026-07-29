import { describe, expect, it } from 'vitest';

import { evaluatePluginFinalPolicy } from '@happier-dev/protocol';

import {
  resolvePluginFinalPolicyAuthorizationFacts,
  resolveRequiredPluginNetworkOrigins,
} from './facts';

const current = Object.freeze({
  immutableGenerationId: 'generation-7',
  packageDigest: 'sha256:package',
  manifestDigest: 'sha256:manifest',
  distribution: Object.freeze({ kind: 'npm', packageName: '@acme/plugin', channel: 'latest' }),
  applied: true,
  selectedAccess: Object.freeze([]),
});

describe('resolvePluginFinalPolicyAuthorizationFacts', () => {
  it('binds every consumer to the same exact package and applied generation facts', () => {
    const authorization = resolvePluginFinalPolicyAuthorizationFacts({
      pluginId: 'acme.plugin',
      targetManifestDigest: 'sha256:manifest',
      current,
    });

    expect(evaluatePluginFinalPolicy({
      ...authorization,
      serviceAvailability: [],
      currentIntent: 'notRequired',
    })).toMatchObject({ outcome: 'visible', code: 'plugin_final_available' });
  });

  it('fails closed when a consumer presents a stale manifest generation', () => {
    const authorization = resolvePluginFinalPolicyAuthorizationFacts({
      pluginId: 'acme.plugin',
      targetManifestDigest: 'sha256:stale-manifest',
      current,
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
