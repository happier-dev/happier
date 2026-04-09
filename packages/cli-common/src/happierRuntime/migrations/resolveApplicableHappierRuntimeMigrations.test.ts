import { describe, expect, it } from 'vitest';

import {
    resolveApplicableHappierRuntimeMigrations,
    hasApplicableHappierRuntimeMigrations,
} from './resolveApplicableHappierRuntimeMigrations.js';

describe('resolveApplicableHappierRuntimeMigrations', () => {
    it('returns the 0.2.3 background-service migration when an install crosses the boundary', () => {
        expect(resolveApplicableHappierRuntimeMigrations({
            fromVersion: '0.2.2',
            toVersion: '0.2.3',
        })).toEqual([
            expect.objectContaining({
                id: 'v0_2_3-BackgroundServiceAndReleaseChannelMigration',
                boundaryVersion: '0.2.3',
            }),
        ]);
    });

    it('normalizes leading v prefixes and ignores upgrades that stay past the boundary', () => {
        expect(resolveApplicableHappierRuntimeMigrations({
            fromVersion: 'v0.2.3',
            toVersion: 'v0.2.4',
        })).toEqual([]);
        expect(hasApplicableHappierRuntimeMigrations({
            fromVersion: 'v0.2.2',
            toVersion: 'v0.2.3',
        })).toBe(true);
    });
});
