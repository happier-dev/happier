import { describe, expect, it } from 'vitest';
import type { EnvironmentSecretBindingV1 } from '@happier-dev/deployment-protocol';
import { projectDeploymentPromotionBindingGaps, readDeploymentAddDeclaredInputs, readDeploymentDeclaredContainerPorts } from './deploymentPreflightWarnings';

const value = { kind: 'value' as const, value: 'public' };
const secret = { kind: 'secret' as const, ref: 'happier:shared-secret:v1:token', resourceRevision: 1 };
const source: EnvironmentSecretBindingV1[] = [
    { purpose: 'variable', name: 'TOKEN', phase: 'runtime', source: secret },
    { purpose: 'variable', name: 'ORIGIN', phase: 'build', source: value },
    { purpose: 'variable', name: 'ORIGIN', phase: 'runtime', source: value },
    { purpose: 'registry', targetLinkId: 'source-link', registryOrigin: 'https://registry.test', access: 'pull', source: secret },
];
describe('deployment preflight warnings', () => {
    it('projects only the final allocated source declarations, without evaluating short syntax or interpolation', async () => {
        const declarations = await readDeploymentAddDeclaredInputs(JSON.stringify({ services: {
            existing: { container_name: 'existing', ports: ['80:80'] },
            'web-2': { container_name: '${APP_NAME}-2', environment: { PASSWORD: 'never-project' }, ports: [
                '127.0.0.1:8080:80', '${PORT}:81', 82,
                { target: 80, published: 18080, host_ip: '127.0.0.1', protocol: 'tcp' },
                { target: 81, published: '${PORT}', protocol: 'udp' },
            ] },
        } }), ['web-2']);
        expect(declarations).toEqual({ services: [{ service: 'web-2', name: '${APP_NAME}-2', ports: [
            '127.0.0.1:8080:80', '${PORT}:81', 82,
            { target: 80, published: 18080, bindAddress: '127.0.0.1', protocol: 'tcp' },
            { target: 81, published: '${PORT}', bindAddress: null, protocol: 'udp' },
        ] }], query: { ports: [18080], nativeNames: [] }, unresolved: true });
        expect(JSON.stringify(declarations)).not.toContain('never-project');
        expect(await readDeploymentAddDeclaredInputs('services: { web: { image: nginx } }', ['web']))
            .toEqual({ services: [{ service: 'web', name: null, ports: [] }], query: { ports: [], nativeNames: [] }, unresolved: true });
        await expect(readDeploymentAddDeclaredInputs('services: [', ['web'])).rejects.toHaveProperty('code', 'invalid_request');
    });
    it('reads each service\'s literal container ports from expose and the container side of ports', async () => {
        expect(await readDeploymentDeclaredContainerPorts(JSON.stringify({ services: {
            app: { image: 'nginx', expose: ['80', 80, '9000/udp'] },
            api: { ports: ['8080:3000', { target: 4000, published: 14000 }, '${PORT}:5000', '7000-7002'] },
            worker: { image: 'busybox' },
        } }))).toEqual([
            { service: 'app', containerPort: 80 }, { service: 'app', containerPort: 9000 },
            { service: 'api', containerPort: 3000 }, { service: 'api', containerPort: 4000 }, { service: 'api', containerPort: 5000 },
        ]);
    });
    it('compares variable identities including phase, without requiring matching secret refs or exposing their values', () => {
        const destination: EnvironmentSecretBindingV1[] = [{ purpose: 'variable', name: 'ORIGIN', phase: 'runtime', source: value }];
        expect(projectDeploymentPromotionBindingGaps(source, destination)).toEqual([
            { name: 'TOKEN', phase: 'runtime', secret: true }, { name: 'ORIGIN', phase: 'build', secret: false },
        ]);
        expect(projectDeploymentPromotionBindingGaps(source, source.map(binding => binding.purpose === 'variable' ? { ...binding, source: value } : binding))).toEqual([]);
        expect(projectDeploymentPromotionBindingGaps([], [])).toEqual([]);
    });

});
