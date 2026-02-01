import { runCapture } from '../proc/proc.mjs';
import { ensureDepsInstalled, pmExecBin } from '../proc/pm.mjs';
import { isSandboxed, sandboxAllowsGlobalSideEffects } from '../env/sandbox.mjs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { resolvePrismaClientImportForServerComponent, resolveServerLightPrismaMigrateDeployArgs, resolveServerLightPrismaSchemaArgs } from '../server/flavor_scripts.mjs';

function looksLikeMissingTableError(msg) {
  const s = String(msg ?? '').toLowerCase();
  return s.includes('does not exist') || s.includes('no such table');
}

function looksLikeAlreadyExistsError(msg) {
  const s = String(msg ?? '').toLowerCase();
  return s.includes('already exists') || s.includes('duplicate') || s.includes('constraint failed');
}

function looksLikeDatabaseLockedError(msg) {
  const s = String(msg ?? '').toLowerCase();
  return s.includes('database is locked') || s.includes('sqlite database error');
}

function looksLikeMissingGeneratedSqliteClientError(err) {
  const code = err && typeof err === 'object' ? err.code : '';
  if (code !== 'ERR_MODULE_NOT_FOUND') return false;
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return msg.includes('/generated/sqlite-client/') || msg.includes('\\generated\\sqlite-client\\');
}

async function findSqliteBaselineMigrationDir({ serverDir }) {
  try {
    // Unified monorepo server-light migrations live under prisma/sqlite/migrations.
    // For legacy schema.sqlite.prisma setups, migrations use the default prisma/migrations folder.
    const migrationsDir = existsSync(join(serverDir, 'prisma', 'sqlite', 'schema.prisma'))
      ? join(serverDir, 'prisma', 'sqlite', 'migrations')
      : join(serverDir, 'prisma', 'migrations');
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(migrationsDir, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    return dirs[0] || null;
  } catch {
    return null;
  }
}

async function probeAccountCount({ serverComponentName, serverDir, env }) {
  const clientImport = resolvePrismaClientImportForServerComponent({ serverComponentName, serverDir });
  const probe = `
	let db;
	try {
	  const { PrismaClient } = await import(${JSON.stringify(clientImport)});
	  db = new PrismaClient();
	  const accountCount = await db.account.count();
	  console.log(JSON.stringify({ accountCount }));
	} catch (e) {
	  console.log(
	    JSON.stringify({
	      error: {
	        name: e?.name,
	        message: e?.message,
	        code: e?.code,
	      },
	    })
	  );
	} finally {
	  try {
	    await db?.$disconnect();
	  } catch {
	    // ignore
	  }
	}
	`.trim();

  const out = await runCapture(process.execPath, ['--input-type=module', '-e', probe], { cwd: serverDir, env, timeoutMs: 15_000 });
  const parsed = out.trim() ? JSON.parse(out.trim()) : {};
  if (parsed?.error) {
    const e = new Error(parsed.error.message || 'unknown prisma probe error');
    if (typeof parsed.error.name === 'string' && parsed.error.name) e.name = parsed.error.name;
    if (typeof parsed.error.code === 'string' && parsed.error.code) e.code = parsed.error.code;
    throw e;
  }
  return Number(parsed.accountCount ?? 0);
}

export function resolveAutoCopyFromMainEnabled({ env, stackName, isInteractive }) {
  // Sandboxes should be isolated by default.
  // Auto auth seeding can copy credentials/account rows from another stack (global state),
  // which breaks isolation and can confuse guided auth flows (setup-pr/review-pr).
  if (isSandboxed() && !sandboxAllowsGlobalSideEffects()) {
    return false;
  }
  const raw = (env.HAPPIER_STACK_AUTO_AUTH_SEED ?? '').toString().trim();
  if (raw) return raw !== '0';

  if (stackName === 'main') return false;

  // Default:
  // - always auto-seed in non-interactive contexts (agents/services)
  // - in interactive shells, auto-seed only when the user explicitly configured a non-main seed stack
  //   (this avoids silently spreading main identity for users who haven't opted in yet).
  if (!isInteractive) return true;
  const seed = (env.HAPPIER_STACK_AUTH_SEED_FROM ?? '').toString().trim();
  return Boolean(seed && seed !== 'main');
}

export function resolveAuthSeedFromEnv(env) {
  const seed = (env.HAPPIER_STACK_AUTH_SEED_FROM ?? '').toString().trim();
  return seed || 'main';
}

export async function ensureServerLightSchemaReady({ serverDir, env, bestEffort = false }) {
  await ensureDepsInstalled(serverDir, 'happy-server-light', { env });

  const dataDir = (env?.HAPPY_SERVER_LIGHT_DATA_DIR ?? '').toString().trim();
  const filesDir = (env?.HAPPY_SERVER_LIGHT_FILES_DIR ?? '').toString().trim() || (dataDir ? join(dataDir, 'files') : '');
  if (dataDir) {
    try {
      await mkdir(dataDir, { recursive: true });
    } catch {
      // best-effort
    }
  }
  if (filesDir) {
    try {
      await mkdir(filesDir, { recursive: true });
    } catch {
      // best-effort
    }
  }

  const probe = async () => await probeAccountCount({ serverComponentName: 'happy-server-light', serverDir, env });
  const schemaArgs = resolveServerLightPrismaSchemaArgs({ serverDir });

  const isUnified = schemaArgs.length > 0;

  // Unified server-light (monorepo): ensure deterministic migrations are applied (idempotent).
  // Legacy server-light (single schema.prisma with db push): do NOT run `prisma migrate deploy`,
  // because it commonly fails with P3005 when the DB was created by `prisma db push` and no migrations exist.
  //
  // IMPORTANT:
  // In dev/start flows the server process may already be running and holding the SQLite DB open.
  // Running `prisma migrate deploy` concurrently will fail with "database is locked".
  // When bestEffort=true (used for auth seeding heuristics), skip migrations and only probe.
  if (isUnified && !bestEffort) {
    try {
      await pmExecBin({ dir: serverDir, bin: 'prisma', args: resolveServerLightPrismaMigrateDeployArgs({ serverDir }), env });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (looksLikeDatabaseLockedError(msg) && bestEffort) {
        return { ok: false, migrated: true, accountCount: null, error: msg };
      }
      // If the SQLite DB was created before migrations existed (historical db push era),
      // `migrate deploy` can fail because tables already exist. Best-effort: baseline-resolve
      // the first migration, then retry deploy.
      if (looksLikeAlreadyExistsError(msg)) {
        const baseline = await findSqliteBaselineMigrationDir({ serverDir });
        if (baseline) {
          await pmExecBin({
            dir: serverDir,
            bin: 'prisma',
            args: ['migrate', 'resolve', ...schemaArgs, '--applied', baseline],
            env,
          }).catch(() => {});
          await pmExecBin({ dir: serverDir, bin: 'prisma', args: resolveServerLightPrismaMigrateDeployArgs({ serverDir }), env });
        } else {
          throw e;
        }
      } else {
        throw e;
      }
    }
  }

  // 2) Probe account count (used for auth seeding heuristics).
  try {
    const accountCount = await probe();
    return { ok: true, migrated: isUnified, accountCount };
  } catch (e) {
    if (looksLikeMissingGeneratedSqliteClientError(e)) {
      await pmExecBin({ dir: serverDir, bin: 'prisma', args: ['generate', ...schemaArgs], env });
      try {
        const accountCount = await probe();
        return { ok: true, migrated: isUnified, accountCount };
      } catch (e2) {
        const msg = e2 instanceof Error ? e2.message : String(e2);
        if (bestEffort && looksLikeDatabaseLockedError(msg)) {
          return { ok: false, migrated: isUnified, accountCount: null, error: msg };
        }
        throw e2;
      }
    }
    const msg = e instanceof Error ? e.message : String(e);
    if (bestEffort && looksLikeDatabaseLockedError(msg)) {
      return { ok: false, migrated: isUnified, accountCount: null, error: msg };
    }
    if (looksLikeMissingTableError(msg)) {
      if (isUnified) {
        // Tables still missing after migrate deploy (or probe without migrations); fail closed unless best-effort.
        if (bestEffort) {
          return { ok: false, migrated: true, accountCount: null, error: 'sqlite schema not ready (missing tables)' };
        }
        throw new Error(`[server-light] sqlite schema not ready after prisma migrate deploy (missing tables).`);
      }
      // Legacy server-light: schema is typically applied via `prisma db push` in the component's dev/start scripts.
      // Best-effort: don't fail the whole stack startup just because we can't probe here.
      return { ok: true, migrated: false, accountCount: 0 };
    }
    if (!isUnified) {
      // Legacy server-light: probing is best-effort (don't make stack dev fail closed here).
      return { ok: true, migrated: false, accountCount: 0 };
    }
    if (bestEffort) {
      return { ok: false, migrated: true, accountCount: null, error: msg };
    }
    throw e;
  }
}

export async function ensureHappyServerSchemaReady({ serverDir, env }) {
  await ensureDepsInstalled(serverDir, 'happy-server', { env });

  try {
    const accountCount = await probeAccountCount({ serverComponentName: 'happy-server', serverDir, env });
    return { ok: true, migrated: false, accountCount };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!looksLikeMissingTableError(msg)) {
      throw e;
    }
    // If tables are missing, try migrations (safe for postgres). Then re-probe.
    await pmExecBin({ dir: serverDir, bin: 'prisma', args: ['migrate', 'deploy'], env });
    const accountCount = await probeAccountCount({ serverComponentName: 'happy-server', serverDir, env });
    return { ok: true, migrated: true, accountCount };
  }
}

export async function getAccountCountForServerComponent({ serverComponentName, serverDir, env, bestEffort = false }) {
  if (serverComponentName === 'happy-server-light') {
    try {
      const ready = await ensureServerLightSchemaReady({ serverDir, env, bestEffort });
      if (!ready?.ok) {
        return { ok: false, accountCount: null, error: String(ready?.error ?? 'server-light schema probe failed') };
      }
      return { ok: true, accountCount: Number.isFinite(ready.accountCount) ? ready.accountCount : 0 };
    } catch (e) {
      if (!bestEffort) throw e;
      return { ok: false, accountCount: null, error: e instanceof Error ? e.message : String(e) };
    }
  }
  if (serverComponentName === 'happy-server') {
    try {
      const ready = await ensureHappyServerSchemaReady({ serverDir, env });
      return { ok: true, accountCount: Number.isFinite(ready.accountCount) ? ready.accountCount : 0 };
    } catch (e) {
      if (!bestEffort) throw e;
      return { ok: false, accountCount: null, error: e instanceof Error ? e.message : String(e) };
    }
  }
  return { ok: false, accountCount: null, error: `unknown server component: ${serverComponentName}` };
}

export async function maybeAutoCopyAuthFromMainIfNeeded({
  rootDir,
  env,
  enabled,
  stackName,
  cliHomeDir,
  accountCount,
  quiet = false,
  authEnv = null,
}) {
  const accessKeyPath = join(cliHomeDir, 'access.key');
  const hasAccessKey = existsSync(accessKeyPath);

  // "Initialized" heuristic:
  // - if we have credentials AND (when known) at least one Account row, we don't need to seed from main.
  const hasAccounts = typeof accountCount === 'number' ? accountCount > 0 : null;
  const needsSeed = !hasAccessKey || hasAccounts === false;

  if (!enabled || !needsSeed) {
    return { ok: true, skipped: true, reason: !enabled ? 'disabled' : 'already_initialized' };
  }

  const reason = !hasAccessKey ? 'missing_credentials' : 'no_accounts';
  const fromStackName = resolveAuthSeedFromEnv(env);
  const linkAuth =
    (env.HAPPIER_STACK_AUTH_LINK ?? '').toString().trim() === '1' ||
    (env.HAPPIER_STACK_AUTH_MODE ?? '').toString().trim() === 'link';
  if (!quiet) {
    console.log(`[local] auth: auto seed from ${fromStackName} for ${stackName} (${reason})`);
  }

  // Best-effort: copy credentials/master secret + seed accounts from the configured seed stack.
  // Keep this non-fatal; the daemon will emit actionable errors if it still can't authenticate.
  try {
    const out = await runCapture(
      process.execPath,
      [`${rootDir}/scripts/auth.mjs`, 'copy-from', fromStackName, '--json', ...(linkAuth ? ['--link'] : [])],
      {
      cwd: rootDir,
      env: authEnv && typeof authEnv === 'object' ? authEnv : env,
      }
    );
    return { ok: true, skipped: false, reason, out: out.trim() ? JSON.parse(out) : null };
  } catch (e) {
    return { ok: false, skipped: false, reason, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function prepareDaemonAuthSeedIfNeeded({
  rootDir,
  env,
  stackName,
  cliHomeDir,
  startDaemon,
  isInteractive,
  accountCount,
  quiet = false,
  authEnv = null,
}) {
  if (!startDaemon) return { ok: true, skipped: true, reason: 'no_daemon' };
  const enabled = resolveAutoCopyFromMainEnabled({ env, stackName, isInteractive });
  return await maybeAutoCopyAuthFromMainIfNeeded({
    rootDir,
    env,
    enabled,
    stackName,
    cliHomeDir,
    accountCount,
    quiet,
    authEnv,
  });
}
