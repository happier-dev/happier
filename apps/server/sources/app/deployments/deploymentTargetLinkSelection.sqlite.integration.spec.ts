import { afterAll, beforeAll, expect, it } from 'vitest';
import * as privacyKit from 'privacy-kit';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createProjectSourceInTx } from '@/app/projects/sources/projectSourceService';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { observeSqliteRequests } from '@/testkit/observeSqliteRequests';
import { listDeploymentTargetLinksInTx } from './deploymentTargetLinkReadService';

const serverId = `srv_${'f'.repeat(32)}`;
let harness: LightSqliteHarness;
beforeAll(async () => {
    harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-link-selection-', initEncrypt: true,
        env: { HAPPIER_SERVER_IDENTITY_ID: serverId } });
}, 180_000);
afterAll(async () => { await harness?.close(); });

it('admits only matching public Link candidates before paging, leaving unrelated unreadable content outside coverage', async () => {
    const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
    const source = await inTx(tx => createProjectSourceInTx(tx, owner.id,
        { serverId, requestKey: crypto.randomUUID(), name: 'Selected Link' }));
    if (!source.ok) throw new Error(source.error);
    const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: owner.id,
        metadata: '{}', installationId: crypto.randomUUID() } });
    const content = async (kind: string) => {
        const artifact = await db.artifact.create({ data: { id: crypto.randomUUID(), accountId: owner.id,
            kind: `v1:other:${kind}`, headerVersion: 1, bodyVersion: 1,
            header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind, title: '' })),
            body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ body: '{}' })),
            dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) } });
        return { contentArtifactId: artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 };
    };
    const environment = await db.deploymentEnvironment.create({ data: { projectSourceId: source.source.id,
        createdByAccountId: owner.id, protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
        controllerMachineId: machine.id, ...await content('deployment-environment.v1') } });
    const selected = await content('deployment-target-link.v1');
    const unreadable = await content('deployment-target-link.v1');
    await db.artifact.update({ where: { id: unreadable.contentArtifactId }, data: { deletedAt: new Date() } });
    const base = { environmentId: environment.id, createdByAccountId: owner.id, role: 'data',
        sourceKind: 'plugin', pluginId: 'example.deploy', contributionLocalId: 'platform', targetKind: 'platform', state: 'configured' };
    await db.deploymentTargetLink.createMany({ data: [
        ...Array.from({ length: 120 }, (_, index) => ({ ...base, id: `a-unrelated-${index}`, ...unreadable,
            ...(index % 3 === 0 ? { pluginId: 'other.deploy' }
                : index % 3 === 1 ? { contributionLocalId: 'database' } : { targetKind: 'database' }) })),
        ...['b-match', 'c-match'].map(id => ({ ...base, id, ...selected })),
        { ...base, id: 'd-native', role: 'runtime', sourceKind: 'host', hostTargetId: 'own-server', pluginId: null,
            contributionLocalId: null, targetKind: 'ownServer', ...selected },
        { ...base, id: 'a-other-host', role: 'runtime', sourceKind: 'host', hostTargetId: 'other-host', pluginId: null,
            contributionLocalId: null, targetKind: 'ownServer', ...unreadable },
    ] });
    await db.deploymentTargetLinkMachine.createMany({ data: ['d-native', 'a-other-host'].map(targetLinkId => ({
        targetLinkId, machineId: machine.id, installationId: machine.installationId!, position: 0, state: 'active',
    })) });
    const selection = { source: { kind: 'plugin' as const, contribution: { pluginId: base.pluginId, localId: base.contributionLocalId } }, targetKind: base.targetKind };
    const input = { serverId, scope: { kind: 'account' as const, accountId: owner.id }, selection, limit: 1 };
    const requests: { model?: string; action: string; args: unknown }[] = [];
    const stop = observeSqliteRequests({ before: request => { requests.push(request); } });
    try {
        expect(await inTx(tx => listDeploymentTargetLinksInTx(tx, owner.id, input)))
            .toMatchObject({ ok: true, items: [{ targetLink: { id: 'b-match' } }], nextCursor: 'b-match', coverage: 'complete' });
        const artifactReads = requests.filter(request => request.model === 'Artifact' && request.action === 'findMany');
        expect(artifactReads).toHaveLength(1);
        expect(JSON.stringify(artifactReads[0]?.args)).not.toContain(unreadable.contentArtifactId);
        expect(await inTx(tx => listDeploymentTargetLinksInTx(tx, owner.id, { ...input, cursor: 'b-match' })))
            .toMatchObject({ items: [{ targetLink: { id: 'c-match' } }], nextCursor: null, coverage: 'complete' });
        expect(await inTx(tx => listDeploymentTargetLinksInTx(tx, owner.id, { ...input,
            selection: { source: { kind: 'host', id: 'own-server' }, targetKind: 'ownServer' } })))
            .toMatchObject({ items: [{ targetLink: { id: 'd-native' } }], nextCursor: null, coverage: 'complete' });
        await db.artifact.update({ where: { id: selected.contentArtifactId }, data: { deletedAt: new Date() } });
        expect(await inTx(tx => listDeploymentTargetLinksInTx(tx, owner.id, input)))
            .toMatchObject({ items: [], coverage: 'partial' });
    } finally { stop(); }
});
