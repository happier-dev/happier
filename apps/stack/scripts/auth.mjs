import './utils/env/env.mjs';
import { parseArgs } from './utils/cli/args.mjs';
import { printResult, wantsHelp, wantsJson } from './utils/cli/cli.mjs';
import { getComponentDir, getDefaultAutostartPaths, getRootDir, getStackName, resolveStackEnvPath } from './utils/paths/paths.mjs';
import { listAllStackNames } from './utils/stack/stacks.mjs';
import { resolvePublicServerUrl } from './tailscale.mjs';
import { getInternalServerUrl, getPublicServerUrlEnvOverride, getWebappUrlEnvOverride } from './utils/server/urls.mjs';
import { fetchHappyHealth } from './utils/server/server.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { parseEnvToObject } from './utils/env/dotenv.mjs';
import { ensureDepsInstalled, pmExecBin } from './utils/proc/pm.mjs';
import { applyHappyServerMigrations, ensureHappyServerManagedInfra } from './utils/server/infra/happy_server_infra.mjs';
import { resolvePrismaClientImportForServerComponent, resolveServerLightPrismaMigrateDeployArgs } from './utils/server/flavor_scripts.mjs';
import { clearDevAuthKey, readDevAuthKey, writeDevAuthKey } from './utils/auth/dev_key.mjs';
import { getExpoStatePaths, isStateProcessRunning } from './utils/expo/expo.mjs';
import { resolveAuthSeedFromEnv } from './utils/stack/startup.mjs';
import { printAuthLoginInstructions } from './utils/auth/login_ux.mjs';
import { copyFileIfMissing, linkFileIfMissing, removeFileOrSymlinkIfExists, writeSecretFileIfMissing } from './utils/auth/files.mjs';
import { getLegacyHappyBaseDir, isLegacyAuthSourceName } from './utils/auth/sources.mjs';
import { isSandboxed, sandboxAllowsGlobalSideEffects } from './utils/env/sandbox.mjs';
import { resolveHandyMasterSecretFromStack } from './utils/auth/handy_master_secret.mjs';
import { ensureDir, readTextIfExists } from './utils/fs/ops.mjs';
import { stackExistsSync } from './utils/stack/stacks.mjs';
import { checkDaemonState } from './daemon.mjs';
import { parseCliIdentityOrThrow, resolveCliHomeDirForIdentity } from './utils/stack/cli_identities.mjs';
import {
  getCliHomeDirFromEnvOrDefault,
  getServerLightDataDirFromEnvOrDefault,
  resolveCliHomeDir,
} from './utils/stack/dirs.mjs';
import { resolveLocalhostHost, preferStackLocalhostUrl } from './utils/paths/localhost_host.mjs';
import { banner, bullets, cmd as cmdFmt, kv, ok, sectionTitle, warn } from './utils/ui/layout.mjs';
import { bold, cyan, dim } from './utils/ui/ansi.mjs';

function getInternalServerUrlCompat() {
  const { port, internalServerUrl } = getInternalServerUrl({ env: process.env, defaultPort: 3005 });
  return { port, url: internalServerUrl };
}

async function resolveWebappUrlFromRunningExpo({ rootDir, stackName }) {
  try {
    const baseDir = resolveStackEnvPath(stackName).baseDir;
    const uiDir = getComponentDir(rootDir, 'happy');
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

function fileHasContent(path) {
  try {
    if (!existsSync(path)) return false;
    return readFileSync(path, 'utf-8').trim().length > 0;
  } catch {
    return false;
  }
}

function authLoginSuggestion(stackName) {
  return stackName === 'main' ? 'hapsta auth login' : `hapsta stack auth ${stackName} login`;
}

function authCopyFromSeedSuggestion(stackName) {
  if (stackName === 'main') return null;
  const from = resolveAuthSeedFromEnv(process.env);
  return `hapsta stack auth ${stackName} copy-from ${from}`;
}

function resolveServerComponentForCurrentStack() {
  return (
    (process.env.HAPPIER_STACK_SERVER_COMPONENT ?? 'happy-server-light').trim() ||
    'happy-server-light'
  );
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
          `${dim('save locally:')} ${cmdFmt('hapsta auth dev-key --set "<base64url-secret-or-backup-format>"')}`,
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
  const v = (env.HAPPIER_STACK_SERVER_COMPONENT ?? 'happy-server-light').trim() || 'happy-server-light';
  return v === 'happy-server' ? 'happy-server' : 'happy-server-light';
}

function resolveDatabaseUrlForStackOrThrow({ env, stackName, baseDir, serverComponent, label }) {
  const v = (env.DATABASE_URL ?? '').toString().trim();
  if (v) {
    if (serverComponent === 'happy-server') {
      const lower = v.toLowerCase();
      const ok = lower.startsWith('postgresql://') || lower.startsWith('postgres://');
      if (!ok) {
        throw new Error(
          `[auth] invalid DATABASE_URL for ${label || `stack "${stackName}"`}: expected postgresql://... (got ${JSON.stringify(v)})`
        );
      }
    }
    return v;
  }
  if (serverComponent === 'happy-server-light') {
    const dataDir = (env.HAPPY_SERVER_LIGHT_DATA_DIR ?? '').toString().trim() || join(baseDir, 'server-light');
    return `file:${join(dataDir, 'happy-server-light.sqlite')}`;
  }
  throw new Error(`[auth] missing DATABASE_URL for ${label || `stack "${stackName}"`}`);
}

function resolveServerComponentDir({ rootDir, serverComponent }) {
  return getComponentDir(rootDir, serverComponent === 'happy-server' ? 'happy-server' : 'happy-server-light');
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
      '[auth] usage: hapsta stack auth <name> copy-from <sourceStack|legacy> [--force] [--with-infra] [--json]  OR  hapsta auth copy-from <sourceStack|legacy> --all [--except=main,dev-auth] [--force] [--with-infra] [--json]\n' +
        'notes:\n' +
        '  - sourceStack can be a stack name (e.g. main, dev-auth)\n' +
        '  - legacy uses ~/.happy/{cli,server-light} as a source (best-effort)'
    );
  }

  const { flags, kv } = parseArgs(argv);
  const all = flags.has('--all');
  if (isLegacyAuthSourceName(fromStackName) && isSandboxed() && !sandboxAllowsGlobalSideEffects()) {
    throw new Error(
      '[auth] legacy auth source is disabled in sandbox mode.\n' +
        'Reason: it reads from ~/.happy (global user state).\n' +
        'If you really want this, set: HAPPIER_STACK_SANDBOX_ALLOW_GLOBAL=1'
    );
  }
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
      '[auth] copy-from is intended for stack-scoped usage (e.g. hapsta stack auth <name> copy-from main), or pass --all.\n' +
        'If you really intend to seed the main Hapsta install, re-run with: --allow-main'
    );
  }

  const serverComponent = resolveServerComponentForCurrentStack();
  const serverDirForPrisma = resolveServerComponentDir({ rootDir, serverComponent });
  const targetBaseDir = getDefaultAutostartPaths().baseDir;
  const targetCli = resolveCliHomeDir();
  const targetServerLightDataDir =
    (process.env.HAPPY_SERVER_LIGHT_DATA_DIR ?? '').trim() || join(targetBaseDir, 'server-light');
  const targetSecretFile =
    (process.env.HAPPIER_STACK_HANDY_MASTER_SECRET_FILE ?? '').trim() || join(targetBaseDir, 'happy-server', 'handy-master-secret.txt');

  const isLegacySource = isLegacyAuthSourceName(fromStackName);
  if (isLegacySource && isSandboxed() && !sandboxAllowsGlobalSideEffects()) {
    throw new Error(
      '[auth] legacy auth source is disabled in sandbox mode.\n' +
        'Reason: it reads from ~/.happy (global user state).\n' +
        'If you really want this, set: HAPPIER_STACK_SANDBOX_ALLOW_GLOBAL=1'
    );
  }
  const { secret, source } = await resolveHandyMasterSecretFromStack({
    stackName: fromStackName,
    requireStackExists: !isLegacySource,
    allowLegacyAuthSource: !isSandboxed() || sandboxAllowsGlobalSideEffects(),
    allowLegacyMainFallback: !isSandboxed() || sandboxAllowsGlobalSideEffects(),
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

  if (secret) {
    if (serverComponent === 'happy-server-light') {
      const target = join(targetServerLightDataDir, 'handy-master-secret.txt');
      const sourcePath = source && !String(source).includes('(HANDY_MASTER_SECRET)') ? String(source) : '';
      if (linkMode && sourcePath && existsSync(sourcePath)) {
        copied.secret = await linkFileIfMissing({ from: sourcePath, to: target, force });
      } else {
        copied.secret = await writeSecretFileIfMissing({ path: target, secret, force });
      }
    } else if (serverComponent === 'happy-server') {
      const sourcePath = source && !String(source).includes('(HANDY_MASTER_SECRET)') ? String(source) : '';
      if (linkMode && sourcePath && existsSync(sourcePath)) {
        copied.secret = await linkFileIfMissing({ from: sourcePath, to: targetSecretFile, force });
      } else {
        copied.secret = await writeSecretFileIfMissing({ path: targetSecretFile, secret, force });
      }
    }
  }

  const sourceBaseDir = isLegacySource ? getLegacyHappyBaseDir() : resolveStackEnvPath(fromStackName).baseDir;
  const sourceEnvRaw = isLegacySource ? '' : await readTextIfExists(resolveStackEnvPath(fromStackName).envPath);
  const sourceEnv = sourceEnvRaw ? parseEnvToObject(sourceEnvRaw) : {};
  const sourceCli = isLegacySource
    ? join(sourceBaseDir, 'cli')
    : getCliHomeDirFromEnvOrDefault({ stackBaseDir: sourceBaseDir, env: sourceEnv });

  if (linkMode) {
    copied.accessKey = await linkFileIfMissing({ from: join(sourceCli, 'access.key'), to: join(targetCli, 'access.key'), force });
    copied.settings = await linkFileIfMissing({ from: join(sourceCli, 'settings.json'), to: join(targetCli, 'settings.json'), force });
  } else {
    copied.accessKey = await copyFileIfMissing({
      from: join(sourceCli, 'access.key'),
      to: join(targetCli, 'access.key'),
      mode: 0o600,
      force,
    });
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

    const fromServerComponent = isLegacySource ? 'happy-server-light' : resolveServerComponentFromEnv(sourceEnv);
    const fromDatabaseUrl = resolveDatabaseUrlForStackOrThrow({
      env: sourceEnv,
      stackName: fromStackName,
      baseDir: sourceBaseDir,
      serverComponent: fromServerComponent,
      label: `source stack "${fromStackName}"`,
    });
    const targetEnv = process.env;
    const targetServerComponent = resolveServerComponentFromEnv(targetEnv);
    let targetDatabaseUrl;
    try {
      targetDatabaseUrl = resolveDatabaseUrlForStackOrThrow({
        env: targetEnv,
        stackName,
        baseDir: targetBaseDir,
        serverComponent: targetServerComponent,
        label: `target stack "${stackName}"`,
      });
    } catch (e) {
      // For full server stacks, allow `copy-from --with-infra` to bring up Docker infra just-in-time
      // so we can seed DB accounts reliably.
      const managed = (targetEnv.HAPPIER_STACK_MANAGED_INFRA ?? '1').toString().trim() !== '0';
      if (targetServerComponent === 'happy-server' && withInfra && managed) {
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
          (targetServerComponent === 'happy-server' ? `If this is a managed infra stack, re-run with --with-infra.` : '')
      );
    }

    const runSeed = async () => {
      const seeded = await seedAccountsFromSourceDbToTargetDb({
        rootDir,
        fromStackName,
        fromServerComponent,
        fromDatabaseUrl,
        targetStackName: stackName,
        targetServerComponent,
        targetDatabaseUrl,
        force,
      });
      copied.dbAccounts = { sourceCount: seeded.sourceCount, insertedCount: seeded.insertedCount };
      copied.db = true;
      copied.dbError = null;
    };

    try {
      await runSeed();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // If the target DB exists but hasn't had schema applied yet, Prisma will report missing tables.
      // Fix it best-effort by applying schema, then retry seeding once.
      const looksLikeMissingTable = msg.toLowerCase().includes('does not exist') || msg.toLowerCase().includes('no such table');
      if (looksLikeMissingTable) {
        if (serverComponent === 'happy-server-light') {
          await pmExecBin({
            dir: serverDirForPrisma,
            bin: 'prisma',
            args: resolveServerLightPrismaMigrateDeployArgs({ serverDir: serverDirForPrisma }),
            env: { ...process.env, DATABASE_URL: targetDatabaseUrl },
            quiet: json,
          }).catch(() => {});
        } else if (serverComponent === 'happy-server') {
          await applyHappyServerMigrations({
            serverDir: serverDirForPrisma,
            env: { ...process.env, DATABASE_URL: targetDatabaseUrl },
            quiet: json,
          }).catch(() => {});
        }
        await runSeed();
      } else {
        throw e;
      }
    }
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
  const accessKeyPath = join(cliHomeDir, 'access.key');
  const settingsPath = join(cliHomeDir, 'settings.json');

  const auth = {
    ok: fileHasContent(accessKeyPath),
    accessKeyPath,
    hasAccessKey: fileHasContent(accessKeyPath),
    settingsPath,
    hasSettings: fileHasContent(settingsPath),
  };

  const daemon = checkDaemonState(cliHomeDir);
  const healthRaw = await fetchHappyHealth(internalServerUrl);
  const health = {
    ok: Boolean(healthRaw.ok),
    status: healthRaw.status,
    body: healthRaw.text ? healthRaw.text.trim() : null,
  };

  const out = {
    stackName,
    internalServerUrl,
    publicServerUrl,
    cliHomeDir,
    cliIdentity: identity,
    auth,
    daemon,
    serverHealth: health,
    cliBin: join(getComponentDir(rootDir, 'happy-cli'), 'bin', 'happy.mjs'),
  };

  if (json) {
    printResult({ json, data: out });
    return;
  }

  const authLine = auth.ok ? '✅ auth: ok' : '❌ auth: required';
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
  }
  console.log(daemonLine);
  console.log(serverLine);
  if (!health.ok) {
    const startHint = stackName === 'main' ? 'hapsta dev' : `hapsta stack dev ${stackName}`;
    console.log(`  ↪ this stack does not appear to be running. Start it with: ${startHint}`);
    return;
  }
  if (auth.ok && daemon.status !== 'running') {
    console.log(`  ↪ daemon is not running for this stack. If you expected it to be running, try: hapsta doctor`);
  }
}

async function cmdLogin({ argv, json }) {
  const rootDir = getRootDir(import.meta.url);
  const stackName = getStackName();
  const { flags, kv } = parseArgs(argv);

  const { port, url: internalServerUrl } = getInternalServerUrlCompat();
  const { defaultPublicUrl, envPublicUrl } = getPublicServerUrlEnvOverride({ env: process.env, serverPort: port, stackName });
  const { publicServerUrl } = await resolvePublicServerUrl({
    internalServerUrl,
    defaultPublicUrl,
    envPublicUrl,
    allowEnable: false,
    stackName,
  });
  const { envWebappUrl } = getWebappUrlEnvOverride({ env: process.env, stackName });
  const expoWebappUrl = await resolveWebappUrlFromRunningExpo({ rootDir, stackName });
  const webappUrlRaw = envWebappUrl || expoWebappUrl || publicServerUrl;
  const webappUrl = await preferStackLocalhostUrl(webappUrlRaw, { stackName });
  const webappUrlSource = expoWebappUrl ? 'expo' : envWebappUrl ? 'stack env override' : 'server';

  const identity = parseCliIdentityOrThrow((kv.get('--identity') ?? '').trim());
  const cliHomeDir = resolveCliHomeDirForIdentity({ cliHomeDir: resolveCliHomeDir(), identity });
  const cliBin = join(getComponentDir(rootDir, 'happy-cli'), 'bin', 'happy.mjs');

  const force = !argv.includes('--no-force');
  const wantPrint = argv.includes('--print');
  const noOpen = flags.has('--no-open') || flags.has('--no-browser') || flags.has('--no-browser-open');
  const contextRaw =
    (kv.get('--context') ?? process.env.HAPPIER_STACK_AUTH_LOGIN_CONTEXT ?? '')
      .toString()
      .trim();
  const context = contextRaw || (stackName === 'main' ? 'generic' : 'stack');

  const nodeArgs = [cliBin, 'auth', 'login'];
  if (force || argv.includes('--force')) {
    nodeArgs.push('--force');
  }
  if (noOpen) {
    nodeArgs.push('--no-open');
  }

  const env = {
    ...process.env,
    HAPPY_HOME_DIR: cliHomeDir,
    HAPPY_SERVER_URL: internalServerUrl,
    HAPPY_WEBAPP_URL: webappUrl,
    ...(noOpen ? { HAPPY_NO_BROWSER_OPEN: '1' } : {}),
  };

  if (wantPrint) {
    const cmd =
      `HAPPY_HOME_DIR="${cliHomeDir}" ` +
      `HAPPY_SERVER_URL="${internalServerUrl}" ` +
      `HAPPY_WEBAPP_URL="${webappUrl}" ` +
      (noOpen ? `HAPPY_NO_BROWSER_OPEN="1" ` : '') +
      `node "${cliBin}" auth login` +
      (nodeArgs.includes('--force') ? ' --force' : '') +
      (noOpen ? ' --no-open' : '');
    if (json) {
      printResult({ json, data: { ok: true, stackName, cliIdentity: identity, cmd } });
    } else {
      console.log(cmd);
    }
    return;
  }

  const quietUx = flags.has('--quiet') || flags.has('--no-ux');
  if (!json && !quietUx) {
    printAuthLoginInstructions({
      stackName,
      context,
      webappUrl,
      webappUrlSource,
      internalServerUrl,
      publicServerUrl,
      rerunCmd: authLoginSuggestion(stackName),
    });
  }

  const child = spawn(process.execPath, nodeArgs, {
    cwd: rootDir,
    env,
    stdio: 'inherit',
  });

  const timeoutMsRaw =
    (process.env.HAPPIER_STACK_AUTH_LOGIN_TIMEOUT_MS ?? '600000').toString().trim();
  const timeoutMs = timeoutMsRaw ? Number(timeoutMsRaw) : 600000;
  const hasTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0;

  let exiting = false;
  const killChild = (signal) => {
    if (exiting) return;
    exiting = true;
    try {
      child.kill(signal);
    } catch {
      // ignore
    }
    setTimeout(() => {
      try {
        if (child.pid) process.kill(child.pid, 'SIGKILL');
      } catch {
        // ignore
      }
    }, 1500).unref?.();
  };

  const onSigint = () => killChild('SIGINT');
  const onSigterm = () => killChild('SIGTERM');
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);

  const t = hasTimeout
    ? setTimeout(() => {
        console.warn(`[auth] login timed out after ${timeoutMs}ms (set HAPPIER_STACK_AUTH_LOGIN_TIMEOUT_MS=0 to disable)`);
        killChild('SIGTERM');
      }, timeoutMs)
    : null;

  await new Promise((resolve) => child.on('exit', resolve));
  process.off('SIGINT', onSigint);
  process.off('SIGTERM', onSigterm);
  if (t) clearTimeout(t);
  if (json) {
    printResult({ json, data: { ok: child.exitCode === 0, exitCode: child.exitCode } });
  } else if (child.exitCode && child.exitCode !== 0) {
    process.exit(child.exitCode);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const { flags } = parseArgs(argv);
  const json = wantsJson(argv, { flags });

  const cmd = argv.find((a) => !a.startsWith('--')) || 'status';
  if (wantsHelp(argv, { flags }) || cmd === 'help') {
    printResult({
      json,
      data: { commands: ['status', 'login', 'copy-from', 'dev-key'], stackScoped: 'hapsta stack auth <name> status|login|copy-from' },
      text: [
        '',
        banner('auth', { subtitle: 'Login and auth seeding helpers for Hapsta.' }),
        '',
        sectionTitle('Usage (global)'),
        bullets([
          `${dim('status:')} ${cmdFmt('hapsta auth status')} ${dim('[--json]')}`,
          `${dim('login:')}  ${cmdFmt('hapsta auth login')} ${dim('[--identity=<name>] [--no-open] [--force] [--print] [--json]')}`,
          `${dim('seed:')}   ${cmdFmt('hapsta auth copy-from <sourceStack|legacy> --all')} ${dim('[--except=main,dev-auth] [--force] [--with-infra] [--link] [--json]')}`,
          `${dim('dev key:')} ${cmdFmt('hapsta auth dev-key')} ${dim('[--print] [--format=base64url|backup] [--set=<secret>] [--clear] [--json]')}`,
        ]),
        '',
        sectionTitle('Usage (stack-scoped)'),
        bullets([
          `${dim('status:')} ${cmdFmt('hapsta stack auth <name> status')} ${dim('[--json]')}`,
          `${dim('login:')}  ${cmdFmt('hapsta stack auth <name> login')} ${dim('[--identity=<name>] [--no-open] [--force] [--print] [--json]')}`,
          `${dim('seed:')}   ${cmdFmt('hapsta stack auth <name> copy-from <sourceStack|legacy>')} ${dim('[--force] [--with-infra] [--link] [--json]')}`,
        ]),
        '',
        sectionTitle('Advanced'),
        bullets([
          `${dim('UX labels only:')} ${cmdFmt('hapsta auth login --context=selfhost|dev|stack')}`,
          `${dim('import legacy creds into main:')} ${cmdFmt('hapsta auth copy-from legacy --allow-main')} ${dim('[--link] [--force]')}`,
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
