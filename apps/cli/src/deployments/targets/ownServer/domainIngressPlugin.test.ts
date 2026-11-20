import { expect, it } from 'vitest';
import { DeploymentDomainContentV1Schema } from '@happier-dev/protocol/deployments/deploymentDomainV1';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployments/testing/v1';
import type { HostReviewedChildInvocationV1 } from '@happier-dev/protocol/actions/executor/types';
import { prepareOwnServerDomainReviewedChildren } from './ownServerDomainActions';
import { disableCloudflareDomainForHost } from './cloudflareDomainPreparation';

it.each([
    { pluginId: 'example.ingress', localId: 'cloudflare', admitted: false },
    { pluginId: 'happier.deploy.cloudflare', localId: 'another-service', admitted: false },
    { pluginId: 'happier.deploy.cloudflare', localId: 'cloudflare', admitted: true },
])('admits only the declared ingress supplier during review and removal ($pluginId/$localId)', async ({ pluginId, localId, admitted }) => {
    const environment = createDeploymentEnvironmentDetailV1();
    const link = environment.targetLinks[0]!.targetLink;
    const content = DeploymentDomainContentV1Schema.parse({ hostname: 'app.example.test',
        target: { service: 'web', containerPort: 8080 },
        ingress: { provider: { kind: 'builtin', id: 'cloudflareNamed' },
            config: { hostname: 'app.example.test', controller: { accountId: 'vendor', zoneId: 'zone',
                tunnel: { kind: 'create', name: 'app' }, owned: [], dnsOwnership: [],
                connector: { imageRef: 'connector:1', version: '1' } } },
            credentialRefs: [{ purpose: 'tunnel.manage', credentialRef: { kind: 'connectedAccount',
                account: { service: { pluginId, localId }, accountId: 'profile' } } }] } });
    const unexpected = async (): Promise<never> => { throw new Error('No native effect during review'); };
    const plan = await prepareOwnServerDomainReviewedChildren({ actionId: 'deployments.domains.add', context: {},
        input: { serverId: 'home', environmentId: environment.environment.id, domainId: 'domain',
            expectedRevision: environment.environment.revision, targetLinkId: link.id,
            expectedTargetLinkRevision: link.revision, requestKey: 'review', content } }, {
        readEnvironment: async () => environment, storage: unexpected, open: unexpected,
        dispatch: unexpected, readReceipt: unexpected, readInstallation: unexpected,
    });
    const recovered: HostReviewedChildInvocationV1 = { action: { pluginId, localId: 'cloudflare-named/disable' },
        role: 'disable', input: { tunnelName: 'app' } };
    const invoked: HostReviewedChildInvocationV1[] = [];
    const context = { hostReviewedChild: { preparedChildren: [recovered], invoke: async (request: HostReviewedChildInvocationV1) => {
        invoked.push(request);
        return { ok: true as const, result: { kind: 'verified' } };
    } } };
    if (!admitted) {
        expect(plan).toMatchObject({ ok: false, errorCode: 'connected_account_required' });
        await expect(disableCloudflareDomainForHost(content, context, false, undefined))
            .rejects.toMatchObject({ code: 'connected_account_required' });
        expect(invoked).toEqual([]);
        return;
    }
    expect(plan).toMatchObject({ children: [{ action: { pluginId, localId: 'cloudflare-named/configure' }, role: 'configure' }] });
    const wrongAction = { ...recovered, action: { pluginId, localId: 'cloudflare-named/configure' } };
    await expect(disableCloudflareDomainForHost(content, { hostReviewedChild: { ...context.hostReviewedChild,
        preparedChildren: [wrongAction] } }, false, undefined))
        .rejects.toMatchObject({ code: 'required_fact_unavailable', details: { requiredFact: 'reviewed_cloudflare_child' } });
    expect(invoked).toEqual([]);
    await disableCloudflareDomainForHost(content, context, false, undefined);
    expect(invoked).toEqual([recovered]);
    invoked.length = 0;
    await disableCloudflareDomainForHost({ ...content,
        cloudflarePreparation: { tunnelId: 'retained', owned: [], dnsOwnership: [] } }, context, false, undefined);
    expect(invoked).toMatchObject([{ action: { pluginId, localId: 'cloudflare-named/disable' }, role: 'disable',
        input: { tunnelId: 'retained' } }]);
});
