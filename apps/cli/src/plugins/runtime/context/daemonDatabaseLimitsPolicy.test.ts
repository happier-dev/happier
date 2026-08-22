import { describe, expect, it } from 'vitest';

import {
    PLUGIN_DAEMON_DATABASE_DEFAULT_LIMITS_V1,
    PLUGIN_DAEMON_DATABASE_PROTOCOL_MAXIMUM_BYTES_V1,
} from '@happier-dev/protocol';

import { DEFAULT_PLUGIN_DAEMON_DATABASE_LIMITS_POLICY } from './daemonDatabaseLimitsPolicy';

describe('default plugin daemon database limits policy', () => {
    it('returns the single evidence-backed Preview allocation under the protocol ceiling', () => {
        const first = DEFAULT_PLUGIN_DAEMON_DATABASE_LIMITS_POLICY.resolvePluginLimits(
            'examples.background-indexer',
        );
        const second = DEFAULT_PLUGIN_DAEMON_DATABASE_LIMITS_POLICY.resolvePluginLimits(
            'com.example.other-plugin',
        );

        expect(first).toEqual({
            maximumDatabaseBytes: 128 * 1024 * 1024,
            maximumInputBytes: 16 * 1024,
            maximumResultBytes: 16 * 1024,
            maximumResultRows: 100,
            maximumAffectedRows: 1_000,
            maximumElapsedMs: 5_000,
        });
        expect(first).toEqual(PLUGIN_DAEMON_DATABASE_DEFAULT_LIMITS_V1);
        expect(second).toBe(first);
        expect(first?.maximumDatabaseBytes).toBe(PLUGIN_DAEMON_DATABASE_PROTOCOL_MAXIMUM_BYTES_V1);
        expect(DEFAULT_PLUGIN_DAEMON_DATABASE_LIMITS_POLICY.protocolMaximumDatabaseBytes)
            .toBe(PLUGIN_DAEMON_DATABASE_PROTOCOL_MAXIMUM_BYTES_V1);
    });
});
