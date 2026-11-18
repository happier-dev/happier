import { expect, it } from 'vitest';
import { PluginUiOpenResourceIntentV1Schema, PluginUiResourceIntentV1Schema } from './resourceLinks.js';

it('opens an Artifact by identity without accepting a caller-selected Home or widening provider URL lookups', () => {
    const artifact = { kind: 'artifact', artifactId: 'review/one' };
    expect(PluginUiOpenResourceIntentV1Schema.parse(artifact)).toEqual(artifact);
    expect(PluginUiOpenResourceIntentV1Schema.safeParse({ ...artifact, serverId: 'other-home' }).success).toBe(false);
    expect(PluginUiResourceIntentV1Schema.safeParse(artifact).success).toBe(false);
    expect(PluginUiOpenResourceIntentV1Schema.parse({ kind: 'pullRequest', url: 'https://forge.test/org/repo/pull/1' }))
        .toEqual({ kind: 'pullRequest', url: 'https://forge.test/org/repo/pull/1' });
});
