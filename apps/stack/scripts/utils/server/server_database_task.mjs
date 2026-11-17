import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runCaptureResult } from '../proc/proc.mjs';
import { resolvePrismaClientImportForDbProvider } from './prisma_client_import.mjs';

const CHILD_ENTRY = fileURLToPath(new URL('./server_database_task_child.mjs', import.meta.url));
const RESULT_KEY = 'happierServerDatabaseTask';
const SERVER_DATABASE_OWNER_FILES = ['scripts/runTsx.mjs', 'tsconfig.exec.json', 'sources/storage/prismaClientConstruction.ts'];

function normalizeProvider(provider) {
  const normalized = String(provider ?? '').trim().toLowerCase();
  return normalized === 'postgresql' ? 'postgres' : normalized;
}

function readPrismaClientMajor(serverDir) {
  try {
    const requireFromServer = createRequire(join(serverDir, 'package.json'));
    const { version } = requireFromServer(requireFromServer.resolve('@prisma/client/package.json'));
    const major = Number.parseInt(String(version ?? ''), 10);
    return Number.isFinite(major) ? major : null;
  } catch {
    return null;
  }
}

/**
 * Decides how stack tooling opens a server directory's database. A server source
 * checkout is opened only through its own client owner (`createDbMaintenanceClient`
 * in `sources/storage/prismaClientConstruction.ts`, run with the server's tsx launcher), which picks
 * the Prisma 7 driver adapter.
 */
export function resolveServerDatabaseAccess({ serverDir, provider }) {
  if (SERVER_DATABASE_OWNER_FILES.every(path => existsSync(join(serverDir, path)))) return { kind: 'owner' };
  // LEGACY(Prisma 6): a stack may point at an older server checkout (HAPPIER_STACK_REPO_DIR,
  // `hstack wt use`), e.g. the 0.2 line, which predates the owner launcher above. Every
  // Prisma 7 checkout has it, so only a Prisma <7 client may construct itself from
  // DATABASE_URL. Remove when hstack stops operating stacks on pre-Prisma-7 server checkouts.
  const major = readPrismaClientMajor(serverDir);
  if (major !== null && major < 7) {
    return { kind: 'legacy-prisma6', clientImport: resolvePrismaClientImportForDbProvider({ serverDir, provider }) };
  }
  throw Object.assign(new Error(
    `[server-db] ${serverDir} is not a server source checkout (missing ${SERVER_DATABASE_OWNER_FILES.join(', ')}) `
    + `and its Prisma client (${major ?? 'unresolved'}) needs the server's driver adapter; open this database through a server source checkout.`,
  ), { code: 'ESERVERDBOWNERUNAVAILABLE' });
}

function parseTaskOutput(out) {
  const lines = String(out ?? '').split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object' && RESULT_KEY in parsed) return parsed[RESULT_KEY];
    } catch {
      // Server logging can share stdout; only the marked line is the result.
    }
  }
  return null;
}

/**
 * Runs one database task in a child process against a server's database:
 * `account-count`, `list-accounts`, `insert-accounts` ({ accounts }), `migration-ledger`
 * (each with `databaseUrl`, or `pgliteDbDir` [+ `pgliteLockPurpose`] for pglite), and
 * `copy-light-to-server` ({ source, target, force }, each side a database spec with its
 * own `provider`). Rejects with the task's error.
 */
export async function runServerDatabaseTask({ serverDir, provider: rawProvider, task, env = process.env, timeoutMs, streamLabel, ...input }) {
  const provider = normalizeProvider(rawProvider);
  const access = resolveServerDatabaseAccess({ serverDir, provider });
  const args = access.kind === 'owner'
    ? [join(serverDir, 'scripts', 'runTsx.mjs'), '--tsconfig', './tsconfig.exec.json', CHILD_ENTRY]
    : [CHILD_ENTRY];
  const res = await runCaptureResult(process.execPath, args, {
    cwd: serverDir,
    env,
    input: JSON.stringify({ ...input, task, provider, access }),
    timeoutMs,
    ...(streamLabel ? { streamLabel, stdoutDiagnosticStream: process.stderr } : {}),
  });
  const parsed = parseTaskOutput(res.out);
  if (parsed?.ok === true) return parsed.result;
  const error = new Error(parsed?.error?.message
    || (res.timedOut ? `server database task ${task} timed out after ${timeoutMs}ms` : `server database task ${task} failed${res.err?.trim() ? `: ${res.err.trim()}` : ''}`));
  if (typeof parsed?.error?.name === 'string' && parsed.error.name) error.name = parsed.error.name;
  if (typeof parsed?.error?.code === 'string' && parsed.error.code) error.code = parsed.error.code;
  throw error;
}
