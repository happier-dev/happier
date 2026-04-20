import { describe, expect, it } from 'vitest';

import { buildScopedSessionRouteHref } from './sessionRouteServerScope';

describe('buildScopedSessionRouteHref', () => {
    it('preserves the scoped serverId when query also contains serverId', () => {
        expect(buildScopedSessionRouteHref({
            sessionId: 'session-1',
            serverId: 'server-scoped',
            query: {
                serverId: 'server-overridden',
                tab: 'runs',
            },
        })).toBe('/session/session-1?serverId=server-scoped&tab=runs');
    });
});
