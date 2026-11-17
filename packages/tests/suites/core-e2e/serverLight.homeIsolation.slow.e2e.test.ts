import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { startProjectDaemonFixture } from '../../src/testkit/daemon/projectDaemon';
import { readAccountIdFromToken } from '../../../../apps/cli/src/cloud/decodeJwtPayload';

describe('server fixture Home database isolation', () => {
  const fixtures: Awaited<ReturnType<typeof startProjectDaemonFixture>>[] = [];
  afterAll(async () => { for (const fixture of fixtures.reverse()) await fixture.stop(); });

  it('keeps independent fixture owners and Accounts in distinct Homes', async () => {
    const containerId = process.env.HAPPIER_DB_CONTRACT_CONTAINER_ID;
    const templateUrl = process.env.HAPPIER_DB_CONTRACT_TEMPLATE_URL;
    if (!containerId || !templateUrl) throw new Error('Home isolation requires the runner-owned disposable PostgreSQL container');
    const template = new URL(templateUrl);
    const readTemplateTables = () => execFileSync('docker', ['exec', '-i', containerId, 'psql', '-X', '-qAt',
      '-v', 'ON_ERROR_STOP=1', '-U', decodeURIComponent(template.username), '-d', decodeURIComponent(template.pathname.slice(1))], {
      input: "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;\n",
      encoding: 'utf8',
    });
    const templateTables = readTemplateTables();
    const first = await startProjectDaemonFixture({
      testDir: await mkdtemp(join(tmpdir(), 'home-isolation-first-')), dbProvider: 'postgres',
    });
    fixtures.push(first);
    const firstOwner = await first.createAccount('first-home-owner');
    expect((await first.claimHomeOwner(firstOwner)).result.status).toBe('claimed');
    expect((await first.claimHomeOwner(firstOwner)).result.status).toBe('already_owned');

    const second = await startProjectDaemonFixture({
      testDir: await mkdtemp(join(tmpdir(), 'home-isolation-second-')), dbProvider: 'postgres',
    });
    fixtures.push(second);
    const secondOwner = await second.createAccount('second-home-owner');
    expect(second.serverId, 'Each fixture must have its own persisted Home identity').not.toBe(first.serverId);
    expect((await second.claimHomeOwner(secondOwner)).result.status).toBe('claimed');
    expect(await secondOwner.execute('home.accounts.get', {
      accountId: readAccountIdFromToken(secondOwner.credentials.token),
    })).toMatchObject({ ok: true });
    const foreignAccount = await secondOwner.execute('home.accounts.get', {
      accountId: readAccountIdFromToken(firstOwner.credentials.token),
    });
    expect(foreignAccount).toMatchObject({ ok: false, errorCode: 'home_account_not_found' });
    expect(readTemplateTables(), 'Fixture migrations and Accounts must leave the template unchanged').toBe(templateTables);
  });
});
import { execFileSync } from 'node:child_process';
