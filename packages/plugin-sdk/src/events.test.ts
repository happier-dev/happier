import { describe, expect, it } from 'vitest';

import * as events from './events.js';

describe('events SDK surface', () => {
    it('exports hook catalog helpers with plugin vocabulary', () => {
        expect(events.PLUGIN_HOOK_CATALOG_V1.map((entry) => entry.id)).toContain('plugin.reload.after');
        expect(events.getPluginHookDefinitionV1('plugin.reload.after')?.id).toBe('plugin.reload.after');
        expect(events).not.toHaveProperty('EXTENSION_HOOK_CATALOG_V1');
        expect(events).not.toHaveProperty('getExtensionHookDefinitionV1');
    });
});
