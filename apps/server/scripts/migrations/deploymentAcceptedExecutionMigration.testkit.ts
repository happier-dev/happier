import { expect } from 'vitest';
import type { DeploymentMigrationDatabase, DeploymentMigrationProvider } from './deploymentTargetLinkMigration.testkit';

export const deploymentAcceptedExecutionMigration = '20261028184000_capture_deployment_accepted_host';
const columns = ['acceptedControllerMachineId', 'acceptedControllerInstallationId', 'acceptedBuildMachineId',
    'acceptedBuildInstallationId'] as const;

/** Identity expansion preserves history without inventing capture or retaining settled Machines by FK. */
export async function assertDeploymentAcceptedExecutionUpgrade(provider: DeploymentMigrationProvider, db: DeploymentMigrationDatabase) {
    const q = (name: string) => provider === 'mysql' ? `\`${name}\`` : `"${name}"`;
    const read = () => db.query(`SELECT ${columns.map(q)} FROM ${q('Deployment')} WHERE ${q('id')}='receipt'`);
    expect(await read()).toEqual([Object.fromEntries(columns.map(name => [name, null]))]);
    for (const column of columns) {
        if (provider === 'sqlite') {
            expect((await db.query('PRAGMA table_info("Deployment")')).find(row => row.name === column))
                .toMatchObject({ type: 'TEXT', notnull: 0, dflt_value: null });
        } else {
            expect(await db.query(provider === 'postgres'
                ? `SELECT is_nullable,column_default FROM information_schema.columns WHERE table_schema=current_schema()
                    AND table_name='Deployment' AND column_name='${column}'`
                : `SELECT IS_NULLABLE AS is_nullable,COLUMN_DEFAULT AS column_default FROM information_schema.columns
                    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='Deployment' AND COLUMN_NAME='${column}'`))
                .toEqual([{ is_nullable: 'YES', column_default: null }]);
        }
    }
    for (const machineColumn of ['acceptedControllerMachineId', 'acceptedBuildMachineId']) {
        const index = `Deployment_${machineColumn}_state_id_idx`;
        if (provider === 'sqlite') {
            expect((await db.query(`PRAGMA index_info('${index}')`)).map(row => row.name)).toEqual([machineColumn, 'state', 'id']);
        } else if (provider === 'mysql') {
            expect((await db.query(`SELECT COLUMN_NAME AS name FROM information_schema.statistics
                WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='Deployment' AND INDEX_NAME='${index}' ORDER BY SEQ_IN_INDEX`))
                .map(row => row.name)).toEqual([machineColumn, 'state', 'id']);
        } else {
            expect(await db.query(`SELECT indexname FROM pg_indexes WHERE schemaname=current_schema()
                AND tablename='Deployment' AND indexname='${index}'`)).toEqual([{ indexname: index }]);
        }
    }
    await db.execute(`INSERT INTO ${q('Machine')} (${q('id')}) VALUES ('historical-controller')`);
    await db.execute(`UPDATE ${q('Deployment')} SET ${q('acceptedControllerMachineId')}='historical-controller',
        ${q('acceptedControllerInstallationId')}='historical-installation', ${q('acceptedBuildMachineId')}='historical-builder',
        ${q('acceptedBuildInstallationId')}='historical-build-installation' WHERE ${q('id')}='receipt'`);
    await db.execute(`DELETE FROM ${q('Machine')} WHERE ${q('id')}='historical-controller'`);
    expect(await read()).toEqual([{ acceptedControllerMachineId: 'historical-controller',
        acceptedControllerInstallationId: 'historical-installation', acceptedBuildMachineId: 'historical-builder',
        acceptedBuildInstallationId: 'historical-build-installation' }]);
    await db.execute(`UPDATE ${q('Deployment')} SET ${columns.map(name => `${q(name)}=NULL`)} WHERE ${q('id')}='receipt'`);
}
