import { expect, it } from 'vitest';
import { DeploymentDomainContentV1Schema } from '@happier-dev/deployment-protocol';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployment-protocol/testing/v1';
import type { HostReviewedChildInvocationV1 } from '@happier-dev/protocol/actions/executor/types';
import { prepareOwnServerDomainReviewedChildren } from './ownServerDomainActions';
import { disableCloudflareDomainForHost } from './cloudflareDomainPreparation';

it.each(['example.ingress', 'happier.deploy.cloudflare'])('keeps the selected ingress supplier %s through review and removal', async pluginId => {
    const environment = createDeploymentEnvironmentDetailV1();
    const link = environment.targetLinks[0]!.targetLink;
    const content = DeploymentDomainContentV1Schema.parse({ hostname: 'app.example.test',
        target: { service: 'web', containerPort: 8080 },
        ingress: { provider: { kind: 'builtin', id: 'cloudflareNamed' },
            config: { hostname: 'app.example.test', controller: { accountId: 'vendor', zoneId: 'zone',
                tunnel: { kind: 'create', name: 'app' }, owned: [], dnsOwnership: [],
                connector: { imageRef: 'connector:1', version: '1' } } },
            credentialRefs: [{ purpose: 'tunnel.manage', credentialRef: { kind: 'connectedAccount',
                account: { service: { pluginId, localId: 'ingress-service' }, accountId: 'profile' } } }] } });
    const unexpected = async (): Promise<never> => { throw new Error('No native effect during review'); };
    const plan = await prepareOwnServerDomainReviewedChildren({ actionId: 'deployments.domains.add', context: {},
        input: { serverId: 'home', environmentId: environment.environment.id, domainId: 'domain',
            expectedRevision: environment.environment.revision, targetLinkId: link.id,
            expectedTargetLinkRevision: link.revision, requestKey: 'review', content } }, {
        readEnvironment: async () => environment, storage: unexpected, open: unexpected,
        dispatch: unexpected, readReceipt: unexpected, readInstallation: unexpected,
    });
    expect(plan).toMatchObject({ children: [{ action: { pluginId, localId: 'cloudflare-named/configure' }, role: 'configure' }] });

    const recovered: HostReviewedChildInvocationV1 = { action: { pluginId, localId: 'cloudflare-named/disable' },
        role: 'disable', input: { tunnelName: 'app' } };
    const invoked: HostReviewedChildInvocationV1[] = [];
    const context = { hostReviewedChild: { preparedChildren: [recovered], invoke: async (request: HostReviewedChildInvocationV1) => {
        invoked.push(request);
        return { ok: true as const, result: { kind: 'verified' } };
    } } };
    await disableCloudflareDomainForHost(content, context);
    expect(invoked).toEqual([recovered]);
    invoked.length = 0;
    await disableCloudflareDomainForHost({ ...content,
        cloudflarePreparation: { tunnelId: 'retained', owned: [], dnsOwnership: [] } }, context);
    expect(invoked).toMatchObject([{ action: { pluginId, localId: 'cloudflare-named/disable' }, role: 'disable',
        input: { tunnelId: 'retained' } }]);
});
