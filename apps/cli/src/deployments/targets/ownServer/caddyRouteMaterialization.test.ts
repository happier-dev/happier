import { describe, expect, it } from 'vitest';
import { nativeCaddyDomainRouteIdsV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { materializeCaddyDomainRouteV1, materializeCaddyInitialConfigV1 } from './caddyRouteMaterialization';

describe('Caddy public TLS materialization', () => {
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
    });

    it('uses Caddy ACME automation only for the public hostname and leaves its renewal scheduling native', () => {
        const input = { domainId: 'domain-managed', listener: 'public' as const,
            domain: { hostname: 'app.example.com', target: { service: 'web', containerPort: 3000 }, healthCheck: { path: '/', expectStatus: 200 } },
            upstreams: { kind: 'replicas' as const, containerNames: ['app-web-1'] as const }, privateSourceRanges: [] };
        expect(materializeCaddyDomainRouteV1(input)).toHaveProperty('tls.automationPolicy', {
            '@id': nativeCaddyDomainRouteIdsV1(input.domainId, input.listener).automationPolicyId,
            subjects: ['app.example.com'], issuers: [{ module: 'acme' }],
        });
        expect(materializeCaddyDomainRouteV1({ ...input, listener: 'privateOrigin' })).not.toHaveProperty('tls');
    });
});
