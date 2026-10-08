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
      version: 2,
      entries: [{
        artifactId: contributionId,
        tier: 'hostedWeb',
        entry: `hosted-web/${contributionId}/index.html`,
        files: [{
          relativePath: `hosted-web/${contributionId}/index.html`,
          digest: `sha256:${'a'.repeat(64)}`,
          byteSize: 1,
        }],
        digest: `sha256:${'b'.repeat(64)}`,
        builtWith: { staging: 'staticDirectory' },
        hostUiApiRange: '^999.0.0',
      }],
    },
  };
}

function projectionWithCanonicalIngestionInvalidManifest(
  duplicateContributionId: string,
): Record<string, unknown> {
  return {
    version: 1,
    manifest: {
      schemaVersion: 2,
      id: 'acme.compatibility-fixture',
      version: '1.2.5',
      displayName: 'Compatibility fixture',
      engines: { happier: '>=0.0.0' },
      runtime: { apiVersion: 1 },
      contributes: {
        resources: [{
          id: duplicateContributionId,
          kind: 'asset',
          path: 'shared.txt',
          contentType: 'text/plain',
        }],
        actions: [{
          id: duplicateContributionId,
          title: 'Shared',
          scopes: ['session'],
          surfaces: ['cli'],
          placementBindings: ['primary'],
          dangerLevel: 'safe',
          execution: { target: 'daemon' },
        }],
      },
    },
    uiArtifacts: { version: 2, entries: [] },
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

  it('reports a bounded non-echoing host diagnostic for a canonically invalid manifest', () => {
    const duplicateContributionId = `duplicated-contribution-id-${'x'.repeat(200)}`;
    const evaluation = evaluatePluginCompatibilityProjection(
      projectionWithCanonicalIngestionInvalidManifest(duplicateContributionId),
    );

    expect(evaluation.kind).toBe('incompatible');
    if (evaluation.kind !== 'incompatible') return;
    expect(evaluation.projection.manifest.id).toBe('acme.compatibility-fixture');
    expect(evaluation.diagnostics).toEqual([{
      code: 'plugin_manifest_invalid',
      message: 'Plugin manifest compatibility check failed: plugin_manifest_duplicate_contribution_id.',
    }]);
    expect(evaluation.diagnostics[0]?.message).not.toContain(duplicateContributionId);
  });

  it('reports a bounded non-echoing reason for an incompatible generated UI artifact', () => {
    // Keep the authored path segment portable so this reaches host API admission.
    const untrustedContributionId = `generated-ui-${'x'.repeat(200)}`;
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
