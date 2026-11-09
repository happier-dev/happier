import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import serverDbContractConfig from '../../../../../apps/server/vitest.dbcontract.config';

import {
  buildDbContainerPlan,
  buildExtendedDbCommandPlan,
  buildDatabaseUrlForContainer,
  parseDockerPortLine,
  sanitizeDockerEnv,
} from '../../../scripts/extended-db-docker.plan.mjs';
import { parseArgs } from '../../../scripts/run-extended-db-docker.mjs';
import { prepareDbContractDatabase } from '../../../scripts/dbContractDatabase.mjs';

// Docker's process/SQL transport is the external boundary; isolation decisions
// and environment routing run through the real owner.
vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  execFileSync: vi.fn(),
}));

describe('DB contract worker databases', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.mocked(execFileSync).mockReset(); });

  function configure(db: 'postgres' | 'mysql') {
    const templateUrl = buildDatabaseUrlForContainer({ db, host: '127.0.0.1', port: 5432 });
    vi.stubEnv('HAPPIER_DB_CONTRACT_CONTAINER_ID', 'a'.repeat(64));
    vi.stubEnv('HAPPIER_DB_CONTRACT_TEMPLATE_URL', templateUrl);
    vi.stubEnv('HAPPIER_DB_PROVIDER', db);
    vi.stubEnv('VITEST_POOL_ID', '1');
    vi.stubEnv('DATABASE_URL', templateUrl);
    vi.stubEnv(db === 'postgres' ? 'HAPPIER_TEST_POSTGRES_DATABASE_URL' : 'HAPPIER_TEST_MYSQL_DATABASE_URL', templateUrl);
    vi.mocked(execFileSync).mockReturnValue('');
    return templateUrl;
  }

  it('does not touch databases without an explicit disposable container', () => {
    vi.stubEnv('HAPPIER_DB_CONTRACT_CONTAINER_ID', undefined);
    prepareDbContractDatabase();
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('refreshes PostgreSQL between files, isolates workers, and preserves the migrated template', () => {
    const templateUrl = configure('postgres');
    prepareDbContractDatabase();
    const first = process.env.DATABASE_URL;
    prepareDbContractDatabase();
    expect(process.env.DATABASE_URL).toBe(first);
    vi.stubEnv('VITEST_POOL_ID', '2');
    prepareDbContractDatabase();
    expect(process.env.DATABASE_URL).not.toBe(first);
    expect(new URL(process.env.DATABASE_URL!).pathname).toBe('/happier_contract_2');
    expect(process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL).toBe(process.env.DATABASE_URL);
    expect(process.env.HAPPIER_DB_CONTRACT_TEMPLATE_URL).toBe(templateUrl);
    const inputs = vi.mocked(execFileSync).mock.calls.map(([, , options]) => options?.input);
    expect(inputs).toEqual([
      'DROP DATABASE IF EXISTS "happier_contract_1" WITH (FORCE);\nCREATE DATABASE "happier_contract_1" TEMPLATE "happier";\n',
      'DROP DATABASE IF EXISTS "happier_contract_1" WITH (FORCE);\nCREATE DATABASE "happier_contract_1" TEMPLATE "happier";\n',
      'DROP DATABASE IF EXISTS "happier_contract_2" WITH (FORCE);\nCREATE DATABASE "happier_contract_2" TEMPLATE "happier";\n',
    ]);
  });

  it('restores the MySQL template dump into the worker without values in process arguments', () => {
    configure('mysql');
    // Captured MySQL 8 mysqldump shape: a stored trailing terminator inside
    // the versioned trigger comment is rejected on restore.
    const dump = [
      'CREATE TABLE preserved_fixture (id INT, note TEXT);',
      "INSERT INTO preserved_fixture VALUES (1, 'retain; */;;');",
      'DELIMITER ;;',
      "/*!50003 CREATE*/ /*!50003 TRIGGER retained BEFORE DELETE ON preserved_fixture FOR EACH ROW UPDATE preserved_fixture SET note='inside; preserved'; */;;",
      'DELIMITER ;',
      '',
    ].join('\n');
    vi.mocked(execFileSync).mockImplementation((_command, args) => args?.includes('mysqldump') ? dump : '');
    prepareDbContractDatabase();
    expect(new URL(process.env.DATABASE_URL!).pathname).toBe('/happier_contract_1');
    expect(process.env.HAPPIER_TEST_MYSQL_DATABASE_URL).toBe(process.env.DATABASE_URL);
    expect(vi.mocked(execFileSync).mock.calls.at(-1)?.[2]?.input).toBe(
      dump.replace("note='inside; preserved'; */;;", "note='inside; preserved' */;;"),
    );
    const args = vi.mocked(execFileSync).mock.calls.flatMap(([, args]) => args ?? []);
    expect(args).toContain('MYSQL_PWD');
    expect(args.some(arg => typeof arg === 'string' && arg.startsWith('MYSQL_PWD='))).toBe(false);
  });

  it.each(['container', 'pool'] as const)('rejects an invalid %s identity before accessing Docker', invalid => {
    configure('postgres');
    vi.stubEnv(invalid === 'container' ? 'HAPPIER_DB_CONTRACT_CONTAINER_ID' : 'VITEST_POOL_ID', '../unowned');
    expect(() => prepareDbContractDatabase()).toThrow(/exact test container/);
    expect(execFileSync).not.toHaveBeenCalled();
  });
});

describe('extended db docker plan', () => {
  it('isolates every provider contract step while leaving its migrated template untouched', () => {
    const containerId = 'a'.repeat(64);
    for (const db of ['postgres', 'mysql'] as const) {
      const databaseUrl = buildDatabaseUrlForContainer({ db, host: '127.0.0.1', port: 5432 });
      for (const mode of ['contract', 'extended', 'session-system-record-upgrade'] as const) {
        const plan = buildExtendedDbCommandPlan({ db, mode, databaseUrl, containerId });
        const isContract = (step: (typeof plan)[number]) => step.kind === 'contract' || step.kind === 'session-system-record-board-contract';
        expect(plan.find(isContract)?.env).toMatchObject({
          HAPPIER_DB_CONTRACT_CONTAINER_ID: containerId,
          HAPPIER_DB_CONTRACT_TEMPLATE_URL: databaseUrl,
        });
        expect(plan.filter(step => !isContract(step)).every(step => !('HAPPIER_DB_CONTRACT_CONTAINER_ID' in step.env))).toBe(true);
      }
    }
    expect(serverDbContractConfig.test?.fileParallelism).not.toBe(false);
    expect(serverDbContractConfig.test?.setupFiles?.[0]).toBe(
      fileURLToPath(new URL('../../../scripts/dbContractDatabase.mjs', import.meta.url)),
    );
  });
  it('passes an optional contract file filter only to the contract runner', () => {
    const contractFile = 'sources/app/session/systemRecords/sessionSystemRecords.dbcontract.spec.ts';
    const parsed = parseArgs(['node', 'run-extended-db-docker.mjs', '--db', 'mysql', '--mode', 'contract', '--contract-file', contractFile]);
    expect(parsed['contract-file']).toBe(contractFile);
    const plan = buildExtendedDbCommandPlan({ db: 'mysql', mode: 'contract', databaseUrl: 'mysql://localhost/test', contractFile });
    expect(plan.find(step => step.kind === 'contract')?.args).toEqual(['--filter', '@happier-dev/server', 'run', 'test:db-contract', contractFile]);
    expect(plan.filter(step => step.kind !== 'contract').every(step => !step.args.includes(contractFile))).toBe(true);
    expect(() => buildExtendedDbCommandPlan({ db: 'mysql', mode: 'e2e', databaseUrl: 'mysql://localhost/test', contractFile })).toThrow();
  });
  it('builds a postgres container plan with healthcheck and ephemeral port mapping', () => {
    const plan = buildDbContainerPlan({ db: 'postgres', name: 'happier-test-pg' });

    expect(plan.image).toBe('postgres:17');
    expect(plan.ports.containerPort).toBe(5432);
    expect(plan.ports.publishSpec).toBe('127.0.0.1::5432');
    expect(plan.env.POSTGRES_DB).toBeTruthy();
    expect(plan.env.POSTGRES_PASSWORD).toBeTruthy();
    expect(plan.env.POSTGRES_USER).toBeTruthy();
    expect(plan.healthCmd).toContain('pg_isready');
  });

  it('builds a mysql container plan with healthcheck and ephemeral port mapping', () => {
    const plan = buildDbContainerPlan({ db: 'mysql', name: 'happier-test-mysql' });

    expect(plan.image).toBe('mysql:8.0');
    expect(plan.ports.containerPort).toBe(3306);
    expect(plan.ports.publishSpec).toBe('127.0.0.1::3306');
    expect(plan.env.MYSQL_ROOT_PASSWORD).toBeTruthy();
    expect(plan.env.MYSQL_DATABASE).toBeTruthy();
    expect(plan.healthCmd).toContain('mysqladmin ping');
  });

  it('parses docker port output to host and port', () => {
    expect(parseDockerPortLine('127.0.0.1:49190')).toEqual({ host: '127.0.0.1', port: 49190 });
    expect(parseDockerPortLine('0.0.0.0:54321')).toEqual({ host: '0.0.0.0', port: 54321 });
    expect(parseDockerPortLine(':::54321')).toEqual({ host: '::', port: 54321 });
  });

  it('builds the correct DATABASE_URL for postgres and mysql', () => {
    expect(buildDatabaseUrlForContainer({ db: 'postgres', host: '127.0.0.1', port: 5432 })).toMatch(
      /^postgresql:\/\/happier:happier@127\.0\.0\.1:5432\/happier\?sslmode=disable$/,
    );
    expect(buildDatabaseUrlForContainer({ db: 'postgres', host: '0.0.0.0', port: 5432 })).toMatch(
      /^postgresql:\/\/happier:happier@127\.0\.0\.1:5432\/happier\?sslmode=disable$/,
    );
    expect(buildDatabaseUrlForContainer({ db: 'postgres', host: '::', port: 5432 })).toMatch(
      /^postgresql:\/\/happier:happier@127\.0\.0\.1:5432\/happier\?sslmode=disable$/,
    );
    expect(buildDatabaseUrlForContainer({ db: 'postgres', host: '::1', port: 5432 })).toBe(
      'postgresql://happier:happier@[::1]:5432/happier?sslmode=disable',
    );
    expect(buildDatabaseUrlForContainer({ db: 'mysql', host: '127.0.0.1', port: 3306 })).toBe(
      'mysql://root:happier@127.0.0.1:3306/happier',
    );
  });

  it('plans the correct pnpm commands for e2e and db-contract modes', () => {
    const databaseUrl = buildDatabaseUrlForContainer({ db: 'postgres', host: '127.0.0.1', port: 5432 });
    const e2e = buildExtendedDbCommandPlan({ db: 'postgres', mode: 'e2e', databaseUrl });
    expect(e2e).toHaveLength(3);
    expect(e2e[0].kind).toBe('prebuild-cli-shared');
    expect(e2e[1].kind).toBe('prebuild-cli');
    expect(e2e[2].kind).toBe('e2e');
    expect(e2e[2].env.HAPPIER_E2E_DB_PROVIDER).toBe('postgres');
    expect(e2e[2].env.DATABASE_URL).toBe(databaseUrl);

    const contract = buildExtendedDbCommandPlan({ db: 'mysql', mode: 'contract', databaseUrl: 'mysql://root:happier@127.0.0.1:3306/happier' });
    expect(contract).toHaveLength(3);
    expect(contract[0]).toMatchObject({
      kind: 'mysql-voice-identity-upgrade-contract',
      args: ['--silent', '--filter', '@happier-dev/server', 'run', 'test:mysql-voice-identity-upgrade-contract'],
      env: {
        HAPPIER_DB_PROVIDER: 'mysql',
        DATABASE_URL: 'mysql://root:happier@127.0.0.1:3306/happier',
      },
    });
    expect(contract[1].kind).toBe('migrate');
    expect(contract[1].env.HAPPIER_DB_MIGRATION_APPROVAL).toBe(
      '20260729102000_add_voice_conversation_grant_provenance',
    );
    expect(contract[2].kind).toBe('contract');
    expect(contract[2].env.HAPPIER_DB_PROVIDER).toBe('mysql');
  });

  it('plans the correct pnpm commands for extended mode (all steps)', () => {
    const databaseUrl = buildDatabaseUrlForContainer({ db: 'postgres', host: '127.0.0.1', port: 5432 });
    const extended = buildExtendedDbCommandPlan({ db: 'postgres', mode: 'extended', databaseUrl });
    expect(extended).toHaveLength(5);
    expect(extended[0].kind).toBe('prebuild-cli-shared');
    expect(extended[1].kind).toBe('prebuild-cli');
    expect(extended[2].kind).toBe('e2e');
    expect(extended[2].env.HAPPIER_E2E_DB_PROVIDER).toBe('postgres');
    expect(extended[2].env.DATABASE_URL).toBe(databaseUrl);
    expect(extended[3].kind).toBe('migrate');
    expect(extended[3].env.DATABASE_URL).toBe(databaseUrl);
    expect(extended[4].kind).toBe('contract');
    expect(extended[4].env.HAPPIER_DB_PROVIDER).toBe('postgres');
    expect(extended[4].env.DATABASE_URL).toBe(databaseUrl);
  });

  it('sanitizes docker env by dropping DOCKER_API_VERSION to allow negotiation', () => {
    const res = sanitizeDockerEnv({ DOCKER_API_VERSION: '1.51', FOO: 'bar' });
    expect(res).toEqual({ FOO: 'bar' });
  });
});
