import { expect, it } from 'vitest';
import { PluginUiViewV2Schema } from './v2.js';

it('admits a named page area with a self-contained readable context contract', () => {
    expect(PluginUiViewV2Schema.safeParse({ id: 'overview', renderer: 'native', container: 'appPage', target: { kind: 'app' },
        widgetAreas: [{ name: 'pinned', contextSchema: { type: 'object', properties: { filter: { type: 'string' } }, additionalProperties: false } }],
    }).success).toBe(true);
});

it('refuses duplicate names and areas on non-page destinations', () => {
    const area = { name: 'pinned', contextSchema: { type: 'object', additionalProperties: false } };
    const page = { id: 'overview', renderer: 'native', container: 'appPage', target: { kind: 'app' } };
    expect(PluginUiViewV2Schema.safeParse({ ...page, widgetAreas: [area, area] }).success).toBe(false);
    expect(PluginUiViewV2Schema.safeParse({ ...page, container: 'detailsTab', target: { kind: 'session' }, widgetAreas: [area] }).success).toBe(false);
});
