import { expect, it } from 'vitest';
import { readProjectWidgetAreaContextV1 } from './projectWidgetAreaContext';

it('keeps exact checkout context distinct from the missing portable Project Source producer', () => {
    const checkout = { id: 'workspace', serverId: 'home', machineId: 'machine', rootPath: '/repo', createdAtMs: 1 };
    expect(readProjectWidgetAreaContextV1({ serverId: 'home', activeCheckout: checkout })).toEqual({
        status: 'unavailable', reasonCode: 'widget_project_source_unavailable', providedContext: { project: [], checkout: [checkout] },
    });
    expect(readProjectWidgetAreaContextV1({ serverId: 'other', activeCheckout: checkout }).providedContext).toEqual({ project: [], checkout: [] });
    expect(readProjectWidgetAreaContextV1({ serverId: 'home', activeCheckout: { id: 'portable' } }).providedContext).toEqual({ project: [], checkout: [] });
});
