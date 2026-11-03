import { expect, it } from 'vitest';
import { isHealthCheckLoopbackRefusedV1 } from './healthCheckSourceV1.js';

const subject = { kind: 'machineService', machineId: 'shop-prod', serviceId: 'compose:uptime-kuma' } as const;

it('refuses a loopback host only when a different Machine runs the check, as the producer does', () => {
    const http = { endpoint: 'http://127.0.0.1:3001', expectStatus: 200 };
    expect(isHealthCheckLoopbackRefusedV1({ subject, observerMachineId: 'build-01', kindLocalId: 'http', config: http })).toBe(true);
    expect(isHealthCheckLoopbackRefusedV1({ subject, observerMachineId: 'shop-prod', kindLocalId: 'http', config: http })).toBe(false);
    expect(isHealthCheckLoopbackRefusedV1({ subject, observerMachineId: 'build-01', kindLocalId: 'certificate',
        config: { endpoint: 'https://[::1]/', expectStatus: 200 } })).toBe(true);
    expect(isHealthCheckLoopbackRefusedV1({ subject, observerMachineId: 'build-01', kindLocalId: 'tcp',
        config: { host: 'localhost', port: 5432 } })).toBe(true);
    expect(isHealthCheckLoopbackRefusedV1({ subject, observerMachineId: 'build-01', kindLocalId: 'http',
        config: { endpoint: 'https://status.example.com', expectStatus: 200 } })).toBe(false);
    // DNS and heartbeat carry no probe host; an incomplete draft is not refused before it parses.
    expect(isHealthCheckLoopbackRefusedV1({ subject, observerMachineId: 'build-01', kindLocalId: 'dns',
        config: { hostname: 'localhost', recordType: 'A' } })).toBe(false);
    expect(isHealthCheckLoopbackRefusedV1({ subject, observerMachineId: 'build-01', kindLocalId: 'tcp', config: { host: '127.0.0.1' } })).toBe(false);
});
