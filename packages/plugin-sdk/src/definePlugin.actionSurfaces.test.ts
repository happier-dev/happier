import { describe, expect, it } from 'vitest';
import { definePlugin } from './definePlugin.js';

describe('authored Action surface admission', () => {
    it('preserves an explicit UI surface list without exposing an unadmitted agent path', () => {
        const { manifest } = definePlugin({
            id: 'example.surface-admission', version: '0.0.0', displayName: 'Surface admission',
            actions: { read: { title: 'Read', surfaces: ['ui', 'cli', 'plugin'], placementBindings: [], run: () => null } },
        });
        expect(manifest.contributes.actions[0]?.surfaces).toEqual(['ui', 'cli', 'plugin']);
    });

    it('retains the author default when no surfaces were selected', () => {
        const { manifest } = definePlugin({
            id: 'example.default-surfaces', version: '0.0.0', displayName: 'Default surfaces',
            actions: { read: { title: 'Read', run: () => null } },
        });
        expect(manifest.contributes.actions[0]?.surfaces).toEqual(['cli']);
    });
});
