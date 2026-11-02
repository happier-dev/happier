import { expect } from 'vitest';
import type { DeploymentMigrationDatabase, DeploymentMigrationProvider } from './deploymentTargetLinkMigration.testkit';

export const deploymentDomainMigration = '20261028210000_add_deployment_domain';

/** The same relational contract is exercised by embedded and native providers. */
export async function assertDeploymentDomainStorage(provider: DeploymentMigrationProvider, db: DeploymentMigrationDatabase) {
    const q = (name: string) => provider === 'mysql' ? `\`${name}\`` : `"${name}"`;
    const insert = (id: string, state: string, revision = 1) => db.execute(
        `INSERT INTO ${q('DeploymentDomain')} (${['id', 'environmentId', 'targetLinkId', 'revision', 'state', 'contentArtifactId',
            'contentHeaderVersion', 'contentBodyVersion', 'createdByAccountId', 'updatedAt'].map(q)})
            VALUES ('${id}','environment','runtime',${revision},'${state}','private-link',1,1,'owner',CURRENT_TIMESTAMP)`);
    // Missing storage fails on an admitted retained removal, not a filename.
    await insert('domain-removing', 'removing');
    for (const state of ['pending', 'applying', 'active', 'warning', 'failed']) await insert(`domain-${state}`, state);
    expect(await db.query(`SELECT ${['id', 'state', 'revision', 'environmentId', 'targetLinkId'].map(q)}
        FROM ${q('DeploymentDomain')} WHERE ${q('state')}='removing'`))
        .toEqual([{ id: 'domain-removing', state: 'removing', revision: 1, environmentId: 'environment', targetLinkId: 'runtime' }]);
    await expect(insert('invalid-state', 'invented')).rejects.toThrow();
    await expect(insert('invalid-revision', 'pending', 0)).rejects.toThrow();
    for (const column of ['environmentId', 'targetLinkId', 'contentArtifactId', 'createdByAccountId']) {
        await expect(db.execute(`UPDATE ${q('DeploymentDomain')} SET ${q(column)}='missing' WHERE ${q('id')}='domain-removing'`)).rejects.toThrow();
    }
    for (const column of ['contentHeaderVersion', 'contentBodyVersion']) {
        await expect(db.execute(`UPDATE ${q('DeploymentDomain')} SET ${q(column)}=0 WHERE ${q('id')}='domain-removing'`)).rejects.toThrow();
    }
    const columns = provider === 'sqlite'
        ? (await db.query('PRAGMA table_info("DeploymentDomain")')).map(row => row.name)
        : (await db.query(`SELECT ${provider === 'mysql' ? 'COLUMN_NAME AS column_name' : 'column_name'} FROM information_schema.columns
            WHERE ${provider === 'mysql' ? "TABLE_SCHEMA=DATABASE() AND TABLE_NAME='DeploymentDomain'" : "table_schema=current_schema() AND table_name='DeploymentDomain'"}`)).map(row => row.column_name);
    expect(columns.sort()).toEqual(['id', 'environmentId', 'targetLinkId', 'revision', 'state', 'contentArtifactId',
        'contentHeaderVersion', 'contentBodyVersion', 'createdByAccountId', 'capturedPlacements', 'observedAt', 'createdAt', 'updatedAt', 'deletedAt'].sort());
    return db.query(`SELECT * FROM ${q('DeploymentDomain')} ORDER BY ${q('id')}`);
}
