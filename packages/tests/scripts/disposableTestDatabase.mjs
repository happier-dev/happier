import { execFileSync } from 'node:child_process';

/** Clone only a runner-owned disposable container's template. The container's
 * existing teardown owns these databases; retained or explicit unrelated URLs
 * never authorize database creation or replacement. */
export function prepareDisposableTestDatabase({ databaseName: workerName, dbProvider: db,
  sourceDatabaseUrl, reuseExisting = false, env = process.env }) {
  const containerId = env.HAPPIER_DB_CONTRACT_CONTAINER_ID;
  if (!containerId) return;
  if (!/^[a-f0-9]{64}$/.test(containerId) || (db !== 'postgres' && db !== 'mysql')) {
    throw new Error('Disposable database isolation requires an exact test container and provider');
  }
  let template;
  try {
    template = new URL(env.HAPPIER_DB_CONTRACT_TEMPLATE_URL);
  } catch {
    throw new Error('Disposable database isolation requires its template connection');
  }
  if ((db === 'postgres' && template.protocol !== 'postgresql:')
    || (db === 'mysql' && template.protocol !== 'mysql:')) {
    throw new Error('Disposable database template does not match its provider');
  }
  if (new URL(sourceDatabaseUrl).href !== template.href) return;
  const templateName = decodeURIComponent(template.pathname.slice(1));
  if (!templateName || templateName === workerName) {
    throw new Error('Disposable database template must be distinct from the fixture database');
  }
  const worker = new URL(template);
  worker.pathname = `/${workerName}`;
  // Retained server restarts already own the database selected by this fixture.
  if (reuseExisting) return worker.href;
  const user = decodeURIComponent(template.username);
  const runDocker = (args, input, commandEnv = env) => execFileSync('docker', ['exec', '-i', ...args], {
    input,
    env: commandEnv,
    encoding: 'utf8',
    maxBuffer: Infinity,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (db === 'postgres') {
    const quote = value => `"${value.replaceAll('"', '""')}"`;
    // psql executes these as separate statements, outside a transaction. FORCE
    // retires leaked connections only in this disposable worker database.
    runDocker([containerId, 'psql', '-X', '-U', user, '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'],
      `DROP DATABASE IF EXISTS ${quote(workerName)} WITH (FORCE);\n`
      + `CREATE DATABASE ${quote(workerName)} TEMPLATE ${quote(templateName)};\n`);
  } else {
    const quote = value => `\`${value.replaceAll('`', '``')}\``;
    const mysqlEnv = { ...env, MYSQL_PWD: decodeURIComponent(template.password) };
    // Pass the environment name, never the value, through Docker's argv.
    const args = ['--env', 'MYSQL_PWD', containerId];
    const dump = runDocker([...args, 'mysqldump', '-u', user, '--single-transaction',
      '--set-gtid-purged=OFF', '--no-tablespaces', '--hex-blob', '--routines', templateName], undefined, mysqlEnv);
    runDocker([...args, 'mysql', '-u', user],
      `DROP DATABASE IF EXISTS ${quote(workerName)};\nCREATE DATABASE ${quote(workerName)};\n`, mysqlEnv);
    // MySQL 8 dumps the VoiceSessionLease single-statement trigger with its
    // stored terminator inside a versioned comment, which fails on restore.
    // Remove only that trailing terminator at the dump's delimiter boundary;
    // retain statement bodies, quoted values and all trigger definitions.
    const restorable = dump.replace(/;[ \t]+\*\/;;(?=\r?\nDELIMITER ;(?:\r?\n|$))/g, ' */;;');
    runDocker([...args, 'mysql', '-u', user, workerName], restorable, mysqlEnv);
  }
  return worker.href;
}
