import { describe, expect, it } from 'vitest';
import { buildLightMigrateDeployPlan, requireLightDataDir } from './migrate.light.deployPlan';

describe('requireLightDataDir', () => {
    it('throws when HAPPY_SERVER_LIGHT_DATA_DIR is missing', () => {
        expect(() => requireLightDataDir({})).toThrow(/HAPPY_SERVER_LIGHT_DATA_DIR/);
    });

    it('throws when HAPPY_SERVER_LIGHT_DATA_DIR is empty', () => {
        expect(() => requireLightDataDir({ HAPPY_SERVER_LIGHT_DATA_DIR: '   ' })).toThrow(/HAPPY_SERVER_LIGHT_DATA_DIR/);
    });

    it('returns a trimmed HAPPY_SERVER_LIGHT_DATA_DIR', () => {
        expect(requireLightDataDir({ HAPPY_SERVER_LIGHT_DATA_DIR: '  /tmp/happy  ' })).toBe('/tmp/happy');
    });
});

describe('buildLightMigrateDeployPlan', () => {
    it('throws when HAPPY_SERVER_LIGHT_DATA_DIR is missing', () => {
        expect(() => buildLightMigrateDeployPlan({})).toThrow(/HAPPY_SERVER_LIGHT_DATA_DIR/);
    });

    it('returns the expected migrate args for pglite light', () => {
        const plan = buildLightMigrateDeployPlan({ HAPPY_SERVER_LIGHT_DATA_DIR: '/tmp/happy' });
        expect(plan.dataDir).toBe('/tmp/happy');
        expect(plan.prismaDeployArgs).toEqual(['-s', 'migrate:light:deploy']);
    });
});
