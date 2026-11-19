import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
// The focused hook harness avoids mounting unrelated app-shell presentation owners.
import { act, renderHook } from '@/dev/testkit/hooks/renderHook';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployments/testing/v1';
import { createDeploymentEnvironmentHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { buildDeploymentAccountChangeV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { DeploymentDomainHeaderV1Schema } from '@happier-dev/protocol/deployments/deploymentDomainV1';
import { encodeBase64 } from '@/encryption/base64';
import { createAccountScopedCryptoMaterialSnapshotV1 } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';


const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
const { useDeploymentProject, useDeploymentEnvironmentPreviews } = await import('./useDeploymentProject');
const { useDeploymentEnvironmentDomains, useDeploymentEnvironmentBackups } = await import('./useDeploymentReads');
const shown = { mounted: true, visible: true, focused: true };
const hidden = { mounted: true, visible: false, focused: false };

async function addHome(mode: 'plain' | 'e2ee', name: string) {
    const token = `e30.${Buffer.from(JSON.stringify({ sub: 'alice' })).toString('base64url')}.signature`;
    const secret = new Uint8Array(32).fill(11);
    const serverId = await homes.addHome({ name, serverUrl: `https://tab-${name.toLowerCase()}.test`, accountId: 'alice',
        accountEncryptionMode: mode, ...(mode === 'e2ee' ? { credentials: { token, secret: encodeBase64(secret, 'base64url') } } : {}) });
    if (mode === 'e2ee') homes.answer(serverId, '/v1/account/encryption/currentness', { body: {
        mode: 'e2ee', version: 1, signingKeyFingerprint: 'signing-fingerprint',
        contentKeyFingerprint: convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(
            createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material: { type: 'legacy', secret } }).contentPublicKeyFingerprint),
        updatedAt: 1, recipientEnvelopeReadiness: { status: 'available' },
    } });
    return serverId;
}

describe('Environment tab data through Home transport', () => {
    beforeEach(() => homes.reset());
    afterEach(() => standardCleanup());

    it.each(['plain', 'e2ee'] as const)('opens %s Domain bodies only on demand, pages explicitly, ignores unrelated receipts and settles empty/refused/retry', async mode => {
        const serverId = await addHome(mode, 'Domains');
        const account = await captureLazyActionAccountContext(serverId);
        const environment = createDeploymentEnvironmentHeaderV1({ serverId });
        // The real Action front door resolves its existing Environment approval scope.
        homes.answer(serverId, `/v1/deployments/environments/${environment.id}`, {
            body: { ok: true, environment, targetLinks: [] },
        });
        const domain = DeploymentDomainHeaderV1Schema.parse({ v: 1, id: 'domain', environmentId: environment.id,
            targetLinkId: 'target', revision: 1, state: 'active', contentArtifactId: 'domain-content',
            contentHeaderVersion: 1, contentBodyVersion: 1, createdByAccountId: 'alice', createdAtMs: 1, updatedAtMs: 1 });
        await account.createArtifactDocument({ artifactId: domain.contentArtifactId, header: { kind: 'deployment-domain.v1', title: 'Web' },
            body: JSON.stringify({ hostname: 'web.example.test', target: { service: 'web', containerPort: 8080 },
                healthCheck: { path: '/', expectStatus: 200 } }) });
        let response: unknown = { ok: true, environmentId: environment.id, revision: 1, domains: [domain], nextCursor: 'page-two' };
        const pending = createDeferred<void>();
        const path = `/v1/deployments/environments/${environment.id}/domains`;
        homes.answer(serverId, path, { select: async () => { await pending.promise; return { body: response }; } });
        const hook = await renderHook(demand => {
            const { controller } = useDeploymentProject(account.accountLifetime, environment.projectSourceId, demand);
            return useDeploymentEnvironmentDomains(controller, environment.id, demand);
        }, { initialProps: hidden });
        const reads = () => homes.requests.filter(r => r.path.split('?')[0] === path);
        try {
            expect(reads()).toHaveLength(0);
            await hook.rerender(shown);
            expect(hook.getCurrent().result.status).toBe('loading');
            await act(async () => pending.resolve());
            await vi.waitFor(() => {
                const result = hook.getCurrent().result;
                expect(result.status, 'reason' in result ? result.reason : undefined).toBe('ready');
                expect(result.items[0]?.content.hostname).toBe('web.example.test');
            });
            expect(reads()).toHaveLength(1);
            await act(async () => publishHomeAccountChange(serverId, Array.from({ length: 100 }, (_, i) => buildDeploymentAccountChangeV1({
                projectSourceId: environment.projectSourceId, environmentId: `peer-${i}`, deploymentId: `receipt-${i}`, revision: 2 }).entityId), { changeKinds: ['account'] }));
            expect(reads()).toHaveLength(1);
            response = { ok: true, environmentId: environment.id, revision: 1,
                domains: [{ ...domain, revision: 2, state: 'warning' }], nextCursor: 'page-two' };
            await act(async () => publishHomeAccountChange(serverId, [buildDeploymentAccountChangeV1({
                projectSourceId: environment.projectSourceId, environmentId: environment.id, revision: 2 }).entityId], { changeKinds: ['account'] }));
            await vi.waitFor(() => expect(hook.getCurrent().result).toMatchObject({ status: 'ready', items: [{ domain: { revision: 2, state: 'warning' } }] }));
            expect(reads()).toHaveLength(2);
            response = { ok: true, environmentId: environment.id, revision: 2, domains: [], nextCursor: null };
            await act(async () => hook.getCurrent().nextPage());
            await vi.waitFor(() => expect(hook.getCurrent().result.status).toBe('empty'));
            expect(new URLSearchParams(reads()[2]!.path.split('?')[1]).get('cursor')).toBe('page-two');
            response = { ok: false, error: 'deployment_access_denied' };
            await act(async () => hook.getCurrent().retry());
            expect(hook.getCurrent().result.status).toBe('denied');
            response = { ok: false, error: 'deployment_unavailable' };
            await act(async () => hook.getCurrent().retry());
            expect(hook.getCurrent().result).toMatchObject({ status: 'unavailable', reason: 'deployment_unavailable' });
        } finally { await hook.unmount(); account.dispose(); }
    });

    it.each(['plain', 'e2ee'] as const)('reads %s backup intent from the selected Environment without receipt fan-out or invented status', async mode => {
        const serverId = await addHome(mode, 'Backups');
        const account = await captureLazyActionAccountContext(serverId);
        const detail = createDeploymentEnvironmentDetailV1({ environment: createDeploymentEnvironmentHeaderV1({ serverId }) });
        await account.createArtifactDocument({ artifactId: detail.environment.contentArtifactId,
            header: { kind: 'deployment-environment.v1', title: 'Application' }, body: JSON.stringify({ ...detail.content, backup: { notNeeded: true } }) });
        const path = `/v1/deployments/environments/${detail.environment.id}`;
        let response: unknown = { ok: true, environment: detail.environment, targetLinks: [] };
        homes.answer(serverId, path, { select: () => ({ body: response }) });
        const hook = await renderHook(() => {
            const { controller } = useDeploymentProject(account.accountLifetime, detail.environment.projectSourceId, shown);
            return useDeploymentEnvironmentBackups(controller, detail.environment.id, shown);
        });
        try {
            await vi.waitFor(() => expect(hook.getCurrent().result).toMatchObject({ status: 'ready', items: [{ notNeeded: true }] }));
            expect(hook.getCurrent().statusRead).toEqual({ status: 'unavailable', value: null, reason: 'backup_receipt_required', retryable: false });
            const reads = () => homes.requests.filter(r => r.path.split('?')[0] === path);
            const count = reads().length;
            // Count the containing Action's canonical scope reads as well as its data read.
            expect(count).toBeGreaterThan(0);
            await act(async () => publishHomeAccountChange(serverId, Array.from({ length: 100 }, (_, i) => buildDeploymentAccountChangeV1({
                projectSourceId: detail.environment.projectSourceId, environmentId: detail.environment.id, deploymentId: `receipt-${i}`, revision: 2 }).entityId), { changeKinds: ['account'] }));
            expect(reads()).toHaveLength(count);
            expect(homes.requests.filter(r => r.path.includes('/deployments?'))).toEqual([]);
            await account.createArtifactDocument({ artifactId: 'backup-removed-content',
                header: { kind: 'deployment-environment.v1', title: 'Application' }, body: JSON.stringify(detail.content) });
            response = { ok: true, environment: { ...detail.environment, contentArtifactId: 'backup-removed-content', revision: 2 }, targetLinks: [] };
            await act(async () => publishHomeAccountChange(serverId, [buildDeploymentAccountChangeV1({
                projectSourceId: detail.environment.projectSourceId, environmentId: detail.environment.id, revision: 2 }).entityId], { changeKinds: ['account'] }));
            await vi.waitFor(() => expect(hook.getCurrent().result.status).toBe('empty'));
            expect(reads()).toHaveLength(count * 2);
            response = { ok: false, error: 'deployment_access_denied' };
            await act(async () => hook.getCurrent().retry());
            expect(hook.getCurrent().result.status).toBe('denied');
            response = { ok: false, error: 'deployment_unavailable' };
            await act(async () => hook.getCurrent().retry());
            expect(hook.getCurrent().result).toMatchObject({ status: 'unavailable', reason: 'deployment_unavailable' });
        } finally { await hook.unmount(); account.dispose(); }
    });

    it.each([
        { response: { ok: true, items: [], nextCursor: null }, expected: { status: 'empty', items: [] } },
        { response: { ok: false, error: 'deployment_unavailable' }, expected: {
            status: 'unavailable', items: [], reason: 'deployment_unavailable', retryable: false,
        } },
    ])('distinguishes a cold empty template preview page from a refused read: $expected.status', async ({ response, expected }) => {
        const serverId = await addHome('plain', 'EmptyPreviews');
        const account = await captureLazyActionAccountContext(serverId);
        const path = '/v1/deployments/environments';
        homes.answer(serverId, path, { body: response });
        const hook = await renderHook(() => useDeploymentEnvironmentPreviews(account.accountLifetime, shown,
            { previewTemplateEnvironmentId: 'template' }));
        try {
            await vi.waitFor(() => expect(hook.getCurrent().result).toMatchObject(expected));
            const reads = homes.requests.filter(request => request.path.split('?')[0] === path);
            expect(reads).toHaveLength(1);
            expect(new URLSearchParams(reads[0]!.path.split('?')[1]).get('previewTemplateEnvironmentId')).toBe('template');
            expect(homes.requests.filter(request => request.path === '/v1/artifacts/read')).toEqual([]);
        } finally { await hook.unmount(); account.dispose(); }
    });

    it('selects one preview page by its template Environment without PR ids, with zero reads for unrelated receipts', async () => {
        const serverId = await homes.addHome({ name: 'Previews', serverUrl: 'https://tab-previews.test', accountId: 'alice' });
        const account = await captureLazyActionAccountContext(serverId);
        const environment = createDeploymentEnvironmentHeaderV1({ serverId, purpose: 'preview', previewRepositoryId: 'repository',
            previewTemplateEnvironmentId: 'template', previewPullRequestId: 'pr:17', previewTargetLinkId: 'target' });
        await account.createArtifactDocument({ artifactId: environment.contentArtifactId,
            header: { kind: 'deployment-environment.v1', title: 'Preview 17' }, body: '{}' });
        const path = '/v1/deployments/environments';
        let response: unknown = { ok: true, items: [environment], nextCursor: 'preview-next' };
        homes.answer(serverId, path, { select: () => ({ body: response }) });
        const hook = await renderHook(demand => useDeploymentEnvironmentPreviews(account.accountLifetime, demand,
            { previewTemplateEnvironmentId: 'template' }), { initialProps: hidden });
        const reads = () => homes.requests.filter(r => r.path.split('?')[0] === path);
        try {
            expect(reads()).toHaveLength(0);
            await hook.rerender(shown);
            await vi.waitFor(() => expect(hook.getCurrent().result).toMatchObject({ status: 'ready', items: [{ environment: { id: environment.id } }] }));
            expect(reads()).toHaveLength(1);
            const selection = new URLSearchParams(reads()[0]!.path.split('?')[1]);
            expect(selection.get('previewTemplateEnvironmentId')).toBe('template');
            expect(selection.has('previewPullRequestIds')).toBe(false);
            await act(async () => publishHomeAccountChange(serverId, Array.from({ length: 100 }, (_, i) => buildDeploymentAccountChangeV1({
                projectSourceId: 'repository', environmentId: `peer-${i}`, deploymentId: `receipt-${i}`, revision: 2 }).entityId), { changeKinds: ['account'] }));
            expect(reads()).toHaveLength(1);
            expect(hook.getCurrent().hasNextPage).toBe(true);
            response = { ok: true, items: [{ ...environment, revision: 2 }], nextCursor: 'preview-next' };
            await act(async () => publishHomeAccountChange(serverId, [buildDeploymentAccountChangeV1({
                projectSourceId: environment.projectSourceId, environmentId: environment.id, revision: 2 }).entityId], { changeKinds: ['account'] }));
            await vi.waitFor(() => expect(hook.getCurrent().result).toMatchObject({ status: 'ready', items: [{ environment: { revision: 2 } }] }));
            expect(reads()).toHaveLength(2);
            response = { ok: true, items: [], nextCursor: null };
            await act(async () => hook.getCurrent().nextPage());
            await vi.waitFor(() => expect(hook.getCurrent().result.status).toBe('empty'));
            expect(reads()).toHaveLength(3);
            response = { ok: false, error: 'deployment_access_denied' };
            await act(async () => hook.getCurrent().retry());
            expect(hook.getCurrent().result.status).toBe('denied');
            response = { ok: false, error: 'deployment_unavailable' };
            await act(async () => hook.getCurrent().retry());
            expect(hook.getCurrent().result).toMatchObject({ status: 'unavailable', reason: 'deployment_unavailable' });
        } finally { await hook.unmount(); account.dispose(); }
    });
});
