import { describe, expect, it } from 'vitest';

import { definePlugin } from './definePlugin.js';

describe('machine role authoring', () => {
    it('retains a plugin role declaration in the admitted manifest', () => {
        const role = { title: 'Intake', description: 'Receives events', partOf: 'intake' } as const;
        const plugin = definePlugin({
            id: 'com.example.intake', version: '1.0.0',
            machineRoles: { intake: role },
        });

        expect(plugin.manifest.contributes.machineRoles).toEqual([{ id: 'intake', ...role }]);
    });
});
