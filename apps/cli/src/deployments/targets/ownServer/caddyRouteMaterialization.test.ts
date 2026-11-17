import { describe, expect, it, vi } from 'vitest';
import { nativeCaddyDomainRouteIdsV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { materializeCaddyDomainRouteV1, materializeCaddyInitialConfigV1,
    materializeCaddyDomainRemovalV1, materializeCaddyDomainReplicaSetV1 } from './caddyRouteMaterialization';
import { logger } from '@/ui/logger';

describe('Caddy public TLS materialization', () => {
    it('routes a deployed telemetry App through its private declared replica port as a local origin', () => {
        const material = materializeCaddyDomainRouteV1({ domainId: 'collector-app', listener: 'privateOrigin',
            domain: { hostname: 'collector.example.test', target: { kind: 'telemetry' } },
            upstreams: { kind: 'replicas', containerNames: ['collector-1'], containerPort: 4318 },
            telemetryPrivateHosts: ['100.70.0.2'], privateSourceRanges: ['100.64.0.0/10'] });
        expect(material.replicaProxy?.upstreams).toEqual([{ dial: 'collector-1:4318' }]);
        expect(material.replicaProxy).toHaveProperty('headers.request.delete', ['X-Happier-Fallback']);
        expect(material.route.match).toEqual([{ host: ['collector.example.test', '100.70.0.2'] }]);
        const observed = materializeCaddyDomainRemovalV1({ domainId: 'collector-app', listener: 'privateOrigin',
            domain: { hostname: 'collector.example.test', target: { kind: 'telemetry' } } },
            { route: material.route, fallbackRoute: material.fallbackRoute });
        expect(observed?.replicaProxy?.upstreams).toEqual([{ dial: 'collector-1:4318' }]);
        if (!observed) throw new Error('The installed collector App route must remain observable');
        expect(materializeCaddyDomainReplicaSetV1(observed, ['collector-2']).replicaProxy?.upstreams)
            .toEqual([{ dial: 'collector-2:4318' }]);
    });
    it('routes an unprobed Domain without active checks, extra path matches or authentication exemptions', () => {
        const material = materializeCaddyDomainRouteV1({ domainId: 'unchecked', listener: 'privateOrigin',
            domain: { hostname: 'app.example.test', target: { service: 'web', containerPort: 3000, path: '/app' } },
            upstreams: { kind: 'replicas', containerNames: ['web-1'] }, privateSourceRanges: ['100.64.0.0/10'],
            basicAuth: [{ username: 'reader', bcryptHash: 'boundary-hash' }] });
        expect(material.route.match).toEqual([{ host: ['app.example.test'], path: ['/app*'] }]);
        expect(material.route).toHaveProperty('handle.0.routes.0.handle.0.handler', 'authentication');
        expect(material.route).not.toHaveProperty('handle.0.routes.0.match');
        expect(material.replicaProxy?.upstreams).toEqual([{ dial: 'web-1:3000' }]);
        expect(material.replicaProxy).not.toHaveProperty('health_checks');
    });
    it('adds Caddy active checks and their auth exemption only for an explicitly expected status', () => {
        const input: Parameters<typeof materializeCaddyDomainRouteV1>[0] = { domainId: 'default-check', listener: 'privateOrigin',
            domain: { hostname: 'app.example.test', target: { service: 'web', containerPort: 3000 }, healthCheck: { path: '/' } },
            upstreams: { kind: 'replicas', containerNames: ['web-1'] }, privateSourceRanges: ['100.64.0.0/10'],
            basicAuth: [{ username: 'reader', bcryptHash: 'boundary-hash' }] };
        const defaulted = materializeCaddyDomainRouteV1(input);
        expect(defaulted.replicaProxy).not.toHaveProperty('health_checks');
        expect(defaulted.route).not.toHaveProperty('handle.0.routes.0.match');
        const explicit = materializeCaddyDomainRouteV1({ ...input, domain: { ...input.domain, healthCheck: { path: '/', expectStatus: 200 } } });
        expect(explicit.replicaProxy).toHaveProperty('health_checks.active', expect.objectContaining({ uri: '/', expect_status: 200 }));
    });
    it('exempts only the exact uncleaned private GET health path and keeps public health authenticated', () => {
        for (const path of ['/healthz', '/', '/health"check']) {
            const input: Parameters<typeof materializeCaddyDomainRouteV1>[0] = { domainId: 'health-auth', listener: 'privateOrigin',
                domain: { hostname: 'app.example.test', target: { service: 'web', containerPort: 3000 },
                    healthCheck: { path, expectStatus: 200 } },
                upstreams: { kind: 'replicas', containerNames: ['web-1'] }, privateSourceRanges: ['100.64.0.0/10'],
                basicAuth: [{ username: 'reader', bcryptHash: 'boundary-hash' }] };
            const privateRoute = materializeCaddyDomainRouteV1(input).route;
            expect(privateRoute).toHaveProperty('handle.0.routes.0.match.0.not.0', {
                method: ['GET'], expression: `{http.request.uri.path} == ${JSON.stringify(path)}`,
                remote_ip: { ranges: input.privateSourceRanges },
            });
            expect(materializeCaddyDomainRouteV1({ ...input, listener: 'public' }).route)
                .not.toHaveProperty('handle.0.routes.0.match');
        }
    });

    it('keeps the private origin plain while seeding public TLS and HTTP redirect owners only when requested', () => {
        const privateOnly = materializeCaddyInitialConfigV1({ adminSocket: '/run/caddy/admin.sock', originListen: [':8080'] });
        expect(Object.keys(privateOnly.apps.http.servers)).toEqual(['happier_private']);
        expect(privateOnly.apps.http.servers.happier_private?.automatic_https).toEqual({ disable: true });
        expect(privateOnly.apps).not.toHaveProperty('tls');
        const publicInput = { adminSocket: '/run/caddy/admin.sock', originListen: [':8080'] as const,
            publicListen: [':443'] as const, publicHttpListen: [':80'] as const };
        const publicConfig = materializeCaddyInitialConfigV1(publicInput);
        expect(publicConfig.apps.http.servers.happier_public).toMatchObject({ listen: [':443'], tls_connection_policies: [{}] });
        expect(publicConfig.apps.http.servers.happier_public_http).toMatchObject({ listen: [':80'], automatic_https: { disable: true } });
        expect(publicConfig.apps).toHaveProperty('tls.certificates.load_pem', []);
    });

    it('renders custom SNI selection, exact owned certificate tags and canonical redirects without weakening auth', () => {
        const input = { domainId: 'domain-public', listener: 'public' as const,
            domain: { hostname: 'www.example.test', target: { service: 'web', containerPort: 3000, redirectTo: 'https://example.test' },
                healthCheck: { path: '/healthz', expectStatus: 200 } },
            upstreams: { kind: 'replicas' as const, containerNames: ['app-web-1'] as const }, privateSourceRanges: [],
            publicTls: { kind: 'custom' as const, certificatePem: 'certificate-role-content', privateKeyPem: 'private-key-role-content' },
            basicAuth: [{ username: 'reader', bcryptHash: 'bcrypt-boundary-value' }] };
        const material = materializeCaddyDomainRouteV1(input);
        const ids = nativeCaddyDomainRouteIdsV1(input.domainId, input.listener);
        expect(material).toHaveProperty('tls.certificate', { '@id': ids.certificateId,
            certificate: 'certificate-role-content', key: 'private-key-role-content', tags: [ids.certificateId] });
        expect(material).toHaveProperty('tls.connectionPolicy', { '@id': ids.tlsPolicyId,
            match: { sni: ['www.example.test'] }, certificate_selection: { any_tag: [ids.certificateId] } });
        expect(material).toHaveProperty('tls.redirectRoute.handle.0.headers.Location', ['https://www.example.test{http.request.uri}']);
        expect(material.route).toHaveProperty('handle.0.routes.0.handle.0.handler', 'authentication');
        expect(material.route).toHaveProperty('handle.0.routes.1.handle.0.headers.Location', ['https://example.test{http.request.uri}']);
        const privateMaterial = materializeCaddyDomainRouteV1({ ...input, listener: 'privateOrigin' });
        expect(privateMaterial).not.toHaveProperty('tls');
        expect(privateMaterial.route).toHaveProperty('handle.0.routes.1.handle.1.handler', 'reverse_proxy');
    });

    it('normalizes a declared canonical Domain or URL prefix and refuses unsupported destination grammar', () => {
        const input = { domainId: 'canonical', listener: 'public' as const, privateSourceRanges: [],
            upstreams: { kind: 'replicas' as const, containerNames: ['web-1'] as const },
            domain: { hostname: 'www.example.test', target: { service: 'web', containerPort: 3000, redirectTo: 'example.test' },
                healthCheck: { path: '/healthz', expectStatus: 200 } } };
        const location = (redirectTo: string) => materializeCaddyDomainRouteV1({ ...input, domain: { ...input.domain,
            target: { ...input.domain.target, redirectTo } } }).route;
        expect(location('example.test')).toHaveProperty('handle.0.routes.0.handle.0.headers.Location', ['https://example.test{http.request.uri}']);
        expect(location('http://example.test/prefix/')).toHaveProperty('handle.0.routes.0.handle.0.headers.Location', ['http://example.test/prefix{http.request.uri}']);
        for (const destination of ['javascript:alert(1)', 'https://user:password@example.test', 'https://example.test/?q=1', 'https://example.test/#fragment']) {
            expect(() => location(destination)).toThrowError(expect.objectContaining({ code: 'invalid_parameters' }));
        }
        const logged = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => {});
        try {
            expect(() => location('https://[PRIVATE-invalid-host'))
                .toThrowError(expect.objectContaining({ code: 'invalid_parameters' }));
            expect(logged).toHaveBeenCalledWith('[Deployment] Domain redirect parse failed', expect.objectContaining({
                phase: 'deployment.domain.redirect_parse', errorClass: 'TypeError', errorCode: null,
            }));
            expect(JSON.stringify(logged.mock.calls)).not.toContain('PRIVATE');
        } finally { logged.mockRestore(); }
    });

    it.each(['app.example.com', 'replay135-cli-dj18.localhost', 'localhost', '127.0.0.1'])('leaves managed issuer selection for %s to Caddy', hostname => {
        const input = { domainId: 'domain-managed', listener: 'public' as const,
            domain: { hostname, target: { service: 'web', containerPort: 3000 }, healthCheck: { path: '/', expectStatus: 200 } },
            upstreams: { kind: 'replicas' as const, containerNames: ['app-web-1'] as const }, privateSourceRanges: [] };
        expect(materializeCaddyDomainRouteV1(input)).not.toHaveProperty('tls.automationPolicy');
        expect(materializeCaddyDomainRouteV1({ ...input, listener: 'privateOrigin' })).not.toHaveProperty('tls');
    });
});
