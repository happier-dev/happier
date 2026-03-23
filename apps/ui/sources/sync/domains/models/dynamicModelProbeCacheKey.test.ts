import { describe, expect, it } from 'vitest';

import { buildDynamicModelProbeCacheKey } from '@/sync/domains/models/dynamicModelProbeCacheKey';

describe('buildDynamicModelProbeCacheKey', () => {
    it('returns null without machine id', () => {
        expect(
            buildDynamicModelProbeCacheKey({ machineId: null, targetKey: 'agent:codex', serverId: 'server-a', cwd: '/repo' }),
        ).toBeNull();
    });

    it('includes server id in the cache key for server-scoped probes', () => {
        expect(
            buildDynamicModelProbeCacheKey({ machineId: 'machine-1', targetKey: 'agent:codex', serverId: 'server-b', cwd: '/repo' }),
        ).toBe(JSON.stringify(['dynamicModelProbe', 'server-b', 'machine-1', 'agent:codex', '/repo']));
    });

    it('normalizes empty server id to active-scope key segment', () => {
    expect(
        buildDynamicModelProbeCacheKey({ machineId: 'machine-1', targetKey: 'agent:codex', serverId: '   ', cwd: '/repo' }),
    ).toBe(JSON.stringify(['dynamicModelProbe', 'active', 'machine-1', 'agent:codex', '/repo']));
  });

    it('includes extra key suffix parts when present', () => {
        expect(
            buildDynamicModelProbeCacheKey({
                machineId: 'machine-1',
                targetKey: 'agent:codex',
                serverId: 'server-a',
                cwd: '/repo',
                extraKeySuffixParts: ['appServer'],
            }),
        ).toBe(JSON.stringify(['dynamicModelProbe', 'server-a', 'machine-1', 'agent:codex', '/repo', 'appServer']));
    });
});
