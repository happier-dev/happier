import { describe, expect, it } from 'vitest';

import {
    PLUGIN_DAEMON_DATABASE_DEFAULT_LIMITS_V1,
    PLUGIN_DAEMON_DATABASE_PROTOCOL_MAXIMUM_BYTES_V1,
} from '@happier-dev/protocol';

import { createMachinePluginDaemonDatabaseLimitsPolicy, DEFAULT_PLUGIN_DAEMON_DATABASE_LIMITS_POLICY } from './daemonDatabaseLimitsPolicy';

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

// Policy metadata and filesystem capacity are the external boundaries.
describe('Machine retained database allocation', () => {
    it.each([30, null])('preserves the fixed byte floor with retention %s and preserves statement bounds', async (days) => {
        const { MachineResourcesPolicyV1Schema } = await import('@happier-dev/protocol/machines/resources/machineResourcesPolicyV1');
        let freeBytes = 512 * 1024 * 1024;
        const floorBytes = 128 * 1024 * 1024;
        let reads = 0;
        const policy = createMachinePluginDaemonDatabaseLimitsPolicy({
            readPolicy: () => ({ status: 'ready', revision: 1, source: 'stored', policy: MachineResourcesPolicyV1Schema.parse({ v: 1, storage: { logRetentionDays: days }, alerts: { disk: { threshold: { freeBytes: floorBytes } } } }) }),
            readCapacity: async (path) => { reads++; expect(path).toBe('/exact/database'); return { status: 'known', path, observedAt: 1, freeBytes, totalBytes: 1024 * 1024 * 1024 }; },
        });
        const context = { directory: '/exact/database', retainedBytes: 8192, declarations: [{ id: 'capture', migrations: [], incumbentQueryFixtureId: 'events', retention: [{ table: 'events', timeColumn: 'at' }] }] };
        const first = await policy.resolvePluginLimits('acme.capture', context);
        expect(first).toMatchObject({ ...PLUGIN_DAEMON_DATABASE_DEFAULT_LIMITS_V1, maximumDatabaseBytes: 8192 + freeBytes - floorBytes });
        freeBytes = floorBytes;
        expect(await policy.resolvePluginLimits('acme.capture', context)).toMatchObject({ maximumDatabaseBytes: 8192 });
        expect(reads).toBe(2);
        expect(await policy.resolvePluginLimits('acme.capture')).toEqual(PLUGIN_DAEMON_DATABASE_DEFAULT_LIMITS_V1);
        expect(reads).toBe(2);
    });
    it('refuses unknown policy or capacity for retained stores', async () => {
        const { MachineResourcesPolicyV1Schema } = await import('@happier-dev/protocol/machines/resources/machineResourcesPolicyV1');
        const context = { directory: '/exact/database', retainedBytes: 0, declarations: [{ id: 'capture', migrations: [], incumbentQueryFixtureId: 'events', retention: [{ table: 'events', timeColumn: 'at' }] }] };
        for (const ready of [false, true]) {
            const policy = createMachinePluginDaemonDatabaseLimitsPolicy({
                readPolicy: () => ready ? { status: 'ready', revision: 1, source: 'stored', policy: MachineResourcesPolicyV1Schema.parse({ v: 1 }) } : { status: 'unavailable' },
                readCapacity: async path => ({ status: 'unknown', path, reason: 'unavailable' }),
            });
            expect(await policy.resolvePluginLimits('acme.capture', context)).toBeNull();
        }
    });
});
