import { describe, expect, it } from 'vitest';
import { DeploymentDomainHealthCheckV1Schema, withDeploymentDomainHealthCheckDefaultV1 } from './deploymentDomainHealthCheckV1.js';

describe('Domain outside check default', () => {
    it('gives a native Domain without a check the root path and no exact status, and keeps an authored check', () => {
        const native = { hostname: 'app.test', target: { service: 'web', containerPort: 80 } };
        expect(withDeploymentDomainHealthCheckDefaultV1(native)).toEqual({ ...native, healthCheck: { path: '/' } });
        const authored = { ...native, healthCheck: { path: '/health', expectStatus: 204 } };
        expect(withDeploymentDomainHealthCheckDefaultV1(authored)).toBe(authored);
        const provider = { hostname: 'app.test', target: { kind: 'provider' as const } };
        expect(withDeploymentDomainHealthCheckDefaultV1(provider)).toBe(provider);
        expect(DeploymentDomainHealthCheckV1Schema.safeParse({ path: '/' }).success).toBe(true);
    });
});
