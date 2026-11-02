import { DeploymentPendingDeployV1Schema } from '@happier-dev/protocol';
import { expect } from 'vitest';
import type { DeploymentMigrationDatabase, DeploymentMigrationProvider } from './deploymentTargetLinkMigration.testkit';

export const deploymentPendingContentMigration = '20261027121500_add_deployment_pending_content';

/** Storage carries the Protocol envelope without interpreting private source or trigger intent. */
export async function assertDeploymentPendingContent(provider: DeploymentMigrationProvider, db: DeploymentMigrationDatabase) {
    const q = (name: string) => provider === 'mysql' ? `\`${name}\`` : `"${name}"`;
    const read = async () => {
        const rows = await db.query(`SELECT ${q('pendingDeployContent')} FROM ${q('DeploymentEnvironment')} WHERE ${q('id')}='environment'`);
        const value = rows[0]?.pendingDeployContent;
        return typeof value === 'string' ? JSON.parse(value) as unknown : value;
    };
    expect(await read()).toBeNull();
    for (const input of [
        { t: 'plain', v: { sourceIntent: { kind: 'stored', contentRevision: 7, composeDigest: `sha256:${'a'.repeat(64)}`,
            document: "services:\n  app:\n    image: example/app:stable\n    environment:\n      LABEL: \"person's café 🚀\"\n", profiles: [], services: ['app'] },
        requestKey: 'pending-request', targetLinkId: 'runtime', actionOperationId: 'pending-operation' } },
        { t: 'encrypted', c: 'opaque-ciphertext+/=' },
    ]) {
        const envelope = DeploymentPendingDeployV1Schema.parse(input);
        const serialized = JSON.stringify(envelope);
        const json = (provider === 'mysql' ? serialized.replaceAll('\\', '\\\\') : serialized).replaceAll("'", "''");
        await db.execute(`UPDATE ${q('DeploymentEnvironment')} SET ${q('pendingDeployContent')}='${json}' WHERE ${q('id')}='environment'`);
        expect(await read()).toEqual(envelope);
    }
    await db.execute(`UPDATE ${q('DeploymentEnvironment')} SET ${q('pendingDeployContent')}=NULL WHERE ${q('id')}='environment'`);
    expect(await read()).toBeNull();
    if (provider === 'sqlite') {
        const columns = await db.query('PRAGMA table_info("DeploymentEnvironment")');
        expect(columns.find(column => column.name === 'pendingDeployContent')).toMatchObject({ type: 'JSONB', notnull: 0, dflt_value: null });
    } else {
        const columns = await db.query(provider === 'postgres'
            ? `SELECT data_type,is_nullable,column_default FROM information_schema.columns WHERE table_schema=current_schema()
                AND table_name='DeploymentEnvironment' AND column_name='pendingDeployContent'`
            : `SELECT DATA_TYPE AS data_type,IS_NULLABLE AS is_nullable,COLUMN_DEFAULT AS column_default FROM information_schema.columns
                WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='DeploymentEnvironment' AND COLUMN_NAME='pendingDeployContent'`);
        expect(columns).toEqual([{ data_type: provider === 'postgres' ? 'jsonb' : 'json', is_nullable: 'YES', column_default: null }]);
    }
}
