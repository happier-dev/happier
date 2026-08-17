import { existsSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

describe('legacy Plugin UI contribution contraction', () => {
  it('keeps generated artifact facts while removing manual artifact and bundle declarations', () => {
    const rootBarrel = readFileSync(new URL('../../index.ts', import.meta.url), 'utf8');
    const uiContributionBarrel = readFileSync(
      new URL('../contributions/ui/index.ts', import.meta.url),
      'utf8',
    );
    const generatedArtifactManifest = readFileSync(
      new URL('../ui/uiArtifactsManifest.ts', import.meta.url),
      'utf8',
    );

    expect(existsSync(new URL('../contributions/ui/reactNativeBundles.ts', import.meta.url))).toBe(false);
    expect(existsSync(new URL('../ui/reactNativeBundleManifest.ts', import.meta.url))).toBe(false);
    expect(existsSync(new URL('../ui/artifacts.ts', import.meta.url))).toBe(false);
    expect(rootBarrel).not.toMatch(/\bPluginReactNativeBundleContributionV1(?:Schema)?\b/);
    expect(rootBarrel).not.toMatch(/\bPluginUiArtifactContributionV1(?:Schema)?\b/);
    expect(rootBarrel).not.toMatch(/\bPluginReactNativeBundleManifestV1(?:Schema)?\b/);
    expect(rootBarrel).not.toMatch(/\bPluginUiExecutableArtifactManifestV1(?:Schema)?\b/);
    expect(uiContributionBarrel).not.toContain('./reactNativeBundles.js');
    expect(generatedArtifactManifest).toContain('PluginUiArtifactsManifestV1Schema');
    expect(generatedArtifactManifest).toContain('PluginUiArtifactFileV1Schema');
  });
});
