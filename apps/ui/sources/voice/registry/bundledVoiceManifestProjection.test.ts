import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { PluginManifestV2LoadSchema } from '@happier-dev/protocol/plugins/manifest';

import { projectBundledVoiceManifestContributions } from './bundledVoiceManifestProjection';

it('reads packaged Voice declarations despite empty retired manifest families', () => {
    const packaged: unknown = JSON.parse(readFileSync(new URL(
        '../../../../../packages/plugins/codex/.happier-plugin/plugin.json', import.meta.url,
    ), 'utf8'));
    const manifest = PluginManifestV2LoadSchema.parse(packaged);
    const expected = projectBundledVoiceManifestContributions(manifest);
    expect(expected.length).toBeGreaterThan(0);
    const compatible = {
        ...manifest, contributes: { ...manifest.contributes, tools: [], commands: [] },
    };
    const projected = projectBundledVoiceManifestContributions(compatible);
    expect(projected).toEqual(expected);
});
