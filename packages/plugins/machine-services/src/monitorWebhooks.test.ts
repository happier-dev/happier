import { expect, it } from 'vitest';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { HealthCheckSourceConfigV1, JsonValue } from '@happier-dev/plugin-sdk';
import type { AccountKvEntry, AccountKvService } from '@happier-dev/plugin-sdk/storage';
import { plugin } from './manifest.js';

it.each(['uptime-kuma', 'gatus'] as const)('routes only the saved admitted %s mapping, ignores replay/old basis, and never exposes provider bags', async kind => {
    const endpoint = 'wh_ep_AAAAAAAAAAAAAAAAAAAAAA';
    let source: HealthCheckSourceConfigV1 = { v: 1, subject: { kind: 'machineService', machineId: 'machine', serviceId: 'shop' },
        checks: [{ checkId: 'shop', kind: { pluginId: plugin.manifest.id, localId: kind },
            binding: { kind: 'healthCheck' }, config: { ...(kind === 'uptime-kuma' ? { monitorId: '7' }
                : { endpointGroup: '', endpointName: '7' }), webhookEndpointId: endpoint, observingSince: 100 },
            periodMs: 1000, consecutiveFailuresBeforeAlerting: 2 }] };
    const rows = new Map<string, AccountKvEntry>();
    const events: JsonValue[] = [];
    const kv = { async get(key: string) { return rows.get(key) ?? null; },
        async set(key: string, value: JsonValue, options: { expectedVersion: number | 'absent' }) {
            const version = (rows.get(key)?.version ?? 0) + 1;
            expect(rows.get(key)?.version ?? 'absent').toBe(options.expectedVersion);
            rows.set(key, { version, value }); return { version };
        },
        async transaction<T>(operation: (store: AccountKvService) => Promise<T>) { return operation(kv as AccountKvService); },
    };
    // Account storage, admitted source lookup and Event transport are host boundaries.
    const kit = await createPluginTestkit({ manifest: plugin.manifest, module: plugin, services: {
        storage: { account: { kv: kv as AccountKvService } },
        healthChecks: { readSource: async () => source },
        events: { plugin: { emit: async (_id: string, payload: JsonValue) => { events.push(payload); } } },
    } });
    const delivery = (status: number, receivedAtMs: number, monitorID = 7) => {
        const raw = JSON.stringify(kind === 'uptime-kuma' ? { monitor: { id: monitorID }, heartbeat: { monitorID, status,
            time: `2026-11-10 10:00:${status === 1 ? '02' : '01'}.000`, msg: 'private vendor data' }, subject: { serviceId: 'other' } }
            : { endpointGroup: '', endpointName: String(monitorID), status: status === 1 ? 'RESOLVED' : 'TRIGGERED', msg: 'private vendor data' });
        return { v: 1, endpoint: { webhookContribution: { pluginId: plugin.manifest.id, localId: `health-${kind}` },
            sourceInstanceId: 'health:shop', webhookEndpointId: endpoint },
            delivery: { deliveryId: `delivery-${receivedAtMs}`, attempt: 1, replay: 0, receivedAtMs, providerDeliveryId: `provider-${receivedAtMs}` },
            request: { contentType: 'application/json', headers: [], rawBodyBytes: Buffer.byteLength(raw), rawBodyBase64: Buffer.from(raw).toString('base64') },
            verified: { verifier: 'capabilityUrl_v1' } };
    };
    try {
        expect(await kit.invokeAction(`health/${kind}/receive`, delivery(0, 200))).toMatchObject({ disposition: 'accepted' });
        expect(await kit.invokeAction(`health/${kind}`, { sourceInstanceId: 'health:shop', checkId: 'shop' })).toMatchObject({ status: 'down' });
        await kit.invokeAction(`health/${kind}/receive`, delivery(1, 90));
        await kit.invokeAction(`health/${kind}/receive`, delivery(1, 300, 8));
        await kit.invokeAction(`health/${kind}/receive`, delivery(0, 200));
        // A retried delivery repeats its hint so an interrupted emit can recover.
        // The single observer dedupes the retained result before counting D5.
        expect(events).toHaveLength(2);
        expect(JSON.stringify(events)).not.toContain('private');
        source = { ...source, checks: source.checks.map(check => ({ ...check, config: { ...check.config as object,
            ...(kind === 'uptime-kuma' ? { monitorId: '8' } : { endpointName: '8' }), observingSince: 400 } })) };
        expect(await kit.invokeAction(`health/${kind}`, { sourceInstanceId: 'health:shop', checkId: 'shop' })).toMatchObject({ status: 'unknown' });
    } finally { await kit.dispose(); }
});
