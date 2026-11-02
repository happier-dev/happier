import { describe, expect, it } from 'vitest';

import * as contracts from './index.js';

const evidence = { v: 1, items: [{ source: { kind: 'alert', label: 'Saved check' },
    author: { kind: 'process' }, text: 'The admitted endpoint returned its expected status.' }] };
const result = { status: 'up', observedAt: 1_793_210_000_000, latencyMs: 0.25, evidence };

describe('saved finite health-check contracts', () => {
    it('admits the shared data-only result and rejects transport/authority bags and invalid numeric facts', () => {
        expect(contracts).toHaveProperty('HealthCheckResultV1Schema');
        expect(contracts.HealthCheckResultV1Schema.parse(JSON.parse(JSON.stringify(result)))).toEqual(result);
        for (const invalid of [
            { ...result, status: 'healthy' }, { ...result, observedAt: -1 },
            { ...result, observedAt: 0.5 }, { ...result, observedAt: Infinity },
            { ...result, observedAt: Number.MAX_SAFE_INTEGER + 1 },
            { ...result, latencyMs: -0.1 }, { ...result, latencyMs: NaN }, { ...result, latencyMs: Infinity },
            { ...result, body: 'raw response' }, { ...result, headers: { authorization: 'credential' } },
            { ...result, observerMachineId: 'caller-selected' },
            { ...result, evidence: { ...evidence, credential: 'raw' } },
            { ...result, evidence: { v: 1, items: [] } },
            { ...result, evidence: { v: 1, items: [{ ...evidence.items[0], actionId: 'machines.reboot' }] } },
        ]) expect(contracts.HealthCheckResultV1Schema.safeParse(invalid).success).toBe(false);
        expect(contracts.HealthCheckResultV1Schema.parse({ status: 'unknown', observedAt: 0, evidence }))
            .toEqual({ status: 'unknown', observedAt: 0, evidence });
    });

    it('uses the existing strict subject for Environment and watched-service checks', () => {
        for (const subject of [{ kind: 'environment', environmentId: 'environment-a' },
            { kind: 'machineService', machineId: 'machine-a', serviceId: 'service-a' }]) {
            expect(contracts.HealthCheckSubjectV1Schema.parse(subject)).toEqual(subject);
            expect(contracts.HealthCheckSubjectV1Schema.safeParse({ ...subject, observerMachineId: 'machine-c' }).success).toBe(false);
        }
        expect(contracts.HealthCheckSubjectV1Schema.safeParse({ kind: 'machineService', serviceId: 'service-a' }).success).toBe(false);
    });

    it('publishes exactly the five first-party kinds without accepting executable commands as a kind', () => {
        expect(contracts).toHaveProperty('HealthCheckKindV1Schema');
        for (const kind of ['http', 'certificate', 'tcp', 'dns', 'heartbeat'])
            expect(contracts.HealthCheckKindV1Schema.parse(kind)).toBe(kind);
        for (const kind of ['shell', 'command', 'probe', '', { kind: 'http' }])
            expect(contracts.HealthCheckKindV1Schema.safeParse(kind).success).toBe(false);
    });
});
