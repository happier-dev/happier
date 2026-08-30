import { run, runCapture } from '../proc/proc.mjs';
import { ensureDepsInstalled, ensureWorkspacePackagesBuiltForComponent } from '../proc/pm.mjs';
import { isSandboxed, sandboxAllowsGlobalSideEffects } from '../env/sandbox.mjs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { resolvePrismaClientImportForDbProvider } from '../server/prisma_client_import.mjs';
import { findAnyCredentialPathInCliHome } from '../auth/credentials_paths.mjs';
import { applyEffectiveDbProviderEnv } from '../server/effective_db_provider.mjs';
import { applyServerMigrations } from '../server/server_migrations.mjs';
import {
  renderPrismaCompatibleSqliteDatabaseUrl,
  resolveServerLightSqliteDatabaseUrlOptionsFromEnv,
} from '@happier-dev/cli-common/firstPartyRuntime';

function looksLikeMissingTableError(msg) {
  const s = String(msg ?? '').toLowerCase();
  return s.includes('does not exist') || s.includes('no such table');
}

function firstNonEmptyEnv(...values) {
  for (const value of values) {
    const normalized = String(value ?? '').trim();
    if (normalized) return normalized;
  }
  return '';
}

async function probeAccountCount({ serverDir, env, dbProvider = 'sqlite' }) {
  const runEnv = dbProvider === 'sqlite'
    ? resolveSqliteDatabaseUrlEnvForProbe(env)
    : env;
  const probe =
    dbProvider === 'pglite'
      ? `
		let db;
	  let pglite;
	  let server;
		try {
	    const { PGlite } = await import('@electric-sql/pglite');
	    const { PGLiteSocketServer } = await import('@electric-sql/pglite-socket');
	    const { PrismaClient } = await import('@prisma/client');
	    const dbDirPrimary = (process.env.HAPPIER_SERVER_LIGHT_DB_DIR ?? '').toString().trim();
	    const dbDirLegacy = (process.env.HAPPY_SERVER_LIGHT_DB_DIR ?? '').toString().trim();
	    const dbDir = dbDirPrimary || dbDirLegacy;
	    if (!dbDir) throw new Error('Missing HAPPIER_SERVER_LIGHT_DB_DIR or HAPPY_SERVER_LIGHT_DB_DIR for pglite probe');
	    pglite = new PGlite(dbDir);
	    await pglite.waitReady;
	    server = new PGLiteSocketServer({ db: pglite, host: '127.0.0.1', port: 0 });
	    await server.start();
	    const raw = server.getServerConn();
	    const url = (() => {
	      try {
	        return new URL(raw);
	      } catch {
	        return new URL(\`postgresql://postgres@\${raw}/postgres?sslmode=disable\`);
	      }
	    })();
	    url.searchParams.set('connection_limit', '1');
	    process.env.DATABASE_URL = url.toString();
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
	    try {
	      await server?.stop();
	    } catch {}
	    try {
	      await pglite?.close();
	    } catch {}
		}
		`.trim()
      : dbProvider === 'sqlite'
      ? `
	 	let db;
		try {
		  const { PrismaClient } = await import(${JSON.stringify(
        resolvePrismaClientImportForDbProvider({ serverDir, provider: 'sqlite' })
      )});
      const dataDirPrimary = (process.env.HAPPIER_SERVER_LIGHT_DATA_DIR ?? '').toString().trim();
      const dataDirLegacy = (process.env.HAPPY_SERVER_LIGHT_DATA_DIR ?? '').toString().trim();
      const dataDir = dataDirPrimary || dataDirLegacy;
      const url = (process.env.DATABASE_URL ?? '').toString().trim();
      if (!url) throw new Error('Missing DATABASE_URL and HAPPIER_SERVER_LIGHT_DATA_DIR or HAPPY_SERVER_LIGHT_DATA_DIR for sqlite probe');
      process.env.DATABASE_URL = url;
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
		`.trim()
      : `
	 	let db;
		try {
		  const { PrismaClient } = await import(${JSON.stringify(
	      resolvePrismaClientImportForDbProvider({ serverDir, provider: dbProvider })
	    )});
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

  const out = await runCapture(process.execPath, ['--input-type=module', '-e', probe], { cwd: serverDir, env: runEnv, timeoutMs: 15_000 });
  const parsed = out.trim() ? JSON.parse(out.trim()) : {};
  if (parsed?.error) {
    const e = new Error(parsed.error.message || 'unknown prisma probe error');
    if (typeof parsed.error.name === 'string' && parsed.error.name) e.name = parsed.error.name;
    if (typeof parsed.error.code === 'string' && parsed.error.code) e.code = parsed.error.code;
    throw e;
  }
  return Number(parsed.accountCount ?? 0);
}

function resolveSqliteDatabaseUrlEnvForProbe(env) {
  if ((env?.DATABASE_URL ?? '').toString().trim()) {
    return env;
  }
  const dataDir = firstNonEmptyEnv(env?.HAPPIER_SERVER_LIGHT_DATA_DIR, env?.HAPPY_SERVER_LIGHT_DATA_DIR);
  if (!dataDir) {
    return env;
  }
  return {
    ...env,
    DATABASE_URL: renderPrismaCompatibleSqliteDatabaseUrl({
      dbPath: join(dataDir, 'happier-server-light.sqlite'),
      platform: process.platform,
      sqlite: resolveServerLightSqliteDatabaseUrlOptionsFromEnv(env),
    }),
  };
}

export async function probeExistingAccountCountForServerComponent({
  serverComponentName,
  serverDir,
  env,
}) {
  try {
    const dbProvider = applyEffectiveDbProviderEnv({
      serverComponentName,
      env,
      targetEnv: { ...env },
    });
    const accountCount = await probeAccountCount({
      serverDir,
      env,
      dbProvider,
    });
    return { ok: true, accountCount };
  } catch (e) {
    return { ok: false, accountCount: null, error: e instanceof Error ? e.message : String(e) };
  }
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

export async function ensureServerSchemaReady({ serverComponentName, serverDir, env, bestEffort = false }) {
  const dbProvider = applyEffectiveDbProviderEnv({
    serverComponentName,
    env,
    targetEnv: { ...env },
  });
  await ensureWorkspacePackagesBuiltForComponent(serverDir, { env });
  await ensureDepsInstalled(serverDir, serverComponentName, { env });

  const dataDir = firstNonEmptyEnv(env?.HAPPIER_SERVER_LIGHT_DATA_DIR, env?.HAPPY_SERVER_LIGHT_DATA_DIR);
  const filesDir = firstNonEmptyEnv(env?.HAPPIER_SERVER_LIGHT_FILES_DIR, dataDir ? join(dataDir, 'files') : '');
  const dbDir = firstNonEmptyEnv(env?.HAPPIER_SERVER_LIGHT_DB_DIR, env?.HAPPY_SERVER_LIGHT_DB_DIR, dataDir ? join(dataDir, 'pglite') : '');
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
  if (dbDir) {
    try {
      await mkdir(dbDir, { recursive: true });
      env.HAPPIER_SERVER_LIGHT_DB_DIR = env.HAPPIER_SERVER_LIGHT_DB_DIR ?? dbDir;
      env.HAPPY_SERVER_LIGHT_DB_DIR = env.HAPPY_SERVER_LIGHT_DB_DIR ?? dbDir;
    } catch {
      // best-effort
    }
  }

  const runEnv = { ...env };
  if (
    dbProvider === 'sqlite' &&
    dataDir &&
    !(runEnv.DATABASE_URL ?? '').toString().trim()
  ) {
    runEnv.DATABASE_URL = renderPrismaCompatibleSqliteDatabaseUrl({
      dbPath: join(dataDir, 'happier-server-light.sqlite'),
      platform: process.platform,
      sqlite: resolveServerLightSqliteDatabaseUrlOptionsFromEnv(runEnv),
    });
  }

  // A running PGlite server may hold the single-process database lock. Heuristic probes use
  // bestEffort and intentionally do not migrate; startup paths migrate every provider first.
  if (!bestEffort) {
    await applyServerMigrations({ serverDir, env: runEnv, dbProvider });
  }

  try {
    const accountCount = await probeAccountCount({ serverDir, env: runEnv, dbProvider });
    return { ok: true, migrated: !bestEffort, accountCount };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (looksLikeMissingTableError(msg)) {
      if (bestEffort) {
        return { ok: false, migrated: false, accountCount: null, error: 'server schema not ready (missing tables)' };
      }
      throw new Error(`[server] schema not ready after ${dbProvider} migrations (missing tables).`);
    }
    if (bestEffort) {
      return { ok: false, migrated: false, accountCount: null, error: msg };
    }
    throw e;
  }
}

export async function getAccountCountForServerComponent({ serverComponentName, serverDir, env, bestEffort = false }) {
  if (serverComponentName !== 'happier-server-light' && serverComponentName !== 'happier-server') {
    return { ok: false, accountCount: null, error: `unknown server component: ${serverComponentName}` };
  }
  try {
    const ready = await ensureServerSchemaReady({ serverComponentName, serverDir, env, bestEffort });
    if (!ready?.ok) {
      return { ok: false, accountCount: null, error: String(ready?.error ?? 'server schema probe failed') };
    }
    return { ok: true, accountCount: Number.isFinite(ready.accountCount) ? ready.accountCount : 0 };
  } catch (e) {
    if (!bestEffort) throw e;
    return { ok: false, accountCount: null, error: e instanceof Error ? e.message : String(e) };
  }
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
  const hasAccessKey = Boolean(findAnyCredentialPathInCliHome({ cliHomeDir }));

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
