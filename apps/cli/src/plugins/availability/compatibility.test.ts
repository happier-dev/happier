import { describe, expect, it } from 'vitest';

import { evaluatePluginCompatibilityProjection } from './compatibility';

function projectionWithIncompatibleUiArtifact(contributionId: string): Record<string, unknown> {
  return {
    version: 1,
    manifest: {
      schemaVersion: 2,
      id: 'acme.compatibility-fixture',
      version: '1.2.5',
      displayName: 'Compatibility fixture',
      engines: { happier: '>=0.0.0' },
      runtime: { apiVersion: 1 },
      contributes: {},
    },
    uiArtifacts: {
      version: 1,
      entries: [{
        contributionId,
        tier: 'hostedWeb',
        entry: 'web/index.html',
        files: [{
          relativePath: 'web/index.html',
          digest: `sha256:${'a'.repeat(64)}`,
          byteSize: 1,
        }],
        digest: `sha256:${'b'.repeat(64)}`,
        builtWith: { bundler: 'vite', version: '7.0.0' },
        hostUiApiVersion: '999.0.0',
        compat: {},
      }],
    },
  };
}

describe('evaluatePluginCompatibilityProjection', () => {
  it('reports one bounded non-echoing diagnostic for malformed generated metadata', () => {
    const untrustedUnknownKey = `unexpected-${'x'.repeat(32_769)}`;
    const evaluation = evaluatePluginCompatibilityProjection({ [untrustedUnknownKey]: true });

    expect(evaluation.kind).toBe('invalid');
    if (evaluation.kind !== 'invalid') return;
    expect(evaluation.diagnostics).toHaveLength(1);
    expect(evaluation.diagnostics[0]).toEqual({
      code: 'plugin_compatibility_projection_invalid',
      message: 'Plugin compatibility projection is invalid.',
    });
  });

  it('reports a bounded non-echoing reason for an incompatible generated UI artifact', () => {
    const untrustedContributionId = `generated-ui-${'x'.repeat(32_769)}`;
    const evaluation = evaluatePluginCompatibilityProjection(
      projectionWithIncompatibleUiArtifact(untrustedContributionId),
    );

    expect(evaluation.kind).toBe('incompatible');
    if (evaluation.kind !== 'incompatible') return;
    expect(evaluation.diagnostics).toEqual([{
      code: 'plugin_compatibility_projection_invalid',
      message: 'Generated UI artifact compatibility check failed: generated_ui_host_api_mismatch.',
    }]);
    expect(evaluation.diagnostics[0]?.message).not.toContain(untrustedContributionId);
  });
});
