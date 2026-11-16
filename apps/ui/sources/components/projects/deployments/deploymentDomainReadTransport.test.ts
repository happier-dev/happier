import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createDeploymentEnvironmentDetailV1, createDeploymentEnvironmentHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { encodeBase64 } from '@/encryption/base64';
import { createAccountScopedCryptoMaterialSnapshotV1 } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { createDeploymentReadTransport } = await import('./deploymentReadTransport');

// These are Home HTTP and Account Artifact boundaries; the Action, mode-aware
// Artifact reader and Domain admission all run unchanged beneath the harness.
describe('deployment Domain read transport', () => {
    beforeEach(() => homes.reset());
    afterEach(() => standardCleanup());
    it.each(['plain', 'e2ee'] as const)('retains valid %s Domains with partial coverage and a typed Artifact outage', async mode => {
        const token = `e30.${Buffer.from(JSON.stringify({ sub: 'account-owner' })).toString('base64url')}.signature`;
        const secret = new Uint8Array(32).fill(11);
        const serverId = await homes.addHome({ name: 'Deployments', serverUrl: 'https://deployments-ui.test', accountId: 'account-owner',
            accountEncryptionMode: mode,
            ...(mode === 'e2ee' ? { credentials: { token, secret: encodeBase64(secret, 'base64url') } } : {}),
        });
        if (mode === 'e2ee') homes.answer(serverId, '/v1/account/encryption/currentness', { body: {
            mode: 'e2ee', version: 1, signingKeyFingerprint: 'signing-fingerprint',
            contentKeyFingerprint: convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(
                createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material: { type: 'legacy', secret } }).contentPublicKeyFingerprint),
            updatedAt: 1, recipientEnvelopeReadiness: { status: 'available' },
        } });
        const lifetime: ServerAccountScopeLifetime = { scope: { serverId, accountId: 'account-owner' }, isCurrent: () => true,
            onRetire: () => ({ dispose() {} }) };
        const detail = createDeploymentEnvironmentDetailV1({ environment: createDeploymentEnvironmentHeaderV1({ serverId }) });
        const environmentHeader = detail.environment;
        const targetHeader = detail.targetLinks[0]!.targetLink;
        const root = '/v1/deployments/environments';
        homes.answer(serverId, `${root}/${environmentHeader.id}`, { body: { ok: true, environment: environmentHeader, targetLinks: [targetHeader] } });
        const transport = createDeploymentReadTransport(lifetime);
        const scope = { ...lifetime.scope, projectSourceId: environmentHeader.projectSourceId };
        const options = { signal: new AbortController().signal };
        const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
        const domain = { v: 1, id: 'valid-domain', environmentId: environmentHeader.id, targetLinkId: targetHeader.id,
            revision: 1, state: 'active', contentArtifactId: 'domain-artifact', contentHeaderVersion: 1, contentBodyVersion: 1,
            createdByAccountId: 'account-owner', createdAtMs: 1000, updatedAtMs: 1000 };
        const domainWriter = await captureLazyActionAccountContext(serverId);
        try {
            await domainWriter.createArtifactDocument({ artifactId: domain.contentArtifactId,
                header: { kind: 'deployment-domain.v1', title: 'Application' }, body: JSON.stringify({ hostname: 'app.test',
                    target: { service: 'app', containerPort: 80 }, healthCheck: { path: '/', expectStatus: 200 } }) });
            await domainWriter.createArtifactDocument({ artifactId: environmentHeader.contentArtifactId,
                header: { kind: 'deployment-environment.v1', title: 'Production' }, body: JSON.stringify(detail.content) });
        } finally { domainWriter.dispose(); }
        const staleWriter = await captureLazyActionAccountContext(serverId);
        try {
            await staleWriter.createArtifactDocument({ artifactId: 'missing-stale-domain-artifact',
                header: { kind: 'deployment-domain.v1', title: 'Stale' }, body: JSON.stringify({ hostname: 'stale.test' }) });
        } finally { staleWriter.dispose(); }
        homes.answer(serverId, `${root}/${environmentHeader.id}/domains`, { body: { ok: true, environmentId: environmentHeader.id,
            revision: 1, domains: [{ ...domain, id: 'missing-domain', contentArtifactId: 'missing-domain-artifact' }, domain,
                { ...domain, id: 'stale-domain', contentArtifactId: 'missing-stale-domain-artifact' }], nextCursor: 'next-domain-page' } });
        const bundled = await homes.request('https://deployments-ui.test/v1/artifacts/read', {
            method: 'POST', headers: { Authorization: `Bearer ${domainWriter.credentials.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ artifactIds: [domain.contentArtifactId, environmentHeader.contentArtifactId] }) });
        const batch = await bundled.json();
        homes.answer(serverId, '/v1/deployments/domains', { body: { ok: true,
            items: [{ domain, environment: environmentHeader }], artifacts: batch.items
                .flatMap((item: { ok: boolean; artifact?: unknown }) => item.ok ? [item.artifact] : []), nextCursor: 'page-two' } });
        homes.answer(serverId, '/v1/deployments/data-services', { body: { ok: true,
            items: [{ environment: environmentHeader }],
            artifacts: batch.items.filter((item: { artifactId: string }) => item.artifactId === environmentHeader.contentArtifactId)
                .flatMap((item: { ok: boolean; artifact?: unknown }) => item.ok ? [item.artifact] : []), nextCursor: 'page-two' } });
        const readCount = () => homes.requests.filter(request => request.path === '/v1/artifacts/read').length;
        const before = readCount();
        expect(await transport.listDomainPage!(scope, {}, options)).toMatchObject({ ok: true,
            value: { items: [{ domain: { id: domain.id }, environment: { id: environmentHeader.id }, environmentTitle: 'Production' }], nextCursor: 'page-two' } });
        expect(await transport.listDataServicePage!(scope, {}, options)).toMatchObject({ ok: true,
            value: { items: [{ environment: { id: environmentHeader.id }, title: 'Production', content: detail.content }], nextCursor: 'page-two' } });
        expect(readCount()).toBe(before);
        homes.answer(serverId, '/v1/deployments/domains', { body: { ok: true,
            items: [{ domain, environment: environmentHeader }], artifacts: [], nextCursor: 'page-three' } });
        expect(await transport.listDomainPage!(scope, {}, options)).toMatchObject({ ok: true,
            value: { items: [], coverage: 'partial', nextCursor: 'page-three' } });
        expect(readCount()).toBe(before);
        const partialDomains = await transport.listDomains!(scope, environmentHeader.id, {}, options);
        expect(partialDomains.ok ? null : partialDomains.failure).toBeNull();
        expect(partialDomains).toMatchObject({ ok: true, value: { items: [{ domain: { id: domain.id } }], coverage: 'partial', nextCursor: 'next-domain-page' } });
        expect(partialDomains.ok && partialDomains.value.items).toHaveLength(1);
        homes.answer(serverId, '/v1/artifacts/read', { status: 503, body: { error: 'artifact_content_unavailable' } });
        expect(await transport.listDomains!(scope, environmentHeader.id, {}, options)).toMatchObject({ ok: false,
            failure: { code: 'artifact_content_unavailable' } });
    });
});
