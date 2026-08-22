import { existsSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

describe('legacy Plugin UI contribution contraction', () => {
  it('does not retain a second registry admission route after public manifest ingestion rejects it', () => {
    const normalize = readFileSync(new URL('./package.ts', import.meta.url), 'utf8');
    const resolvedTypes = readFileSync(new URL('../types.ts', import.meta.url), 'utf8');
    const resolvedRegistry = readFileSync(
      new URL('../createResolvedContributionRegistry.ts', import.meta.url),
      'utf8',
    );
    const resolver = readFileSync(new URL('../resolvePluginContributions.ts', import.meta.url), 'utf8');
    const projection = readFileSync(new URL('../ui/projection.ts', import.meta.url), 'utf8');
    const staticAssetSource = readFileSync(
      new URL('../../../../daemon/local/services/plugins/staticAssets/source.ts', import.meta.url),
      'utf8',
    );

    expect(normalize).not.toMatch(/\bPluginReactNativeBundleContributionV1\b/);
    expect(normalize).not.toMatch(/\bPluginUiArtifactContributionV1\b/);
    expect(normalize).not.toContain("'reactNativeBundles'");
    expect(normalize).not.toContain("'uiArtifacts'");
    expect(resolvedTypes).not.toMatch(/\bResolvedReactNativeBundleContribution\b/);
    expect(resolvedTypes).not.toMatch(/\bResolvedUiArtifactContribution\b/);
    expect(resolvedRegistry).not.toContain('reactNativeBundlesById');
    expect(resolvedRegistry).not.toContain('uiArtifactsById');
    expect(resolver).not.toMatch(/\bPluginResolvedReactNativeBundleContribution\b/);
    expect(resolver).not.toMatch(/\bPluginResolvedUiArtifactContribution\b/);
    expect(projection).not.toContain('registry.reactNativeBundles');
    expect(projection).not.toContain('registry.uiArtifacts');
    expect(staticAssetSource).not.toContain('registry.uiArtifacts');
    expect(existsSync(new URL('../ui/reactNativeRuntime.ts', import.meta.url))).toBe(false);
    expect(existsSync(new URL('../ui/hostedWebBuild.ts', import.meta.url))).toBe(false);
  });
});
