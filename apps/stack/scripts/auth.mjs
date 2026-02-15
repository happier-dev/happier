import './utils/env/env.mjs';
import { parseArgs } from './utils/cli/args.mjs';
import { printResult, wantsHelp, wantsJson } from './utils/cli/cli.mjs';
import { getComponentDir, getDefaultAutostartPaths, getRootDir, getStackName, resolveStackEnvPath } from './utils/paths/paths.mjs';
import { listAllStackNames } from './utils/stack/stacks.mjs';
import { resolvePublicServerUrl } from './tailscale.mjs';
import { getInternalServerUrl, getPublicServerUrlEnvOverride, getWebappUrlEnvOverride } from './utils/server/urls.mjs';
import { fetchHappierHealth, waitForHappierHealthOk } from './utils/server/server.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { parseEnvToObject } from './utils/env/dotenv.mjs';
import { run, runCapture } from './utils/proc/proc.mjs';
import { applyStackCacheEnv, ensureDepsInstalled } from './utils/proc/pm.mjs';
import { applyHappyServerMigrations, ensureHappyServerManagedInfra } from './utils/server/infra/happy_server_infra.mjs';
import { resolvePrismaClientImportForDbProvider, resolvePrismaClientImportForServerComponent } from './utils/server/flavor_scripts.mjs';
import { clearDevAuthKey, readDevAuthKey, writeDevAuthKey } from './utils/auth/dev_key.mjs';
import { getExpoStatePaths, isStateProcessRunning } from './utils/expo/expo.mjs';
import { resolveAuthSeedFromEnv } from './utils/stack/startup.mjs';
import { copyFileIfMissing, linkFileIfMissing, removeFileOrSymlinkIfExists, writeSecretFileIfMissing } from './utils/auth/files.mjs';
import { resolveHandyMasterSecretFromStack } from './utils/auth/handy_master_secret.mjs';
import { ensureDir, readTextIfExists } from './utils/fs/ops.mjs';
import { stackExistsSync } from './utils/stack/stacks.mjs';
import { checkDaemonState } from './daemon.mjs';
import { isTty, prompt, withRl } from './utils/cli/wizard.mjs';
import { parseCliIdentityOrThrow, resolveCliHomeDirForIdentity } from './utils/stack/cli_identities.mjs';
import {
  getCliHomeDirFromEnvOrDefault,
  getServerLightDataDirFromEnvOrDefault,
  resolveCliHomeDir,
} from './utils/stack/dirs.mjs';
import { resolveLocalhostHost, preferStackLocalhostUrl } from './utils/paths/localhost_host.mjs';
import { banner, bullets, cmd as cmdFmt, kv, ok, sectionTitle, warn } from './utils/ui/layout.mjs';
import { bold, cyan, dim } from './utils/ui/ansi.mjs';
import { getVerbosityLevel } from './utils/cli/verbosity.mjs';
import { runOrchestratedGuidedAuthFlow, startDaemonPostAuth } from './utils/auth/orchestrated_stack_auth_flow.mjs';
import { applyStackActiveServerScopeEnv } from './utils/auth/stable_scope_id.mjs';
import {
  findAnyCredentialPathInCliHome,
  findExistingStackCredentialPath,
  resolveStackCredentialPaths,
} from './utils/auth/credentials_paths.mjs';
import { decodeJwtPayloadUnsafe } from './utils/auth/decode_jwt_payload_unsafe.mjs';
import { fileHasContent } from './utils/fs/file_has_content.mjs';
import { buildConfigureServerLinks } from '@happier-dev/cli-common/links';
import { getStackRuntimeStatePath, isPidAlive as isRuntimePidAlive, readStackRuntimeStateFile } from './utils/stack/runtime_state.mjs';

function resolveGuidedStartAction({ healthOk = false, runtimeOwnerAlive = false, autoStart = false } = {}) {
  if (healthOk) return 'proceed';
  if (runtimeOwnerAlive) return 'wait';
  if (autoStart) return 'start';
  return 'prompt';
}

function getInternalServerUrlCompat() {
  const { port, internalServerUrl } = getInternalServerUrl({ env: process.env, defaultPort: 3005 });
  return { port, url: internalServerUrl };
}

async function resolveWebappUrlFromRunningExpo({ rootDir, stackName }) {
  try {
    const baseDir = resolveStackEnvPath(stackName).baseDir;
    const uiDir = getComponentDir(rootDir, 'happier-ui');
    const uiPaths = getExpoStatePaths({
      baseDir,
      kind: 'expo-dev',
      projectDir: uiDir,
      stateFileName: 'expo.state.json',
    });
    const uiRunning = await isStateProcessRunning(uiPaths.statePath);
    if (!uiRunning.running) return null;
    const port = Number(uiRunning.state?.port);
    if (!Number.isFinite(port) || port <= 0) return null;
    const host = resolveLocalhostHost({ stackMode: stackName !== 'main', stackName });
    return `http://${host}:${port}`;
  } catch {
    return null;
  }
}

// NOTE: common fs helpers live in scripts/utils/fs/ops.mjs

// (auth file copy/link helpers live in scripts/utils/auth/files.mjs)

function readAuthTokenFromCredentialPath(path) {
  const p = String(path ?? '').trim();
  if (!p || !existsSync(p)) return null;
  try {
    const raw = readFileSync(p, 'utf-8').trim();
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed?.token === 'string' && parsed.token.trim()) {
        return parsed.token.trim();
      }
    } catch {
      // fall through
    }
    return raw;
  } catch {
    return null;
  }
}

function resolveJwtSubjectFromCredentialPath(path) {
  const token = readAuthTokenFromCredentialPath(path);
  if (!token) return '';
  const payload = decodeJwtPayloadUnsafe(token);
  const sub = payload && typeof payload.sub === 'string' ? payload.sub.trim() : '';
  return sub || '';
}

async function validateAuthTokenAgainstServer({ credentialPath, internalServerUrl }) {
  const token = readAuthTokenFromCredentialPath(credentialPath);
  if (!token) {
    return {
      checked: false,
      valid: null,
      status: null,
      code: 'missing-token',
      error: null,
    };
  }

  const ctl = new AbortController();
  const timeout = setTimeout(() => ctl.abort(), 2_500);
  try {
    const res = await fetch(`${internalServerUrl}/v1/account/profile`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      signal: ctl.signal,
    });
    const text = await res.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }

    if (res.status >= 200 && res.status < 300) {
      return {
        checked: true,
        valid: true,
        status: res.status,
        code: 'ok',
        error: null,
      };
    }

    if (res.status === 401) {
      return {
        checked: true,
        valid: false,
        status: res.status,
        code: typeof body?.code === 'string' && body.code ? body.code : 'invalid-token',
        error: typeof body?.error === 'string' ? body.error : null,
      };
    }

    return {
      checked: true,
      valid: false,
      status: res.status,
      code: `http-${res.status}`,
      error: typeof body?.error === 'string' ? body.error : null,
    };
  } catch (e) {
    return {
      checked: true,
      valid: null,
      status: null,
      code: 'request-error',
      error: e instanceof Error ? e.message : String(e),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function authLoginSuggestion(stackName) {
  return stackName === 'main' ? 'hstack auth login' : `hstack stack auth ${stackName} login`;
}

function authCopyFromSeedSuggestion(stackName) {
  if (stackName === 'main') return null;
  const from = resolveAuthSeedFromEnv(process.env);
  return `hstack stack auth ${stackName} copy-from ${from}`;
}

function argvKvValue(argv, name) {
  const n = String(name ?? '').trim();
  if (!n) return '';
  for (let i = 0; i < argv.length; i += 1) {
    const a = String(argv[i] ?? '');
    if (a === n) {
      const next = String(argv[i + 1] ?? '');
      if (next && !next.startsWith('--')) return next;
      return '';
    }
    if (a.startsWith(`${n}=`)) {
      return a.slice(`${n}=`.length);
    }
  }
  return '';
}

function resolveGuidedServerReadyTimeoutMs(env = process.env) {
  const raw = String(env.HAPPIER_STACK_AUTH_SERVER_READY_TIMEOUT_MS ?? '').trim();
  if (!raw) return 30_000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1_000 ? n : 30_000;
}

async function isStackRuntimeOwnerAlive(stackName) {
  try {
    const statePath = getStackRuntimeStatePath(stackName);
    const state = await readStackRuntimeStateFile(statePath);
    const ownerPid = Number(state?.ownerPid);
    return Number.isFinite(ownerPid) && ownerPid > 1 && isRuntimePidAlive(ownerPid);
  } catch {
    return false;
  }
}

function resolveServerComponentForCurrentStack() {
  return (
    (process.env.HAPPIER_STACK_SERVER_COMPONENT ?? 'happier-server-light').trim() ||
    'happier-server-light'
  );
}

async function cmdSeed({ argv, json }) {
  const rootDir = getRootDir(import.meta.url);
  const positionals = argv.filter((a) => !a.startsWith('--'));
  const name = (positionals[1] ?? '').trim() || 'dev-auth';

  // Forward to the stack subcommand that implements the full "seed stack" workflow.
  const passthrough = argv.slice(1).filter((a) => a !== name);
  const child = spawn(
    process.execPath,
    [join(rootDir, 'scripts', 'stack.mjs'), 'create-dev-auth-seed', name, ...passthrough],
    { cwd: rootDir, env: process.env, stdio: 'inherit' }
  );
  await new Promise((resolve) => child.on('exit', resolve));

  if (json) {
    printResult({ json, data: { ok: child.exitCode === 0, exitCode: child.exitCode, name } });
  } else if (child.exitCode && child.exitCode !== 0) {
    process.exit(child.exitCode);
  }
}

async function cmdDevKey({ argv, json }) {
  const { flags, kv } = parseArgs(argv);

  // parseArgs currently only supports --k=v, but UX/docs commonly use: --k "value".
  // Support both forms here (without changing global parsing semantics).
  const argvKvValue = (name) => {
    const n = String(name ?? '').trim();
    if (!n) return '';
    for (let i = 0; i < argv.length; i += 1) {
      const a = String(argv[i] ?? '');
      if (a === n) {
        const next = String(argv[i + 1] ?? '');
        if (next && !next.startsWith('--')) return next;
        return '';
      }
      if (a.startsWith(`${n}=`)) {
        return a.slice(`${n}=`.length);
      }
    }
    return '';
  };

  const wantPrint = flags.has('--print');
  const fmtRaw = (argvKvValue('--format') || (kv.get('--format') ?? '')).trim();
  // UX: the Happy UI restore screen expects the "backup" (XXXXX-...) format.
  //
  // IMPORTANT: the Happy restore screen treats any key containing '-' as "backup format",
  // so printing a base64url key (which may contain '-') is *not reliably pasteable*.
  // Default to backup always unless explicitly overridden.
  const fmt = fmtRaw || 'backup'; // base64url | backup
  const set = (argvKvValue('--set') || (kv.get('--set') ?? '')).trim();
  const clear = flags.has('--clear');

  if (set) {
    const res = await writeDevAuthKey({ env: process.env, input: set });
    if (json) {
      printResult({ json, data: { ok: true, action: 'set', path: res.path } });
      return;
    }
    // eslint-disable-next-line no-console
    console.log('');
    // eslint-disable-next-line no-console
    console.log(banner('auth dev-key', { subtitle: 'Saved locally (never committed).' }));
    // eslint-disable-next-line no-console
    console.log(bullets([ok(kv('path:', res.path))]));
    return;
  }
  if (clear) {
    const res = await clearDevAuthKey({ env: process.env });
    if (json) {
      printResult({ json, data: { ok: res.ok, action: 'clear', ...res } });
      return;
    }
    // eslint-disable-next-line no-console
    console.log('');
    // eslint-disable-next-line no-console
    console.log(banner('auth dev-key', { subtitle: 'Local dev key state.' }));
    // eslint-disable-next-line no-console
    console.log(
      bullets([
        res.deleted ? ok(`removed ${dim(`(${res.path})`)}`) : warn(`not set ${dim(`(${res.path})`)}`),
      ])
    );
    return;
  }

  const out = await readDevAuthKey({ env: process.env });
  if (!out.ok) {
    throw new Error(`[auth] dev-key: ${out.error ?? 'failed'}`);
  }
  if (!out.secretKeyBase64Url) {
    if (json) {
      printResult({ json, data: { ok: false, error: 'missing_dev_key', file: out.path ?? null } });
    } else {
      // eslint-disable-next-line no-console
      console.log('');
      // eslint-disable-next-line no-console
      console.log(banner('auth dev-key', { subtitle: 'Not configured.' }));
      // eslint-disable-next-line no-console
      console.log('');
      // eslint-disable-next-line no-console
      console.log(sectionTitle('How to set it'));
      // eslint-disable-next-line no-console
        console.log(
          bullets([
          `${dim('save locally:')} ${cmdFmt('hstack auth dev-key --set "<base64url-secret-or-backup-format>"')}`,
          `${dim('or export for this shell:')} export HAPPIER_STACK_DEV_AUTH_SECRET_KEY="<base64url-secret>"`,
        ])
      );
      if (out.path) {
        // eslint-disable-next-line no-console
        console.log('');
        // eslint-disable-next-line no-console
        console.log(dim(`Path: ${out.path}`));
      }
    }
    process.exit(1);
  }

  const value = fmt === 'backup' ? out.backup : out.secretKeyBase64Url;
  if (wantPrint) {
    process.stdout.write(value + '\n');
    return;
  }
  if (json) {
    printResult({ json, data: { ok: true, key: value, format: fmt, source: out.source ?? null } });
    return;
  }
  // eslint-disable-next-line no-console
  console.log('');
  // eslint-disable-next-line no-console
  console.log(banner('auth dev-key', { subtitle: 'Local dev key (use --print for raw output).' }));
  // eslint-disable-next-line no-console
  console.log(bullets([kv('format:', cyan(fmt)), kv('source:', out.source ?? 'unknown')]));
  // eslint-disable-next-line no-console
  console.log('');
  // eslint-disable-next-line no-console
  console.log(value);
}

async function runNodeCapture({ cwd, env, args, stdin }) {
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += String(d);
    });
    child.stderr.on('data', (d) => {
      stderr += String(d);
    });
    child.on('error', (err) => rejectPromise(err));
    child.on('close', (code) => {
      if (code === 0) {
        resolvePromise({ stdout, stderr });
        return;
      }
      rejectPromise(new Error(`node exited with ${code}${stderr.trim() ? `: ${stderr.trim()}` : ''}`));
    });
    if (stdin != null) {
      child.stdin.write(String(stdin));
    }
    child.stdin.end();
  });
}

function resolveServerComponentFromEnv(env) {
  const v = (env.HAPPIER_STACK_SERVER_COMPONENT ?? 'happier-server-light').trim() || 'happier-server-light';
  return v === 'happier-server' ? 'happier-server' : 'happier-server-light';
}

function resolvePostgresDatabaseUrlFromEnvOrThrow({ env, stackName, label }) {
  const v = (env.DATABASE_URL ?? '').toString().trim();
  if (!v) throw new Error(`[auth] missing DATABASE_URL for ${label || `stack "${stackName}"`}`);
  const lower = v.toLowerCase();
  const ok = lower.startsWith('postgresql://') || lower.startsWith('postgres://');
  if (!ok) {
    throw new Error(
      `[auth] invalid DATABASE_URL for ${label || `stack "${stackName}"`}: expected postgresql://... (got ${JSON.stringify(v)})`
    );
  }
  return v;
}

function resolveDatabaseUrlFromEnvOrThrow({ env, stackName, label, provider }) {
  const v = (env.DATABASE_URL ?? '').toString().trim();
  if (!v) throw new Error(`[auth] missing DATABASE_URL for ${label || `stack "${stackName}"`}`);
  const lower = v.toLowerCase();
  const p = String(provider ?? '').trim().toLowerCase();
  if (p === 'mysql') {
    const ok = lower.startsWith('mysql://') || lower.startsWith('mysqls://') || lower.startsWith('mariadb://');
    if (!ok) {
      throw new Error(
        `[auth] invalid DATABASE_URL for ${label || `stack "${stackName}"`}: expected mysql://... (got ${JSON.stringify(v)})`
      );
    }
    return v;
  }
  // Default: postgres (also covers pglite socket URLs).
  return resolvePostgresDatabaseUrlFromEnvOrThrow({ env, stackName, label });
}

function resolveLightDirsForStack({ env, baseDir }) {
  const dataDir = (env.HAPPIER_SERVER_LIGHT_DATA_DIR ?? env.HAPPY_SERVER_LIGHT_DATA_DIR ?? '').toString().trim() || join(baseDir, 'server-light');
  const filesDir = (env.HAPPIER_SERVER_LIGHT_FILES_DIR ?? env.HAPPY_SERVER_LIGHT_FILES_DIR ?? '').toString().trim() || join(dataDir, 'files');
  const dbDir = (env.HAPPIER_SERVER_LIGHT_DB_DIR ?? env.HAPPY_SERVER_LIGHT_DB_DIR ?? '').toString().trim() || join(dataDir, 'pglite');
  return { dataDir, filesDir, dbDir };
}

function resolveDbProviderForLightFromEnv(env) {
  const raw = (env.HAPPIER_DB_PROVIDER ?? env.HAPPY_DB_PROVIDER ?? '').toString().trim().toLowerCase();
  if (raw === 'sqlite') return 'sqlite';
  if (raw === 'pglite') return 'pglite';
  // Default for light flavor.
  return 'sqlite';
}

function resolveDbProviderForFullFromEnv(env) {
  const raw = (env.HAPPIER_DB_PROVIDER ?? env.HAPPY_DB_PROVIDER ?? '').toString().trim().toLowerCase();
  if (raw === 'mysql') return 'mysql';
  return 'postgres';
}

function resolveSqliteDatabaseUrlForLight({ dataDir }) {
  return `file:${join(dataDir, 'happier-server-light.sqlite')}`;
}

async function ensureLightMigrationsApplied({ serverDir, baseDir, envIn, quiet = false }) {
  // IMPORTANT: envIn is often parsed from a stack env file (so it does not include PATH).
  // Start from the current process env so we can spawn Yarn reliably, then overlay stack-specific vars.
  const env = { ...process.env, ...(envIn && typeof envIn === 'object' ? envIn : {}) };
  const { dataDir, filesDir, dbDir } = resolveLightDirsForStack({ env, baseDir });
  env.HAPPIER_SERVER_LIGHT_DATA_DIR = dataDir;
  env.HAPPIER_SERVER_LIGHT_FILES_DIR = filesDir;
  env.HAPPIER_SERVER_LIGHT_DB_DIR = dbDir;
  env.HAPPY_SERVER_LIGHT_DATA_DIR = env.HAPPY_SERVER_LIGHT_DATA_DIR ?? dataDir;
  env.HAPPY_SERVER_LIGHT_FILES_DIR = env.HAPPY_SERVER_LIGHT_FILES_DIR ?? filesDir;
  env.HAPPY_SERVER_LIGHT_DB_DIR = env.HAPPY_SERVER_LIGHT_DB_DIR ?? dbDir;

  const provider = resolveDbProviderForLightFromEnv(env);
  env.HAPPIER_DB_PROVIDER = env.HAPPIER_DB_PROVIDER ?? provider;

  // Migration step:
  // - pglite: spins a temporary pglite socket and runs prisma migrate deploy against prisma/schema.prisma
  // - sqlite: runs migrate:sqlite:deploy against prisma/sqlite/schema.prisma
  //
  // Both are idempotent and safe to re-run when the light DB is not held open.
  const envWithCache = await applyStackCacheEnv(env);
  const migrateScript = provider === 'sqlite' ? 'migrate:sqlite:deploy' : 'migrate:light:deploy';
  await run('yarn', ['-s', migrateScript], { cwd: serverDir, env: envWithCache, stdio: quiet ? 'ignore' : 'inherit' });
  return { dataDir, filesDir, dbDir };
}

async function listAccountsFromPglite({ cwd, dbDir }) {
  const lockModuleUrl = new URL('./utils/pglite_lock.mjs', import.meta.url).toString();
  const script = `
process.on('uncaughtException', (e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
process.on('unhandledRejection', (e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
const DB_DIR = ${JSON.stringify(dbDir)};
const { acquirePgliteDirLock } = await import(${JSON.stringify(lockModuleUrl)});
const releaseLock = await acquirePgliteDirLock(DB_DIR, { purpose: 'auth:listAccountsFromPglite' });
const { PGlite } = await import('@electric-sql/pglite');
const { PGLiteSocketServer } = await import('@electric-sql/pglite-socket');
const { PrismaClient } = await import('@prisma/client');
const pglite = new PGlite(DB_DIR);
try {
  await pglite.waitReady;
  const server = new PGLiteSocketServer({ db: pglite, host: '127.0.0.1', port: 0 });
  await server.start();
  try {
    const raw = server.getServerConn();
    const url = (() => {
      try { return new URL(raw); } catch { return new URL(\`postgresql://postgres@\${raw}/postgres?sslmode=disable\`); }
    })();
    url.searchParams.set('connection_limit', '1');
    process.env.DATABASE_URL = url.toString();
    const db = new PrismaClient();
    try {
      const accounts = await db.account.findMany({ select: { id: true, publicKey: true } });
      console.log(JSON.stringify(accounts));
    } finally {
      await db.$disconnect();
    }
  } finally {
    await server.stop();
  }
} finally {
  await pglite.close();
  await releaseLock().catch(() => {});
}
`.trim();

  const { stdout } = await runNodeCapture({
    cwd,
    env: process.env,
    args: ['--input-type=module', '-e', script],
  });
  return stdout.trim() ? JSON.parse(stdout.trim()) : [];
}

async function insertAccountsIntoPglite({ cwd, dbDir, accounts, force }) {
  const lockModuleUrl = new URL('./utils/pglite_lock.mjs', import.meta.url).toString();
  const script = `
process.on('uncaughtException', (e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
process.on('unhandledRejection', (e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
const { PGlite } = await import('@electric-sql/pglite');
const { PGLiteSocketServer } = await import('@electric-sql/pglite-socket');
const { PrismaClient } = await import('@prisma/client');
import fs from 'node:fs';
const DB_DIR = ${JSON.stringify(dbDir)};
const { acquirePgliteDirLock } = await import(${JSON.stringify(lockModuleUrl)});
const releaseLock = await acquirePgliteDirLock(DB_DIR, { purpose: 'auth:insertAccountsIntoPglite' });
const FORCE = ${force ? 'true' : 'false'};
const raw = fs.readFileSync(0, 'utf8').trim();
const accounts = raw ? JSON.parse(raw) : [];
const pglite = new PGlite(DB_DIR);
try {
  await pglite.waitReady;
  const server = new PGLiteSocketServer({ db: pglite, host: '127.0.0.1', port: 0 });
  await server.start();
  try {
    const rawConn = server.getServerConn();
    const url = (() => {
      try { return new URL(rawConn); } catch { return new URL(\`postgresql://postgres@\${rawConn}/postgres?sslmode=disable\`); }
    })();
    url.searchParams.set('connection_limit', '1');
    process.env.DATABASE_URL = url.toString();
	  const db = new PrismaClient();
	  try {
	    let insertedCount = 0;
	    for (const a of accounts) {
	      // eslint-disable-next-line no-await-in-loop
	      try {
	        await db.account.upsert({
	          where: { id: a.id },
	          update: { publicKey: a.publicKey },
	          create: { id: a.id, publicKey: a.publicKey },
	        });
	        insertedCount += 1;
	      } catch (e) {
	        // Prisma unique constraint violation (most commonly: publicKey already exists on another id).
	        if (e && typeof e === 'object' && 'code' in e && e.code === 'P2002') {
	          const existing = await db.account.findUnique({ where: { publicKey: a.publicKey }, select: { id: true } });
	          if (existing?.id && existing.id !== a.id) {
	            if (!FORCE) {
	              throw new Error(
	                \`account publicKey conflict: target already has publicKey for id=\${existing.id}, but seed wants id=\${a.id}. Re-run with --force to replace the conflicting account row.\`
	              );
	            }
	            await db.account.delete({ where: { publicKey: a.publicKey } });
	            await db.account.upsert({
	              where: { id: a.id },
	              update: { publicKey: a.publicKey },
	              create: { id: a.id, publicKey: a.publicKey },
	            });
	            insertedCount += 1;
	            continue;
	          }
	          // If we can't attribute the constraint to a publicKey conflict, treat it as "already seeded".
	          continue;
	        }
	        throw e;
	      }
	    }
	    console.log(JSON.stringify({ sourceCount: accounts.length, insertedCount }));
	  } finally {
	    await db.$disconnect();
	  }
  } finally {
    await server.stop();
  }
} finally {
  await pglite.close();
  await releaseLock().catch(() => {});
}
`.trim();

  const { stdout } = await runNodeCapture({
    cwd,
    env: process.env,
    args: ['--input-type=module', '-e', script],
    stdin: JSON.stringify(accounts),
  });
  const res = stdout.trim() ? JSON.parse(stdout.trim()) : { sourceCount: accounts.length, insertedCount: 0 };
  return {
    ok: true,
    sourceCount: Number(res.sourceCount ?? accounts.length) || 0,
    insertedCount: Number(res.insertedCount ?? 0) || 0,
  };
}

async function listAccountsFromPostgres({ cwd, clientImport, databaseUrl }) {
  const script = `
process.on('uncaughtException', (e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
process.on('unhandledRejection', (e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
const mod = await import(${JSON.stringify(clientImport)});
const PrismaClient = mod?.PrismaClient ?? mod?.default?.PrismaClient;
if (!PrismaClient) throw new Error('Failed to load PrismaClient for DB seed (source).');
const db = new PrismaClient();
try {
  const accounts = await db.account.findMany({ select: { id: true, publicKey: true } });
  console.log(JSON.stringify(accounts));
} finally {
  await db.$disconnect();
}
`.trim();

  const { stdout } = await runNodeCapture({
    cwd,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    args: ['--input-type=module', '-e', script],
  });
  return stdout.trim() ? JSON.parse(stdout.trim()) : [];
}

async function insertAccountsIntoPostgres({ cwd, clientImport, databaseUrl, accounts, force }) {
  const script = `
process.on('uncaughtException', (e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
process.on('unhandledRejection', (e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
const mod = await import(${JSON.stringify(clientImport)});
const PrismaClient = mod?.PrismaClient ?? mod?.default?.PrismaClient;
if (!PrismaClient) throw new Error('Failed to load PrismaClient for DB seed (target).');
import fs from 'node:fs';
const FORCE = ${force ? 'true' : 'false'};
const raw = fs.readFileSync(0, 'utf8').trim();
const accounts = raw ? JSON.parse(raw) : [];
	const db = new PrismaClient();
	try {
	  let insertedCount = 0;
	  for (const a of accounts) {
	    // eslint-disable-next-line no-await-in-loop
	    try {
	      await db.account.upsert({
	        where: { id: a.id },
	        update: { publicKey: a.publicKey },
	        create: { id: a.id, publicKey: a.publicKey },
	      });
	      insertedCount += 1;
	    } catch (e) {
	      // Prisma unique constraint violation (most commonly: publicKey already exists on another id).
	      if (e && typeof e === 'object' && 'code' in e && e.code === 'P2002') {
	        const existing = await db.account.findUnique({ where: { publicKey: a.publicKey }, select: { id: true } });
	        if (existing?.id && existing.id !== a.id) {
	          if (!FORCE) {
	            throw new Error(
	              \`account publicKey conflict: target already has publicKey for id=\${existing.id}, but seed wants id=\${a.id}. Re-run with --force to replace the conflicting account row.\`
	            );
	          }
	          await db.account.delete({ where: { publicKey: a.publicKey } });
	          await db.account.upsert({
	            where: { id: a.id },
	            update: { publicKey: a.publicKey },
	            create: { id: a.id, publicKey: a.publicKey },
	          });
	          insertedCount += 1;
	          continue;
	        }
	        // If we can't attribute the constraint to a publicKey conflict, treat it as "already seeded".
	        continue;
	      }
	      throw e;
	    }
	  }
	  console.log(JSON.stringify({ sourceCount: accounts.length, insertedCount }));
	} finally {
	  await db.$disconnect();
	}
`.trim();

  const { stdout } = await runNodeCapture({
    cwd,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    args: ['--input-type=module', '-e', script],
    stdin: JSON.stringify(accounts),
  });
  const res = stdout.trim() ? JSON.parse(stdout.trim()) : { sourceCount: accounts.length, insertedCount: 0 };
  return {
    ok: true,
    sourceCount: Number(res.sourceCount ?? accounts.length) || 0,
    insertedCount: Number(res.insertedCount ?? 0) || 0,
  };
}

function resolveServerComponentDir({ rootDir, serverComponent }) {
  return getComponentDir(rootDir, serverComponent === 'happier-server' ? 'happier-server' : 'happier-server-light');
}

async function seedAccountsFromSourceDbToTargetDb({
  rootDir,
  fromStackName,
  fromServerComponent,
  fromDatabaseUrl,
  targetStackName,
  targetServerComponent,
  targetDatabaseUrl,
  force = false,
}) {
  const sourceCwd = resolveServerComponentDir({ rootDir, serverComponent: fromServerComponent });
  const targetCwd = resolveServerComponentDir({ rootDir, serverComponent: targetServerComponent });

  const sourceClientImport = resolvePrismaClientImportForServerComponent({
    serverComponentName: fromServerComponent,
    serverDir: sourceCwd,
  });
  const targetClientImport = resolvePrismaClientImportForServerComponent({
    serverComponentName: targetServerComponent,
    serverDir: targetCwd,
  });

  const listScript = `
process.on('uncaughtException', (e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
process.on('unhandledRejection', (e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
const mod = await import(${JSON.stringify(sourceClientImport)});
const PrismaClient = mod?.PrismaClient ?? mod?.default?.PrismaClient;
if (!PrismaClient) {
  throw new Error('Failed to load PrismaClient for DB seed (source).');
}
const db = new PrismaClient();
try {
  const accounts = await db.account.findMany({ select: { id: true, publicKey: true } });
  console.log(JSON.stringify(accounts));
} finally {
  await db.$disconnect();
}
`.trim();

  const insertScript = `
process.on('uncaughtException', (e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
process.on('unhandledRejection', (e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
const mod = await import(${JSON.stringify(targetClientImport)});
const PrismaClient = mod?.PrismaClient ?? mod?.default?.PrismaClient;
if (!PrismaClient) {
  throw new Error('Failed to load PrismaClient for DB seed (target).');
}
import fs from 'node:fs';
const FORCE = ${force ? 'true' : 'false'};
const raw = fs.readFileSync(0, 'utf8').trim();
const accounts = raw ? JSON.parse(raw) : [];
const db = new PrismaClient();
try {
  let insertedCount = 0;
  for (const a of accounts) {
    // eslint-disable-next-line no-await-in-loop
    try {
      await db.account.create({ data: { id: a.id, publicKey: a.publicKey } });
      insertedCount += 1;
    } catch (e) {
      // Prisma unique constraint violation
      if (e && typeof e === 'object' && 'code' in e && e.code === 'P2002') {
        // Two common cases:
        // - id already exists (fine)
        // - publicKey already exists on a different id (auth mismatch -> machine FK failures later)
        //
        // For --force, we try to delete the conflicting row by publicKey and then retry insert.
        // Without --force, fail-closed with a helpful error so users don't end up with "seeded" but broken stacks.
        try {
          const existing = await db.account.findUnique({ where: { publicKey: a.publicKey }, select: { id: true } });
          if (existing?.id && existing.id !== a.id) {
            if (!FORCE) {
              throw new Error(
                \`account publicKey conflict: target already has publicKey for id=\${existing.id}, but seed wants id=\${a.id}. Re-run with --force to replace the conflicting account row.\`
              );
            }
            // Best-effort delete; will fail if other rows reference this account (then we fail closed).
            await db.account.delete({ where: { publicKey: a.publicKey } });
            await db.account.create({ data: { id: a.id, publicKey: a.publicKey } });
            insertedCount += 1;
            continue;
          }
        } catch (inner) {
          throw inner;
        }
        continue;
      }
      throw e;
    }
  }
  console.log(JSON.stringify({ sourceCount: accounts.length, insertedCount }));
} finally {
  await db.$disconnect();
}
`.trim();

  const { stdout: srcOut } = await runNodeCapture({
    cwd: sourceCwd,
    env: { ...process.env, DATABASE_URL: fromDatabaseUrl },
    args: ['--input-type=module', '-e', listScript],
  });
  const accounts = srcOut.trim() ? JSON.parse(srcOut.trim()) : [];

  const { stdout: insOut } = await runNodeCapture({
    cwd: targetCwd,
    env: { ...process.env, DATABASE_URL: targetDatabaseUrl },
    args: ['--input-type=module', '-e', insertScript],
    stdin: JSON.stringify(accounts),
  });
  const res = insOut.trim() ? JSON.parse(insOut.trim()) : { sourceCount: accounts.length, insertedCount: 0 };

  return {
    ok: true,
    fromStackName,
    targetStackName,
    sourceCount: Number(res.sourceCount ?? accounts.length) || 0,
    insertedCount: Number(res.insertedCount ?? 0) || 0,
  };
}

async function cmdCopyFrom({ argv, json }) {
  const rootDir = getRootDir(import.meta.url);
  const stackName = getStackName();

  const positionals = argv.filter((a) => !a.startsWith('--'));
  const fromStackName = (positionals[1] ?? '').trim();
  if (!fromStackName) {
    throw new Error(
      '[auth] usage: hstack stack auth <name> copy-from <sourceStack> [--force] [--with-infra] [--json]  OR  hstack auth copy-from <sourceStack> --all [--except=main,dev-auth] [--force] [--with-infra] [--json]\n' +
        'notes:\n' +
        '  - sourceStack can be a stack name (e.g. main, dev-auth)'
    );
  }

  const { flags, kv } = parseArgs(argv);
  const all = flags.has('--all');
  const force =
    flags.has('--force') ||
    flags.has('--overwrite') ||
    (kv.get('--force') ?? '').trim() === '1' ||
    (kv.get('--overwrite') ?? '').trim() === '1';
  const withInfra =
    flags.has('--with-infra') ||
    flags.has('--ensure-infra') ||
    flags.has('--infra') ||
    (kv.get('--with-infra') ?? '').trim() === '1' ||
    (kv.get('--ensure-infra') ?? '').trim() === '1';
  const linkMode =
    flags.has('--link') ||
    flags.has('--symlink') ||
    flags.has('--link-auth') ||
    (kv.get('--link') ?? '').trim() === '1' ||
    (kv.get('--symlink') ?? '').trim() === '1' ||
    (kv.get('--auth-mode') ?? '').trim() === 'link' ||
    (process.env.HAPPIER_STACK_AUTH_LINK ?? '').toString().trim() === '1' ||
    (process.env.HAPPIER_STACK_AUTH_MODE ?? '').toString().trim() === 'link';
  const allowMain = flags.has('--allow-main') || flags.has('--main-ok') || (kv.get('--allow-main') ?? '').trim() === '1';
  const exceptRaw = (kv.get('--except') ?? '').trim();
  const except = new Set(exceptRaw.split(',').map((s) => s.trim()).filter(Boolean));

  if (all) {
    // Global bulk operation (no stack context required).
    const stacks = await listAllStackNames();
    const results = [];
    const totalTargets = stacks.filter((s) => !except.has(s) && s !== fromStackName).length;
    let idx = 0;
    const progress = (line) => {
      // In JSON mode, never pollute stdout (reserved for final JSON).
      // eslint-disable-next-line no-console
      (json ? console.error : console.log)(line);
    };

    progress(
      `[auth] copy-from --all: from=${fromStackName}${except.size ? ` (except=${[...except].join(',')})` : ''}${force ? ' (force)' : ''}${withInfra ? ' (with-infra)' : ''}`
    );
    for (const target of stacks) {
      if (except.has(target)) {
        progress(`- ↪ ${target}: skipped (excluded)`);
        results.push({ stackName: target, ok: true, skipped: true, reason: 'excluded' });
        continue;
      }
      if (target === fromStackName) {
        progress(`- ↪ ${target}: skipped (source_stack)`);
        results.push({ stackName: target, ok: true, skipped: true, reason: 'source_stack' });
        continue;
      }

      idx += 1;
      progress(`[auth] [${idx}/${totalTargets}] seeding stack "${target}"...`);

      try {
        const out = await runNodeCapture({
          cwd: rootDir,
          env: process.env,
          args: [
            join(rootDir, 'scripts', 'stack.mjs'),
            'auth',
            target,
            '--',
            'copy-from',
            fromStackName,
            '--json',
            ...(force ? ['--force'] : []),
            ...(withInfra ? ['--with-infra'] : []),
            ...(linkMode ? ['--link'] : []),
          ],
        });
        const parsed = out.stdout.trim() ? JSON.parse(out.stdout.trim()) : null;

        const copied = parsed?.copied && typeof parsed.copied === 'object' ? parsed.copied : null;
        const db = copied?.dbAccounts ? `db=${copied.dbAccounts.insertedCount}/${copied.dbAccounts.sourceCount}` : copied?.dbError ? `db=skipped` : `db=unknown`;
        const secret = copied?.secret ? 'secret' : null;
        const cli = copied?.accessKey || copied?.settings ? 'cli' : null;
        const any = copied?.secret || copied?.accessKey || copied?.settings || copied?.db;
        const summary = any ? `seeded (${[db, secret, cli].filter(Boolean).join(', ')})` : `noop (already has auth)`;
        progress(`- ✅ ${target}: ${summary}`);
        if (copied?.dbError) {
          progress(`  - db seed skipped: ${copied.dbError}`);
        }

        results.push({ stackName: target, ok: true, skipped: false, fromStackName, out: parsed });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        progress(`- ❌ ${target}: failed`);
        progress(`  - ${msg}`);
        results.push({ stackName: target, ok: false, skipped: false, fromStackName, error: msg });
      }
    }

    const ok = results.every((r) => r.ok);
    if (json) {
      printResult({ json, data: { ok, fromStackName, results } });
      return;
    }
    // (we already streamed progress above)
    const failed = results.filter((r) => !r.ok).length;
    const skipped = results.filter((r) => r.ok && r.skipped).length;
    const seeded = results.filter((r) => r.ok && !r.skipped).length;
    // eslint-disable-next-line no-console
    console.log(`[auth] done: ok=${ok ? 'true' : 'false'} seeded=${seeded} skipped=${skipped} failed=${failed}`);
    if (!ok) process.exit(1);
    return;
  }

  if (stackName === 'main' && !allowMain) {
    throw new Error(
      '[auth] copy-from is intended for stack-scoped usage (e.g. hstack stack auth <name> copy-from main), or pass --all.\n' +
        'If you really intend to seed the main hstack install, re-run with: --allow-main'
    );
  }

  const serverComponent = resolveServerComponentForCurrentStack();
  const serverDirForPrisma = resolveServerComponentDir({ rootDir, serverComponent });
  const targetBaseDir = getDefaultAutostartPaths().baseDir;
  const targetCli = resolveCliHomeDir();
  const targetServerLightDataDir =
    (process.env.HAPPIER_SERVER_LIGHT_DATA_DIR ?? '').trim() || join(targetBaseDir, 'server-light');
  const targetSecretFile =
    (process.env.HAPPIER_STACK_HANDY_MASTER_SECRET_FILE ?? '').trim() || join(targetBaseDir, 'happier-server', 'handy-master-secret.txt');
  const { secret, source } = await resolveHandyMasterSecretFromStack({
    stackName: fromStackName,
    requireStackExists: true,
  });

  const copied = {
    secret: false,
    accessKey: false,
    settings: false,
    db: false,
    dbAccounts: null,
    dbError: null,
    sourceStack: fromStackName,
    stackName,
  };

  const sourceBaseDir = resolveStackEnvPath(fromStackName).baseDir;
  const sourceEnvRaw = await readTextIfExists(resolveStackEnvPath(fromStackName).envPath);
  const sourceEnv = sourceEnvRaw ? parseEnvToObject(sourceEnvRaw) : {};
  const sourceCli = getCliHomeDirFromEnvOrDefault({ stackBaseDir: sourceBaseDir, env: sourceEnv });

  const resolveStackInternalServerUrlForAuth = async ({ stackName: name, env, defaultPort }) => {
    const runtimeStatePath = getStackRuntimeStatePath(name);
    try {
      const st = await readStackRuntimeStateFile(runtimeStatePath);
      const ownerPid = Number(st?.ownerPid);
      const runtimeOwnerAlive = Number.isFinite(ownerPid) && ownerPid > 1 ? isRuntimePidAlive(ownerPid) : false;
      const port = Number(st?.ports?.server);
      if (runtimeOwnerAlive && Number.isFinite(port) && port > 0) {
        return `http://127.0.0.1:${port}`;
      }
    } catch {
      // ignore; fall back to env/default port
    }
    const { internalServerUrl } = getInternalServerUrl({ env, defaultPort });
    return internalServerUrl;
  };

  // IMPORTANT:
  // Stack auth now uses stable server IDs (`HAPPIER_ACTIVE_SERVER_ID`) which are not persisted in stack env files.
  // Reconstruct the stable scope ID here so copy-from reads the same source credential path that login wrote.
  // copy-from must use stack-stable credential scope even if the caller shell leaked
  // rollback flags like HAPPIER_STACK_DISABLE_STABLE_SCOPE=1.
  const sourceScopeEnv = { ...process.env, ...sourceEnv };
  delete sourceScopeEnv.HAPPIER_STACK_DISABLE_STABLE_SCOPE;
  const sourceEnvScoped = applyStackActiveServerScopeEnv({
    env: sourceScopeEnv,
    stackName: fromStackName,
    cliIdentity: 'default',
  });
  const sourceInternalServerUrl = await resolveStackInternalServerUrlForAuth({
    stackName: fromStackName,
    env: sourceEnvScoped,
    defaultPort: 3005,
  });
  const sourceCredentialPath =
    findExistingStackCredentialPath({ cliHomeDir: sourceCli, serverUrl: sourceInternalServerUrl, env: sourceEnvScoped }) ||
    findAnyCredentialPathInCliHome({ cliHomeDir: sourceCli });
  const targetEnv = process.env;
  const targetScopeEnv = { ...targetEnv };
  delete targetScopeEnv.HAPPIER_STACK_DISABLE_STABLE_SCOPE;
  const targetEnvScoped = applyStackActiveServerScopeEnv({
    env: targetScopeEnv,
    stackName,
    cliIdentity: 'default',
  });
  const { url: targetInternalServerUrl } = getInternalServerUrlCompat();
  const targetCredentialPaths = resolveStackCredentialPaths({
    cliHomeDir: targetCli,
    serverUrl: targetInternalServerUrl,
    env: targetEnvScoped,
  });
  const fromServerComponent = resolveServerComponentFromEnv(sourceEnv);
  const targetServerComponent = resolveServerComponentFromEnv(targetEnv);

  const sourceCwd = resolveServerComponentDir({ rootDir, serverComponent: fromServerComponent });
  const targetCwd = resolveServerComponentDir({ rootDir, serverComponent: targetServerComponent });
  const sourceDbProvider =
    fromServerComponent === 'happier-server-light'
      ? resolveDbProviderForLightFromEnv(sourceEnv)
      : resolveDbProviderForFullFromEnv(sourceEnv);
  const targetDbProvider =
    targetServerComponent === 'happier-server-light'
      ? resolveDbProviderForLightFromEnv(targetEnv)
      : resolveDbProviderForFullFromEnv(targetEnv);

  const sourceClientImport =
    fromServerComponent === 'happier-server-light'
      ? sourceDbProvider === 'sqlite'
        ? resolvePrismaClientImportForDbProvider({ serverDir: sourceCwd, provider: 'sqlite' })
        : resolvePrismaClientImportForServerComponent({ serverComponentName: fromServerComponent, serverDir: sourceCwd })
      : resolvePrismaClientImportForDbProvider({ serverDir: sourceCwd, provider: sourceDbProvider });
  const targetClientImport =
    targetServerComponent === 'happier-server-light'
      ? targetDbProvider === 'sqlite'
        ? resolvePrismaClientImportForDbProvider({ serverDir: targetCwd, provider: 'sqlite' })
        : resolvePrismaClientImportForServerComponent({ serverComponentName: targetServerComponent, serverDir: targetCwd })
      : resolvePrismaClientImportForDbProvider({ serverDir: targetCwd, provider: targetDbProvider });

  const readSourceAccounts = async () => {
    if (fromServerComponent === 'happier-server-light') {
      const lightProvider = resolveDbProviderForLightFromEnv(sourceEnv);
      const { dataDir, dbDir } = await ensureLightMigrationsApplied({
        serverDir: sourceCwd,
        baseDir: sourceBaseDir,
        envIn: sourceEnv,
        quiet: json,
      });
      if (lightProvider === 'sqlite') {
        const url = resolveSqliteDatabaseUrlForLight({ dataDir });
        return await listAccountsFromPostgres({ cwd: sourceCwd, clientImport: sourceClientImport, databaseUrl: url });
      }
      return await listAccountsFromPglite({ cwd: sourceCwd, dbDir });
    }
    const fromDatabaseUrl = resolveDatabaseUrlFromEnvOrThrow({
      env: sourceEnv,
      stackName: fromStackName,
      label: `source stack "${fromStackName}"`,
      provider: sourceDbProvider,
    });
    return await listAccountsFromPostgres({ cwd: sourceCwd, clientImport: sourceClientImport, databaseUrl: fromDatabaseUrl });
  };

  let sourceAccounts = null;
  const sourceTokenSubject = resolveJwtSubjectFromCredentialPath(sourceCredentialPath);
  let sourceTokenValidation = null;
  const sourceRuntimeOwnerAlive = await isStackRuntimeOwnerAlive(fromStackName);
  if (sourceCredentialPath && sourceRuntimeOwnerAlive) {
    sourceTokenValidation = await validateAuthTokenAgainstServer({
      credentialPath: sourceCredentialPath,
      internalServerUrl: sourceInternalServerUrl,
    });
    if (sourceTokenValidation.checked && sourceTokenValidation.valid === false) {
      const status = sourceTokenValidation.status != null ? sourceTokenValidation.status : 'error';
      const code = sourceTokenValidation.code ? `/${sourceTokenValidation.code}` : '';
      throw new Error(
        `[auth] source auth appears stale: source server rejected credential for stack "${fromStackName}" (${status}${code}). Re-auth the source stack and retry.`
      );
    }
  }
  const hasSourceDatabaseUrl = Boolean(String(sourceEnv.DATABASE_URL ?? '').trim());
  const canValidateSourceTokenSubject =
    !(sourceTokenValidation && sourceTokenValidation.checked && sourceTokenValidation.valid === true) &&
    Boolean(sourceTokenSubject) &&
    (fromServerComponent === 'happier-server-light' || hasSourceDatabaseUrl);
  if (canValidateSourceTokenSubject) {
    try {
      sourceAccounts = await readSourceAccounts();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `[auth] source auth appears stale: unable to validate token subject "${sourceTokenSubject}" against source Account rows for stack "${fromStackName}" (${detail}). Re-auth the source stack and retry.`
      );
    }
    const hasMatchingSourceAccount = sourceAccounts.some((account) => String(account?.id ?? '') === sourceTokenSubject);
    if (!hasMatchingSourceAccount) {
      throw new Error(
        `[auth] source auth appears stale: token subject "${sourceTokenSubject}" is not present in source Account rows for stack "${fromStackName}". Re-auth the source stack and retry.`
      );
    }
  }

  if (secret) {
    if (serverComponent === 'happier-server-light') {
      const target = join(targetServerLightDataDir, 'handy-master-secret.txt');
      const sourcePath = source && !String(source).includes('(HANDY_MASTER_SECRET)') ? String(source) : '';
      if (linkMode && sourcePath && existsSync(sourcePath)) {
        copied.secret = await linkFileIfMissing({ from: sourcePath, to: target, force });
      } else {
        copied.secret = await writeSecretFileIfMissing({ path: target, secret, force });
      }
    } else if (serverComponent === 'happier-server') {
      const sourcePath = source && !String(source).includes('(HANDY_MASTER_SECRET)') ? String(source) : '';
      if (linkMode && sourcePath && existsSync(sourcePath)) {
        copied.secret = await linkFileIfMissing({ from: sourcePath, to: targetSecretFile, force });
      } else {
        copied.secret = await writeSecretFileIfMissing({ path: targetSecretFile, secret, force });
      }
    }
  }

  if (linkMode) {
    const linkedLegacy = await linkFileIfMissing({
      from: sourceCredentialPath || '',
      to: targetCredentialPaths.legacyPath,
      force,
    });
    const linkedServerScoped = await linkFileIfMissing({
      from: sourceCredentialPath || '',
      to: targetCredentialPaths.serverScopedPath,
      force,
    });
    copied.accessKey = linkedLegacy || linkedServerScoped;
    copied.settings = await linkFileIfMissing({ from: join(sourceCli, 'settings.json'), to: join(targetCli, 'settings.json'), force });
  } else {
    const copiedLegacy = await copyFileIfMissing({
      from: sourceCredentialPath || '',
      to: targetCredentialPaths.legacyPath,
      mode: 0o600,
      force,
    });
    const copiedServerScoped = await copyFileIfMissing({
      from: sourceCredentialPath || '',
      to: targetCredentialPaths.serverScopedPath,
      mode: 0o600,
      force,
    });
    copied.accessKey = copiedLegacy || copiedServerScoped;
    copied.settings = await copyFileIfMissing({
      from: join(sourceCli, 'settings.json'),
      to: join(targetCli, 'settings.json'),
      mode: 0o600,
      force,
    });
  }

  // Best-effort DB seeding: copy Account rows from source stack DB to target stack DB.
  // This avoids FK failures (e.g., Prisma P2003) when the target DB is fresh but the copied token
  // refers to an account ID that does not exist there yet.
  try {
    // Ensure prisma is runnable (best-effort). If deps aren't installed, we'll fall back to skipping DB seeding.
    // IMPORTANT: when running with --json, keep stdout clean (no yarn/prisma chatter).
    await ensureDepsInstalled(serverDirForPrisma, serverComponent, { quiet: json }).catch(() => {});

    // 1) Read Account rows from the source DB.
    const accounts = sourceAccounts ?? (await readSourceAccounts());

    // 2) Insert Account rows into the target DB.
    const runInsert = async () => {
	      if (targetServerComponent === 'happier-server-light') {
	        const lightProvider = resolveDbProviderForLightFromEnv(targetEnv);
	        const { dataDir, dbDir } = await ensureLightMigrationsApplied({ serverDir: targetCwd, baseDir: targetBaseDir, envIn: targetEnv, quiet: json });
	        if (lightProvider === 'sqlite') {
	          const url = resolveSqliteDatabaseUrlForLight({ dataDir });
	          return await insertAccountsIntoPostgres({
	            cwd: targetCwd,
	            clientImport: targetClientImport,
	            databaseUrl: url,
	            accounts,
	            force,
	          });
	        }
	        return await insertAccountsIntoPglite({ cwd: targetCwd, dbDir, accounts, force });
	      }

      let targetDatabaseUrl;
      try {
	        targetDatabaseUrl = resolveDatabaseUrlFromEnvOrThrow({
	          env: targetEnv,
	          stackName,
	          label: `target stack "${stackName}"`,
	          provider: targetDbProvider,
	        });
	      } catch (e) {
        // For full server stacks, allow `copy-from --with-infra` to bring up Docker infra just-in-time
        // so we can seed DB accounts reliably.
        const managed = (targetEnv.HAPPIER_STACK_MANAGED_INFRA ?? '1').toString().trim() !== '0';
	        if (targetServerComponent === 'happier-server' && targetDbProvider === 'postgres' && withInfra && managed) {
          const { port } = getInternalServerUrlCompat();
          const publicServerUrl = await preferStackLocalhostUrl(`http://localhost:${port}`, { stackName });
          const envPath = resolveStackEnvPath(stackName).envPath;
          const infra = await ensureHappyServerManagedInfra({
            stackName,
            baseDir: targetBaseDir,
            serverPort: port,
            publicServerUrl,
            envPath,
            env: targetEnv,
            quiet: json,
            // Auth seeding only needs Postgres; don't block on Minio bucket init.
            skipMinioInit: true,
          });
	          targetDatabaseUrl = infra?.env?.DATABASE_URL ?? '';
	        } else {
	          throw e;
	        }
	      }
      if (!targetDatabaseUrl) {
        throw new Error(
          `[auth] missing DATABASE_URL for target stack "${stackName}". ` +
            (targetServerComponent === 'happier-server' ? `If this is a managed infra stack, re-run with --with-infra.` : '')
        );
      }

      return await insertAccountsIntoPostgres({ cwd: targetCwd, clientImport: targetClientImport, databaseUrl: targetDatabaseUrl, accounts, force });
    };

    const res = await (async () => {
      try {
        return await runInsert();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const looksLikeMissingTable = msg.toLowerCase().includes('does not exist') || msg.toLowerCase().includes('no such table');
        if (!looksLikeMissingTable) throw e;

        // Best-effort: apply schema, then retry once.
        if (targetServerComponent === 'happier-server-light') {
          await ensureLightMigrationsApplied({ serverDir: targetCwd, baseDir: targetBaseDir, envIn: targetEnv, quiet: json }).catch(() => {});
        } else if (targetServerComponent === 'happier-server') {
          await applyHappyServerMigrations({ serverDir: targetCwd, env: targetEnv, quiet: json }).catch(() => {});
        }
        return await runInsert();
      }
    })();

    copied.dbAccounts = { sourceCount: res.sourceCount, insertedCount: res.insertedCount };
    copied.db = true;
    copied.dbError = null;
  } catch (err) {
    copied.db = false;
    copied.dbAccounts = null;
    copied.dbError = err instanceof Error ? err.message : String(err);
    if (!json) {
      console.warn(`[auth] db seed skipped: ${copied.dbError}`);
    }
  }

  if (json) {
    printResult({ json, data: { ok: true, copied } });
    return;
  }

  const any = copied.secret || copied.accessKey || copied.settings || copied.db;
  if (!any) {
    console.log(`[auth] nothing to copy (target already has auth files)`);
    return;
  }

  console.log(`[auth] copied auth from "${fromStackName}" into "${stackName}" (no re-login needed)`);
  if (copied.secret) console.log(`  - master secret: copied (${source || 'unknown source'})`);
  if (copied.dbAccounts) {
    console.log(`  - db: seeded Account rows (inserted=${copied.dbAccounts.insertedCount}/${copied.dbAccounts.sourceCount})`);
  }
  if (copied.accessKey) console.log(`  - cli: copied access.key`);
  if (copied.settings) console.log(`  - cli: copied settings.json`);
}

async function cmdStatus({ json }) {
  const rootDir = getRootDir(import.meta.url);
  const stackName = getStackName();
  const argv = process.argv.slice(2);
  const { kv } = parseArgs(argv);
  const identity = parseCliIdentityOrThrow((kv.get('--identity') ?? '').trim());

  const { port, url: internalServerUrl } = getInternalServerUrlCompat();
  const { defaultPublicUrl, envPublicUrl } = getPublicServerUrlEnvOverride({ env: process.env, serverPort: port, stackName });
  const { publicServerUrl } = await resolvePublicServerUrl({
    internalServerUrl,
    defaultPublicUrl,
    envPublicUrl,
    allowEnable: false,
    stackName,
  });

  const cliHomeDir = resolveCliHomeDirForIdentity({ cliHomeDir: resolveCliHomeDir(), identity });
  const credentialPaths = resolveStackCredentialPaths({ cliHomeDir, serverUrl: internalServerUrl, env: process.env });
  const existingCredentialPath = findExistingStackCredentialPath({ cliHomeDir, serverUrl: internalServerUrl, env: process.env });
  const settingsPath = join(cliHomeDir, 'settings.json');

  const auth = {
    ok: Boolean(existingCredentialPath),
    accessKeyPath: existingCredentialPath || credentialPaths.legacyPath,
    accessKeyPaths: credentialPaths.paths,
    hasAccessKey: Boolean(existingCredentialPath),
    settingsPath,
    hasSettings: fileHasContent(settingsPath),
    serverValidation: {
      checked: false,
      valid: null,
      status: null,
      code: 'not-checked',
      error: null,
    },
  };

  const daemon = checkDaemonState(cliHomeDir, { serverUrl: internalServerUrl });
  const healthRaw = await fetchHappierHealth(internalServerUrl);
  const health = {
    ok: Boolean(healthRaw.ok),
    status: healthRaw.status,
    body: healthRaw.text ? healthRaw.text.trim() : null,
  };

  if (auth.hasAccessKey && health.ok) {
    auth.serverValidation = await validateAuthTokenAgainstServer({
      credentialPath: existingCredentialPath || credentialPaths.legacyPath,
      internalServerUrl,
    });
  } else if (auth.hasAccessKey && !health.ok) {
    auth.serverValidation = {
      checked: false,
      valid: null,
      status: null,
      code: 'server-unreachable',
      error: null,
    };
  }

  const out = {
    stackName,
    internalServerUrl,
    publicServerUrl,
    cliHomeDir,
    cliIdentity: identity,
    auth,
    daemon,
    serverHealth: health,
    cliBin: join(getComponentDir(rootDir, 'happier-cli'), 'bin', 'happier.mjs'),
  };

  if (json) {
    printResult({ json, data: out });
    return;
  }

  const authLine = (() => {
    if (!auth.hasAccessKey) return '❌ auth: required';
    if (auth.serverValidation.checked && auth.serverValidation.valid === true) {
      return '✅ auth: ok (server-verified)';
    }
    if (auth.serverValidation.checked && auth.serverValidation.valid === false) {
      const code = auth.serverValidation.code ? `, ${auth.serverValidation.code}` : '';
      const status = auth.serverValidation.status != null ? auth.serverValidation.status : 'error';
      return `❌ auth: invalid (${status}${code})`;
    }
    if (!health.ok) return '⚠️ auth: present (server unreachable)';
    return '⚠️ auth: present (not verified)';
  })();
  const daemonLine =
    daemon.status === 'running'
      ? `✅ daemon: running (pid=${daemon.pid})`
      : daemon.status === 'starting'
        ? `⏳ daemon: starting (pid=${daemon.pid})`
        : daemon.status === 'stale_state'
          ? `⚠️ daemon: stale state file (pid=${daemon.pid} not running)`
          : daemon.status === 'stale_lock'
            ? `⚠️ daemon: stale lock file (pid=${daemon.pid} not running)`
            : daemon.status === 'bad_state'
              ? '⚠️ daemon: unreadable state'
              : '❌ daemon: not running';

  const serverLine = health.ok ? `✅ server: healthy (${health.status})` : `⚠️ server: unreachable (${internalServerUrl})`;

  console.log(`[auth] stack: ${stackName}`);
  console.log(`[auth] urls: internal=${internalServerUrl} public=${publicServerUrl}`);
  console.log(`[auth] cli:  ${cliHomeDir}`);
  console.log('');
  console.log(authLine);
  if (!auth.ok) {
    console.log(`  ↪ run: ${authLoginSuggestion(stackName)}`);
    const copyFromSeed = authCopyFromSeedSuggestion(stackName);
    if (copyFromSeed) {
      console.log(`  ↪ or (recommended if your seed stack is already logged in): ${copyFromSeed}`);
    }
  } else if (auth.serverValidation.checked && auth.serverValidation.valid === false) {
    const copyFromSeed = authCopyFromSeedSuggestion(stackName);
    console.log(`  ↪ run: ${authLoginSuggestion(stackName)} --force`);
    if (copyFromSeed) {
      console.log(`  ↪ or reseed explicitly: ${copyFromSeed} --force`);
    }
  }
  console.log(daemonLine);
  console.log(serverLine);
  if (!health.ok) {
    const startHint = stackName === 'main' ? 'hstack dev' : `hstack stack dev ${stackName}`;
    console.log(`  ↪ this stack does not appear to be running. Start it with: ${startHint}`);
    return;
  }
  if (auth.ok && daemon.status !== 'running') {
    console.log(`  ↪ daemon is not running for this stack. If you expected it to be running, try: hstack doctor`);
  }
}

async function cmdLogin({ argv, json }) {
  const rootDir = getRootDir(import.meta.url);
  const stackName = getStackName();
  const { flags, kv } = parseArgs(argv);

  const tty = isTty();
  const { port, url: internalServerUrl } = getInternalServerUrlCompat();
  const { defaultPublicUrl, envPublicUrl } = getPublicServerUrlEnvOverride({ env: process.env, serverPort: port, stackName });
  const { publicServerUrl } = await resolvePublicServerUrl({
    internalServerUrl,
    defaultPublicUrl,
    envPublicUrl,
    allowEnable: false,
    stackName,
  });

  const webappModeRaw =
    (argvKvValue(argv, '--webapp') || (kv.get('--webapp') ?? '')).toString().trim().toLowerCase();
  const webappMode = webappModeRaw || 'auto'; // auto|stack|public|expo|hosted
  const explicitWebappUrl =
    (argvKvValue(argv, '--webapp-url') || (kv.get('--webapp-url') ?? '')).toString().trim();
  const methodRaw = (argvKvValue(argv, '--method') || (kv.get('--method') ?? '')).toString().trim().toLowerCase();
  const method = methodRaw === 'mobile' ? 'mobile' : methodRaw === 'web' || methodRaw === 'browser' ? 'web' : '';
  if (methodRaw && !method) {
    throw new Error(`[auth] login: invalid --method=${methodRaw} (expected: web|browser|mobile)`);
  }

  const { envWebappUrl } = getWebappUrlEnvOverride({ env: process.env, stackName });
  const expoWebappUrl = await resolveWebappUrlFromRunningExpo({ rootDir, stackName });

  let webappUrlRaw = '';
  let webappUrlSource = '';
  if (explicitWebappUrl) {
    webappUrlRaw = explicitWebappUrl;
    webappUrlSource = 'webapp-url flag';
  } else if (webappMode === 'public') {
    webappUrlRaw = publicServerUrl;
    webappUrlSource = 'public server';
  } else if (webappMode === 'hosted') {
    // Use happier-cli defaults (do not force a URL here).
    webappUrlRaw = '';
    webappUrlSource = 'cli default';
  } else if (webappMode === 'expo') {
    webappUrlRaw = expoWebappUrl || '';
    webappUrlSource = 'expo';
  } else {
    // auto|stack: preserve existing ordering for now (env override wins unless explicitly forced otherwise).
    webappUrlRaw = envWebappUrl || expoWebappUrl || publicServerUrl;
    webappUrlSource = envWebappUrl ? 'stack env override' : expoWebappUrl ? 'expo' : 'server';
  }

  const webappUrl = webappUrlRaw ? await preferStackLocalhostUrl(webappUrlRaw, { stackName }) : '';
  const flowRaw = (argvKvValue(argv, '--flow') || (kv.get('--flow') ?? '')).toString().trim();
  if (flowRaw) {
    throw new Error('[auth] login: --flow is no longer supported (stack login is always guided)');
  }
  const flow = 'guided';

  const identity = parseCliIdentityOrThrow((kv.get('--identity') ?? '').trim());
  const cliHomeDir = resolveCliHomeDirForIdentity({ cliHomeDir: resolveCliHomeDir(), identity });
  const cliBin = join(getComponentDir(rootDir, 'happier-cli'), 'bin', 'happier.mjs');

  const force =
    argv.includes('--force') ||
    (kv.get('--force') ?? '').toString().trim() === '1';
  const wantPrint = argv.includes('--print');
  const noOpen = flags.has('--no-open') || flags.has('--no-browser') || flags.has('--no-browser-open');

  const nodeArgs = [cliBin, 'auth', 'login'];
  if (force || argv.includes('--force')) {
    nodeArgs.push('--force');
  }
  if (noOpen) {
    nodeArgs.push('--no-open');
  }
  if (method) {
    nodeArgs.push('--method', method);
  }

  let env = {
    ...process.env,
    HAPPIER_HOME_DIR: cliHomeDir,
    HAPPIER_SERVER_URL: internalServerUrl,
    HAPPIER_PUBLIC_SERVER_URL: publicServerUrl,
    ...(webappUrl ? { HAPPIER_WEBAPP_URL: webappUrl } : {}),
    ...(noOpen ? { HAPPIER_NO_BROWSER_OPEN: '1' } : {}),
    ...(method ? { HAPPIER_AUTH_METHOD: method } : {}),
    ...(force ? { HAPPIER_AUTH_FORCE: '1' } : {}),
  };
  env = applyStackActiveServerScopeEnv({ env, stackName, cliIdentity: identity });

  if (wantPrint) {
    const cmd =
      `HAPPIER_HOME_DIR="${cliHomeDir}" ` +
      `HAPPIER_SERVER_URL="${internalServerUrl}" ` +
      `HAPPIER_PUBLIC_SERVER_URL="${publicServerUrl}" ` +
      (env.HAPPIER_ACTIVE_SERVER_ID ? `HAPPIER_ACTIVE_SERVER_ID="${env.HAPPIER_ACTIVE_SERVER_ID}" ` : '') +
      (webappUrl ? `HAPPIER_WEBAPP_URL="${webappUrl}" ` : '') +
      (noOpen ? `HAPPIER_NO_BROWSER_OPEN="1" ` : '') +
      (method ? `HAPPIER_AUTH_METHOD="${method}" ` : '') +
      `node "${cliBin}" auth login` +
      (nodeArgs.includes('--force') ? ' --force' : '') +
      (noOpen ? ' --no-open' : '') +
      (method ? ` --method ${method}` : '');

    const configureServer =
      webappUrl && publicServerUrl
        ? buildConfigureServerLinks({ webappUrl, serverUrl: publicServerUrl })
        : webappUrl
          ? buildConfigureServerLinks({ webappUrl, serverUrl: internalServerUrl })
          : null;
    if (json) {
      printResult({
        json,
        data: {
          ok: true,
          flow,
          stackName,
          cliIdentity: identity,
          internalServerUrl,
          publicServerUrl,
          webappUrl,
          webappUrlSource,
          method: method || null,
          configureServer,
          cmd,
        },
      });
    } else {
      console.log(cmd);
    }
    return;
  }

  if (json) {
    throw new Error('[auth] login: --json is supported only with --print');
  }

  const shouldAutoStart = flags.has('--start-if-needed');
  const guidedReadyTimeoutMs = resolveGuidedServerReadyTimeoutMs(process.env);
  const waitForGuidedServerReadyOrThrow = async (reason) => {
    const ready = await waitForHappierHealthOk(internalServerUrl, {
      timeoutMs: guidedReadyTimeoutMs,
      intervalMs: 300,
    });
    if (!ready) {
      throw new Error(
        `[auth] ${stackName}: server did not become healthy in time (${guidedReadyTimeoutMs}ms) while ${reason}.\n` +
          `[auth] Start it manually:\n` +
          `  hstack stack dev ${stackName} --background`
      );
    }
  };

  const health = await fetchHappierHealth(internalServerUrl);
  if (!health.ok) {
    const runtimeOwnerAlive = await isStackRuntimeOwnerAlive(stackName);
    const action = resolveGuidedStartAction({
      healthOk: false,
      runtimeOwnerAlive,
      autoStart: shouldAutoStart,
    });

    if (action === 'wait') {
      // eslint-disable-next-line no-console
      console.error(`[auth] ${stackName}: stack runtime is already starting; waiting for health before guided login...`);
      await waitForGuidedServerReadyOrThrow('already starting');
    } else {
      let startOk = action === 'start';
      if (!startOk) {
        if (!tty) {
          throw new Error(
            `[auth] ${stackName}: cannot run guided login because the stack is not running in non-interactive mode.\n` +
              `[auth] Re-run with --start-if-needed or start it manually:\n` +
              `  hstack stack dev ${stackName} --background`
          );
        }
        startOk = await withRl(async (rl) => {
          const ans = (
            await prompt(rl, `[auth] ${stackName}: server is not running. Start the stack in background now? [Y/n] `, {
              defaultValue: 'y',
            })
          ).toLowerCase();
          return ans === 'y' || ans === 'yes' || ans === '';
        });
      }
      if (!startOk) {
        throw new Error(
          `[auth] ${stackName}: cannot run guided login because the stack is not running.\n` +
            `[auth] Start it with: hstack stack dev ${stackName} --background`
        );
      }

      await run(
        process.execPath,
        [join(rootDir, 'scripts', 'stack.mjs'), 'dev', stackName, '--background', '--no-daemon', '--no-browser'],
        {
          cwd: rootDir,
          env: { ...process.env, HAPPIER_STACK_AUTH_FLOW: '1' },
        }
      ).catch((err) => {
        const msg =
          `[auth] ${stackName}: failed to start the stack for guided login.\n` +
          `[auth] Try starting it manually:\n` +
          `  hstack stack dev ${stackName} --background\n\n` +
          `${String(err?.stack ?? err)}`;
        throw new Error(msg);
      });

      await waitForGuidedServerReadyOrThrow('starting in background');
    }
  }

  const verbosity = getVerbosityLevel(process.env);
  const guidedEnv = applyStackActiveServerScopeEnv({
    env: { ...env, HAPPIER_STACK_AUTH_FLOW: '1' },
    stackName,
    cliIdentity: identity,
  });
  const guided = await runOrchestratedGuidedAuthFlow({
    rootDir,
    stackName,
    env: guidedEnv,
    verbosity,
    json: false,
  });

  const daemonStart = await startDaemonPostAuth({
    rootDir,
    stackName,
    env: guidedEnv,
    forceRestart: true,
    webappUrl: guided?.webappUrl,
  });
  if (daemonStart?.ok === false) {
    // eslint-disable-next-line no-console
    console.error(daemonStart.error ?? `[auth] ${stackName}: post-auth daemon start verification timed out`);
  }
  return;
}

async function main() {
  const argv = process.argv.slice(2);
  const helpSepIdx = argv.indexOf('--');
  const helpScopeArgv = helpSepIdx === -1 ? argv : argv.slice(0, helpSepIdx);
  const { flags } = parseArgs(helpScopeArgv);
  const json = wantsJson(helpScopeArgv, { flags });

  const wantsHelpFlag = wantsHelp(helpScopeArgv, { flags });
  const explicitCmd = helpScopeArgv.find((a) => a && a !== '--' && !a.startsWith('-')) || '';
  const cmd = explicitCmd || (wantsHelpFlag ? 'help' : 'status');

  const usageByCmd = new Map([
    ['status', 'hstack auth status [--json]'],
    ['login', 'hstack auth login [--identity=<name>] [--no-open] [--force] [--method=web|mobile] [--print] [--webapp=auto|stack|public|expo|hosted] [--webapp-url=<url>] [--start-if-needed] [--json]'],
    ['seed', 'hstack auth seed [name=dev-auth] [--login|--no-login] [--server=...] [--skip-default-seed] [--non-interactive] [--json]'],
    ['copy-from', 'hstack auth copy-from <sourceStack|legacy> --all [--except=main,dev-auth] [--force] [--with-infra] [--link] [--json]'],
    ['dev-key', 'hstack auth dev-key [--print] [--format=base64url|backup] [--set=<secret>] [--clear] [--json]'],
  ]);

  if (wantsHelpFlag && cmd !== 'help') {
    const usage = usageByCmd.get(cmd);
    if (usage) {
      printResult({
        json,
        data: { ok: true, cmd, usage },
        text: [`[auth ${cmd}] usage:`, `  ${usage}`, '', 'see also:', '  hstack auth --help'].join('\n'),
      });
      return;
    }
  }

  if (wantsHelpFlag || cmd === 'help') {
    printResult({
      json,
      data: { commands: ['status', 'login', 'seed', 'copy-from', 'dev-key'], stackScoped: 'hstack stack auth <name> status|login|copy-from' },
      text: [
        '',
        banner('auth', { subtitle: 'Login and auth seeding helpers for hstack.' }),
        '',
        sectionTitle('Usage (global)'),
        bullets([
          `${dim('status:')} ${cmdFmt('hstack auth status')} ${dim('[--json]')}`,
          `${dim('login:')}  ${cmdFmt('hstack auth login')} ${dim('[--identity=<name>] [--no-open] [--force] [--method=web|mobile] [--print] [--webapp=auto|stack|public|expo|hosted] [--webapp-url=<url>] [--start-if-needed] [--json]')}`,
          `${dim('seed stack:')} ${cmdFmt('hstack auth seed')} ${dim('[name=dev-auth] [--login|--no-login] [--server=...] [--skip-default-seed] [--non-interactive] [--json]')}`,
          `${dim('seed:')}   ${cmdFmt('hstack auth copy-from <sourceStack|legacy> --all')} ${dim('[--except=main,dev-auth] [--force] [--with-infra] [--link] [--json]')}`,
          `${dim('dev key:')} ${cmdFmt('hstack auth dev-key')} ${dim('[--print] [--format=base64url|backup] [--set=<secret>] [--clear] [--json]')}`,
        ]),
        '',
        sectionTitle('Usage (stack-scoped)'),
        bullets([
          `${dim('status:')} ${cmdFmt('hstack stack auth <name> status')} ${dim('[--json]')}`,
          `${dim('login:')}  ${cmdFmt('hstack stack auth <name> login')} ${dim('[--identity=<name>] [--no-open] [--force] [--method=web|mobile] [--print] [--webapp=auto|stack|public|expo|hosted] [--webapp-url=<url>] [--start-if-needed] [--json]')}`,
          `${dim('seed:')}   ${cmdFmt('hstack stack auth <name> copy-from <sourceStack|legacy>')} ${dim('[--force] [--with-infra] [--link] [--json]')}`,
        ]),
        '',
        sectionTitle('Advanced'),
        bullets([
          `${dim('UX labels only:')} ${cmdFmt('hstack auth login --context=selfhost|dev|stack')}`,
          `${dim('import legacy creds into main:')} ${cmdFmt('hstack auth copy-from legacy --allow-main')} ${dim('[--link] [--force]')}`,
        ]),
      ].join('\n'),
    });
    return;
  }

  if (cmd === 'status') {
    await cmdStatus({ json });
    return;
  }
  if (cmd === 'login') {
    await cmdLogin({ argv, json });
    return;
  }
  if (cmd === 'seed') {
    await cmdSeed({ argv, json });
    return;
  }
  if (cmd === 'copy-from') {
    await cmdCopyFrom({ argv, json });
    return;
  }
  if (cmd === 'dev-key') {
    await cmdDevKey({ argv, json });
    return;
  }

  throw new Error(`[auth] unknown command: ${cmd}`);
}

main().catch((err) => {
  console.error('[auth] failed:', err);
  process.exit(1);
});
