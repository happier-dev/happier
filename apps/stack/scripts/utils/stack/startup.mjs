import { run, runCapture } from '../proc/proc.mjs';
import { ensureDepsInstalled, pmExecBin } from '../proc/pm.mjs';
import { isSandboxed, sandboxAllowsGlobalSideEffects } from '../env/sandbox.mjs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { resolvePrismaClientImportForServerComponent } from '../server/flavor_scripts.mjs';

function looksLikeMissingTableError(msg) {
  const s = String(msg ?? '').toLowerCase();
  return s.includes('does not exist') || s.includes('no such table');
}

async function probeAccountCount({ serverComponentName, serverDir, env }) {
  const probe =
    serverComponentName === 'happier-server-light'
      ? `
		let db;
	  let pglite;
	  let server;
		try {
	    const { PGlite } = await import('@electric-sql/pglite');
	    const { PGLiteSocketServer } = await import('@electric-sql/pglite-socket');
	    const { PrismaClient } = await import('@prisma/client');
	    const dbDir = (process.env.HAPPY_SERVER_LIGHT_DB_DIR ?? process.env.HAPPIER_SERVER_LIGHT_DB_DIR ?? '').toString().trim();
	    if (!dbDir) throw new Error('Missing HAPPY_SERVER_LIGHT_DB_DIR/HAPPIER_SERVER_LIGHT_DB_DIR for pglite probe');
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
      : `
	 	let db;
		try {
		  const { PrismaClient } = await import(${JSON.stringify(
	      resolvePrismaClientImportForServerComponent({ serverComponentName, serverDir })
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
  await ensureDepsInstalled(serverDir, 'happier-server-light', { env });

  const dataDir = (env?.HAPPIER_SERVER_LIGHT_DATA_DIR ?? '').toString().trim();
  const filesDir = (env?.HAPPIER_SERVER_LIGHT_FILES_DIR ?? '').toString().trim() || (dataDir ? join(dataDir, 'files') : '');
  const dbDir =
    (env?.HAPPIER_SERVER_LIGHT_DB_DIR ?? env?.HAPPY_SERVER_LIGHT_DB_DIR ?? '').toString().trim() ||
    (dataDir ? join(dataDir, 'pglite') : '');
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

  const probe = async () => await probeAccountCount({ serverComponentName: 'happier-server-light', serverDir, env });
  // Current light flavor uses embedded Postgres via PGlite.
  // Apply migrations via the server package script (it spins a temporary pglite socket and runs prisma migrate deploy).
  //
  // IMPORTANT:
  // If the server is already running, it may hold the pglite DB open (single-connection).
  // When bestEffort=true (used for heuristics), skip migrations and only probe.
  if (!bestEffort) {
    await run('yarn', ['-s', 'migrate:light:deploy'], { cwd: serverDir, env });
  }

  // 2) Probe account count (used for auth seeding heuristics).
  try {
    const accountCount = await probe();
    return { ok: true, migrated: true, accountCount };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (looksLikeMissingTableError(msg)) {
      if (bestEffort) {
        return { ok: false, migrated: true, accountCount: null, error: 'server-light schema not ready (missing tables)' };
      }
      throw new Error(`[server-light] schema not ready after migrate:light:deploy (missing tables).`);
    }
    if (bestEffort) {
      return { ok: false, migrated: true, accountCount: null, error: msg };
    }
    throw e;
  }
}

export async function ensureHappyServerSchemaReady({ serverDir, env }) {
  await ensureDepsInstalled(serverDir, 'happier-server', { env });

  try {
    const accountCount = await probeAccountCount({ serverComponentName: 'happier-server', serverDir, env });
    return { ok: true, migrated: false, accountCount };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!looksLikeMissingTableError(msg)) {
      throw e;
    }
    // If tables are missing, try migrations (safe for postgres). Then re-probe.
    await pmExecBin({ dir: serverDir, bin: 'prisma', args: ['migrate', 'deploy'], env });
    const accountCount = await probeAccountCount({ serverComponentName: 'happier-server', serverDir, env });
    return { ok: true, migrated: true, accountCount };
  }
}

export async function getAccountCountForServerComponent({ serverComponentName, serverDir, env, bestEffort = false }) {
  if (serverComponentName === 'happier-server-light') {
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
  if (serverComponentName === 'happier-server') {
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
