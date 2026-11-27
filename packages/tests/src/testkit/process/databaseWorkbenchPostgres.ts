import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { buildDbContainerPlan, buildDatabaseUrlForContainer, parseDockerPortLine,
  sanitizeDockerEnv } from '../../../scripts/extended-db-docker.plan.mjs';
import { waitFor } from '../timing';
import { reserveAvailablePort } from '../network/reserveAvailablePort';
import type { EphemeralTlsServerFixture } from '../tls/ephemeralTlsServerFixture.mjs';

const execute = promisify(execFile);

function containerSql(containerId: string, env: NodeJS.ProcessEnv, user: string, database: string, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', ['exec', '-i', containerId, 'psql', '-X', '-qAt',
      '-v', 'ON_ERROR_STOP=1', '-U', user, '-d', database], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    let errors = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { output += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { errors += chunk; });
    child.once('error', reject);
    child.stdin.on('error', reject);
    child.once('close', (code) => code === 0 ? resolve(output.trim())
      : reject(new Error(`DBW fixture SQL failed (${code}): ${errors}`)));
    child.stdin.end(input);
  });
}

/** Write a target fixture only. Happier's launcher, never this helper, starts it. */
export async function prepareDatabaseWorkbenchPostgresService(root: string) {
  const plan = buildDbContainerPlan({ db: 'postgres', name: `dbw-u0-${randomUUID()}` });
  const port = await reserveAvailablePort();
  const database = 'dbw_started';
  const databaseUrl = new URL(buildDatabaseUrlForContainer({ db: 'postgres', host: '127.0.0.1', port }));
  databaseUrl.pathname = `/${database}`;
  await mkdir(join(root, '.happier'), { recursive: true });
  await writeFile(join(root, '.happier/dbw-u0-init.sql'),
    `CREATE EXTENSION pg_stat_statements;\nCREATE TABLE sentinel (id bigint PRIMARY KEY, target text NOT NULL); INSERT INTO sentinel VALUES (1, '${database}');\n`);
  await writeFile(join(root, '.env'), `DATABASE_URL=${databaseUrl.href}\n`, { mode: 0o600 });
  await writeFile(join(root, 'compose.yaml'), JSON.stringify({ services: { postgres: {
    image: plan.image, pull_policy: 'never', container_name: plan.name,
    command: ['postgres', '-c', 'shared_preload_libraries=pg_stat_statements'],
    environment: { ...plan.env, POSTGRES_DB: database, DATABASE_URL: '${DATABASE_URL}' },
    ports: [`127.0.0.1:${port}:5432`],
    // Fixture data expires with this test-owned container rather than leaving an anonymous volume.
    tmpfs: ['/var/lib/postgresql/data'],
    volumes: ['./.happier/dbw-u0-init.sql:/docker-entrypoint-initdb.d/001-sentinel.sql:ro'],
  } } }));
  await writeFile(join(root, '.happier/project.json'), JSON.stringify({ version: 1,
    environmentVariables: [{ name: 'DATABASE_URL', kind: 'config', required: true }],
    services: { postgres: { source: { kind: 'native', tool: 'compose', file: 'compose.yaml', target: 'postgres' } } },
  }));
  const env = { ...sanitizeDockerEnv(process.env), NODE_ENV: process.env.NODE_ENV };
  return { database, databaseUrl: databaseUrl.href, containerName: plan.name,
    sql(input: string) { return containerSql(plan.name, env, plan.env.POSTGRES_USER, database, input); },
    async ready() {
      await waitFor(async () => {
        // TCP plus the init sentinel excludes PostgreSQL's temporary initialization server.
        await execute('docker', ['exec', plan.name, 'psql', '-h', '127.0.0.1', '-U', plan.env.POSTGRES_USER,
          '-d', database, '-c', 'SELECT id FROM sentinel'], { env });
        return true;
      }, { context: 'Happier-started U0 PostgreSQL sentinel' });
    },
    async cleanup() {
      // Exact fixture ownership; ordinary semantic Stop runs before this final resource cleanup.
      const found = await execute('docker', ['ps', '--all', '--quiet', '--filter', `name=^/${plan.name}$`], { env });
      if (!found.stdout.trim()) return;
      const project = await execute('docker', ['inspect', '--format', '{{index .Config.Labels "com.docker.compose.project"}}',
        found.stdout.trim()], { env });
      if (!project.stdout.trim()) throw new Error('U0 fixture container omitted its Compose project');
      await execute('docker', ['compose', '--project-name', project.stdout.trim(), '--file', join(root, 'compose.yaml'),
        'down', '--volumes'], { env });
    },
  };
}

/** P09 test data, not product limits. Separate databases discriminate target leaks. */
export const DATABASE_WORKBENCH_SCALE = Object.freeze({ rows: 1_200_000, statementShapes: 240 });

/** Owns only its returned Docker container; never accepts an existing database URL. */
export async function startDatabaseWorkbenchPostgres(options: Readonly<{
  preloadStatistics?: boolean;
  tls?: Pick<EphemeralTlsServerFixture, 'leafCertificatePath' | 'privateKeyPath'>;
}> = {}) {
  const plan = buildDbContainerPlan({ db: 'postgres', name: `dbw-qa-${randomUUID()}` });
  const env = { ...sanitizeDockerEnv(process.env), NODE_ENV: process.env.NODE_ENV };
  const { stdout } = await execute('docker', ['run', '--detach', '--rm',
    '--name', plan.name, '--publish', plan.ports.publishSpec,
    ...Object.entries(plan.env).flatMap(([key, value]) => ['--env', `${key}=${value}`]),
    plan.image, ...(options.preloadStatistics === false ? [] : ['-c', 'shared_preload_libraries=pg_stat_statements'])], { env });
  const containerId = stdout.trim();
  const stop = async () => { await execute('docker', ['stop', containerId], { env }); };

  function sql(database: string, input: string): Promise<string> {
    return containerSql(containerId, env, plan.env.POSTGRES_USER, database, input);
  }

  try {
    await waitFor(async () => {
      await execute('docker', ['exec', containerId, 'pg_isready', '-U', plan.env.POSTGRES_USER,
        '-d', plan.env.POSTGRES_DB], { env });
      // pg_isready can observe the temporary init server; TCP proves final readiness.
      await execute('docker', ['exec', containerId, 'psql', '-h', '127.0.0.1', '-U', plan.env.POSTGRES_USER,
        '-d', plan.env.POSTGRES_DB, '-c', 'SELECT 1'], { env });
      return true;
    }, { context: 'DBW lane-owned PostgreSQL startup' });
    if (options.tls) {
      const data = '/var/lib/postgresql/data';
      await execute('docker', ['cp', options.tls.leafCertificatePath, `${containerId}:${data}/server.crt`], { env });
      await execute('docker', ['cp', options.tls.privateKeyPath, `${containerId}:${data}/server.key`], { env });
      await execute('docker', ['exec', '--user', '0', containerId, 'chown', 'postgres:postgres',
        `${data}/server.crt`, `${data}/server.key`], { env });
      await execute('docker', ['exec', '--user', 'postgres', containerId, 'chmod', '600', `${data}/server.key`], { env });
      await sql('happier', "ALTER SYSTEM SET ssl = 'on'");
      await sql('happier', 'SELECT pg_reload_conf()');
      await waitFor(async () => (await sql('happier', 'SHOW ssl')) === 'on',
        { context: 'DBW lane-owned PostgreSQL TLS startup' });
    }
    const port = await execute('docker', ['port', containerId, String(plan.ports.containerPort)], { env });
    const address = parseDockerPortLine(port.stdout);
    const homeDatabaseUrl = buildDatabaseUrlForContainer({ db: 'postgres', ...address });
    const databaseUrl = (database: string) => {
      const url = new URL(homeDatabaseUrl);
      url.pathname = `/${database}`;
      return url.href;
    };
    // Home persistence is never used as target data. Negative prerequisites have their own DB.
    await sql('happier', 'CREATE DATABASE dbw_selected; CREATE DATABASE dbw_neighbor; CREATE DATABASE dbw_no_extension;');
    for (const database of ['dbw_selected', 'dbw_neighbor']) {
      await sql(database, `CREATE EXTENSION pg_stat_statements;
        CREATE TABLE sentinel (id bigint PRIMARY KEY, target text NOT NULL);
        INSERT INTO sentinel VALUES (1, '${database}');`);
    }
    async function seedScale() {
      await sql('dbw_selected', `CREATE TABLE scale_rows (id bigint PRIMARY KEY, group_id integer NOT NULL,
          nullable_text text, empty_text text NOT NULL, large_integer bigint NOT NULL);
        INSERT INTO scale_rows SELECT i, i % 1000, NULL, '', 9007199254740993
          FROM generate_series(1, ${DATABASE_WORKBENCH_SCALE.rows}) AS i;
        ANALYZE scale_rows;`);
      // Different expression arities survive pg_stat_statements constant normalization.
      await sql('dbw_selected', Array.from({ length: DATABASE_WORKBENCH_SCALE.statementShapes }, (_, i) =>
        `SELECT ${Array.from({ length: i + 1 }, () => '1').join('+')};`).join('\n'));
    }
    return { containerId, homeDatabaseUrl, selectedDatabaseUrl: databaseUrl('dbw_selected'),
      neighborDatabaseUrl: databaseUrl('dbw_neighbor'), noExtensionDatabaseUrl: databaseUrl('dbw_no_extension'),
      sql, seedScale, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
