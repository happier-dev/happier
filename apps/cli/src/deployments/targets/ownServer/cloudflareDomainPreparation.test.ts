import { expect, it } from 'vitest';
import { DeploymentDomainContentV1Schema } from '@happier-dev/protocol/deployments/deploymentDomainV1';
import { disableCloudflareDomainForHost } from './cloudflareDomainPreparation';

it('identifies the missing Cloudflare removal fact before any vendor effect', async () => {
    const content = DeploymentDomainContentV1Schema.parse({ hostname: 'app.example.test',
        target: { service: 'web', containerPort: 8080 }, healthCheck: { path: '/health', expectStatus: 200 },
        ingress: { provider: { kind: 'builtin', id: 'cloudflareNamed' },
            config: { hostname: 'app.example.test', controller: { accountId: 'vendor-account', zoneId: 'vendor-zone',
                tunnel: { kind: 'adopt', tunnelId: 'reviewed-tunnel', name: 'environment-tunnel' }, owned: [], dnsOwnership: [],
                connector: { imageRef: 'cloudflare/cloudflared:2026.10.0', version: '2026.10.0' } } },
            credentialRefs: [{ purpose: 'tunnel.manage', credentialRef: { kind: 'connectedAccount',
                account: { service: { pluginId: 'happier.deploy.cloudflare', localId: 'cloudflare' }, accountId: 'profile' } } }] } });
    await expect(disableCloudflareDomainForHost(content, {})).rejects.toMatchObject({ code: 'required_fact_unavailable',
        details: { requiredFact: 'reviewed_cloudflare_child' } });
    await expect(disableCloudflareDomainForHost({ ...content,
        cloudflarePreparation: { tunnelId: 'reviewed-tunnel', owned: [], dnsOwnership: [] } }, {}))
        .rejects.toMatchObject({ code: 'required_fact_unavailable', details: { requiredFact: 'reviewed_cloudflare_child' } });
});
