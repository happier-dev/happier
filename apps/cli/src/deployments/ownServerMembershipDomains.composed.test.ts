import axios from 'axios';
import tweetnacl from 'tweetnacl';
import { afterEach, expect, it, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { readDeploymentTargetLinkArtifactV1 } from '@happier-dev/deployment-protocol';
import { DeploymentEnvironmentGetResultV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { ExternalActionExecutionAuthorizationV1Schema, bindExternalActionExecutionAuthorizationVerifyHttpPathV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { DeploymentDomainHeaderV1Schema } from '@happier-dev/protocol/deployments/deploymentDomainV1';
import { DeploymentTemplateInstantiateInputV1Schema } from '@happier-dev/protocol/deployments/deploymentTemplateInstantiationV1';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { createDaemonDeploymentActionDeps } from './createDaemonDeploymentActionDeps';
import { createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { readDeploymentEnvironmentForHost } from './readEnvironmentForHost';
import { createOwnServerDomainActions, createOwnServerDomainContentWriter } from './targets/ownServer/ownServerDomainActions';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { prepareRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionProjection';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each(['join', 'successor join', 'rollback', 'promote', 'template upgrade', 'drain', 'full teardown'] as const)('reviews Domain configuration during %s through daemon composition', async kind => {
    const environment = createDeploymentEnvironmentDetailV1();
    const link = environment.targetLinks[0]!.targetLink;
    link.members = [{ machineId: 'a', installationId: 'installed-a', state: 'active' },
        { machineId: 'b', installationId: 'installed-b', state: kind === 'join' || kind === 'successor join' || kind === 'rollback' || kind === 'promote' || kind === 'template upgrade' ? 'joining' : 'active' }];
    link.machines = ['a', 'b'];
    const targetLinks = [link];
    if (kind === 'successor join') {
        link.predecessorTargetLinkId = 'prior-link';
        targetLinks.push({ ...link, id: 'prior-link', predecessorTargetLinkId: undefined, contentArtifactId: 'prior-link-content',
            members: [link.members[0]!], machines: ['a'] });
    }
    const domain = DeploymentDomainHeaderV1Schema.parse({ v: 1, id: 'domain', environmentId: environment.environment.id,
        targetLinkId: kind === 'successor join' ? 'prior-link' : link.id, revision: 7, state: 'active', contentArtifactId: 'domain-content', contentHeaderVersion: 1,
        contentBodyVersion: 1, createdByAccountId: 'owner', createdAtMs: 1, updatedAtMs: 1 });
    const credentialRef = { service: { pluginId: 'happier.deploy.cloudflare', localId: 'cloudflare' }, accountId: 'cloudflare-profile' };
    const domainContent = { hostname: 'app.example.test', target: { service: 'web', containerPort: 80 },
        ingress: { provider: { kind: 'builtin', id: 'cloudflareNamed' }, config: { hostname: 'app.example.test',
            controller: { accountId: 'vendor-account', zoneId: 'vendor-zone', tunnel: { kind: 'adopt', tunnelId: 'tunnel', name: 'environment' },
                owned: [], dnsOwnership: [], connector: { imageRef: 'cloudflare/cloudflared:2026.10.0', version: '2026.10.0' } } },
            credentialRefs: [{ purpose: 'tunnel.manage', credentialRef: { kind: 'connectedAccount', account: credentialRef } }] },
        cloudflarePreparation: { tunnelId: 'tunnel', owned: [], dnsOwnership: [] } };
    const documents = new Map<string, { kind: string; content: unknown }>([
        [environment.environment.contentArtifactId, { kind: 'deployment-environment.v1', content: environment.content }],
        [link.contentArtifactId, { kind: 'deployment-target-link.v1', content: environment.targetLinks[0]!.content }],
        ['domain-content', { kind: 'deployment-domain.v1', content: domainContent }],
    ]);
    if (kind === 'successor join') documents.set('prior-link-content', {
        kind: 'deployment-target-link.v1', content: environment.targetLinks[0]!.content });
    // Home HTTP is the boundary. Daemon composition, Artifact codecs and Domain preparation stay real.
    vi.spyOn(axios, 'get').mockImplementation(async url => {
        const path = new URL(url).pathname;
        if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture({ mode: 'plain' }) };
        if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
        if (path === '/v1/account/profile') return { status: 200, data: { id: 'owner' } };
        if (path === '/v2/account/settings') return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
        const id = path.split('/').at(-1)!;
        const document = documents.get(id);
        if (!document) throw new Error(`Unexpected membership Artifact read: ${path}`);
        return { status: 200, data: { id, ownerAccountId: 'owner', access: 'owner', publicAudience: 'none', encryptionMode: 'plain',
            dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, header: encodePlainArtifactStoredContent({ kind: document.kind, title: 'Content' }),
            body: encodePlainArtifactStoredContent({ body: JSON.stringify(document.content) }), headerVersion: 1, bodyVersion: 1,
            seq: 1, createdAt: 1, updatedAt: 1 } };
    });
    vi.spyOn(axios, 'request').mockImplementation(async request => {
        const path = new URL(request.url!).pathname;
        expect(request.method).toBe('GET');
        return { status: 200, data: path.endsWith('/domains/domain')
            ? { ok: true, environmentId: environment.environment.id, revision: environment.environment.revision, domain }
            : path.endsWith('/domains')
            ? { ok: true, environmentId: environment.environment.id, revision: environment.environment.revision, domains: [domain], nextCursor: null }
            : { ok: true, environment: environment.environment, targetLinks } };
    });
    const credentials = { token: `h.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.s`, encryption: null };
    const deps = createDaemonDeploymentActionDeps({ serverId: 'home', serverHttpBaseUrl: 'https://home.test', machineId: 'a',
        credentials,
        runtime: { async acquire() { throw new Error('Preparing membership cannot acquire a native deployment'); } } });
    const input = { serverId: 'home', environmentId: environment.environment.id, targetLinkId: link.id,
        expectedRevision: environment.environment.revision, expectedTargetLinkRevision: link.revision, requestKey: 'membership',
        contentArtifactId: 'candidate', contentHeaderVersion: 1, contentBodyVersion: 1,
        ...(kind === 'rollback' ? { deploymentId: 'previous' } : {}),
        ...(kind === 'promote' ? { sourceEnvironmentId: 'source', sourceDeploymentId: 'source-deployment', artifact: 'image',
            destinationContent: { contentArtifactId: 'destination', contentHeaderVersion: 1, contentBodyVersion: 1 } } : {}),
        ...(kind === 'drain' || kind === 'full teardown' ? { reason: 'manual', volumes: [], machines: kind === 'drain' ? ['b'] : ['a', 'b'] } : {}) };
    const plan = await deps.prepareHostReviewedChildren!({ actionId: kind === 'join' || kind === 'successor join' ? 'deployments.deploy'
        : kind === 'rollback' ? 'deployments.rollback' : kind === 'promote' ? 'deployments.promote'
            : kind === 'template upgrade' ? 'deployments.templates.instantiate' : 'deployments.teardown',
        input: kind === 'template upgrade' ? DeploymentTemplateInstantiateInputV1Schema.parse({ mode: 'apply', serverId: 'home', machineId: 'a',
            projectSourceId: environment.environment.projectSourceId,
            templateRef: { sourceId: 'apps', itemId: 'app', version: '1', ref: { kind: 'version', version: '1' } },
            environment: { kind: 'existing', environmentId: environment.environment.id, expectedRevision: environment.environment.revision },
            target: { kind: 'existing', targetLinkId: link.id, expectedRevision: link.revision, installationId: 'installed-a' },
            destination: { kind: 'stored' }, bindings: [], deploy: { requestKey: 'membership' } }) : input, context: {} });
    const role = kind === 'full teardown' ? 'disable' : 'configure';
    expect(plan).toMatchObject({ children: [{ action: { pluginId: 'happier.deploy.cloudflare', localId: `cloudflare-named/${role}` },
        role, scopeInput: { credentialRef, accountId: 'vendor-account', zoneId: 'vendor-zone',
            ...(role === 'disable' ? { tunnelId: 'tunnel' } : { tunnel: { kind: 'adopt', tunnelId: 'tunnel', name: 'environment' } }) } }] });
    if (kind === 'successor join') {
        const artifacts = createCredentialedAccountArtifactStore(credentials);
        const open = (id: string) => runWithServerHttpBaseUrl('https://home.test', () => artifacts.read(id, {
            prepareRecipients: false, includeSharedAudience: false }));
        const headers = async () => ({ Authorization: `Bearer ${credentials.token}` });
        const discoveries: Array<{ targetLinkId: string; domainId: string; membershipMachines?: unknown }> = [];
        const domains = createOwnServerDomainActions({ serverId: 'home', serverHttpBaseUrl: 'https://home.test', machineId: 'a', credentials,
            storage: deps.deploymentAction,
            open, headers,
            createContent: async () => { throw new Error('Retained Domains already have content'); },
            persistPreparedContent: createOwnServerDomainContentWriter({ serverId: 'home', serverHttpBaseUrl: 'https://home.test', artifacts, headers }),
            readInstallation: async () => 'installed-a',
            readEnvironment: async request => {
                const detail = await readDeploymentEnvironmentForHost(request, { open,
                    assertCurrent: async context => context.signal?.throwIfAborted(),
                    readMetadata: async ({ environmentId, context }) => {
                        const result = DeploymentEnvironmentGetResultV1Schema.parse(await deps.deploymentAction(
                            'deployments.environments.get', { serverId: 'home', environmentId }, context));
                        if (!result.ok) throw new Error(result.error);
                        return result;
                    } });
                return { ...detail, targetLinks: await Promise.all(detail.targetLinks.map(async targetLink => {
                    const opened = readDeploymentTargetLinkArtifactV1(targetLink, await open(targetLink.contentArtifactId));
                    if (!opened.ok) throw new Error(opened.error);
                    return { targetLink, content: opened.content };
                })) };
            },
            // Native discovery is a Machine transport boundary. Refusal proves this retained Domain reached the owner.
            dispatch: async job => {
                if (job.kind !== 'domainDiscover') throw new Error('Unreached native Domain effect');
                discoveries.push(job.input);
                return { ok: false, errorCode: 'native_route_unavailable', error: 'native_route_unavailable' };
            } });
        const envelope = { v: 1 as const, requestId: 'successor-membership', target: { kind: 'machine' as const, machineId: 'a' }, input };
        const externalActionExecutionAuthorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'fixture-admission', binding: {
            accountId: 'owner', custodianAccountId: 'owner', authentication: { kind: 'account', tokenEpoch: 1 }, accountEncryptionMode: 'plain',
            serverIdentityId: 'home', machineId: 'a', installationId: 'installed-a', admittedMachineRole: 'manage', target: envelope.target,
            actionId: 'deployments.deploy', requestId: envelope.requestId, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) } });
        vi.stubGlobal('fetch', async () => Response.json({ features: {}, capabilities: { serverIdentity: { serverIdentityId: 'home' } } }));
        vi.spyOn(axios, 'post').mockImplementation(async url => {
            expect(new URL(url).pathname).toBe(bindExternalActionExecutionAuthorizationVerifyHttpPathV1('deployments.deploy'));
            return { status: 200, data: { ok: true } };
        });
        const channel = await createRequesterCurrentnessSocketHarness();
        let requester: Awaited<ReturnType<typeof prepareRequesterAccountActionContext>> = null;
        try {
            requester = await prepareRequesterAccountActionContext({ authorization: externalActionExecutionAuthorization,
                purpose: { kind: 'external_action' }, machineId: 'a', installationId: 'installed-a',
                installationPrivateKey: tweetnacl.sign.keyPair().secretKey, serverId: 'home', serverIdentityId: 'home',
                serverHttpBaseUrl: 'https://home.test', ownCredentials: credentials, isCurrent: async () => true,
                createExecutor: () => createActionExecutor({ ...createUnavailableActionTransportDeps(), ...deps }) });
            if (!requester) throw new Error('Expected admitted successor requester');
            expect(await domains.reconcileMembership({ environmentId: input.environmentId, targetLinkId: link.id,
                deploymentId: 'accepted-successor', requestKey: input.requestKey }, { externalActionExecutionAuthorization: requester.authorization,
                originalActionEnvelope: envelope })).toMatchObject({ ok: false, errorCode: 'native_route_unavailable' });
            expect(discoveries).toMatchObject([{ domainId: domain.id, targetLinkId: link.id,
                membershipMachines: [{ machineId: 'a', installationId: 'installed-a' }, { machineId: 'b', installationId: 'installed-b' }] }]);
        } finally { await requester?.dispose(); await channel.close(); }
    }
});
