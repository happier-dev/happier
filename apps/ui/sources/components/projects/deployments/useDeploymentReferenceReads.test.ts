import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeploymentReadControllerV1, type DeploymentReadDemandV1 } from '@happier-dev/deployments';
import { createDeploymentEnvironmentDetailV1, createDeploymentEnvironmentHeaderV1,
    createDeploymentReceiptDetailV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { DeploymentOwnServerContentV1Schema } from '@happier-dev/deployment-protocol/v1';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { act, renderHook } from '@/dev/testkit/hooks/renderHook';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { createRenderCommitCounter, useRenderCommitCounter } from '@/dev/testkit/performance/counts';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { encodeBase64 } from '@/encryption/base64';
import { createAccountScopedCryptoMaterialSnapshotV1 } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { buildDeploymentAccountChangeV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
const { useDeploymentAccountController } = await import('./useDeploymentProject');
const { useDeploymentEnvironmentName, useEnvironmentBackupSummary, useDeploymentEnvironmentBackups } = await import('./useDeploymentReads');
const shown = { mounted: true, visible: true, focused: true };
const hidden = { mounted: true, visible: false, focused: false };

function retainedReceipt() {
    const base = createDeploymentReceiptDetailV1();
    return createDeploymentReceiptDetailV1({ content: DeploymentOwnServerContentV1Schema.parse({ ...base.content,
        ownServer: { approvedInputBasis: { v: 1, environmentId: base.deployment.environmentId, environmentRevision: 1,
            targetLinkId: base.deployment.targetLinkId, targetLinkRevision: 1, sourceIntent: base.content.sourceIntent,
            manifestFingerprint: 'manifest', configInputDigests: [], physicalProjectName: 'project', toolVersion: '2.40.1',
            services: ['app'], profiles: [], members: [{ machineId: 'machine-a', installationId: 'installation-a' }],
            bindings: [], images: [] },
        preMigrationBackup: { sourceFormat: 'postgresCustom', target: { service: 'app', adapter: 'postgres-v1', database: 'database' },
            repository: { repository: 's3:https://backup.test/bucket' },
            configuration: { configRevision: 1, destinationRef: { pluginId: 'happier.backup.destinations', localId: 'open' },
                occurrenceId: 'destination', config: {}, credentialBindings: [],
                sources: [{ kind: 'dump', sourceId: 'database', service: 'app', consistency: 'logical' }],
                ownership: { environmentId: base.deployment.environmentId, prefix: 'app' }, retention: { kind: 'keepEverything' } },
            source: { schemaVersion: 1, environmentId: base.deployment.environmentId, sourceId: 'database', kind: 'dump', configRevision: 1,
                repositoryId: 'a'.repeat(64), producerChecksumSha256: 'b'.repeat(64), totalBytesProcessed: 42, totalFilesProcessed: 1,
                snapshot: { snapshotId: 'c'.repeat(64), treeId: 'd'.repeat(64), hostname: 'runtime',
                    time: '2026-11-01T12:00:00Z', paths: ['dump'], tags: [] } } } },
    }) });
}

describe('deployment reference reads', () => {
    beforeEach(() => homes.reset());
    afterEach(() => standardCleanup());

    it('shares one exact read per opened id, ignores unrelated arrivals, and settles missing or failed reads', async () => {
        let environment = createDeploymentEnvironmentDetailV1();
        let receipt = retainedReceipt();
        let environmentReads = 0;
        let receiptReads = 0;
        let inventoryReads = 0;
        let healthSubscriptions = 0;
        const pending = createDeferred<void>();
        const controller = createDeploymentReadControllerV1({ scope: { serverId: 'home', accountId: 'account-owner' }, transport: {
            listEnvironments: async () => { inventoryReads++; return { ok: true, value: { items: [], nextCursor: null } }; },
            listHistory: async () => { inventoryReads++; return { ok: true, value: { ok: true, items: [], nextCursor: null } }; },
            readEnvironment: async (_scope, id) => { environmentReads++; expect(id).toBe(environment.environment.id);
                await pending.promise; return { ok: true, value: environment }; },
            readReceipt: async (_scope, environmentId, receiptId) => { receiptReads++;
                expect(environmentId).toBe(environment.environment.id); expect(receiptId).toBe(receipt.deployment.id);
                await pending.promise; return { ok: true, value: receipt }; },
            observeEnvironmentHealth: () => { healthSubscriptions++; return () => {}; },
        } });
        const counts = createRenderCommitCounter();
        const hook = await renderHook((demand: DeploymentReadDemandV1) => {
            useRenderCommitCounter(counts);
            return { name: useDeploymentEnvironmentName(controller, environment.environment.id, demand),
                backup: useEnvironmentBackupSummary(controller, environment.environment.id, receipt.deployment.id, demand),
                peer: useEnvironmentBackupSummary(controller, environment.environment.id, receipt.deployment.id, demand),
                mismatch: useEnvironmentBackupSummary(controller, environment.environment.id, receipt.deployment.id, demand, 'other-snapshot') };
        }, { initialProps: hidden });
        try {
            expect([environmentReads, receiptReads, inventoryReads, healthSubscriptions]).toEqual([0, 0, 0, 0]);
            await hook.rerender(shown);
            expect(hook.getCurrent().name.result.status).toBe('loading');
            expect(hook.getCurrent().backup.result.status).toBe('loading');
            await act(async () => pending.resolve());
            expect(hook.getCurrent().name.result).toEqual({ status: 'ready', value: 'Staging' });
            expect(hook.getCurrent().backup.result).toMatchObject({ status: 'ready', value: {
                deploymentId: receipt.deployment.id, backupId: 'c'.repeat(64), label: '2026-11-01T12:00:00Z',
                capture: { target: { service: 'app', database: 'database' } },
            } });
            expect(hook.getCurrent().mismatch.result).toMatchObject({ status: 'unavailable', reason: 'backup_required' });
            expect([environmentReads, receiptReads, inventoryReads, healthSubscriptions]).toEqual([1, 1, 0, 0]);
            counts.reset();
            await act(async () => { controller.invalidate(Array.from({ length: 100 }, (_, index) => ({
                environmentId: `unrelated-${index}`, deploymentId: `receipt-${index}` })));
                await flushHookEffects(); });
            expect([environmentReads, receiptReads, inventoryReads, healthSubscriptions]).toEqual([1, 1, 0, 0]);
            expect(counts.read()).toEqual({ renders: 0, commits: 0 });
            environment = { ...environment, content: { ...environment.content, name: 'Renamed Environment' } };
            await act(async () => { controller.invalidate({ environmentId: environment.environment.id }); await flushHookEffects(); });
            expect(hook.getCurrent().name.result).toEqual({ status: 'ready', value: 'Renamed Environment' });
            expect([environmentReads, receiptReads, inventoryReads, healthSubscriptions]).toEqual([2, 1, 0, 0]);
            receipt = createDeploymentReceiptDetailV1();
            await act(async () => { controller.invalidate({ environmentId: receipt.deployment.environmentId, deploymentId: receipt.deployment.id });
                await flushHookEffects(); });
            expect(hook.getCurrent().backup.result).toMatchObject({ status: 'unavailable', reason: 'backup_required' });
            expect(receiptReads).toBe(2);
            await act(async () => controller.retire());
            await hook.rerender(shown);
            expect(hook.getCurrent().name.result).toMatchObject({ status: 'unavailable', reason: 'authority_changed' });
        } finally { await hook.unmount(); controller.retire(); }
    });

    it.each(['plain', 'e2ee'] as const)('opens %s labels through the existing public receipt and Environment owners', async mode => {
        const token = `e30.${Buffer.from(JSON.stringify({ sub: 'account-owner' })).toString('base64url')}.signature`;
        const secret = new Uint8Array(32).fill(11);
        const serverId = await homes.addHome({ name: 'ReferenceNames', serverUrl: 'https://reference-names.test',
            accountId: 'account-owner', accountEncryptionMode: mode,
            ...(mode === 'e2ee' ? { credentials: { token, secret: encodeBase64(secret, 'base64url') } } : {}) });
        if (mode === 'e2ee') homes.answer(serverId, '/v1/account/encryption/currentness', { body: {
            mode: 'e2ee', version: 1, signingKeyFingerprint: 'signing-fingerprint',
            contentKeyFingerprint: convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(
                createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material: { type: 'legacy', secret } }).contentPublicKeyFingerprint),
            updatedAt: 1, recipientEnvelopeReadiness: { status: 'available' },
        } });
        const account = await captureLazyActionAccountContext(serverId);
        const environment = createDeploymentEnvironmentDetailV1({ environment: createDeploymentEnvironmentHeaderV1({ serverId }) });
        const receipt = retainedReceipt();
        const environmentPath = `/v1/deployments/environments/${environment.environment.id}`;
        const receiptPath = `/v1/deployments/receipts/${receipt.deployment.id}`;
        homes.answer(serverId, environmentPath, { body: { ok: true, environment: environment.environment, targetLinks: [] } });
        homes.answer(serverId, receiptPath, { body: { ok: true, deployment: receipt.deployment } });
        for (const [artifactId, kind, title, content] of [
            [environment.environment.contentArtifactId, 'deployment-environment.v1', 'Staging', environment.content],
            [receipt.deployment.contentArtifactId, 'deployment-receipt.v1', 'Release', receipt.content],
        ] as const) await account.createArtifactDocument({ artifactId, header: { kind, title }, body: JSON.stringify(content) });
        const hook = await renderHook(() => {
            const controller = useDeploymentAccountController(account.accountLifetime, true, shown);
            return { name: useDeploymentEnvironmentName(controller, environment.environment.id, shown),
                backup: useEnvironmentBackupSummary(controller, environment.environment.id, receipt.deployment.id, shown),
                tab: useDeploymentEnvironmentBackups(controller, environment.environment.id, shown, receipt.deployment.id) };
        });
        try {
            await vi.waitFor(() => expect(hook.getCurrent().backup.result).toMatchObject({ status: 'ready', value: { backupId: 'c'.repeat(64) } }));
            expect(hook.getCurrent().name.result).toEqual({ status: 'ready', value: 'Staging' });
            expect(hook.getCurrent().tab.statusRead).toMatchObject({ status: 'ready', value: { backupId: 'c'.repeat(64) } });
            const before = homes.requests.length;
            await act(async () => publishHomeAccountChange(serverId, Array.from({ length: 100 }, (_, index) =>
                buildDeploymentAccountChangeV1({ projectSourceId: environment.environment.projectSourceId,
                    environmentId: `peer-${index}`, deploymentId: `receipt-${index}`, revision: 2 }).entityId), { changeKinds: ['account'] }));
            expect(homes.requests).toHaveLength(before);
            expect(homes.requests.filter(request => request.path.split('?')[0] === '/v1/deployments/environments')).toHaveLength(0);
        } finally { await hook.unmount(); account.dispose(); }
    });
});
