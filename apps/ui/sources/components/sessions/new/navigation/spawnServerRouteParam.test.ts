import { describe, expect, it } from 'vitest';

import { resolveSpawnServerRouteParam } from '@/components/sessions/new/navigation/spawnServerRouteParam';

describe('resolveSpawnServerRouteParam', () => {
    it('returns trimmed spawn server id when provided as string', () => {
        expect(resolveSpawnServerRouteParam(' server-b ')).toBe('server-b');
    });

    it('returns null for missing or invalid values', () => {
        expect(resolveSpawnServerRouteParam(undefined)).toBeNull();
        expect(resolveSpawnServerRouteParam(null)).toBeNull();
        expect(resolveSpawnServerRouteParam('   ')).toBeNull();
        expect(resolveSpawnServerRouteParam(['server-a'])).toBeNull();
    });
});
