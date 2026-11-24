import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { PluginManifestV2LoadSchema } from '@happier-dev/protocol/plugins/manifest';

import { projectBundledVoiceManifestContributions } from './bundledVoiceManifestProjection';

it('reads bundled Voice declarations despite empty retired manifest families', () => {
    const bundled: unknown = JSON.parse(readFileSync(new URL(
        '../../../../../apps/cli/assets/bundled-plugin-manifests/codex.json', import.meta.url,
    ), 'utf8'));
    const manifest = PluginManifestV2LoadSchema.parse(bundled);
    const expected = projectBundledVoiceManifestContributions(manifest);
    expect(expected.length).toBeGreaterThan(0);
    const compatible = {
        ...manifest, contributes: { ...manifest.contributes, tools: [], commands: [] },
    };
    const projected = projectBundledVoiceManifestContributions(compatible);
    expect(projected).toEqual(expected);
});
