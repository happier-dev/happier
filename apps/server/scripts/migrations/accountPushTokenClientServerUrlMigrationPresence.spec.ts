import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function readText(filePath: string): string {
  return readFileSync(filePath, 'utf8');
}

describe('Prisma migrations (AccountPushToken.clientServerUrl)', () => {
  it('ships a Postgres migration adding AccountPushToken.clientServerUrl', () => {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const serverRootDir = resolve(__dirname, '..', '..');

    const migrationDir = resolve(
      serverRootDir,
      'prisma',
      'migrations',
      '20260412172000_add_account_push_token_client_server_url',
    );
    const migrationSqlPath = resolve(migrationDir, 'migration.sql');

    expect(existsSync(migrationDir)).toBe(true);
    expect(existsSync(migrationSqlPath)).toBe(true);

    const sql = readText(migrationSqlPath);
    expect(sql).toContain('"AccountPushToken"');
    expect(sql).toContain('"clientServerUrl"');
  });
});
