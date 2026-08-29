import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  applyHappyServerMigrations,
  ensureHappyServerManagedInfra,
} from './happy_server_infra.mjs';

function parseEnvText(text) {
  return Object.fromEntries(String(text).split('\n').flatMap((line) => {
    const index = line.indexOf('=');
    return index > 0 ? [[line.slice(0, index), line.slice(index + 1)]] : [];
  }));
}

test('mysql managed infra keeps shared services without allocating or waiting for postgres', async (t) => {
  const baseDir = await mkdtemp(join(tmpdir(), 'happier-mysql-infra-'));
  t.after(() => rm(baseDir, { recursive: true, force: true }));
  const allocatedStarts = [];
  const allocationReservations = [];
  let nextPort = 42_000;
  const dockerCalls = [];
  let postgresWaits = 0;
  let redisWaits = 0;
  const databaseUrl = 'mysql://operator:secret@db.example/happier';
  const envPath = join(baseDir, 'env');
  await writeFile(envPath, [
    'HAPPIER_DB_PROVIDER=mysql',
    `DATABASE_URL=${databaseUrl}`,
    'HAPPIER_STACK_PG_PORT=45432',
    'HAPPIER_STACK_PG_USER=stale-postgres-user',
    'HAPPIER_STACK_PG_PASSWORD=stale-postgres-password',
    'HAPPIER_STACK_PG_DATABASE=stale-postgres-database',
    '',
  ].join('\n'), 'utf8');

  const result = await ensureHappyServerManagedInfra(
    {
      stackName: 'mysql-provider-test',
      baseDir,
      serverPort: 3005,
      publicServerUrl: 'http://127.0.0.1:3005',
      envPath,
      env: { HAPPIER_DB_PROVIDER: 'mysql', DATABASE_URL: databaseUrl },
      quiet: true,
      skipMinioInit: true,
    },
    {
      ensureDockerComposeImpl: async () => {},
      pickNextFreeTcpPortImpl: async (start, { reservedPorts }) => {
        allocatedStarts.push(start);
        allocationReservations.push(new Set(reservedPorts));
        return nextPort++;
      },
      dockerComposeImpl: async (input) => dockerCalls.push(input),
      waitForHealthyPostgresImpl: async () => { postgresWaits += 1; },
      waitForHealthyRedisImpl: async () => { redisWaits += 1; },
    },
  );

  const compose = await readFile(result.composePath, 'utf8');
  const persistedEnv = await readFile(envPath, 'utf8');
  assert.equal(result.env.DATABASE_URL, databaseUrl);
  assert.equal(postgresWaits, 0);
  assert.equal(redisWaits, 1);
  assert.equal(allocatedStarts.length, 3);
  assert.ok(allocationReservations.every((ports) => !ports.has(45_432)));
  assert.equal(dockerCalls.length, 1);
  assert.doesNotMatch(compose, /^  postgres:/m);
  assert.match(compose, /^  redis:/m);
  assert.match(compose, /^  minio:/m);
  assert.equal(parseEnvText(persistedEnv).DATABASE_URL, databaseUrl);
  assert.doesNotMatch(persistedEnv, /^HAPPIER_STACK_PG_/m);
  assert.doesNotMatch(persistedEnv, /^HAPPIER_STACK_REDIS_PORT=/m);
  assert.match(persistedEnv, /^HAPPIER_STACK_HANDY_MASTER_SECRET_FILE=/m);
  assert.match(persistedEnv, /^S3_ACCESS_KEY=/m);
  assert.match(persistedEnv, /^S3_SECRET_KEY=/m);
  assert.match(persistedEnv, /^S3_BUCKET=/m);
});

test('external postgres authority keeps shared services without allocating or waiting for managed postgres', async (t) => {
  const baseDir = await mkdtemp(join(tmpdir(), 'happier-external-postgres-infra-'));
  t.after(() => rm(baseDir, { recursive: true, force: true }));
  const allocatedStarts = [];
  const allocationReservations = [];
  let nextPort = 43_000;
  const dockerCalls = [];
  let postgresWaits = 0;
  let redisWaits = 0;
  const databaseUrl = 'postgresql://operator:secret@db.example/happier?sslmode=require';
  const envPath = join(baseDir, 'env');
  await writeFile(envPath, [
    'HAPPIER_DB_PROVIDER=postgres',
    `DATABASE_URL=${databaseUrl}`,
    'HAPPIER_STACK_PG_PORT=45432',
    'HAPPIER_STACK_PG_USER=stale-postgres-user',
    'HAPPIER_STACK_PG_PASSWORD=stale-postgres-password',
    'HAPPIER_STACK_PG_DATABASE=stale-postgres-database',
    '',
  ].join('\n'), 'utf8');

  const result = await ensureHappyServerManagedInfra(
    {
      stackName: 'external-postgres-provider-test',
      baseDir,
      serverPort: 3005,
      publicServerUrl: 'http://127.0.0.1:3005',
      envPath,
      env: { HAPPIER_DB_PROVIDER: 'postgres', DATABASE_URL: databaseUrl },
      quiet: true,
      skipMinioInit: true,
    },
    {
      ensureDockerComposeImpl: async () => {},
      pickNextFreeTcpPortImpl: async (start, { reservedPorts }) => {
        allocatedStarts.push(start);
        allocationReservations.push(new Set(reservedPorts));
        return nextPort++;
      },
      dockerComposeImpl: async (input) => dockerCalls.push(input),
      waitForHealthyPostgresImpl: async () => { postgresWaits += 1; },
      waitForHealthyRedisImpl: async () => { redisWaits += 1; },
    },
  );

  const compose = await readFile(result.composePath, 'utf8');
  const persistedEnv = await readFile(envPath, 'utf8');
  assert.equal(result.env.DATABASE_URL, databaseUrl);
  assert.equal(postgresWaits, 0);
  assert.equal(redisWaits, 1);
  assert.equal(allocatedStarts.length, 3);
  assert.ok(allocationReservations.every((ports) => !ports.has(45_432)));
  assert.equal(dockerCalls.length, 1);
  assert.doesNotMatch(compose, /^  postgres:/m);
  assert.match(compose, /^  redis:/m);
  assert.match(compose, /^  minio:/m);
  assert.equal(parseEnvText(persistedEnv).DATABASE_URL, databaseUrl);
  assert.doesNotMatch(persistedEnv, /^HAPPIER_STACK_PG_/m);
  assert.doesNotMatch(persistedEnv, /^HAPPIER_STACK_REDIS_PORT=/m);
  assert.match(persistedEnv, /^HAPPIER_STACK_HANDY_MASTER_SECRET_FILE=/m);
  assert.match(persistedEnv, /^S3_ACCESS_KEY=/m);
  assert.match(persistedEnv, /^S3_SECRET_KEY=/m);
  assert.match(persistedEnv, /^S3_BUCKET=/m);
});

test('postgres managed infra retains its service, readiness wait, and persisted connection state across restart', async (t) => {
  const baseDir = await mkdtemp(join(tmpdir(), 'happier-postgres-infra-'));
  t.after(() => rm(baseDir, { recursive: true, force: true }));

  const envPath = join(baseDir, 'env');
  await writeFile(envPath, [
    'HAPPIER_DB_PROVIDER=postgres',
    'HAPPIER_STACK_PG_USER=postgres-user',
    'HAPPIER_STACK_PG_PASSWORD=postgres-password',
    'HAPPIER_STACK_PG_DATABASE=postgres-database',
    '',
  ].join('\n'), 'utf8');

  const allocatedStarts = [];
  let nextPort = 42_000;
  const dockerCalls = [];
  const postgresWaits = [];
  let redisWaits = 0;

  const result = await ensureHappyServerManagedInfra(
    {
      stackName: 'main',
      baseDir,
      serverPort: 3005,
      publicServerUrl: 'http://127.0.0.1:3005',
      envPath,
      env: { HAPPIER_DB_PROVIDER: 'postgres' },
      quiet: true,
      skipMinioInit: true,
    },
    {
      ensureDockerComposeImpl: async () => {},
      pickNextFreeTcpPortImpl: async (start) => {
        allocatedStarts.push(start);
        return nextPort++;
      },
      dockerComposeImpl: async (input) => dockerCalls.push(input),
      waitForHealthyPostgresImpl: async (input) => postgresWaits.push(input),
      waitForHealthyRedisImpl: async () => { redisWaits += 1; },
    },
  );

  const compose = await readFile(result.composePath, 'utf8');
  const persistedEnv = await readFile(envPath, 'utf8');
  assert.deepEqual(allocatedStarts, [4_005, 42_001, 42_002, 42_003]);
  assert.equal(postgresWaits.length, 1);
  assert.equal(postgresWaits[0].pgUser, 'postgres-user');
  assert.equal(postgresWaits[0].pgDb, 'postgres-database');
  assert.equal(redisWaits, 1);
  assert.equal(dockerCalls.length, 1);
  assert.match(compose, /^  postgres:/m);
  assert.match(compose, /^  redis:/m);
  assert.match(compose, /^  minio:/m);
  assert.equal(
    result.env.DATABASE_URL,
    'postgresql://postgres-user:postgres-password@127.0.0.1:42000/postgres-database',
  );
  assert.match(persistedEnv, /^HAPPIER_STACK_PG_PORT=42000$/m);
  assert.match(persistedEnv, /^HAPPIER_STACK_PG_USER=postgres-user$/m);
  assert.match(persistedEnv, /^HAPPIER_STACK_PG_PASSWORD=postgres-password$/m);
  assert.match(persistedEnv, /^HAPPIER_STACK_PG_DATABASE=postgres-database$/m);

  allocatedStarts.length = 0;
  dockerCalls.length = 0;
  postgresWaits.length = 0;
  redisWaits = 0;
  const restarted = await ensureHappyServerManagedInfra(
    {
      stackName: 'main',
      baseDir,
      serverPort: 3005,
      publicServerUrl: 'http://127.0.0.1:3005',
      envPath,
      env: parseEnvText(persistedEnv),
      quiet: true,
      skipMinioInit: true,
    },
    {
      ensureDockerComposeImpl: async () => {},
      pickNextFreeTcpPortImpl: async (start) => {
        allocatedStarts.push(start);
        return nextPort++;
      },
      dockerComposeImpl: async (input) => dockerCalls.push(input),
      waitForHealthyPostgresImpl: async (input) => postgresWaits.push(input),
      waitForHealthyRedisImpl: async () => { redisWaits += 1; },
    },
  );

  assert.equal(restarted.env.DATABASE_URL, result.env.DATABASE_URL);
  assert.deepEqual(allocatedStarts, []);
  assert.equal(postgresWaits.length, 1);
  assert.equal(redisWaits, 1);
  assert.equal(dockerCalls.length, 1);
  assert.match(await readFile(restarted.composePath, 'utf8'), /^  postgres:/m);
});

test('applyHappyServerMigrations delegates mysql to the canonical provider dispatcher', async () => {
  const calls = [];
  const env = { DATABASE_URL: 'mysql://operator/db', HAPPIER_DB_PROVIDER: 'mysql' };
  await applyHappyServerMigrations(
    { serverDir: '/server', env, dbProvider: 'mysql', quiet: true },
    {
      pmExecBinImpl: async (input) => calls.push(input),
    },
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].bin, 'migrate:deploy');
  assert.deepEqual(calls[0].args, []);
  assert.equal(calls[0].dir, '/server');
  assert.deepEqual(calls[0].env, env);
  assert.equal(calls[0].quiet, true);
});

test('applyHappyServerMigrations delegates every provider to one canonical dispatcher', async () => {
  const calls = [];
  await applyHappyServerMigrations(
    { serverDir: '/server', env: { HAPPIER_DB_PROVIDER: 'postgres' }, dbProvider: 'postgres' },
    {
      pmExecBinImpl: async (input) => calls.push(input),
    },
  );
  assert.equal(calls[0].bin, 'migrate:deploy');
  assert.deepEqual(calls[0].args, []);

  await applyHappyServerMigrations(
    { serverDir: '/server', env: { HAPPIER_DB_PROVIDER: 'sqlite' }, dbProvider: 'sqlite' },
    { pmExecBinImpl: async (input) => calls.push(input) },
  );
  await applyHappyServerMigrations(
    { serverDir: '/server', env: { HAPPIER_DB_PROVIDER: 'pglite' }, dbProvider: 'pglite' },
    { pmExecBinImpl: async (input) => calls.push(input) },
  );
  assert.equal(calls[1].bin, 'migrate:deploy');
  assert.equal(calls[2].bin, 'migrate:deploy');
  assert.deepEqual(calls.map((call) => call.env.HAPPIER_DB_PROVIDER), ['postgres', 'sqlite', 'pglite']);
});
