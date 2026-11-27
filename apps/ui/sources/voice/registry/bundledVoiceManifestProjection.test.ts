import { readIndexedBundledDeclarationManifest } from '../../../../cli/src/plugins/projection/registry/builtIn/declarationAssetFormat.mjs';
import { expect, it } from 'vitest';
import { PluginManifestV2LoadSchema } from '@happier-dev/protocol/plugins/manifest';

import { projectBundledVoiceManifestContributions } from './bundledVoiceManifestProjection';

it('reads bundled Voice declarations despite empty retired manifest families', () => {
    const bundled: unknown = readIndexedBundledDeclarationManifest(new URL(
        '../../../../../apps/cli/assets/bundled-plugin-manifests/codex.json', import.meta.url,
    ));
    const manifest = PluginManifestV2LoadSchema.parse(bundled);
    const expected = projectBundledVoiceManifestContributions(manifest);
    expect(expected.length).toBeGreaterThan(0);
    const compatible = {
        ...manifest, contributes: { ...manifest.contributes, tools: [], commands: [] },
    };
    const projected = projectBundledVoiceManifestContributions(compatible);
    expect(projected).toEqual(expected);
});
