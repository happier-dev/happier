import { describe, expect, it } from 'vitest';

import {
  buildDbContainerPlan,
  buildExtendedDbCommandPlan,
  buildDatabaseUrlForContainer,
  parseDockerPortLine,
  sanitizeDockerEnv,
} from '../../../scripts/extended-db-docker.plan.mjs';

describe('extended db docker plan', () => {
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

  it('plans the correct yarn commands for e2e and db-contract modes', () => {
    const databaseUrl = buildDatabaseUrlForContainer({ db: 'postgres', host: '127.0.0.1', port: 5432 });
    const e2e = buildExtendedDbCommandPlan({ db: 'postgres', mode: 'e2e', databaseUrl });
    expect(e2e).toHaveLength(1);
    expect(e2e[0].kind).toBe('e2e');
    expect(e2e[0].env.HAPPIER_E2E_DB_PROVIDER).toBe('postgres');
    expect(e2e[0].env.DATABASE_URL).toBe(databaseUrl);

    const contract = buildExtendedDbCommandPlan({ db: 'mysql', mode: 'contract', databaseUrl: 'mysql://root:happier@127.0.0.1:3306/happier' });
    expect(contract).toHaveLength(2);
    expect(contract[0].kind).toBe('migrate');
    expect(contract[1].kind).toBe('contract');
    expect(contract[1].env.HAPPIER_DB_PROVIDER).toBe('mysql');
  });

  it('plans the correct yarn commands for extended mode (all steps)', () => {
    const databaseUrl = buildDatabaseUrlForContainer({ db: 'postgres', host: '127.0.0.1', port: 5432 });
    const extended = buildExtendedDbCommandPlan({ db: 'postgres', mode: 'extended', databaseUrl });
    expect(extended).toHaveLength(3);
    expect(extended[0].kind).toBe('e2e');
    expect(extended[0].env.HAPPIER_E2E_DB_PROVIDER).toBe('postgres');
    expect(extended[0].env.DATABASE_URL).toBe(databaseUrl);
    expect(extended[1].kind).toBe('migrate');
    expect(extended[1].env.DATABASE_URL).toBe(databaseUrl);
    expect(extended[2].kind).toBe('contract');
    expect(extended[2].env.HAPPIER_DB_PROVIDER).toBe('postgres');
    expect(extended[2].env.DATABASE_URL).toBe(databaseUrl);
  });

  it('sanitizes docker env by dropping DOCKER_API_VERSION to allow negotiation', () => {
    const res = sanitizeDockerEnv({ DOCKER_API_VERSION: '1.51', FOO: 'bar' });
    expect(res).toEqual({ FOO: 'bar' });
  });
});
