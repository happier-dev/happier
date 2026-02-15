import { describe, expect, it } from 'vitest';

import { buildPreflightModelCacheKey } from '@/components/sessions/new/modules/preflightModelCacheKey';

describe('buildPreflightModelCacheKey', () => {
    it('returns null without machine id', () => {
        expect(
            buildPreflightModelCacheKey({ machineId: null, agentType: 'codex', serverId: 'server-a' }),
        ).toBeNull();
    });

    it('includes server id in the cache key for server-scoped probes', () => {
        expect(
            buildPreflightModelCacheKey({ machineId: 'machine-1', agentType: 'codex', serverId: 'server-b' }),
        ).toBe('server-b::machine-1:codex');
    });

    it('normalizes empty server id to active-scope key segment', () => {
        expect(
            buildPreflightModelCacheKey({ machineId: 'machine-1', agentType: 'codex', serverId: '   ' }),
        ).toBe('active::machine-1:codex');
    });
});
