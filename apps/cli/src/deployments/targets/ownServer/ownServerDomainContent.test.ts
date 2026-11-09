import axios from 'axios';
import { createCanonicalJsonSigningInput } from '@happier-dev/protocol/crypto/canonicalJson';
import { afterEach, expect, it, vi } from 'vitest';
import { DeploymentDomainHeaderV1Schema, DeploymentDomainPreparedContentInputV1Schema, type ActionExecutorContext } from '@happier-dev/protocol';
import { encodePlainArtifactStoredContent, decodePlainArtifactStoredContent, ARTIFACT_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/storage/artifactStoredContent';
import type { DeploymentDomainContentV1 } from '@happier-dev/deployment-protocol';
import { createAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { requesterAccountEncryptionMode } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import * as domainActions from './ownServerDomainActions';

afterEach(() => vi.restoreAllMocks());

it.each([false, true])('prepares private Domain bytes through the atomic owner, stale CAS=%s', async conflict => {
    const content: DeploymentDomainContentV1 = { hostname: 'app.example.test', target: { service: 'api', containerPort: 8080 },
        healthCheck: { path: '/health', expectStatus: 200 },
        cloudflarePreparation: { tunnelId: 'shared-tunnel', owned: [], dnsOwnership: [],
            connectors: ['target-a', 'target-b'].map(machineId => ({ machineId, installationId: `${machineId}-installation`,
                imageRef: 'cloudflare/cloudflared:2026.10.0', version: '2026.10.0', networkName: 'environment_default',
                grantRef: `${machineId}-bound-grant` })) } };
    const artifactId = '238a6c63-d34f-87f9-bb73-84d87f17edbd';
    const capture = { placement: { serverId: 'home', accountId: 'owner', environmentId: 'environment', targetLinkId: 'target',
        domainId: 'domain', machineId: 'target-machine', installationId: 'target-installation', nativeServer: 'private',
        actionOperationId: 'operation', requestId: 'request' }, content: { contentArtifactId: artifactId,
        contentHeaderVersion: 4, contentBodyVersion: 7 }, desired: true, listener: 'privateOrigin' as const, dockerEngineId: 'observed-engine' };
    const domain = DeploymentDomainHeaderV1Schema.parse({ v: 1, id: 'domain', environmentId: 'environment', targetLinkId: 'target',
        revision: 2, state: 'pending', ...capture.content, createdByAccountId: 'owner', placements: [capture], createdAtMs: 1, updatedAtMs: 1 });
    const committed = { ...domain, contentBodyVersion: 8,
        placements: [{ ...capture, content: { ...capture.content, contentBodyVersion: 8 } }] };
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
    const artifacts = createAccountArtifactStore({ credentials: { token, encryption: null }, getAccountEncryptionMode: async () => 'plain' });
    const header = { kind: 'deployment-domain.v1', title: content.hostname };
    // HTTP is the system boundary. The real Artifact codec/preparation must not
    // issue an independent write before the Domain transaction's CAS.
    const reads = vi.spyOn(axios, 'get').mockImplementation(async url => String(url).endsWith('/v1/account/encryption/currentness')
        ? { status: 200, data: createAccountEncryptionCurrentnessFixture({ mode: 'plain' }) }
        : { status: 200, data: { id: artifactId, ownerAccountId: 'owner', access: 'owner',
        publicAudience: 'none', encryptionMode: 'plain', header: encodePlainArtifactStoredContent(header),
        body: encodePlainArtifactStoredContent({ body: JSON.stringify(content) }), headerVersion: 4, bodyVersion: 7,
        seq: 1, createdAt: 1, updatedAt: 1, dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER } });
    const independentWrite = vi.spyOn(axios, 'post').mockRejectedValue(new Error('independent Artifact mutation'));
    const requests: string[] = [];
    vi.spyOn(axios, 'request').mockImplementation(async config => {
        requests.push(String(config.url));
        expect(config.data).toMatchObject({ serverId: 'home', environmentId: 'environment', domainId: 'domain',
            expectedDomainRevision: 2, actionOperationId: 'operation', capture,
            contentUpdate: { expectedHeaderVersion: 4, expectedBodyVersion: 7, body: expect.any(String) } });
        const request = DeploymentDomainPreparedContentInputV1Schema.parse(config.data);
        expect(request.contentUpdate).not.toHaveProperty('header');
        expect(decodePlainArtifactStoredContent(request.contentUpdate.body))
            .toEqual({ body: JSON.stringify(content) });
        expect(config.headers).toMatchObject({ 'x-admitted-controller': 'controller' });
        return { status: conflict ? 409 : 200, data: conflict ? { ok: false, error: 'deployment_conflict' }
            : { ok: true, environmentId: 'environment', revision: 3, domain: committed } };
    });
    const writer = domainActions.createOwnServerDomainContentWriter({ serverId: 'home', serverHttpBaseUrl: 'https://home.test', artifacts,
        headers: async (_context, _actionId, request) => {
            if (request.body !== undefined) createCanonicalJsonSigningInput(request.body);
            return { 'x-admitted-controller': 'controller', [requesterAccountEncryptionMode]: 'plain' as const };
        } });
    const context: ActionExecutorContext = { operationAcceptance: { operationId: 'operation', accept() {} } };
    const result = runWithServerHttpBaseUrl('https://home.test', () => writer({ domain, capture, content, context }));
    if (conflict) await expect(result).rejects.toMatchObject({ code: 'deployment_conflict' });
    else expect(await result).toEqual(committed);
    expect(reads.mock.calls.filter(([url]) => String(url).endsWith(`/v1/artifacts/${artifactId}`)),
        'one Artifact load for the admitted Domain content mutation').toHaveLength(1);
    expect(independentWrite).not.toHaveBeenCalled();
    expect(requests).toEqual(['https://home.test/v1/deployments/environments/environment/domains/domain/prepared-content']);
});
