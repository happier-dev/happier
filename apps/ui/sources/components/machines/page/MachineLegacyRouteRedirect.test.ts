import { describe, expect, it } from 'vitest';

import { machineLegacyRouteHref } from './MachineLegacyRouteRedirect';

describe('the 0.2 /machine/<id> route', () => {
    it('keeps the tab a link names, with its own params and the Home', () => {
        expect(machineLegacyRouteHref({ id: 'm1', serverId: 'home-a', tab: 'security', page: 'network' }))
            .toBe('/machines/m1?serverId=home-a&tab=security&page=network');
        expect(machineLegacyRouteHref({ id: 'm1', tab: 'processes', sort: 'cpu' })).toBe('/machines/m1?tab=processes&sort=cpu');
    });

    it('opens the page itself when no tab is named, and the page a moved route names', () => {
        expect(machineLegacyRouteHref({ id: 'm1', serverId: ' home-a ' })).toBe('/machines/m1?serverId=home-a');
        expect(machineLegacyRouteHref({ id: 'm1' }, { id: 'setup', page: 'tools' })).toBe('/machines/m1?tab=setup&page=tools');
        expect(machineLegacyRouteHref({})).toBe('/machines');
    });
});
