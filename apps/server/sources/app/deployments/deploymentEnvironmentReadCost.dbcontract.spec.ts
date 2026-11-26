import { randomUUID } from 'node:crypto';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol';
import { decodeBase64 } from 'privacy-kit';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { createProjectSourceInTx } from '@/app/projects/sources/projectSourceService';
import { db, getDbProviderFromEnv } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createDbMaintenanceClient, onDbClientQuery } from '@/storage/prisma';
import { createDatabaseIntegrationHarness } from '@/testkit/databaseIntegrationHarness';
import { recordDriverStatements } from '@/testkit/driverStatements';

import { readDeploymentEnvironmentInTx } from './deploymentReadService';

const serverId = `srv_${'c'.repeat(32)}`;
let harness: Awaited<ReturnType<typeof createDatabaseIntegrationHarness>>;
beforeAll(async () => {
    harness = await createDatabaseIntegrationHarness({
        tempDirPrefix: 'deployment-environment-read-cost-', initEncrypt: true,
        env: { HAPPIER_SERVER_IDENTITY_ID: serverId },
    });
});
afterAll(async () => { await harness?.close(); });

it('reads target placement once after admitting the Environment and checks current Machine installations', async () => {
    const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
    const member = await db.account.create({ data: { encryptionMode: 'plain' } });
    const team = await db.team.create({ data: { name: 'Environment read cost' } });
    await db.teamMembership.createMany({ data: [
        { teamId: team.id, accountId: owner.id, role: 'owner' },
        { teamId: team.id, accountId: member.id, role: 'member' },
    ] });
    const source = await inTx(tx => createProjectSourceInTx(tx, owner.id,
        { serverId, requestKey: randomUUID(), name: 'Private Source', audience: [] }));
    if (!source.ok) throw new Error(source.error);

    const writeArtifact = (kind: 'deployment-environment.v1' | 'deployment-target-link.v1') =>
        db.artifact.create({ data: {
            id: randomUUID(), accountId: owner.id, kind: `v1:other:${kind}`, headerVersion: 1, bodyVersion: 1,
            header: decodeBase64(encodePlainArtifactStoredContent({ kind, title: 'Environment read cost' })),
            body: decodeBase64(encodePlainArtifactStoredContent({})),
            dataEncryptionKey: decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER),
        } });
    const [environmentArtifact, linkArtifact] = await Promise.all([
        writeArtifact('deployment-environment.v1'), writeArtifact('deployment-target-link.v1'),
    ]);
    const machine = await db.machine.create({ data: {
        id: randomUUID(), accountId: owner.id, metadata: '{}',
        installationId: randomUUID(), installationPublicKey: new Uint8Array(32),
    } });
    const environment = await db.deploymentEnvironment.create({ data: {
        projectSourceId: source.source.id, createdByAccountId: owner.id, controllerMachineId: machine.id,
        protection: 'nonProduction', purpose: 'standard', deployerMode: 'members',
        contentArtifactId: environmentArtifact.id, contentHeaderVersion: 1, contentBodyVersion: 1,
    } });
    const link = await db.deploymentTargetLink.create({ data: {
        environmentId: environment.id, createdByAccountId: owner.id, role: 'runtime', sourceKind: 'host',
        hostTargetId: 'own-server', targetKind: 'ownServer', state: 'configured',
        contentArtifactId: linkArtifact.id, contentHeaderVersion: 1, contentBodyVersion: 1,
        machines: { create: [{ machineId: machine.id, installationId: machine.installationId!, position: 0, state: 'active' }] },
    } });
    await db.deploymentEnvironment.update({ where: { id: environment.id }, data: {
        runtimeTargetLinkId: link.id,
        referencedSavedSecretRevisions: [{ resourceId: randomUUID(), revision: 1,
            requiredBindings: [{ purpose: 'registry', targetLinkId: link.id, access: 'pull' }] }],
    } });

    const provider = getDbProviderFromEnv(process.env, 'sqlite');
    const selects: string[] = [];
    const record = ({ query }: { query: string }) => {
        if (/^SELECT\b/i.test(query.trimStart())) selects.push(query);
    };
    const client = await createDbMaintenanceClient(provider, undefined, provider === 'postgres'
        ? { onDriverStatement: recordDriverStatements(record) }
        : { log: [{ emit: 'event', level: 'query' }] });
    if (provider !== 'postgres') onDbClientQuery(client, record);
    const read = (accountId: string) => client.$transaction(
        tx => readDeploymentEnvironmentInTx(tx, accountId, { serverId, environmentId: environment.id }),
        provider === 'postgres' ? { isolationLevel: 'RepeatableRead' } : undefined,
    );
    const targets = /\bFROM\s+(?:["\x60]\w+["\x60]\.)?["\x60]DeploymentTargetLink["\x60]/i;
    const members = /\bFROM\s+(?:["\x60]\w+["\x60]\.)?["\x60]DeploymentTargetLinkMachine["\x60]/i;
    const machines = /\bFROM\s+(?:["\x60]\w+["\x60]\.)?["\x60]Machine["\x60]/i;
    try {
        expect(await read(owner.id)).toMatchObject({
            ok: true, targetLinks: [{ id: link.id, machines: [machine.id] }],
            secretScope: { reason: 'secret_scope_resource_unavailable', requiredGrantCount: 1 },
        });
        const counts = {
            selects: selects.length,
            targetLinks: selects.filter(sql => targets.test(sql)).length,
            targetMembers: selects.filter(sql => members.test(sql)).length,
            currentMachines: selects.filter(sql => machines.test(sql) && sql.includes('replacedByMachineId')).length,
        };
        console.info('ENVIRONMENT_READ_SQL', provider, counts);

        selects.length = 0;
        const denied = await read(member.id);
        expect(denied).toMatchObject({ ok: false, error: 'deployment_unavailable' });
        expect(denied).not.toHaveProperty('targetLinks');
        expect(denied).not.toHaveProperty('secretScope');
        expect(selects.some(sql => targets.test(sql) || members.test(sql))).toBe(false);

        const newInstallationId = randomUUID();
        await db.machine.update({ where: { id: machine.id }, data: { installationId: newInstallationId } });
        expect(await read(owner.id)).toMatchObject({
            ok: true, secretScope: { reason: 'secret_scope_requirements_unavailable', requiredGrantCount: 0 },
            runtimeReinstall: { machines: [{
                machineId: machine.id, retiredInstallationId: machine.installationId, currentInstallationId: newInstallationId,
            }] },
        });

        await db.machine.update({ where: { id: machine.id }, data: { revokedAt: new Date() } });
        const revoked = await read(owner.id);
        expect(revoked).toMatchObject({
            ok: true, secretScope: { reason: 'secret_scope_requirements_unavailable', requiredGrantCount: 0 },
        });
        expect(revoked).not.toHaveProperty('runtimeReinstall');
        expect(counts).toMatchObject({ targetLinks: 1, targetMembers: 1, currentMachines: 1 });
    } finally {
        await client.$disconnect();
    }
});
