import { expect } from 'vitest';

export const deploymentTargetLinkIdentityMigration = '20261027100000_widen_deployment_target_link_identity';
export const deploymentS0Migrations = ['20261024140000_add_deployment_model', '20261027072000_add_deployment_machine_references'] as const;
export type DeploymentMigrationProvider = 'sqlite' | 'postgres' | 'mysql';
export interface DeploymentMigrationDatabase {
    execute(sql: string): Promise<unknown>;
    query(sql: string): Promise<Record<string, unknown>[]>;
}
export const deploymentParentIdentitySql = (provider: DeploymentMigrationProvider) => {
    const quote = provider === 'mysql' ? '`' : '"';
    const type = provider === 'mysql' ? 'VARCHAR(191)' : 'TEXT';
    return ['Account', 'ProjectSource', 'Machine', 'Artifact'].map(table =>
        `CREATE TABLE ${quote}${table}${quote} (${quote}id${quote} ${type} PRIMARY KEY)${provider === 'mysql' ? ' DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci' : ''}`).join(';\n') + ';';
};

/** S0's real storage shape, including both selected-runtime and uniform-receipt FK cycles. */
export async function seedDeploymentS0Rows(provider: DeploymentMigrationProvider, db: DeploymentMigrationDatabase) {
    const q = (name: string) => provider === 'mysql' ? `\`${name}\`` : `"${name}"`;
    const execute = (sql: string) => db.execute(sql.replace(/"([^"\n]+)"/g, (_match, name: string) => q(name)));
    for (const sql of [
        `INSERT INTO "Account" VALUES ('owner')`, `INSERT INTO "ProjectSource" VALUES ('source')`,
        `INSERT INTO "Machine" VALUES ('runtime-a'),('runtime-b'),('builder'),('edge')`,
        `INSERT INTO "Artifact" VALUES ('private-environment'),('private-link'),('private-receipt')`,
        `INSERT INTO "DeploymentEnvironment" ("id","projectSourceId","createdByAccountId","protection","purpose","deployerMode","controllerMachineId","buildMachineId","edgeMachineId","contentArtifactId","contentHeaderVersion","contentBodyVersion","updatedAt")
            VALUES ('environment','source','owner','production','standard','managers','runtime-a','builder','edge','private-environment',1,1,CURRENT_TIMESTAMP)`,
        `INSERT INTO "DeploymentTargetLink" ("id","environmentId","role","sourceKind","hostTargetId","targetKind","state","contentArtifactId","contentHeaderVersion","contentBodyVersion","createdByAccountId","updatedAt")
            VALUES ('runtime','environment','runtime','host','own-server','ownServer','deployed','private-link',1,1,'owner',CURRENT_TIMESTAMP)`,
        // S0 SQL permits an empty host id. Preserve it without claiming that the
        // public identifier schema admits it as a newly configured target.
        `INSERT INTO "DeploymentTargetLink" ("id","environmentId","role","sourceKind","hostTargetId","targetKind","state","contentArtifactId","contentHeaderVersion","contentBodyVersion","createdByAccountId","updatedAt")
            VALUES ('empty-host','environment','runtime','host','','ownServer','configured','private-link',1,1,'owner',CURRENT_TIMESTAMP)`,
        `INSERT INTO "DeploymentTargetLinkMachine" ("targetLinkId","machineId","position","installationId","state")
            VALUES ('runtime','runtime-b',0,'installation-b','joining'),('runtime','runtime-a',1,'installation-a','active')`,
        `UPDATE "DeploymentEnvironment" SET "runtimeTargetLinkId"='runtime' WHERE "id"='environment'`,
        `INSERT INTO "Deployment" ("id","environmentId","targetLinkId","operation","state","requestKey","requestedByAccountId","actionOperationId","contentArtifactId","contentHeaderVersion","contentBodyVersion")
            VALUES ('receipt','environment','runtime','deploy','succeeded','request','owner','operation','private-receipt',1,1)`,
        `UPDATE "DeploymentTargetLink" SET "activeDeploymentId"='receipt',"detachedAt"=CURRENT_TIMESTAMP WHERE "id"='runtime'`,
    ]) await execute(sql);
}

/** Only stable structural facts cross this boundary; no protected target body or comparison tuple. */
export async function readDeploymentS0Custody(provider: DeploymentMigrationProvider, db: DeploymentMigrationDatabase) {
    const q = (name: string) => provider === 'mysql' ? `\`${name}\`` : `"${name}"`;
    return {
        links: await db.query(`SELECT ${['id', 'environmentId', 'revision', 'role', 'sourceKind', 'hostTargetId', 'targetKind', 'state',
            'activeDeploymentId', 'detachedAt', 'contentArtifactId', 'contentHeaderVersion', 'contentBodyVersion', 'createdByAccountId',
            'createdAt', 'updatedAt', 'deletedAt'].map(q)} FROM ${q('DeploymentTargetLink')} WHERE ${q('id')} IN ('empty-host','runtime') ORDER BY ${q('id')}`),
        members: await db.query(`SELECT * FROM ${q('DeploymentTargetLinkMachine')} ORDER BY ${q('position')}`),
        // Explicit incumbent columns avoid cached SELECT * result metadata when
        // the same Prisma connection observes a later additive migration.
        environments: await db.query(`SELECT ${['id', 'projectSourceId', 'createdByAccountId', 'revision', 'protection', 'purpose',
            'deployerMode', 'controllerMachineId', 'buildMachineId', 'edgeMachineId', 'runtimeTargetLinkId', 'contentArtifactId',
            'contentHeaderVersion', 'contentBodyVersion', 'createdAt', 'updatedAt', 'deletedAt'].map(q)} FROM ${q('DeploymentEnvironment')}`),
        receipts: await db.query(`SELECT ${['id', 'environmentId', 'targetLinkId', 'revision', 'operation', 'state', 'requestKey',
            'requestedByAccountId', 'actionOperationId', 'predecessorDeploymentId', 'rollbackOfDeploymentId', 'approvalId',
            'cancelRequestedAt', 'contentArtifactId', 'contentHeaderVersion', 'contentBodyVersion', 'requestedAt', 'startedAt', 'settledAt'].map(q)}
            FROM ${q('Deployment')}`),
    };
}

export async function assertDeploymentTargetIdentityArms(provider: DeploymentMigrationProvider, db: DeploymentMigrationDatabase) {
    const q = (name: string) => provider === 'mysql' ? `\`${name}\`` : `"${name}"`;
    const quote = (value: string | null) => value === null ? 'NULL' : `'${value.replaceAll("'", "''")}'`;
    const link = (id: string, role: string, sourceKind: string, targetKind: string, hostTargetId: string | null,
        pluginId: string | null, contributionLocalId: string | null) => db.execute(`INSERT INTO ${q('DeploymentTargetLink')}
            (${['id', 'environmentId', 'role', 'sourceKind', 'targetKind', 'hostTargetId', 'pluginId', 'contributionLocalId', 'state',
                'contentArtifactId', 'contentHeaderVersion', 'contentBodyVersion', 'createdByAccountId', 'updatedAt'].map(q)})
            VALUES (${quote(id)},'environment',${[role, sourceKind, targetKind, hostTargetId, pluginId, contributionLocalId].map(quote)},
                'configured','private-link',1,1,'owner',CURRENT_TIMESTAMP)`);
    // targetKind remains the descriptor's generic nonempty identifier, not a new provider enum.
    await link('plugin-runtime', 'runtime', 'plugin', 'contributor-runtime', null, 'example.deploy', 'runtime');
    await link('plugin-data', 'data', 'plugin', 'contributor-data', null, 'example.deploy', 'data');
    expect(await db.query(`SELECT ${['id', 'role', 'hostTargetId', 'pluginId', 'contributionLocalId'].map(q)}
        FROM ${q('DeploymentTargetLink')} WHERE ${q('sourceKind')}='plugin' ORDER BY ${q('id')}`)).toEqual([
        { id: 'plugin-data', role: 'data', hostTargetId: null, pluginId: 'example.deploy', contributionLocalId: 'data' },
        { id: 'plugin-runtime', role: 'runtime', hostTargetId: null, pluginId: 'example.deploy', contributionLocalId: 'runtime' },
    ]);
    for (const input of [
        ['mixed-host', 'runtime', 'host', 'ownServer', 'own-server', 'example.deploy', 'runtime'],
        ['mixed-plugin', 'runtime', 'plugin', 'contributor-runtime', 'fake-host', 'example.deploy', 'runtime'],
        ['missing-host', 'runtime', 'host', 'ownServer', null, null, null],
        ['missing-plugin', 'runtime', 'plugin', 'contributor-runtime', null, null, 'runtime'],
        ['missing-contribution', 'data', 'plugin', 'contributor-data', null, 'example.deploy', null],
        ['blank-plugin', 'data', 'plugin', 'contributor-data', null, '   ', 'data'],
        ['blank-kind', 'data', 'plugin', '   ', null, 'example.deploy', 'data'],
        ['host-data', 'data', 'host', 'ownServer', 'own-server', null, null],
        ['unknown-role', 'other', 'plugin', 'contributor-data', null, 'example.deploy', 'data'],
    ] satisfies [string, string, string, string, string | null, string | null, string | null][]) {
        await expect(link(...input)).rejects.toThrow();
    }
    await expect(db.execute(`UPDATE ${q('DeploymentTargetLink')} SET ${q('revision')}=0 WHERE ${q('id')}='runtime'`)).rejects.toThrow();
    await expect(db.execute(`UPDATE ${q('DeploymentTargetLink')} SET ${q('state')}='unknown' WHERE ${q('id')}='runtime'`)).rejects.toThrow();
    await expect(db.execute(`UPDATE ${q('DeploymentTargetLink')} SET ${q('contentBodyVersion')}=0 WHERE ${q('id')}='runtime'`)).rejects.toThrow();
    for (const column of ['environmentId', 'activeDeploymentId', 'contentArtifactId', 'createdByAccountId', 'machineId']) {
        await expect(db.execute(`UPDATE ${q('DeploymentTargetLink')} SET ${q(column)}='missing' WHERE ${q('id')}='plugin-data'`)).rejects.toThrow();
    }
    await expect(db.execute(`INSERT INTO ${q('DeploymentTargetLinkMachine')} VALUES ('runtime','builder',0,'other','joining')`)).rejects.toThrow();
    await expect(db.execute(`DELETE FROM ${q('DeploymentTargetLink')} WHERE ${q('id')}='runtime'`)).rejects.toThrow();
    await expect(db.execute(`DELETE FROM ${q('Deployment')} WHERE ${q('id')}='receipt'`)).rejects.toThrow();
    const linkColumns = provider === 'sqlite'
        ? (await db.query(`PRAGMA table_info('DeploymentTargetLink')`)).map(row => row.name)
        : (await db.query(`SELECT ${provider === 'mysql' ? 'COLUMN_NAME AS column_name' : 'column_name'} FROM information_schema.columns
            WHERE ${provider === 'mysql' ? "TABLE_SCHEMA=DATABASE() AND TABLE_NAME='DeploymentTargetLink'" : "table_schema=current_schema() AND table_name='DeploymentTargetLink'"}`)).map(row => row.column_name);
    for (const name of ['providerAccountId', 'providerResourceId', 'providerEnvironment', 'providerComparisonKey', 'machines']) expect(linkColumns).not.toContain(name);
}
