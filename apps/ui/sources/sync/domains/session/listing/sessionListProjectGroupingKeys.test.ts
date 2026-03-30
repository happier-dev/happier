import { describe, expect, it } from 'vitest';

import { resolveSessionProjectGroupingKeyParts } from './sessionListProjectGroupingKeys';

describe('resolveSessionProjectGroupingKeyParts', () => {
    it('normalizes windows separators and expands ~ using homeDir', () => {
        const parts = resolveSessionProjectGroupingKeyParts({
            host: 'example',
            machineId: 'm1',
            homeDir: 'C:\\Users\\Bob\\',
            path: '~\\repo\\',
        });

        expect(parts.homeDir).toBe('C:/Users/Bob');
        expect(parts.pathKey).toBe('C:/Users/Bob/repo');
        expect(parts.machineGroupId).toBe('host:example');
    });

    it('preserves UNC/network share prefixes when normalizing slashes', () => {
        const parts = resolveSessionProjectGroupingKeyParts({
            host: 'example',
            machineId: 'm1',
            path: '\\\\server\\share\\repo\\',
        });

        expect(parts.pathKey).toBe('//server/share/repo');
        expect(parts.machineGroupId).toBe('host:example');
    });
});
