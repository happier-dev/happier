import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

import { buildDbContainerPlan, buildDatabaseUrlForContainer, parseDockerPortLine,
  sanitizeDockerEnv } from '../../../scripts/extended-db-docker.plan.mjs';
import { waitFor } from '../timing';

const execute = promisify(execFile);

/** P09 test data, not product limits. Separate databases discriminate target leaks. */
export const DATABASE_WORKBENCH_SCALE = Object.freeze({ rows: 1_200_000, statementShapes: 240 });

/** Owns only its returned Docker container; never accepts an existing database URL. */
export async function startDatabaseWorkbenchPostgres(options: Readonly<{ preloadStatistics?: boolean }> = {}) {
  const plan = buildDbContainerPlan({ db: 'postgres', name: `dbw-qa-${randomUUID()}` });
  const env = sanitizeDockerEnv(process.env);
  const { stdout } = await execute('docker', ['run', '--detach', '--rm',
    '--name', plan.name, '--publish', plan.ports.publishSpec,
    ...Object.entries(plan.env).flatMap(([key, value]) => ['--env', `${key}=${value}`]),
    plan.image, ...(options.preloadStatistics === false ? [] : ['-c', 'shared_preload_libraries=pg_stat_statements'])], { env });
  const containerId = stdout.trim();
  const stop = async () => { await execute('docker', ['stop', containerId], { env }); };

  function sql(database: string, input: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn('docker', ['exec', '-i', containerId, 'psql', '-X', '-qAt',
        '-v', 'ON_ERROR_STOP=1', '-U', plan.env.POSTGRES_USER, '-d', database],
      { env, stdio: ['pipe', 'pipe', 'pipe'] });
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

  try {
    await waitFor(async () => {
      await execute('docker', ['exec', containerId, 'pg_isready', '-U', plan.env.POSTGRES_USER,
        '-d', plan.env.POSTGRES_DB], { env });
      // pg_isready can observe the temporary init server; TCP proves final readiness.
      await execute('docker', ['exec', containerId, 'psql', '-h', '127.0.0.1', '-U', plan.env.POSTGRES_USER,
        '-d', plan.env.POSTGRES_DB, '-c', 'SELECT 1'], { env });
      return true;
    }, { context: 'DBW lane-owned PostgreSQL startup' });
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
