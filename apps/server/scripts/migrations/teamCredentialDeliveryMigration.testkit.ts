import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export type TeamCredentialMigrationProvider = 'postgres' | 'mysql' | 'sqlite';

export const teamCredentialDeliveryMigrationId = '20261028113000_normalize_team_credential_delivery';

/** Migration contracts execute only the canonical provider SQL. */
export async function readTeamCredentialDeliveryMigrationSql(provider: TeamCredentialMigrationProvider): Promise<string> {
    const root = join(import.meta.dirname, '../../prisma', ...(provider === 'postgres' ? [] : [provider]));
    return readFile(join(root, 'migrations', teamCredentialDeliveryMigrationId, 'migration.sql'), 'utf8');
}
