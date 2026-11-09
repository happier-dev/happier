import { execFileSync } from 'node:child_process';

/** Reset only the current worker's database inside an explicitly supplied test
 * container. setupFiles runs for every file: serial files also retain rows unless
 * the worker database is refreshed from the unchanged migrated template. */
export function prepareDbContractDatabase() {
  const containerId = process.env.HAPPIER_DB_CONTRACT_CONTAINER_ID;
  if (!containerId) return;
  const poolId = process.env.VITEST_POOL_ID;
  const db = process.env.HAPPIER_DB_PROVIDER;
  if (!/^[a-f0-9]{64}$/.test(containerId) || !poolId || !/^\d+$/.test(poolId)
    || (db !== 'postgres' && db !== 'mysql')) {
    throw new Error('DB contract isolation requires an exact test container, provider and Vitest pool id');
  }
  let template;
  try {
    template = new URL(process.env.HAPPIER_DB_CONTRACT_TEMPLATE_URL);
  } catch {
    throw new Error('DB contract isolation requires its migrated template connection');
  }
  if ((db === 'postgres' && template.protocol !== 'postgresql:')
    || (db === 'mysql' && template.protocol !== 'mysql:')) {
    throw new Error('DB contract template does not match its provider');
  }
  const templateName = decodeURIComponent(template.pathname.slice(1));
  const workerName = `happier_contract_${poolId}`;
  if (!templateName || templateName === workerName) {
    throw new Error('DB contract template must be distinct from the worker database');
  }
  const user = decodeURIComponent(template.username);
  const runDocker = (args, input, env = process.env) => execFileSync('docker', ['exec', '-i', ...args], {
    input,
    env,
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
    const env = { ...process.env, MYSQL_PWD: decodeURIComponent(template.password) };
    // Pass the environment name, never the value, through Docker's argv.
    const args = ['--env', 'MYSQL_PWD', containerId];
    const dump = runDocker([...args, 'mysqldump', '-u', user, '--single-transaction',
      '--set-gtid-purged=OFF', '--no-tablespaces', '--hex-blob', '--routines', templateName], undefined, env);
    runDocker([...args, 'mysql', '-u', user],
      `DROP DATABASE IF EXISTS ${quote(workerName)};\nCREATE DATABASE ${quote(workerName)};\n`, env);
    // MySQL 8 dumps the VoiceSessionLease single-statement trigger with its
    // stored terminator inside a versioned comment, which fails on restore.
    // Remove only that trailing terminator at the dump's delimiter boundary;
    // retain statement bodies, quoted values and all trigger definitions.
    const restorable = dump.replace(/;[ \t]+\*\/;;(?=\r?\nDELIMITER ;(?:\r?\n|$))/g, ' */;;');
    runDocker([...args, 'mysql', '-u', user, workerName], restorable, env);
  }
  const worker = new URL(template);
  worker.pathname = `/${workerName}`;
  process.env.DATABASE_URL = worker.href;
  process.env[db === 'postgres' ? 'HAPPIER_TEST_POSTGRES_DATABASE_URL' : 'HAPPIER_TEST_MYSQL_DATABASE_URL'] = worker.href;
}

prepareDbContractDatabase();
