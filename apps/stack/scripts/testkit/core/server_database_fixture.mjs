import { mkdir, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';

/** Creates the minimal `Account` table a server-light SQLite database exposes to auth seeding. */
export async function createSqliteAccountTable(databasePath) {
  await mkdir(dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  try {
    db.exec('CREATE TABLE IF NOT EXISTS "Account" ("id" TEXT NOT NULL PRIMARY KEY, "publicKey" TEXT)');
  } finally {
    db.close();
  }
}

/**
 * Writes a stand-in for a server source checkout's database owner: the tsx launcher
 * (`scripts/runTsx.mjs`), `tsconfig.exec.json` and `sources/storage/prismaClientConstruction.ts`, whose
 * `createDbMaintenanceClient(provider, databaseUrl)` returns `createClientSource`'s client.
 * The server process is a boundary of stack tooling; its real owner is covered by the
 * auth copy-from integration tests against this repository's server.
 */
export async function writeFakeServerDatabaseOwner({ serverDir, createClientSource }) {
  await mkdir(join(serverDir, 'scripts'), { recursive: true });
  await mkdir(join(serverDir, 'sources', 'storage'), { recursive: true });
  await writeFile(join(serverDir, 'tsconfig.exec.json'), '{}\n', 'utf-8');
  await writeFile(
    join(serverDir, 'scripts', 'runTsx.mjs'),
    [
      "import { pathToFileURL } from 'node:url';",
      'const args = process.argv.slice(2);',
      "const at = args.indexOf('--tsconfig');",
      'if (at >= 0) args.splice(at, 2);',
      'await import(pathToFileURL(args[0]).href);',
      '',
    ].join('\n'),
    'utf-8',
  );
  await writeFile(
    join(serverDir, 'sources', 'storage', 'prismaClientConstruction.ts'),
    `export async function createDbMaintenanceClient(provider, databaseUrl) {\n${createClientSource}\n}\n`,
    'utf-8',
  );
}

const SCRIPT_OUTPUT_MARKER = '@@server-database-script-output@@';

/**
 * Runs `code` (with `db` bound to a client from the real server checkout's
 * `createDbMaintenanceClient`) through the server's own tsx launcher. Returns the
 * exit code and what `code` printed with console.log (server logging excluded).
 */
export async function runServerOwnerDatabaseScript({ serverDir, provider, databaseUrl, code, env = process.env }) {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { pathToFileURL } = await import('node:url');
  const { runNodeCapture } = await import('./run_node_capture.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'stack-server-owner-script-'));
  const scriptPath = join(dir, 'script.mjs');
  try {
    await writeFile(scriptPath, `
const { createDbMaintenanceClient } = await import(${JSON.stringify(pathToFileURL(join(serverDir, 'sources', 'storage', 'prismaClientConstruction.ts')).href)});
const db = await createDbMaintenanceClient(${JSON.stringify(provider)}, ${JSON.stringify(databaseUrl)});
const printed = [];
console.log = (...args) => { printed.push(args.join(' ')); };
try {
${code}
} finally {
  await db.$disconnect();
}
process.stdout.write('\\n${SCRIPT_OUTPUT_MARKER}' + JSON.stringify(printed.join('\\n')) + '\\n');
process.exit(0);
`, 'utf-8');
    const result = await runNodeCapture([join(serverDir, 'scripts', 'runTsx.mjs'), '--tsconfig', './tsconfig.exec.json', scriptPath],
      { cwd: serverDir, env });
    const line = result.stdout.split(/\r?\n/).find(entry => entry.startsWith(SCRIPT_OUTPUT_MARKER));
    return { ...result, stdout: line ? JSON.parse(line.slice(SCRIPT_OUTPUT_MARKER.length)) : '', rawStdout: result.stdout };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
