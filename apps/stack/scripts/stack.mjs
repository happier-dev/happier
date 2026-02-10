import './utils/env/env.mjs';
import { chmod, copyFile, mkdir, readFile, readdir, rename } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
// NOTE: random bytes usage centralized in scripts/utils/crypto/tokens.mjs
import { homedir } from 'node:os';
import { ensureDir, readTextIfExists, readTextOrEmpty } from './utils/fs/ops.mjs';

import { parseArgs } from './utils/cli/args.mjs';
import { killProcessTree, run, runCapture } from './utils/proc/proc.mjs';
import {
  coerceHappyMonorepoRootFromPath,
  getComponentDir,
  getHappyStacksHomeDir,
  getRootDir,
  getWorkspaceDir,
  happyMonorepoSubdirForComponent,
  resolveStackEnvPath,
} from './utils/paths/paths.mjs';
import { isTcpPortFree, pickNextFreeTcpPort } from './utils/net/ports.mjs';
import { collectReservedStackPorts, getDefaultPortStart, isPortFree, pickNextFreePort, readPortFromEnvFile } from './stack/port_reservation.mjs';
import {
  createWorktreeFromBaseWorktree,
  WORKTREE_CATEGORIES,
  getWorktreeCategoryRoot,
  inferRemoteNameForOwner,
  isWorktreePath,
  worktreeSpecFromDir,
} from './utils/git/worktrees.mjs';
import { isTty, prompt, promptSelect, withRl } from './utils/cli/wizard.mjs';
import { parseEnvToObject } from './utils/env/dotenv.mjs';
import { printResult, wantsHelp, wantsJson } from './utils/cli/cli.mjs';
import { normalizeStackNameFirstArgs, resolveTopLevelNodeScriptFile, stackNameFromArg } from './stack/command_arguments.mjs';
import { getStackHelpUsageLine, renderStackRootHelpText, renderStackSubcommandHelpText, STACK_HELP_COMMANDS } from './stack/help_text.mjs';
import { copyAuthFromStackIntoNewStack } from './stack/copy_auth_from_stack.mjs';
import {
  getRuntimePortExtraEnv,
  parseServerComponentFromEnv,
  readStackEnvObject,
  resolveDefaultRepoEnv,
  withStackEnv,
  writeStackEnv,
} from './stack/stack_environment.mjs';
import { cmdAuth, cmdListStacks, cmdService, cmdSrv, cmdTailscale, cmdWt } from './stack/delegated_script_commands.mjs';
import { runStackDaemonCommand } from './stack/stack_daemon_command.mjs';
import { runStackHappierPassthroughCommand } from './stack/stack_happier_passthrough_command.mjs';
import { runStackMobileInstallCommand } from './stack/stack_mobile_install_command.mjs';
import { runStackResumeCommand } from './stack/stack_resume_command.mjs';
import { runStackStopCommand } from './stack/stack_stop_command.mjs';
import { readStackInfoSnapshot } from './stack/stack_info_snapshot.mjs';
import { runStackScriptWithStackEnv } from './stack/run_script_with_stack_env.mjs';
import { printDelegatedStackHelpIfAvailable } from './stack/stack_delegated_help.mjs';
import { runStackWorkspaceCommand } from './stack/stack_workspace_command.mjs';
import { resolveRequestedRepoCheckoutDir } from './stack/repo_checkout_resolution.mjs';
import { resolveTransientRepoOverrides } from './stack/transient_repo_overrides.mjs';
import { ensureEnvFilePruned, ensureEnvFileUpdated } from './utils/env/env_file.mjs';
import { listAllStackNames, stackExistsSync } from './utils/stack/stacks.mjs';
import { writeDevAuthKey } from './utils/auth/dev_key.mjs';
import { startDevServer } from './utils/dev/server.mjs';
import { ensureDevExpoServer } from './utils/dev/expo_dev.mjs';
import { requireDir } from './utils/proc/pm.mjs';
import { waitForHttpOk } from './utils/server/server.mjs';
import { resolveLocalhostHost, preferStackLocalhostUrl } from './utils/paths/localhost_host.mjs';
import { openUrlInBrowser } from './utils/ui/browser.mjs';
import { buildConfigureServerLinks } from '@happier-dev/cli-common/links';
import { bold, cyan, dim, green, yellow } from './utils/ui/ansi.mjs';
import { bullets, sectionTitle } from './utils/ui/layout.mjs';
import { findAnyCredentialPathInCliHome } from './utils/auth/credentials_paths.mjs';
import { resolveAuthSeedFromEnv } from './utils/stack/startup.mjs';
import { getHomeEnvLocalPath } from './utils/env/config.mjs';
import { isSandboxed, sandboxAllowsGlobalSideEffects } from './utils/env/sandbox.mjs';
import { getEnvValue, getEnvValueAny } from './utils/env/values.mjs';
import { sanitizeDnsLabel } from './utils/net/dns.mjs';
import {
  getStackRuntimeStatePath,
  isPidAlive,
  readStackRuntimeStateFile,
} from './utils/stack/runtime_state.mjs';
import { killPid } from './utils/expo/expo.mjs';
import { randomToken } from './utils/crypto/tokens.mjs';
import { sanitizeSlugPart } from './utils/git/refs.mjs';
import { readLastLines } from './utils/fs/tail.mjs';
import { interactiveEdit, interactiveNew } from './utils/stack/interactive_stack_config.mjs';
import { normalizeStackNameOrNull } from './utils/stack/names.mjs';
import { runOrchestratedGuidedAuthFlow } from './utils/auth/orchestrated_stack_auth_flow.mjs';
import { assertExpoWebappBundlesOrThrow } from './utils/auth/stack_guided_login.mjs';
import { createStepPrinter } from './utils/cli/progress.mjs';
import { getVerbosityLevel } from './utils/cli/verbosity.mjs';
import { applyBindModeToEnv, resolveBindModeFromArgs } from './utils/net/bind_mode.mjs';
import { getTodayYmd } from './utils/time/get_today_ymd.mjs';

const readExistingEnv = readTextOrEmpty;
const STACK_BACKGROUND_SCRIPT_BY_COMMAND = new Map([
  ['dev', resolveTopLevelNodeScriptFile('dev') || 'dev.mjs'],
  ['start', resolveTopLevelNodeScriptFile('start') || 'run.mjs'],
]);
const STACK_REPO_OVERRIDE_SCRIPT_BY_COMMAND = new Map([
  ['build', resolveTopLevelNodeScriptFile('build') || 'build.mjs'],
  ['typecheck', resolveTopLevelNodeScriptFile('typecheck') || 'typecheck.mjs'],
  ['lint', resolveTopLevelNodeScriptFile('lint') || 'lint.mjs'],
  ['test', resolveTopLevelNodeScriptFile('test') || 'test_cmd.mjs'],
  ['review', resolveTopLevelNodeScriptFile('review') || 'review.mjs'],
]);

async function cmdNew({ rootDir, argv, emit = true }) {
  const { flags, kv } = parseArgs(argv);
  const positionals = argv.filter((a) => !a.startsWith('--'));
  const json = wantsJson(argv, { flags });
  const copyAuth = !(flags.has('--no-copy-auth') || flags.has('--fresh-auth'));
  const copyAuthFrom =
    (kv.get('--copy-auth-from') ?? '').trim() ||
    (process.env.HAPPIER_STACK_AUTH_SEED_FROM ?? '').trim() ||
    'main';
  const linkAuth =
    flags.has('--link-auth') ||
    flags.has('--link') ||
    flags.has('--symlink-auth') ||
    (kv.get('--link-auth') ?? '').trim() === '1' ||
    (kv.get('--auth-mode') ?? '').trim() === 'link' ||
    (kv.get('--copy-auth-mode') ?? '').trim() === 'link' ||
    (process.env.HAPPIER_STACK_AUTH_LINK ?? '').toString().trim() === '1' ||
    (process.env.HAPPIER_STACK_AUTH_MODE ?? '').toString().trim() === 'link';
  const forcePort = flags.has('--force-port');
  const dbProviderRaw = (kv.get('--db-provider') ?? kv.get('--db') ?? '').toString().trim().toLowerCase();
  const databaseUrlOverride = (kv.get('--database-url') ?? '').toString().trim();

  // argv here is already "args after 'new'", so the first positional is the stack name.
  let stackName = stackNameFromArg(positionals, 0);
  const interactive =
    flags.has('--interactive') ||
    (!flags.has('--non-interactive') && isTty() && !json);

  const defaults = {
    stackName,
    port: kv.get('--port')?.trim() ? Number(kv.get('--port')) : null,
    serverComponent: (kv.get('--server') ?? '').trim() || '',
    createRemote: (kv.get('--remote') ?? '').trim() || '',
    repo: (kv.get('--repo') ?? kv.get('--repo-dir') ?? '').trim() || null,
  };

  let config = defaults;
  if (interactive) {
    config = await withRl((rl) => interactiveNew({ rootDir, rl, defaults }));
  }

  stackName = config.stackName?.trim() ? config.stackName.trim() : '';
  if (!stackName) {
    throw new Error(
      '[stack] usage: hstack stack new <name> [--port=NNN] [--server=happier-server|happier-server-light] ' +
        '[--repo=<owner/...>|<path>|default] [--remote=<name>] [--db-provider=pglite|sqlite|postgres|mysql] [--database-url=<url>] ' +
        '[--copy-auth-from=<stack>] [--link-auth] [--no-copy-auth] [--interactive] [--non-interactive] [--force-port]'
    );
  }
  const normalizedName = normalizeStackNameOrNull(stackName);
  if (!normalizedName) {
    throw new Error(
      `[stack] invalid stack name: ${JSON.stringify(stackName)}\n` +
        `[stack] stack names must be DNS-safe labels (lowercase letters/numbers/hyphens).\n` +
        `[stack] Example: my-stack`
    );
  }
  {
    const changedBeyondCase = normalizedName !== stackName.toLowerCase();
    stackName = normalizedName;
    if (!json && emit && changedBeyondCase) {
      console.warn(`[stack] normalized stack name to: ${stackName}`);
    }
  }
  if (stackName === 'main') {
    throw new Error('[stack] stack name \"main\" is reserved (use the default stack without creating it)');
  }

  const serverComponent = (config.serverComponent || 'happier-server-light').trim();
  if (serverComponent !== 'happier-server-light' && serverComponent !== 'happier-server') {
    throw new Error(`[stack] invalid server component: ${serverComponent}`);
  }
  const effectiveDbProvider =
    dbProviderRaw ||
    (serverComponent === 'happier-server-light' ? 'sqlite' : 'postgres');
  if (serverComponent === 'happier-server-light' && effectiveDbProvider !== 'pglite' && effectiveDbProvider !== 'sqlite') {
    throw new Error(`[stack] invalid --db-provider for happier-server-light: ${effectiveDbProvider} (supported: pglite, sqlite)`);
  }
  if (serverComponent === 'happier-server' && effectiveDbProvider !== 'postgres' && effectiveDbProvider !== 'mysql') {
    throw new Error(`[stack] invalid --db-provider for happier-server: ${effectiveDbProvider} (supported: postgres, mysql)`);
  }
  if (serverComponent === 'happier-server' && effectiveDbProvider === 'mysql' && !databaseUrlOverride) {
    throw new Error(
      `[stack] mysql support requires an explicit DATABASE_URL.\n` +
        `Fix:\n` +
        `- re-run with: --database-url=mysql://...\n` +
        `- or use the default: --db-provider=postgres\n`
    );
  }

  const baseDir = resolveStackEnvPath(stackName).baseDir;
  const uiBuildDir = join(baseDir, 'ui');
  const cliHomeDir = join(baseDir, 'cli');

  // Port strategy:
  // - If --port is provided, we treat it as a pinned port and persist it in the stack env.
  // - Otherwise, ports are ephemeral and chosen at stack start time (stored only in stack.runtime.json).
  let port = config.port;
  if (!Number.isFinite(port) || port <= 0) {
    port = null;
  }
  if (port != null) {
    // If user picked a port explicitly, fail-closed on collisions by default.
    const reservedPorts = await collectReservedStackPorts();
    if (!forcePort && reservedPorts.has(port)) {
      throw new Error(
        `[stack] port ${port} is already reserved by another stack env.\n` +
          `Fix:\n` +
          `- omit --port to use an ephemeral port at start time (recommended)\n` +
          `- or pick a different --port\n` +
          `- or re-run with --force-port (not recommended)\n`
      );
    }
    if (!(await isTcpPortFree(port))) {
      throw new Error(
        `[stack] port ${port} is not free on 127.0.0.1.\n` +
          `Fix:\n` +
          `- omit --port to use an ephemeral port at start time (recommended)\n` +
          `- or stop the process currently using ${port}\n`
      );
    }
  }

  const defaultRepoEnv = resolveDefaultRepoEnv({ rootDir });

  // Prepare component dirs (may create worktrees).
  const stackEnv = {
    HAPPIER_STACK_STACK: stackName,
    HAPPIER_STACK_SERVER_COMPONENT: serverComponent,
    HAPPIER_STACK_UI_BUILD_DIR: uiBuildDir,
    HAPPIER_STACK_CLI_HOME_DIR: cliHomeDir,
    HAPPIER_STACK_STACK_REMOTE: config.createRemote?.trim() ? config.createRemote.trim() : 'upstream',
    ...defaultRepoEnv,
  };
  // Persist DB provider explicitly so existing behavior is stable even if defaults evolve later.
  stackEnv.HAPPIER_DB_PROVIDER = effectiveDbProvider;
  // Power user knob: override DATABASE_URL (required for mysql today, useful for external DBs).
  if (databaseUrlOverride) {
    if (serverComponent === 'happier-server-light') {
      throw new Error('[stack] --database-url is not supported for happier-server-light');
    }
    stackEnv.DATABASE_URL = databaseUrlOverride;
  }
  if (port != null) {
    stackEnv.HAPPIER_STACK_SERVER_PORT = String(port);
  }

  // Server-light storage isolation: ensure stacks have their own light data dir.
  // (This prevents a dev stack from mutating main stack's data when schema changes.)
  if (serverComponent === 'happier-server-light') {
    const dataDir = join(baseDir, 'server-light');
    stackEnv.HAPPIER_SERVER_LIGHT_DATA_DIR = dataDir;
    stackEnv.HAPPIER_SERVER_LIGHT_FILES_DIR = join(dataDir, 'files');
    if (effectiveDbProvider !== 'sqlite') {
      stackEnv.HAPPIER_SERVER_LIGHT_DB_DIR = join(dataDir, 'pglite');
    }
  }
  if (serverComponent === 'happier-server') {
    // Persist stable infra credentials in the stack env (ports are ephemeral unless explicitly pinned).
    const pgUser = 'handy';
    const pgPassword = randomToken(24);
    const pgDb = 'handy';
    const s3Bucket = sanitizeDnsLabel(`happier-${stackName}`, { fallback: 'happier' });
    const s3AccessKey = randomToken(12);
    const s3SecretKey = randomToken(24);

    stackEnv.HAPPIER_STACK_MANAGED_INFRA = stackEnv.HAPPIER_STACK_MANAGED_INFRA ?? '1';
    stackEnv.HAPPIER_STACK_PG_USER = pgUser;
    stackEnv.HAPPIER_STACK_PG_PASSWORD = pgPassword;
    stackEnv.HAPPIER_STACK_PG_DATABASE = pgDb;
    stackEnv.HAPPIER_STACK_HANDY_MASTER_SECRET_FILE = join(baseDir, 'happier-server', 'handy-master-secret.txt');
    stackEnv.S3_ACCESS_KEY = s3AccessKey;
    stackEnv.S3_SECRET_KEY = s3SecretKey;
    stackEnv.S3_BUCKET = s3Bucket;

	    // If user explicitly pinned the server port, also pin the rest of the ports + derived URLs for reproducibility.
	    if (port != null) {
	      const reservedPorts = await collectReservedStackPorts();
	      reservedPorts.add(port);
	      const backendPort = await pickNextFreePort(port + 10, { reservedPorts });
	      reservedPorts.add(backendPort);
	      const wantsManagedPostgres = effectiveDbProvider === 'postgres' && !databaseUrlOverride;
	      const baseInfraPort = port + 1000;
	      const dbPort = wantsManagedPostgres ? await pickNextFreePort(baseInfraPort, { reservedPorts }) : null;
	      if (dbPort != null) reservedPorts.add(dbPort);
	      const redisBase = dbPort != null ? dbPort + 1 : baseInfraPort;
	      const redisPort = await pickNextFreePort(redisBase, { reservedPorts });
	      reservedPorts.add(redisPort);
	      const minioPort = await pickNextFreePort(redisPort + 1, { reservedPorts });
	      reservedPorts.add(minioPort);
	      const minioConsolePort = await pickNextFreePort(minioPort + 1, { reservedPorts });

	      const s3PublicUrl = `http://127.0.0.1:${minioPort}/${s3Bucket}`;

	      stackEnv.HAPPIER_STACK_SERVER_BACKEND_PORT = String(backendPort);
	      if (dbPort != null) {
	        stackEnv.HAPPIER_STACK_PG_PORT = String(dbPort);
	      }
	      stackEnv.HAPPIER_STACK_REDIS_PORT = String(redisPort);
	      stackEnv.HAPPIER_STACK_MINIO_PORT = String(minioPort);
	      stackEnv.HAPPIER_STACK_MINIO_CONSOLE_PORT = String(minioConsolePort);

	      // Vars consumed by happier-server:
	      if (databaseUrlOverride) {
	        stackEnv.DATABASE_URL = databaseUrlOverride;
	      } else if (effectiveDbProvider === 'postgres' && dbPort != null) {
	        stackEnv.DATABASE_URL = `postgresql://${encodeURIComponent(pgUser)}:${encodeURIComponent(pgPassword)}@127.0.0.1:${dbPort}/${encodeURIComponent(pgDb)}`;
	      }
		      stackEnv.REDIS_URL = `redis://127.0.0.1:${redisPort}`;
		      stackEnv.S3_HOST = '127.0.0.1';
	      stackEnv.S3_PORT = String(minioPort);
	      stackEnv.S3_USE_SSL = 'false';
	      stackEnv.S3_PUBLIC_URL = s3PublicUrl;
	    }
  }

  // Pin the repo checkout/worktree for this stack (single monorepo).
  // Default is already set via resolveDefaultRepoEnv(); this only applies when the user
  // explicitly selected a different repo source.
  if (config.repo) {
    const resolved = await resolveRequestedRepoCheckoutDir({
      rootDir,
      repoSelection: config.repo,
      defaultRepoDir: String(defaultRepoEnv.HAPPIER_STACK_REPO_DIR ?? '').trim(),
      remoteName: config.repo?.remote || stackEnv.HAPPIER_STACK_STACK_REMOTE,
    });

    if (!resolved || !existsSync(resolved)) {
      throw new Error(
        `[stack] repo checkout does not exist: ${resolved || '(empty)'}\n` +
          `Fix:\n` +
          `- run: hstack setup --profile=dev (clones the monorepo into the workspace)\n` +
          `- or pass an explicit --repo=<path|worktreeSpec>\n`
      );
    }

    const monoRoot = coerceHappyMonorepoRootFromPath(resolved);
    if (!monoRoot) {
      throw new Error(
        `[stack] invalid repo checkout (expected Happier monorepo root): ${resolved}\n` +
          `- expected to contain apps/ui, apps/cli, and apps/server\n`
      );
    }
    stackEnv.HAPPIER_STACK_REPO_DIR = monoRoot;
  }

  if (copyAuth) {
    // Default: inherit seed stack auth so creating a new stack doesn't require re-login.
    // Source: --copy-auth-from (highest), else HAPPIER_STACK_AUTH_SEED_FROM (default: main).
    // Users can opt out with --no-copy-auth to force a fresh auth / machine identity.
    await copyAuthFromStackIntoNewStack({
      fromStackName: copyAuthFrom,
      stackName,
      stackEnv,
      serverComponent,
      json,
      requireSourceStackExists: kv.has('--copy-auth-from'),
      linkMode: linkAuth,
    }).catch((err) => {
      if (!json && emit) {
        console.warn(`[stack] auth copy skipped: ${err instanceof Error ? err.message : String(err)}`);
        console.warn(`[stack] tip: you can always run: hstack stack auth ${stackName} login`);
      }
    });
  }

  const envPath = await writeStackEnv({ stackName, env: stackEnv });
  const res = { ok: true, stackName, envPath, port: port ?? null, serverComponent, portsMode: port == null ? 'ephemeral' : 'pinned' };
  if (emit) {
    printResult({
      json,
      data: res,
      text: [
        `[stack] created ${stackName}`,
        `[stack] env: ${envPath}`,
        `[stack] port: ${port == null ? 'ephemeral (picked at start)' : String(port)}`,
        `[stack] server: ${serverComponent}`,
      ].join('\n'),
    });
  }
  return res;
}

async function cmdEdit({ rootDir, argv }) {
  const { flags } = parseArgs(argv);
  const json = wantsJson(argv, { flags });
  const positionals = argv.filter((a) => !a.startsWith('--'));
  const stackName = stackNameFromArg(positionals, 1);
  if (!stackName) {
    throw new Error('[stack] usage: hstack stack edit <name> [--interactive]');
  }

  const envPath = resolveStackEnvPath(stackName).envPath;
  const raw = await readExistingEnv(envPath);
  const existingEnv = parseEnvToObject(raw);

  const interactive = flags.has('--interactive') || (!flags.has('--no-interactive') && isTty());
  if (!interactive) {
    throw new Error('[stack] edit currently requires --interactive (non-interactive editing not implemented yet).');
  }

  const defaults = {
    stackName,
    port: null,
    serverComponent: '',
    createRemote: '',
    repo: null,
  };

  const config = await withRl((rl) => interactiveEdit({ rootDir, rl, stackName, existingEnv, defaults }));

  // Build next env, starting from existing env but enforcing stack-scoped invariants.
  const baseDir = resolveStackEnvPath(stackName).baseDir;
  const uiBuildDir = join(baseDir, 'ui');
  const cliHomeDir = join(baseDir, 'cli');

  let port = config.port;
  if (!Number.isFinite(port) || port <= 0) {
    port = null;
  }

  const serverComponent = (config.serverComponent || existingEnv.HAPPIER_STACK_SERVER_COMPONENT || 'happier-server-light').trim();

  const next = {
    HAPPIER_STACK_STACK: stackName,
    HAPPIER_STACK_SERVER_COMPONENT: serverComponent,
    HAPPIER_STACK_UI_BUILD_DIR: uiBuildDir,
    HAPPIER_STACK_CLI_HOME_DIR: cliHomeDir,
    HAPPIER_STACK_STACK_REMOTE: config.createRemote?.trim()
      ? config.createRemote.trim()
      : (existingEnv.HAPPIER_STACK_STACK_REMOTE || 'upstream'),
    // Always pin defaults; overrides below can replace.
    ...resolveDefaultRepoEnv({ rootDir }),
  };
  if ((existingEnv.HAPPIER_STACK_REPO_DIR ?? '').trim()) {
    next.HAPPIER_STACK_REPO_DIR = String(existingEnv.HAPPIER_STACK_REPO_DIR).trim();
  }
  if (port != null) {
    next.HAPPIER_STACK_SERVER_PORT = String(port);
  }

  if (serverComponent === 'happier-server-light') {
    const dataDir = join(baseDir, 'server-light');
    next.HAPPIER_SERVER_LIGHT_DATA_DIR = dataDir;
    next.HAPPIER_SERVER_LIGHT_FILES_DIR = join(dataDir, 'files');
    next.HAPPIER_SERVER_LIGHT_DB_DIR = join(dataDir, 'pglite');
    // Light flavor manages its own embedded pglite connection string at runtime.
    // Do not persist DATABASE_URL in the stack env.
    delete next.DATABASE_URL;
  }
  if (serverComponent === 'happier-server') {
    // Persist stable infra credentials. Ports are ephemeral unless explicitly pinned.
    const pgUser = (existingEnv.HAPPIER_STACK_PG_USER ?? 'handy').trim() || 'handy';
    const pgPassword = (existingEnv.HAPPIER_STACK_PG_PASSWORD ?? '').trim() || randomToken(24);
    const pgDb = (existingEnv.HAPPIER_STACK_PG_DATABASE ?? 'handy').trim() || 'handy';
    const s3Bucket =
      (existingEnv.S3_BUCKET ?? sanitizeDnsLabel(`happier-${stackName}`, { fallback: 'happier' })).trim() ||
      sanitizeDnsLabel(`happier-${stackName}`, { fallback: 'happier' });
    const s3AccessKey = (existingEnv.S3_ACCESS_KEY ?? '').trim() || randomToken(12);
    const s3SecretKey = (existingEnv.S3_SECRET_KEY ?? '').trim() || randomToken(24);

    next.HAPPIER_STACK_MANAGED_INFRA = (existingEnv.HAPPIER_STACK_MANAGED_INFRA ?? '1').trim() || '1';
    next.HAPPIER_STACK_PG_USER = pgUser;
    next.HAPPIER_STACK_PG_PASSWORD = pgPassword;
    next.HAPPIER_STACK_PG_DATABASE = pgDb;
    next.HAPPIER_STACK_HANDY_MASTER_SECRET_FILE =
      (existingEnv.HAPPIER_STACK_HANDY_MASTER_SECRET_FILE ?? '').trim() || join(baseDir, 'happier-server', 'handy-master-secret.txt');
    next.S3_ACCESS_KEY = s3AccessKey;
    next.S3_SECRET_KEY = s3SecretKey;
    next.S3_BUCKET = s3Bucket;

    if (port != null) {
      // If user pinned the server port, keep ports + derived URLs stable as well.
      const reservedPorts = await collectReservedStackPorts({ excludeStackName: stackName });
      reservedPorts.add(port);
      const backendPort = existingEnv.HAPPIER_STACK_SERVER_BACKEND_PORT?.trim()
        ? Number(existingEnv.HAPPIER_STACK_SERVER_BACKEND_PORT.trim())
        : await pickNextFreePort(port + 10, { reservedPorts });
      reservedPorts.add(backendPort);
      const pgPort = existingEnv.HAPPIER_STACK_PG_PORT?.trim()
        ? Number(existingEnv.HAPPIER_STACK_PG_PORT.trim())
        : await pickNextFreePort(port + 1000, { reservedPorts });
      reservedPorts.add(pgPort);
      const redisPort = existingEnv.HAPPIER_STACK_REDIS_PORT?.trim()
        ? Number(existingEnv.HAPPIER_STACK_REDIS_PORT.trim())
        : await pickNextFreePort(pgPort + 1, { reservedPorts });
      reservedPorts.add(redisPort);
      const minioPort = existingEnv.HAPPIER_STACK_MINIO_PORT?.trim()
        ? Number(existingEnv.HAPPIER_STACK_MINIO_PORT.trim())
        : await pickNextFreePort(redisPort + 1, { reservedPorts });
      reservedPorts.add(minioPort);
      const minioConsolePort = existingEnv.HAPPIER_STACK_MINIO_CONSOLE_PORT?.trim()
        ? Number(existingEnv.HAPPIER_STACK_MINIO_CONSOLE_PORT.trim())
        : await pickNextFreePort(minioPort + 1, { reservedPorts });

      const databaseUrl = `postgresql://${encodeURIComponent(pgUser)}:${encodeURIComponent(pgPassword)}@127.0.0.1:${pgPort}/${encodeURIComponent(pgDb)}`;
      const s3PublicUrl = `http://127.0.0.1:${minioPort}/${s3Bucket}`;

      next.HAPPIER_STACK_SERVER_BACKEND_PORT = String(backendPort);
      next.HAPPIER_STACK_PG_PORT = String(pgPort);
      next.HAPPIER_STACK_REDIS_PORT = String(redisPort);
      next.HAPPIER_STACK_MINIO_PORT = String(minioPort);
      next.HAPPIER_STACK_MINIO_CONSOLE_PORT = String(minioConsolePort);

      next.DATABASE_URL = databaseUrl;
      next.REDIS_URL = `redis://127.0.0.1:${redisPort}`;
      next.S3_HOST = '127.0.0.1';
      next.S3_PORT = String(minioPort);
      next.S3_USE_SSL = 'false';
      next.S3_PUBLIC_URL = s3PublicUrl;
    }
  }

  // Repo pinning (optional update via interactive edit).
  if (config.repo) {
    const resolved = await resolveRequestedRepoCheckoutDir({
      rootDir,
      repoSelection: config.repo,
      remoteName: config.repo?.remote || next.HAPPIER_STACK_STACK_REMOTE,
    });

    if (!resolved || !existsSync(resolved)) {
      throw new Error(`[stack] repo checkout does not exist: ${resolved || '(empty)'}`);
    }
    const monoRoot = coerceHappyMonorepoRootFromPath(resolved);
    if (!monoRoot) {
      throw new Error(`[stack] invalid repo checkout (expected Happier monorepo root): ${resolved}`);
    }
    next.HAPPIER_STACK_REPO_DIR = monoRoot;
  }

  const wrote = await writeStackEnv({ stackName, env: next });
  printResult({ json, data: { stackName, envPath: wrote, port, serverComponent }, text: `[stack] updated ${stackName}\n[stack] env: ${wrote}` });
}

async function cmdRunScript({ rootDir, stackName, scriptPath, args, extraEnv = {}, background = false }) {
  await runStackScriptWithStackEnv({ rootDir, stackName, scriptPath, args, extraEnv, background });
}

async function cmdAudit({ rootDir, argv }) {
  const { flags, kv } = parseArgs(argv);
  const json = wantsJson(argv, { flags });
  const fix = flags.has('--fix');
  const fixMain = flags.has('--fix-main');
  const fixPorts = flags.has('--fix-ports');
  const fixWorkspace = flags.has('--fix-workspace');
  const fixPaths = flags.has('--fix-paths');
  const unpinPorts = flags.has('--unpin-ports');
  const unpinPortsExceptRaw = (kv.get('--unpin-ports-except') ?? '').trim();
  const unpinPortsExcept = new Set(
    unpinPortsExceptRaw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  );
  const wantsEnvRepair = Boolean(fix || fixWorkspace || fixPaths);

  const stacks = await listAllStackNames();

  const report = [];
  const ports = new Map(); // port -> [stackName]
    const otherWorkspaceRoot = join(getHappyStacksHomeDir(), 'workspace');

  for (const stackName of stacks) {
    const resolved = resolveStackEnvPath(stackName);
    const envPath = resolved.envPath;
    const baseDir = resolved.baseDir;

    let raw = await readExistingEnv(envPath);
    let env = parseEnvToObject(raw);

    // If the env file is missing/empty, optionally reconstruct a safe baseline env.
    if (!raw.trim() && wantsEnvRepair && (stackName !== 'main' || fixMain)) {
      const serverComponent =
        getEnvValue(env, 'HAPPIER_STACK_SERVER_COMPONENT') ||
        'happier-server-light';
      const expectedUi = join(baseDir, 'ui');
      const expectedCli = join(baseDir, 'cli');
      // Port strategy: main is pinned by convention; non-main stacks default to ephemeral ports.
      const reservedPorts = stackName === 'main' ? await collectReservedStackPorts({ excludeStackName: stackName }) : new Set();
      const port = stackName === 'main' ? await pickNextFreePort(getDefaultPortStart(), { reservedPorts }) : null;

      const nextEnv = {
        HAPPIER_STACK_STACK: stackName,
        HAPPIER_STACK_SERVER_COMPONENT: serverComponent,
        HAPPIER_STACK_UI_BUILD_DIR: expectedUi,
        HAPPIER_STACK_CLI_HOME_DIR: expectedCli,
        HAPPIER_STACK_STACK_REMOTE: 'upstream',
        ...resolveDefaultRepoEnv({ rootDir }),
      };
      if (port != null) {
        nextEnv.HAPPIER_STACK_SERVER_PORT = String(port);
      }

      if (serverComponent === 'happier-server-light') {
        const dataDir = join(baseDir, 'server-light');
        nextEnv.HAPPIER_SERVER_LIGHT_DATA_DIR = dataDir;
        nextEnv.HAPPIER_SERVER_LIGHT_FILES_DIR = join(dataDir, 'files');
        nextEnv.HAPPIER_SERVER_LIGHT_DB_DIR = join(dataDir, 'pglite');
      }

      await writeStackEnv({ stackName, env: nextEnv });
      raw = await readExistingEnv(envPath);
      env = parseEnvToObject(raw);
    }

    // Optional: unpin ports for non-main stacks (ephemeral port model).
    if (unpinPorts && stackName !== 'main' && !unpinPortsExcept.has(stackName) && raw.trim()) {
      const serverComponentTmp =
        getEnvValue(env, 'HAPPIER_STACK_SERVER_COMPONENT') || 'happier-server-light';
      const remove = [
        // Always remove pinned public server port.
        'HAPPIER_STACK_SERVER_PORT',
        // Happier-server gateway/backend ports.
        'HAPPIER_STACK_SERVER_BACKEND_PORT',
        // Managed infra ports.
        'HAPPIER_STACK_PG_PORT',
        'HAPPIER_STACK_REDIS_PORT',
        'HAPPIER_STACK_MINIO_PORT',
        'HAPPIER_STACK_MINIO_CONSOLE_PORT',
      ];
      if (serverComponentTmp === 'happier-server') {
        // These are derived from the ports above; safe to re-compute at start time.
        remove.push('DATABASE_URL', 'REDIS_URL', 'S3_PORT', 'S3_PUBLIC_URL');
      }
      await ensureEnvFilePruned({ envPath, removeKeys: remove });
      raw = await readExistingEnv(envPath);
      env = parseEnvToObject(raw);
    }

    const serverComponent = getEnvValue(env, 'HAPPIER_STACK_SERVER_COMPONENT') || 'happier-server-light';
    const portRaw = getEnvValue(env, 'HAPPIER_STACK_SERVER_PORT');
    const port = portRaw ? Number(portRaw) : null;
    if (Number.isFinite(port) && port > 0) {
      const existing = ports.get(port) ?? [];
      existing.push(stackName);
      ports.set(port, existing);
    }

    const issues = [];

    if (!raw.trim()) {
      issues.push({ code: 'missing_env', message: `env file missing/empty (${envPath})` });
    }

    const uiBuildDir = getEnvValue(env, 'HAPPIER_STACK_UI_BUILD_DIR');
    const expectedUi = join(baseDir, 'ui');
    if (!uiBuildDir) {
      issues.push({ code: 'missing_ui_build_dir', message: `missing UI build dir (expected ${expectedUi})` });
    } else if (uiBuildDir !== expectedUi) {
      issues.push({ code: 'ui_build_dir_mismatch', message: `UI build dir points to ${uiBuildDir} (expected ${expectedUi})` });
    }

    const cliHomeDir = getEnvValue(env, 'HAPPIER_STACK_CLI_HOME_DIR');
    const expectedCli = join(baseDir, 'cli');
    if (!cliHomeDir) {
      issues.push({ code: 'missing_cli_home_dir', message: `missing CLI home dir (expected ${expectedCli})` });
    } else if (cliHomeDir !== expectedCli) {
      issues.push({ code: 'cli_home_dir_mismatch', message: `CLI home dir points to ${cliHomeDir} (expected ${expectedCli})` });
    }

    const missingRepoKeys = [];
    const repoDir = getEnvValue(env, 'HAPPIER_STACK_REPO_DIR');
    if (!repoDir) {
      missingRepoKeys.push('HAPPIER_STACK_REPO_DIR');
      issues.push({ code: 'missing_repo_dir', message: `missing HAPPIER_STACK_REPO_DIR` });
    } else if (!isAbsolute(repoDir)) {
      issues.push({ code: 'relative_repo_dir', message: `HAPPIER_STACK_REPO_DIR is relative (${repoDir}); prefer absolute paths under this workspace` });
    } else {
      const norm = repoDir.replaceAll('\\', '/');
      if (norm.startsWith(otherWorkspaceRoot.replaceAll('\\', '/') + '/')) {
        issues.push({ code: 'foreign_workspace_repo_dir', message: `HAPPIER_STACK_REPO_DIR points to another workspace: ${repoDir}` });
      }
      // Optional: fail-closed existence check.
      if (!existsSync(repoDir)) {
        issues.push({ code: 'missing_repo_path', message: `HAPPIER_STACK_REPO_DIR path does not exist: ${repoDir}` });
      }
    }

    // Server-light DB/files isolation.
    const isServerLight = serverComponent === 'happier-server-light';
    if (isServerLight) {
      const dataDir = getEnvValue(env, 'HAPPIER_SERVER_LIGHT_DATA_DIR');
      const filesDir = getEnvValue(env, 'HAPPIER_SERVER_LIGHT_FILES_DIR');
      const dbDir = getEnvValue(env, 'HAPPIER_SERVER_LIGHT_DB_DIR');
      const rawDbProvider =
        (getEnvValue(env, 'HAPPIER_DB_PROVIDER') ?? getEnvValue(env, 'HAPPY_DB_PROVIDER') ?? '').toString().trim().toLowerCase();
      const dbProvider = rawDbProvider === 'pglite' ? 'pglite' : 'sqlite';
      const expectedDataDir = join(baseDir, 'server-light');
      const expectedFilesDir = join(expectedDataDir, 'files');
      const expectedDbDir = join(expectedDataDir, 'pglite');

      if (!dataDir) issues.push({ code: 'missing_server_light_data_dir', message: `missing HAPPIER_SERVER_LIGHT_DATA_DIR (expected ${expectedDataDir})` });
      if (!filesDir) issues.push({ code: 'missing_server_light_files_dir', message: `missing HAPPIER_SERVER_LIGHT_FILES_DIR (expected ${expectedFilesDir})` });
      if (dataDir && dataDir !== expectedDataDir) issues.push({ code: 'server_light_data_dir_mismatch', message: `HAPPIER_SERVER_LIGHT_DATA_DIR=${dataDir} (expected ${expectedDataDir})` });
      if (filesDir && filesDir !== expectedFilesDir) issues.push({ code: 'server_light_files_dir_mismatch', message: `HAPPIER_SERVER_LIGHT_FILES_DIR=${filesDir} (expected ${expectedFilesDir})` });
      if (dbProvider === 'pglite') {
        if (!dbDir) issues.push({ code: 'missing_server_light_db_dir', message: `missing HAPPIER_SERVER_LIGHT_DB_DIR (expected ${expectedDbDir})` });
        if (dbDir && dbDir !== expectedDbDir) issues.push({ code: 'server_light_db_dir_mismatch', message: `HAPPIER_SERVER_LIGHT_DB_DIR=${dbDir} (expected ${expectedDbDir})` });
      }

      const legacyDbUrl = getEnvValue(env, 'DATABASE_URL');
      if (legacyDbUrl) {
        issues.push({
          code: 'legacy_database_url',
          message: `DATABASE_URL is set for a light stack (${legacyDbUrl}); light manages its own local database and does not require DATABASE_URL in the stack env`,
        });
      }
    }

    // Best-effort env repair (opt-in; non-main stacks only by default).
    if ((fix || fixWorkspace || fixPaths) && (stackName !== 'main' || fixMain) && raw.trim()) {
      const updates = [];

      // Always ensure stack directories are explicitly pinned when missing.
      if (!uiBuildDir) updates.push({ key: 'HAPPIER_STACK_UI_BUILD_DIR', value: expectedUi });
      if (!cliHomeDir) updates.push({ key: 'HAPPIER_STACK_CLI_HOME_DIR', value: expectedCli });
      if (fixPaths) {
        if (uiBuildDir && uiBuildDir !== expectedUi) updates.push({ key: 'HAPPIER_STACK_UI_BUILD_DIR', value: expectedUi });
        if (cliHomeDir && cliHomeDir !== expectedCli) updates.push({ key: 'HAPPIER_STACK_CLI_HOME_DIR', value: expectedCli });
      }

      // Pin repo dir if missing (best-effort).
      if (missingRepoKeys.length) {
        const defaults = resolveDefaultRepoEnv({ rootDir });
        const repo = String(defaults.HAPPIER_STACK_REPO_DIR ?? '').trim();
        if (repo) {
          updates.push({ key: 'HAPPIER_STACK_REPO_DIR', value: repo });
        }
      }

      // Server-light storage isolation.
      if (isServerLight) {
        const dataDir = getEnvValue(env, 'HAPPIER_SERVER_LIGHT_DATA_DIR');
        const filesDir = getEnvValue(env, 'HAPPIER_SERVER_LIGHT_FILES_DIR');
        const dbDir = getEnvValue(env, 'HAPPIER_SERVER_LIGHT_DB_DIR');
        const expectedDataDir = join(baseDir, 'server-light');
        const expectedFilesDir = join(expectedDataDir, 'files');
        const expectedDbDir = join(expectedDataDir, 'pglite');
        if (!dataDir || (fixPaths && dataDir !== expectedDataDir)) updates.push({ key: 'HAPPIER_SERVER_LIGHT_DATA_DIR', value: expectedDataDir });
        if (!filesDir || (fixPaths && filesDir !== expectedFilesDir)) updates.push({ key: 'HAPPIER_SERVER_LIGHT_FILES_DIR', value: expectedFilesDir });
        if (!dbDir || (fixPaths && dbDir !== expectedDbDir)) updates.push({ key: 'HAPPIER_SERVER_LIGHT_DB_DIR', value: expectedDbDir });
      }

      if (fixWorkspace) {
        const repoKey = 'HAPPIER_STACK_REPO_DIR';
        const current = getEnvValue(env, repoKey);
        if (current) {
          const otherNorm = otherWorkspaceRoot.replaceAll('\\', '/') + '/';
          const abs = isAbsolute(current) ? current : resolve(getWorkspaceDir(rootDir, env), current);
          const norm = abs.replaceAll('\\', '/');
          if (norm.startsWith(otherNorm)) {
            // Map any path under another workspace root back into this workspace root.
            const rel = norm.slice(otherNorm.length);
            const candidate = resolve(getWorkspaceDir(rootDir, process.env), rel);
            if (existsSync(candidate)) {
              updates.push({ key: repoKey, value: candidate });
            }
          }
        }
      }

      if (updates.length) {
        await ensureEnvFileUpdated({ envPath, updates });
      }

      // Light stacks no longer persist DATABASE_URL in the env file (light uses embedded PGlite).
      // For legacy SQLite-era stacks, prune it when fixing paths so future commands don't accidentally
      // treat the stack as SQLite-backed.
      if (isServerLight && fixPaths) {
        const legacyDbUrl = getEnvValue(env, 'DATABASE_URL');
        if (legacyDbUrl) {
          await ensureEnvFilePruned({ envPath, removeKeys: ['DATABASE_URL'] });
        }
      }
    }

    report.push({
      stackName,
      envPath,
      baseDir,
      serverComponent,
      serverPort: Number.isFinite(port) ? port : null,
      uiBuildDir: uiBuildDir || null,
      cliHomeDir: cliHomeDir || null,
      issues,
    });
  }

  // Port collisions (post-pass)
  const collisions = [];
  for (const [port, names] of ports.entries()) {
    if (names.length <= 1) continue;
    collisions.push({ port, names: Array.from(names) });
  }

  // Optional: fix collisions by reassigning ports (non-main stacks only by default).
  if (fixPorts) {
    const allowMain = Boolean(fixMain);
    const planned = await collectReservedStackPorts();
    const byName = new Map(report.map((r) => [r.stackName, r]));

    const parsePg = (url) => {
      try {
        const u = new URL(url);
        const db = u.pathname?.replace(/^\//, '') || '';
        return {
          user: decodeURIComponent(u.username || ''),
          password: decodeURIComponent(u.password || ''),
          db,
          host: u.hostname || '127.0.0.1',
        };
      } catch {
        return null;
      }
    };

    for (const c of collisions) {
      const names = c.names.slice().sort();
      // Keep the first stack stable; reassign others to reduce churn.
      const keep = names[0];
      for (const stackName of names.slice(1)) {
        if (stackName === 'main' && !allowMain) {
          continue;
        }
        const entry = byName.get(stackName);
        if (!entry) continue;
        if (!entry.envPath) continue;
        const raw = await readExistingEnv(entry.envPath);
        if (!raw.trim()) continue;
        const env = parseEnvToObject(raw);

        const serverComponent =
          getEnvValue(env, 'HAPPIER_STACK_SERVER_COMPONENT') || 'happier-server-light';
        const portRaw = getEnvValue(env, 'HAPPIER_STACK_SERVER_PORT');
        const currentPort = portRaw ? Number(portRaw) : NaN;
        if (Number.isFinite(currentPort) && currentPort > 0) {
          // Fail-safe: don't rewrite ports for a stack that appears to be actively running.
          // Otherwise we can strand a running server/daemon on a now-stale port.
          // eslint-disable-next-line no-await-in-loop
          const free = await isPortFree(currentPort);
          if (!free) {
            entry.issues.push({
              code: 'port_fix_skipped_running',
              message: `skipped port reassignment because port ${currentPort} is currently in use (stop the stack and re-run --fix-ports)`,
            });
            continue;
          }
        }
        const startFrom = Number.isFinite(currentPort) && currentPort > 0 ? currentPort + 1 : getDefaultPortStart();

        const updates = [];
        const newServerPort = await pickNextFreePort(startFrom, { reservedPorts: planned });
        planned.add(newServerPort);
        updates.push({ key: 'HAPPIER_STACK_SERVER_PORT', value: String(newServerPort) });

        if (serverComponent === 'happier-server') {
          planned.add(newServerPort);
          const backendPort = await pickNextFreePort(newServerPort + 10, { reservedPorts: planned });
          planned.add(backendPort);
          const pgPort = await pickNextFreePort(newServerPort + 1000, { reservedPorts: planned });
          planned.add(pgPort);
          const redisPort = await pickNextFreePort(pgPort + 1, { reservedPorts: planned });
          planned.add(redisPort);
          const minioPort = await pickNextFreePort(redisPort + 1, { reservedPorts: planned });
          planned.add(minioPort);
          const minioConsolePort = await pickNextFreePort(minioPort + 1, { reservedPorts: planned });
          planned.add(minioConsolePort);

          updates.push({ key: 'HAPPIER_STACK_SERVER_BACKEND_PORT', value: String(backendPort) });
          updates.push({ key: 'HAPPIER_STACK_PG_PORT', value: String(pgPort) });
          updates.push({ key: 'HAPPIER_STACK_REDIS_PORT', value: String(redisPort) });
          updates.push({ key: 'HAPPIER_STACK_MINIO_PORT', value: String(minioPort) });
          updates.push({ key: 'HAPPIER_STACK_MINIO_CONSOLE_PORT', value: String(minioConsolePort) });

          // Update URLs while preserving existing credentials.
          const pgUser = getEnvValue(env, 'HAPPIER_STACK_PG_USER') || 'handy';
          const pgPassword = getEnvValue(env, 'HAPPIER_STACK_PG_PASSWORD') || '';
          const pgDb = getEnvValue(env, 'HAPPIER_STACK_PG_DATABASE') || 'handy';
          let user = pgUser;
          let pass = pgPassword;
          let db = pgDb;
          const parsed = parsePg(getEnvValue(env, 'DATABASE_URL'));
          if (parsed) {
            if (parsed.user) user = parsed.user;
            if (parsed.password) pass = parsed.password;
            if (parsed.db) db = parsed.db;
          }
          const databaseUrl = `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@127.0.0.1:${pgPort}/${encodeURIComponent(db)}`;
          updates.push({ key: 'DATABASE_URL', value: databaseUrl });
          updates.push({ key: 'REDIS_URL', value: `redis://127.0.0.1:${redisPort}` });
          updates.push({ key: 'S3_PORT', value: String(minioPort) });
          const bucket = getEnvValue(env, 'S3_BUCKET') || sanitizeDnsLabel(`happier-${stackName}`, { fallback: 'happier' });
          updates.push({ key: 'S3_PUBLIC_URL', value: `http://127.0.0.1:${minioPort}/${bucket}` });
        }

        await ensureEnvFileUpdated({ envPath: entry.envPath, updates });

        // Update in-memory report for follow-up collision recomputation.
        entry.serverPort = newServerPort;
        entry.issues.push({ code: 'port_reassigned', message: `server port reassigned -> ${newServerPort} (was ${currentPort || 'unknown'})` });
      }
      // Ensure the "kept" one remains reserved in planned as well.
      const keptEntry = byName.get(keep);
      if (keptEntry?.serverPort) planned.add(keptEntry.serverPort);
    }
  }

  // Recompute port collisions after optional fixes.
  for (const r of report) {
    r.issues = (r.issues ?? []).filter((i) => i.code !== 'port_collision');
  }
  const portsNow = new Map();
  for (const r of report) {
    if (!Number.isFinite(r.serverPort) || r.serverPort == null) continue;
    const existing = portsNow.get(r.serverPort) ?? [];
    existing.push(r.stackName);
    portsNow.set(r.serverPort, existing);
  }
  for (const [port, names] of portsNow.entries()) {
    if (names.length <= 1) continue;
    for (const r of report) {
      if (r.serverPort === port) {
        r.issues.push({ code: 'port_collision', message: `server port ${port} is also used by: ${names.filter((n) => n !== r.stackName).join(', ')}` });
      }
    }
  }

  const out = {
    ok: true,
    fixed: Boolean(fix || fixPorts || fixWorkspace || fixPaths || unpinPorts),
    stacks: report,
    summary: {
      total: report.length,
      withIssues: report.filter((r) => (r.issues ?? []).length > 0).length,
    },
  };

  if (json) {
    printResult({ json, data: out });
    return;
  }

  console.log('[stack] audit');
  for (const r of report) {
    const issueCount = (r.issues ?? []).length;
    const status = issueCount ? `issues=${issueCount}` : 'ok';
    console.log(`- ${r.stackName} (${status})`);
    if (issueCount) {
      for (const i of r.issues) console.log(`  - ${i.code}: ${i.message}`);
    }
  }
  if (fix) {
    console.log('');
    console.log('[stack] audit: applied best-effort fixes (missing keys only).');
  } else {
    console.log('');
    console.log('[stack] tip: run with --fix to add missing safe defaults (non-main stacks only).');
    console.log('[stack] tip: include --fix-main if you also want to modify main stack env defaults.');
  }
}

async function cmdCreateDevAuthSeed({ rootDir, argv }) {
  const { flags, kv } = parseArgs(argv);
  const json = wantsJson(argv, { flags });

  const positionals = argv.filter((a) => !a.startsWith('--'));
  const name = (positionals[1] ?? '').trim() || 'dev-auth';
  const serverComponent = (kv.get('--server') ?? '').trim() || 'happier-server-light';
  const interactive = !flags.has('--non-interactive') && (flags.has('--interactive') || isTty());
  const bindMode = resolveBindModeFromArgs({ flags, kv });
  const skipDefaultSeed =
    flags.has('--skip-default-seed') || flags.has('--no-default-seed') || flags.has('--no-configure-default-seed');
  const forceLogin =
    flags.has('--login') ? true : flags.has('--no-login') || flags.has('--skip-login') ? false : null;

  if (json) {
    // Keep JSON mode non-interactive and stable by using the existing stack command output.
    // (We intentionally don't run the guided login flow in JSON mode.)
    const createArgs = ['new', name, '--no-copy-auth', '--server', serverComponent, '--json'];
    const created = await runCapture(process.execPath, [join(rootDir, 'scripts', 'stack.mjs'), ...createArgs], { cwd: rootDir, env: process.env }).catch((e) => {
      throw new Error(
        `[stack] create-dev-auth-seed: failed to create auth seed stack "${name}": ${e instanceof Error ? e.message : String(e)}`
      );
    });

    printResult({
      json,
      data: {
        ok: true,
        seedStack: name,
        serverComponent,
        created: created.trim() ? JSON.parse(created.trim()) : { ok: true },
        next: {
          login: `hstack stack auth ${name} login`,
          setEnv: `# add to ${getHomeEnvLocalPath()}:\nHAPPIER_STACK_AUTH_SEED_FROM=${name}\nHAPPIER_STACK_AUTO_AUTH_SEED=1`,
          reseedAll: `hstack auth copy-from ${name} --all --except=main,${name}`,
        },
      },
    });
    return;
  }

  // Create the seed stack as fresh auth (no copy) so it doesn't share main identity.
  // IMPORTANT: do this in-process (no recursive spawn) so the env file is definitely written
  // before we run any guided steps (withStackEnv/login).
  if (!stackExistsSync(name)) {
    await cmdNew({
      rootDir,
      argv: [name, '--no-copy-auth', '--server', serverComponent],
    });
  } else {
    console.log(`[stack] auth seed stack already exists: ${name}`);
  }

  if (!stackExistsSync(name)) {
    throw new Error(`[stack] create-dev-auth-seed: expected stack "${name}" to exist after creation, but it does not`);
  }

  // Interactive convenience: guide login first, then configure env.local + store dev key.
  if (interactive) {
    await withRl(async (rl) => {
      let savedDevKey = false;
      const wantLogin =
        forceLogin != null
          ? forceLogin
          : await promptSelect(rl, {
              title: `${bold('dev-auth seed stack')}\n${dim('Recommended: do the guided login now so the seed is ready immediately.')}`,
              options: [
                { label: `yes (${green('recommended')}) — start temporary server + UI and log in`, value: true },
                { label: `no — I will do this later`, value: false },
              ],
              defaultIndex: 0,
            });

      if (wantLogin) {
        console.log('');
        console.log(`[stack] starting ${serverComponent} temporarily so we can log in...`);

        const verbosity = getVerbosityLevel(process.env);
        const quietAuthFlow = verbosity === 0;
        const steps = createStepPrinter({ enabled: quietAuthFlow });

        // Pick a temporary server port for the guided login flow.
        // Respect HAPPIER_STACK_STACK_PORT_START so VM/CI environments can avoid host port collisions
        // without pinning stack env ports explicitly.
        const serverPortStart = getDefaultPortStart(name);
        const serverPort = await pickNextFreeTcpPort(serverPortStart, { host: '127.0.0.1' });
        const internalServerUrl = `http://127.0.0.1:${serverPort}`;
        const publicServerUrl = await preferStackLocalhostUrl(`http://localhost:${serverPort}`, { stackName: name });

        const logDir = join(getHappyStacksHomeDir(process.env), 'logs', 'dev-auth');
        await mkdir(logDir, { recursive: true }).catch(() => {});
        const serverLogPath = join(logDir, `server.${Date.now()}.log`);
        const expoLogPath = join(logDir, `expo.${Date.now()}.log`);

        const autostart = { stackName: name, baseDir: resolveStackEnvPath(name).baseDir };
        const children = [];

        await withStackEnv({
          stackName: name,
          extraEnv: {
            // Make sure stack auth login uses the same port we just picked, and avoid inheriting
            // any global/public URL (e.g. main stack’s Tailscale URL) for this guided flow.
            HAPPIER_STACK_SERVER_PORT: String(serverPort),
            HAPPIER_STACK_SERVER_URL: '',
            ...(bindMode
              ? applyBindModeToEnv(
                  {
                    // start from empty so we only inject the bind override keys here
                  },
                  bindMode
                )
              : {}),
          },
          fn: async ({ env }) => {
            if (bindMode) {
              applyBindModeToEnv(env, bindMode);
            }
            const resolvedServerDir = getComponentDir(rootDir, serverComponent, env);
            const resolvedCliDir = getComponentDir(rootDir, 'happier-cli', env);
            const resolvedUiDir = getComponentDir(rootDir, 'happier-ui', env);

            await requireDir(serverComponent, resolvedServerDir);
            await requireDir('happier-cli', resolvedCliDir);
            await requireDir('happier-ui', resolvedUiDir);

            let serverProc = null;
            let uiProc = null;
            let uiStopRequested = false;
            try {
              steps.start('start temporary server');
              const started = await startDevServer({
                serverComponentName: serverComponent,
                serverDir: resolvedServerDir,
                autostart,
                baseEnv: env,
                serverPort,
                internalServerUrl,
                publicServerUrl,
                envPath: env.HAPPIER_STACK_ENV_FILE ?? '',
                stackMode: true,
                runtimeStatePath: null,
                serverAlreadyRunning: false,
                restart: true,
                children,
                spawnOptions: quietAuthFlow ? { silent: true, teeFile: serverLogPath, teeLabel: 'server' } : {},
                quiet: quietAuthFlow,
              });
              serverProc = started.serverProc;
              steps.stop('✓', 'start temporary server');

              // Start Expo (web) so /terminal/connect exists for happier-cli web auth.
              steps.start('start temporary UI');
              const uiRes = await ensureDevExpoServer({
                startUi: true,
                startMobile: false,
                uiDir: resolvedUiDir,
                autostart,
                baseEnv: env,
                // In the browser, prefer localhost for API calls.
                apiServerUrl: publicServerUrl,
                restart: false,
                stackMode: true,
                runtimeStatePath: null,
                stackName: name,
                envPath: env.HAPPIER_STACK_ENV_FILE ?? '',
                children,
                spawnOptions: quietAuthFlow ? { silent: true, teeFile: expoLogPath, teeLabel: 'expo' } : {},
                quiet: quietAuthFlow,
              });
              if (uiRes?.skipped === false && uiRes.proc) {
                uiProc = uiRes.proc;
              }
              steps.stop('✓', 'start temporary UI');

              if (quietAuthFlow && uiProc) {
                uiProc.once('exit', (code, sig) => {
                  // We intentionally SIGINT Expo when we're done with login.
                  if (uiStopRequested && (sig === 'SIGINT' || sig === 'SIGTERM')) return;
                  if (code === 0) return;
                  void (async () => {
                    const c = typeof code === 'number' ? code : null;
                    // eslint-disable-next-line no-console
                    console.error(`[stack] Expo exited unexpectedly (code=${c ?? 'null'}, sig=${sig ?? 'null'})`);
                    // eslint-disable-next-line no-console
                    console.error(`[stack] expo log: ${expoLogPath}`);
                    const tail = await readLastLines(expoLogPath, 80);
                    if (tail) {
                      // eslint-disable-next-line no-console
                      console.error('');
                      // eslint-disable-next-line no-console
                      console.error(tail.trimEnd());
                    }
                  })();
                });
              }

              console.log('');
              const uiPort = uiRes?.port;
              const uiRootLocalhost = Number.isFinite(uiPort) && uiPort > 0 ? `http://localhost:${uiPort}` : null;
              const uiRoot = uiRootLocalhost ? await preferStackLocalhostUrl(uiRootLocalhost, { stackName: name }) : null;
              const uiSettings = uiRoot ? `${uiRoot}/settings/account` : null;

              console.log(`[stack] step 1/3: create a ${cyan('dev-auth')} account in the UI (this generates the dev key)`);
              if (uiRoot) {
                console.log(`[stack] waiting for UI to be ready...`);
                // Prefer localhost for readiness checks (faster/more reliable), even though we
                // instruct the user to use the stack-scoped *.localhost origin for storage isolation.
                await waitForHttpOk(uiRootLocalhost || uiRoot, { timeoutMs: 30_000 });
                try {
                  await assertExpoWebappBundlesOrThrow({
                    rootDir,
                    stackName: name,
                    webappUrl: uiRootLocalhost || uiRoot,
                  });
                } catch (e) {
                  const detail = e instanceof Error ? e.message : String(e);
                  throw new Error(
                    `[stack] temporary UI is reachable, but the Expo web bundle is not ready.\n` +
                      `${detail}\n` +
                      `[stack] expo log: ${expoLogPath}`
                  );
                }
                console.log(`- open: ${uiRoot}`);
                console.log(`- click: "Create Account"`);
                console.log(`- then open: ${uiSettings}`);
                console.log(`- tap: "Secret Key" to reveal + copy it`);
                console.log('');
                console.log(`${bold('Press Enter')} to open it in your browser.`);
                await prompt(rl, '', { defaultValue: '' });
                if (uiProc && uiProc.exitCode != null && uiProc.exitCode !== 0) {
                  throw new Error(`[stack] Expo exited unexpectedly (code=${uiProc.exitCode}). See log: ${expoLogPath}`);
                }
                await openUrlInBrowser(uiRoot).catch(() => {});
                console.log(`${green('✓')} Browser opened`);
              } else {
                console.log(`- UI is running but the port was not detected; rerun with DEBUG logs if needed`);
              }
              await prompt(rl, `Press Enter once you've created the account in the UI... `);

              console.log('');
              console.log(`[stack] step 2/3: save the dev key locally ${dim('(optional; helps UI restore + automation)')}`);
              const keyInput = (await prompt(
                rl,
                `Paste the Secret Key now (from Settings → Account → Secret Key). Leave empty to skip: `
              )).trim();
              if (keyInput) {
                const res = await writeDevAuthKey({ env: process.env, input: keyInput });
                savedDevKey = true;
                console.log(`[stack] dev key saved: ${res.path}`);
              } else {
                console.log(`[stack] dev key not saved; you can do it later with: ${yellow('hstack auth dev-key --set="<key>"')}`);
              }

              console.log('');
              console.log(`[stack] step 3/3: authenticate the CLI against this stack ${dim('(web auth)')}`);
              console.log(`[stack] launching unified guided auth flow`);
              await runOrchestratedGuidedAuthFlow({
                rootDir,
                stackName: name,
                env,
                verbosity,
                json: false,
              });
            } finally {
              if (uiProc) {
                console.log('');
                console.log(`[stack] stopping temporary UI (pid=${uiProc.pid})...`);
                uiStopRequested = true;
                killProcessTree(uiProc, 'SIGINT');
                await Promise.race([
                  new Promise((resolve) => uiProc.on('exit', resolve)),
                  new Promise((resolve) => setTimeout(resolve, 15_000)),
                ]);
              }
              if (serverProc) {
                console.log('');
                console.log(`[stack] stopping temporary server (pid=${serverProc.pid})...`);
                killProcessTree(serverProc, 'SIGINT');
                await Promise.race([
                  new Promise((resolve) => serverProc.on('exit', resolve)),
                  new Promise((resolve) => setTimeout(resolve, 15_000)),
                ]);
              }
            }
          },
        });

        console.log('');
        console.log('[stack] login step complete.');
      } else {
        console.log(`[stack] skipping guided login. You can do it later with: ${yellow(`hstack stack auth ${name} login`)}`);
      }

      if (!skipDefaultSeed) {
        const envLocalPath = getHomeEnvLocalPath();
        const wantEnv = await promptSelect(rl, {
          title:
            `${bold('Automatic sign-in for new stacks')}\n` +
            `${dim(`Recommended: when you create a new stack, copy/symlink auth from ${cyan(name)} automatically.`)}\n` +
            `${dim(`This writes ${cyan('HAPPIER_STACK_AUTO_AUTH_SEED=1')} + ${cyan(`HAPPIER_STACK_AUTH_SEED_FROM=${name}`)} in ${envLocalPath}.`)}`,
          options: [
            { label: `yes (${green('recommended')}) — enable automatic auth seeding`, value: true },
            { label: `no — I will configure this later`, value: false },
          ],
          defaultIndex: 0,
        });
        if (wantEnv) {
          await ensureEnvFileUpdated({
            envPath: envLocalPath,
            updates: [
              { key: 'HAPPIER_STACK_AUTH_SEED_FROM', value: name },
              { key: 'HAPPIER_STACK_AUTO_AUTH_SEED', value: '1' },
            ],
          });
          console.log(`[stack] updated: ${envLocalPath}`);
        } else {
          console.log(
            `[stack] tip: set in ${envLocalPath}: HAPPIER_STACK_AUTH_SEED_FROM=${name} and HAPPIER_STACK_AUTO_AUTH_SEED=1`
          );
        }
      }

      if (!savedDevKey) {
        const wantKey = await promptSelect(rl, {
          title: `${bold('Dev key (optional, sensitive)')}\n${dim('Save a dev key locally so you can restore the UI account quickly (and support automation).')}`,
          options: [
            { label: 'no (default)', value: false },
            { label: `yes — save a dev key now`, value: true },
          ],
          defaultIndex: 0,
        });
        if (wantKey) {
          console.log(`[stack] paste the secret key (base64url OR backup-format like XXXXX-XXXXX-...):`);
          const input = (await prompt(rl, `dev key: `)).trim();
          if (input) {
            try {
              const res = await writeDevAuthKey({ env: process.env, input });
              console.log(`[stack] dev key saved: ${res.path}`);
            } catch (e) {
              console.warn(`[stack] dev key not saved: ${e instanceof Error ? e.message : String(e)}`);
            }
          } else {
            console.log('[stack] dev key not provided; skipping');
          }
        } else {
          console.log(`[stack] tip: you can set it later with: ${yellow('hstack auth dev-key --set="<key>"')}`);
        }
      }
    });
  } else {
    console.log(`- set as default seed (recommended) in ${getHomeEnvLocalPath()}:`);
    console.log(`  HAPPIER_STACK_AUTH_SEED_FROM=${name}`);
    console.log(`  HAPPIER_STACK_AUTO_AUTH_SEED=1`);
    console.log(`- (optional) seed existing stacks: hstack auth copy-from ${name} --all --except=main,${name}`);
    console.log(`- (optional) store dev key for UI automation: hstack auth dev-key --set="<key>"`);
  }
}

async function cmdArchiveStack({ rootDir, argv, stackName }) {
  const { flags, kv } = parseArgs(argv);
  const json = wantsJson(argv, { flags });
  const dryRun = flags.has('--dry-run');
  const date = (kv.get('--date') ?? '').toString().trim() || getTodayYmd();

  if (!stackExistsSync(stackName)) {
    throw new Error(`[stack] archive: stack does not exist: ${stackName}`);
  }

  const { env } = await readStackEnvObject(stackName);

  const workspaceDir = getWorkspaceDir(rootDir);

  // Collect unique git worktree roots referenced by this stack.
  const byRoot = new Map();
  const rawRepo = (env.HAPPIER_STACK_REPO_DIR ?? '').toString().trim();
  if (rawRepo) {
    const abs = isAbsolute(rawRepo) ? rawRepo : resolve(workspaceDir, rawRepo);
    // Only archive paths that live under workspace worktree categories (<workspace>/{pr,local,tmp}/...).
    if (isWorktreePath({ rootDir, dir: abs, env: process.env })) {
      try {
        const top = (await runCapture('git', ['rev-parse', '--show-toplevel'], { cwd: abs })).trim();
        if (top) {
          byRoot.set(top, { dir: top });
        }
      } catch {
        // ignore invalid git dirs
      }
    }
  }

  const { baseDir } = resolveStackEnvPath(stackName);
  const destStackDir = join(dirname(baseDir), '.archived', date, stackName);

  // Safety: avoid archiving a worktree that is still actively referenced by other stacks.
  // If we did, we'd break those stacks by moving their active checkout.
  if (!dryRun && byRoot.size) {
    const otherStacks = new Map(); // envPath -> Set(keys)
    const otherNames = new Set();

    for (const wt of byRoot.values()) {
      // eslint-disable-next-line no-await-in-loop
      const out = await runCapture(
        process.execPath,
        [join(rootDir, 'scripts', 'worktrees.mjs'), 'archive', wt.dir, '--dry-run', `--date=${date}`, '--json'],
        { cwd: rootDir, env: process.env }
      );
      const info = JSON.parse(out);
      const linked = Array.isArray(info.linkedStacks) ? info.linkedStacks : [];
      for (const s of linked) {
        if (!s?.name || s.name === stackName) continue;
        otherNames.add(s.name);
        const envPath = String(s.envPath ?? '').trim();
        if (!envPath) continue;
        const set = otherStacks.get(envPath) ?? new Set();
        for (const k of Array.isArray(s.keys) ? s.keys : []) {
          if (k) set.add(String(k));
        }
        otherStacks.set(envPath, set);
      }
    }

    if (otherNames.size) {
      const names = Array.from(otherNames).sort().join(', ');
      if (json || !isTty()) {
        throw new Error(`[stack] archive: worktree(s) are still referenced by other stacks: ${names}. Resolve first (detach or archive those stacks).`);
      }

      const action = await withRl(async (rl) => {
        return await promptSelect(rl, {
          title: `Worktree(s) referenced by "${stackName}" are still in use by other stacks: ${names}`,
          options: [
            { label: 'abort (recommended)', value: 'abort' },
            { label: 'detach those stacks from the shared worktree(s)', value: 'detach' },
            { label: 'archive the linked stacks as well', value: 'archive-stacks' },
          ],
          defaultIndex: 0,
        });
      });

      if (action === 'abort') {
        throw new Error('[stack] archive aborted');
      }
      if (action === 'archive-stacks') {
        for (const name of Array.from(otherNames).sort()) {
          // eslint-disable-next-line no-await-in-loop
          await run(process.execPath, [join(rootDir, 'scripts', 'stack.mjs'), 'archive', name, `--date=${date}`], { cwd: rootDir, env: process.env });
        }
      } else {
        for (const [envPath, keys] of otherStacks.entries()) {
          // eslint-disable-next-line no-await-in-loop
          await ensureEnvFilePruned({ envPath, removeKeys: Array.from(keys) });
        }
      }
    }
  }

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      stackName,
      date,
      stackBaseDir: baseDir,
      archivedStackDir: destStackDir,
      worktrees: Array.from(byRoot.values()),
    };
  }

  await mkdir(dirname(destStackDir), { recursive: true });
  await rename(baseDir, destStackDir);

  const archivedWorktrees = [];
  for (const wt of byRoot.values()) {
    if (!existsSync(wt.dir)) continue;
    // eslint-disable-next-line no-await-in-loop
    const out = await runCapture(process.execPath, [join(rootDir, 'scripts', 'worktrees.mjs'), 'archive', wt.dir, `--date=${date}`, '--json'], {
      cwd: rootDir,
      env: process.env,
    });
    archivedWorktrees.push(JSON.parse(out));
  }

  return { ok: true, dryRun: false, stackName, date, archivedStackDir: destStackDir, archivedWorktrees };
}

// (removed) per-component stack pinning: stacks now pin a single monorepo checkout via HAPPIER_STACK_REPO_DIR.

async function cmdDuplicate({ rootDir, argv }) {
  const { flags, kv } = parseArgs(argv);
  const json = wantsJson(argv, { flags });

  const positionals = argv.filter((a) => !a.startsWith('--'));
  const fromStack = (positionals[1] ?? '').trim();
  let toStack = (positionals[2] ?? '').trim();
  if (!fromStack || !toStack) {
    throw new Error('[stack] usage: hstack stack duplicate <from> <to> [--duplicate-worktrees] [--deps=...] [--json]');
  }
  if (toStack === 'main') {
    throw new Error('[stack] refusing to duplicate into stack name "main"');
  }
  if (!stackExistsSync(fromStack)) {
    throw new Error(`[stack] duplicate: source stack does not exist: ${fromStack}`);
  }
  if (stackExistsSync(toStack)) {
    throw new Error(`[stack] duplicate: destination stack already exists: ${toStack}`);
  }

  const duplicateWorktrees =
    flags.has('--duplicate-worktrees') ||
    flags.has('--with-worktrees') ||
    (kv.get('--duplicate-worktrees') ?? '').trim() === '1';
  const depsMode = (kv.get('--deps') ?? '').trim(); // forwarded to wt new when duplicating worktrees

  const { env: fromEnv } = await readStackEnvObject(fromStack);
  const serverComponent = parseServerComponentFromEnv(fromEnv);

  // Create the destination stack env with the correct baseDir and defaults (do not copy auth/data).
  const created = await cmdNew({
    rootDir,
    argv: [toStack, '--no-copy-auth', '--server', serverComponent],
  });
  toStack = created?.stackName ?? toStack;

  const fromRepoDir = String(fromEnv.HAPPIER_STACK_REPO_DIR ?? '').trim();
  if (!fromRepoDir) {
    throw new Error(`[stack] duplicate: source stack is missing HAPPIER_STACK_REPO_DIR (${fromStack})`);
  }

  let nextRepoDir = fromRepoDir;
  if (duplicateWorktrees && isWorktreePath({ rootDir, dir: fromRepoDir, env: fromEnv })) {
    const spec = worktreeSpecFromDir({ rootDir, component: 'happier-ui', dir: fromRepoDir, env: fromEnv });
    if (spec) {
      // Duplicate into a disposable tmp worktree by default. This avoids collisions and keeps
      // the new stack isolated even if the source worktree is later archived/deleted.
      const slugSafe = sanitizeSlugPart(spec.replaceAll('/', '-'));
      const slug = `tmp/dup/${sanitizeSlugPart(toStack)}/${slugSafe || 'worktree'}`;

      const remoteName = 'upstream';
      const created = await createWorktreeFromBaseWorktree({
        rootDir,
        component: 'happier-ui',
        slug,
        baseWorktreeSpec: spec,
        remoteName,
        depsMode,
        env: fromEnv,
      });
      nextRepoDir = coerceHappyMonorepoRootFromPath(created) || created;
    }
  }

  const updates = [{ key: 'HAPPIER_STACK_REPO_DIR', value: nextRepoDir }];

  // Apply component dir overrides to the destination stack env file.
  const toEnvPath = resolveStackEnvPath(toStack).envPath;
  if (updates.length) {
    await ensureEnvFileUpdated({ envPath: toEnvPath, updates });
  }

  const out = {
    ok: true,
    from: fromStack,
    to: toStack,
    serverComponent,
    duplicatedWorktrees: duplicateWorktrees,
    updatedKeys: updates.map((u) => u.key),
    envPath: toEnvPath,
  };

  if (json) {
    printResult({ json, data: out });
    return;
  }

  console.log(`[stack] duplicated: ${fromStack} -> ${toStack}`);
  console.log(`[stack] env: ${toEnvPath}`);
  if (duplicateWorktrees) {
    console.log(`[stack] worktrees: duplicated (deps=${depsMode || 'none'})`);
  } else {
    console.log('[stack] worktrees: not duplicated (reusing existing component dirs)');
  }
}

async function cmdInfo({ rootDir, argv }) {
  const { flags } = parseArgs(argv);
  const json = wantsJson(argv, { flags });
  const positionals = argv.filter((a) => !a.startsWith('--'));
  const stackName = (positionals[1] ?? '').trim();
  if (!stackName) {
    throw new Error('[stack] usage: hstack stack info <name> [--json]');
  }
  if (!stackExistsSync(stackName)) {
    throw new Error(`[stack] info: stack does not exist: ${stackName}`);
  }

  const out = await readStackInfoSnapshot({ rootDir, stackName });
  if (json) {
    printResult({ json, data: out });
    return;
  }

  console.log(`[stack] info: ${stackName}`);
  console.log(`- env: ${out.envPath}`);
  console.log(`- runtime: ${out.runtimeStatePath}`);
  console.log(`- server: ${out.serverComponent}`);
  const runningPid = Number(out.runtime?.runningPid);
  const ownerPid = Number(out.runtime?.ownerPid);
  const runningPidSuffix = Number.isFinite(runningPid) && runningPid > 1
    ? ` (pid=${runningPid})`
    : Number.isFinite(ownerPid) && ownerPid > 1
      ? ` (ownerPid=${ownerPid})`
      : '';
  console.log(`- running: ${out.runtime?.running ? 'yes' : 'no'}${runningPidSuffix}`);
  if (typeof out.runtime?.health?.status === 'string' && out.runtime.health.status) {
    const issues = Array.isArray(out.runtime.health.issues) ? out.runtime.health.issues : [];
    const issueSuffix = issues.length > 0 ? ` (${issues.join(',')})` : '';
    console.log(`- health: ${out.runtime.health.status}${issueSuffix}`);
  }
  if (out.ports.server) console.log(`- port: server=${out.ports.server}${out.ports.backend ? ` backend=${out.ports.backend}` : ''}`);
  if (out.ports.ui) {
    const uiRunning = out.runtime?.components?.ui?.running !== false;
    console.log(`- port: ui=${out.ports.ui}${uiRunning ? '' : ' (unreachable)'}`);
  }
  if (out.urls.uiUrl && out.runtime?.components?.ui?.running !== false) {
    console.log(`- ui: ${out.urls.uiUrl}`);
  } else if (out.ports.ui && out.runtime?.components?.ui?.running === false) {
    console.log(`- ui: unavailable (re-run: hstack stack dev ${stackName} --restart)`);
  }
  if (out.urls.internalServerUrl) console.log(`- internal: ${out.urls.internalServerUrl}`);
  if (out.pinned.serverPort) console.log(`- pinned: serverPort=${out.pinned.serverPort}`);
  if (out.repo?.dir) {
    console.log(`- repo: ${out.repo.dir}${out.repo.worktreeSpec ? ` (${out.repo.worktreeSpec})` : ''}`);
  }
  if (out.dirs?.uiDir) console.log(`- dir: ui=${out.dirs.uiDir}`);
  if (out.dirs?.cliDir) console.log(`- dir: cli=${out.dirs.cliDir}`);
  if (out.dirs?.serverDir) console.log(`- dir: server=${out.dirs.serverDir}`);
}

async function cmdPrStack({ rootDir, argv }) {
  // Supports passing args to the eventual `stack dev/start` via `-- ...`.
  const sep = argv.indexOf('--');
  const argv0 = sep >= 0 ? argv.slice(0, sep) : argv;
  const passthrough = sep >= 0 ? argv.slice(sep + 1) : [];

  const { flags, kv } = parseArgs(argv0);
  const json = wantsJson(argv0, { flags });

	  if (wantsHelp(argv0, { flags })) {
	    printResult({
	      json,
	      data: {
	        usage:
	          'hstack stack pr <name> --repo=<pr-url|number> [--server-flavor=light|full] [--server=happier-server|happier-server-light] [--remote=upstream] [--deps=none|link|install|link-or-install] [--seed-auth] [--copy-auth-from=<stack>] [--with-infra] [--auth-force] [--dev|--start] [--background] [--mobile] [--expo-tailscale] [--json] [-- <stack dev/start args...>]',
	      },
	      text: [
        '[stack] usage:',
        '  hstack stack pr <name> --repo=<pr-url|number> [--dev|--start]',
        '    [--seed-auth] [--copy-auth-from=<stack>] [--link-auth] [--with-infra] [--auth-force]',
        '    [--remote=upstream] [--deps=none|link|install|link-or-install] [--update] [--force] [--background]',
        '    [--mobile]         # also start Expo dev-client Metro for mobile',
        '    [--expo-tailscale] # forward Expo to Tailscale interface for remote access',
        '    [--json] [-- <stack dev/start args...>]',
        '',
        'examples:',
        '  # Create stack + check out PRs + start dev UI',
        '  hstack stack pr pr123 \\',
        '    --repo=https://github.com/happier-dev/happier/pull/123 \\',
        '    --seed-auth --copy-auth-from=dev-auth \\',
        '    --dev',
        '',
        '  # Use numeric PR refs (remote defaults to upstream)',
        '  hstack stack pr pr123 --repo=123 --seed-auth --copy-auth-from=dev-auth --dev',
        '',
	        'notes:',
	        '  - This composes existing commands: `hstack stack new`, `hstack stack wt ...`, and `hstack stack auth ...`',
	        '  - For auth seeding, pass `--seed-auth` and optionally `--copy-auth-from=dev-auth` (or main)',
	        '  - `--link-auth` symlinks auth files instead of copying (keeps credentials in sync, but reduces isolation)',
	      ].join('\n'),
	    });
	    return;
	  }

  const positionals = argv0.filter((a) => !a.startsWith('--'));
  let stackName = (positionals[1] ?? '').trim();
  if (!stackName) {
    throw new Error('[stack] pr: missing stack name. Usage: hstack stack pr <name> --repo=<pr>');
  }
  {
    const normalizedName = normalizeStackNameOrNull(stackName);
    if (!normalizedName) {
      throw new Error(
        `[stack] pr: invalid stack name: ${JSON.stringify(stackName)}\n` +
          `[stack] stack names must be DNS-safe labels (lowercase letters/numbers/hyphens).\n` +
          `[stack] Example: pr-123`
      );
    }
    const changedBeyondCase = normalizedName !== stackName.toLowerCase();
    stackName = normalizedName;
    if (!json && changedBeyondCase) {
      console.warn(`[stack] normalized stack name to: ${stackName}`);
    }
  }
  if (stackName === 'main') {
    throw new Error('[stack] pr: stack name "main" is reserved; pick a unique name for this PR stack');
  }
  const reuseExisting = flags.has('--reuse') || flags.has('--update-existing') || (kv.get('--reuse') ?? '').trim() === '1';
  const stackExists = stackExistsSync(stackName);
  if (stackExists && !reuseExisting) {
    throw new Error(
      `[stack] pr: stack already exists: ${stackName}\n` +
        `[stack] tip: re-run with --reuse to update the existing PR worktrees and keep the stack wiring intact`
    );
  }

  const remoteNameFromArg = (kv.get('--remote') ?? '').trim();
  const depsMode = (kv.get('--deps') ?? '').trim();
  const dbProviderFromArg = (kv.get('--db-provider') ?? kv.get('--db') ?? '').toString().trim();
  const databaseUrlFromArg = (kv.get('--database-url') ?? '').toString().trim();

  const prRepo = (kv.get('--repo') ?? kv.get('--pr') ?? '').trim();
  if (!prRepo) {
    throw new Error('[stack] pr: missing PR input. Provide --repo=<pr-url|number>.');
  }

  const serverFlavorFromArg = (kv.get('--server-flavor') ?? '').trim().toLowerCase();
  const serverFromArg = (kv.get('--server') ?? '').trim();
	  const serverComponent =
	    serverFlavorFromArg === 'full'
	      ? 'happier-server'
	      : serverFlavorFromArg === 'light'
	        ? 'happier-server-light'
	        : (serverFromArg || 'happier-server-light').trim();
	  if (serverComponent !== 'happier-server' && serverComponent !== 'happier-server-light') {
	    throw new Error(`[stack] pr: invalid --server: ${serverFromArg || serverComponent}`);
	  }

  const wantsDev = flags.has('--dev') || flags.has('--start-dev');
  const wantsStart = flags.has('--start') || flags.has('--prod');
  if (wantsDev && wantsStart) {
    throw new Error('[stack] pr: choose either --dev or --start (not both)');
  }

  const wantsMobile = flags.has('--mobile') || flags.has('--with-mobile');
  const wantsExpoTailscale = flags.has('--expo-tailscale');
  const background = flags.has('--background') || flags.has('--bg') || (kv.get('--background') ?? '').trim() === '1';

  const seedAuthFlag = flags.has('--seed-auth') ? true : flags.has('--no-seed-auth') ? false : null;
  const authFromFlag = (kv.get('--copy-auth-from') ?? '').trim();
  const withInfra = flags.has('--with-infra') || flags.has('--ensure-infra') || flags.has('--infra');
  const authForce = flags.has('--auth-force') || flags.has('--force-auth');
  const authLinkFlag = flags.has('--link-auth') || flags.has('--link') || flags.has('--symlink-auth') ? true : null;
  const authLinkEnv =
    (process.env.HAPPIER_STACK_AUTH_LINK ?? '').toString().trim() === '1' ||
    (process.env.HAPPIER_STACK_AUTH_MODE ?? '').toString().trim() === 'link';

	  const isInteractive = Boolean(process.stdin.isTTY && process.stdout.isTTY) && !json;

	  const hasMainAccessKey = Boolean(findAnyCredentialPathInCliHome({ cliHomeDir: join(resolveStackEnvPath('main').baseDir, 'cli') }));
	  const hasDevAuthAccessKey =
	    existsSync(resolveStackEnvPath('dev-auth').envPath) &&
	    Boolean(findAnyCredentialPathInCliHome({ cliHomeDir: join(resolveStackEnvPath('dev-auth').baseDir, 'cli') }));
	  const hasLegacyAccessKey =
	    existsSync(resolveStackEnvPath('legacy').envPath) &&
	    Boolean(findAnyCredentialPathInCliHome({ cliHomeDir: join(resolveStackEnvPath('legacy').baseDir, 'cli') }));

	  const inferredSeedFromEnv = resolveAuthSeedFromEnv(process.env);
	  const inferredSeedFromAvailability = hasDevAuthAccessKey ? 'dev-auth' : hasMainAccessKey ? 'main' : 'main';
	  const defaultAuthFrom = authFromFlag || inferredSeedFromEnv || inferredSeedFromAvailability;

  // Default behavior for stack pr:
  // - if user explicitly flags --seed-auth/--no-seed-auth, obey
  // - otherwise in interactive mode: prompt when we have *some* plausible source, default yes
  // - in non-interactive mode: follow HAPPIER_STACK_AUTO_AUTH_SEED (if set), else default false
  const envAutoSeed =
    (process.env.HAPPIER_STACK_AUTO_AUTH_SEED ?? '').toString().trim();
  const autoSeedEnabled = envAutoSeed ? envAutoSeed !== '0' : false;

  let seedAuth = seedAuthFlag != null ? seedAuthFlag : autoSeedEnabled;
  let authFrom = defaultAuthFrom;
  let authLink = authLinkFlag != null ? authLinkFlag : authLinkEnv;

  if (seedAuthFlag == null && isInteractive) {
    const anySource = hasDevAuthAccessKey || hasMainAccessKey || hasLegacyAccessKey;
    if (anySource) {
      seedAuth = await withRl(async (rl) => {
        return await promptSelect(rl, {
          title: 'Seed authentication into this PR stack so it works without a re-login?',
          options: [
            { label: 'yes (recommended)', value: true },
            { label: 'no (I will login manually for this stack)', value: false },
          ],
          defaultIndex: 0,
        });
      });
    } else {
      seedAuth = false;
    }
  }

	  if (seedAuth && !authFromFlag && isInteractive) {
	    const options = [];
	    if (hasDevAuthAccessKey) {
	      options.push({ label: 'dev-auth (recommended) — use your dedicated dev auth seed stack', value: 'dev-auth' });
	    }
	    if (hasMainAccessKey) {
	      options.push({ label: 'main — use hstack main credentials', value: 'main' });
	    }
	    options.push({ label: 'skip seeding (manual login)', value: 'skip' });

	    const defaultIdx = Math.max(
	      0,
	      options.findIndex((o) => o.value === (hasDevAuthAccessKey ? 'dev-auth' : hasMainAccessKey ? 'main' : 'skip'))
	    );
    const picked = await withRl(async (rl) => {
      return await promptSelect(rl, {
        title: 'Which auth source should this PR stack use?',
        options,
        defaultIndex: defaultIdx,
      });
    });
    if (picked === 'skip') {
      seedAuth = false;
    } else {
      authFrom = String(picked);
    }
  }

  if (seedAuth && authLinkFlag == null && isInteractive) {
    authLink = await withRl(async (rl) => {
      return await promptSelect(rl, {
        title: 'When seeding, reuse credentials via symlink or copy?',
        options: [
          { label: 'symlink (recommended) — stays up to date', value: true },
          { label: 'copy — more isolated per stack', value: false },
        ],
        defaultIndex: authLink ? 0 : 1,
      });
    });
  }

  const progress = (line) => {
    // In JSON mode, never pollute stdout (reserved for final JSON).
    // eslint-disable-next-line no-console
    (json ? console.error : console.log)(line);
  };

  // 1) Create (or reuse) the stack.
  let created = null;
		  if (!stackExists) {
		    progress(`[stack] pr: creating stack "${stackName}" (server=${serverComponent})...`);
		    created = await cmdNew({
	      rootDir,
	      argv: [
	        stackName,
	        '--no-copy-auth',
	        `--server=${serverComponent}`,
	        ...(dbProviderFromArg ? [`--db-provider=${dbProviderFromArg}`] : []),
	        ...(databaseUrlFromArg ? [`--database-url=${databaseUrlFromArg}`] : []),
	        ...(json ? ['--json'] : []),
	      ],
		      // Prevent cmdNew from printing in JSON mode (we’ll print the final combined object below).
		      emit: !json,
		    });
        stackName = created?.stackName ?? stackName;
		  } else {
	    progress(`[stack] pr: reusing existing stack "${stackName}"...`);
	    // Ensure requested server flavor is compatible with the existing stack.
	    const existing = await readStackInfoSnapshot({ rootDir, stackName });
    if (existing.serverComponent !== serverComponent) {
      throw new Error(
        `[stack] pr: existing stack "${stackName}" uses server=${existing.serverComponent}, but command requested server=${serverComponent}.\n` +
          `Fix: create a new stack name, or switch the stack's server flavor first (hstack stack srv ${stackName} -- use ...).`
      );
    }
    created = { ok: true, stackName, reused: true, serverComponent: existing.serverComponent };
  }

  // 2) Checkout PR worktrees and pin them to the stack env file.
  const prSpecs = [{ component: 'happier-ui', pr: prRepo }];

  const worktrees = [];
  const stackEnvPath = resolveStackEnvPath(stackName).envPath;
  for (const { component, pr } of prSpecs) {
    progress(`[stack] pr: ${stackName}: fetching PR for ${component} (${pr})...`);
    const out = await withStackEnv({
      stackName,
      fn: async ({ env }) => {
        const doUpdate = reuseExisting || flags.has('--update');
        const args = [
          'pr',
          pr,
          ...(remoteNameFromArg ? [`--remote=${remoteNameFromArg}`] : []),
          ...(depsMode ? [`--deps=${depsMode}`] : []),
          ...(doUpdate ? ['--update'] : []),
          ...(flags.has('--force') ? ['--force'] : []),
          '--use',
          '--json',
        ];
        const stdout = await runCapture(process.execPath, [join(rootDir, 'scripts', 'worktrees.mjs'), ...args], { cwd: rootDir, env });
        const parsed = stdout.trim() ? JSON.parse(stdout.trim()) : null;

        // Fail-closed invariant for PR stacks:
        // If you asked to pin a component to a PR checkout, it MUST be a worktree path under
        // the active workspace components dir (including sandbox workspace).
        if (parsed?.path && !isWorktreePath({ rootDir, dir: parsed.path, env })) {
          throw new Error(
            `[stack] pr: refusing to pin ${component} because the checked out path is not a worktree.\n` +
              `- expected under: ${resolve(getWorkspaceDir(rootDir, env))}/{pr,local,tmp}/...\n` +
              `- actual: ${String(parsed.path ?? '').trim()}\n` +
              `Fix: this is a bug. Please re-run with --force, or delete/recreate the stack (${stackName}).`
          );
        }

        return parsed;
      },
    });
    if (out) {
      worktrees.push(out);
      const repoDir =
        (out.worktreeRoot ? resolve(String(out.worktreeRoot)) : null) ||
        (out.path ? coerceHappyMonorepoRootFromPath(String(out.path)) : null);
      if (!repoDir) {
        throw new Error('[stack] pr: expected a monorepo worktree root but could not resolve it from the checked out path.');
      }
      if (!isWorktreePath({ rootDir, dir: repoDir, env: process.env })) {
        throw new Error(`[stack] pr: refusing to pin repo because the checked out path is not a worktree: ${repoDir}`);
      }
      await ensureEnvFileUpdated({ envPath: stackEnvPath, updates: [{ key: 'HAPPIER_STACK_REPO_DIR', value: repoDir }] });
    }
    if (json) {
      // collected above
    } else if (out) {
      const short = (sha) => (sha ? String(sha).slice(0, 8) : '');
      const changed = Boolean(out.updated && out.oldHead && out.newHead && out.oldHead !== out.newHead);
      if (changed) {
        // eslint-disable-next-line no-console
        console.log(`[stack] pr: ${stackName}: ${component}: updated ${short(out.oldHead)} -> ${short(out.newHead)}`);
      } else if (out.updated) {
        // eslint-disable-next-line no-console
        console.log(`[stack] pr: ${stackName}: ${component}: already up to date (${short(out.newHead)})`);
      } else {
        // eslint-disable-next-line no-console
        console.log(`[stack] pr: ${stackName}: ${component}: checked out (${short(out.newHead)})`);
      }
    }
  }

  // Validate that the PR checkout is pinned correctly before starting.
  if (prSpecs.length) {
    const wt0 = worktrees[0] ?? null;
    const expectedRepo =
      (wt0?.worktreeRoot ? resolve(String(wt0.worktreeRoot)) : null) ||
      (wt0?.path ? coerceHappyMonorepoRootFromPath(String(wt0.path)) : null);
    if (!expectedRepo) {
      throw new Error('[stack] pr: failed to resolve expected repo dir from the PR checkout output.');
    }
    const afterRaw = await readExistingEnv(stackEnvPath);
    const afterEnv = parseEnvToObject(afterRaw);
    const pinned = String(afterEnv.HAPPIER_STACK_REPO_DIR ?? '').trim();
    if (!pinned) {
      throw new Error(
        `[stack] pr: failed to pin repo to the PR checkout.\n` +
          `- missing env key: HAPPIER_STACK_REPO_DIR\n` +
          `- expected: ${expectedRepo}\n` +
          `Fix: re-run with --force, or delete/recreate the stack (${stackName}).`
      );
    }
    const expected = resolve(expectedRepo);
    const actual = resolve(pinned);
    if (expected !== actual) {
      throw new Error(
        `[stack] pr: stack is pinned to the wrong checkout.\n` +
          `- env key: HAPPIER_STACK_REPO_DIR\n` +
          `- expected: ${expected}\n` +
          `- actual:   ${actual}\n` +
          `Fix: re-run with --force, or delete/recreate the stack (${stackName}).`
      );
    }
  }

  // 3) Optional: seed auth (copies cli creds + master secret + DB Account rows).
  let auth = null;
  if (seedAuth) {
    progress(`[stack] pr: ${stackName}: seeding auth from "${authFrom}"...`);
    const args = [
      'copy-from',
      authFrom,
      ...(authForce ? ['--force'] : []),
      ...(withInfra ? ['--with-infra'] : []),
      ...(authLink ? ['--link'] : []),
    ];
    if (json) {
      const extraEnv = await getRuntimePortExtraEnv(stackName);
      auth = await withStackEnv({
        stackName,
        ...(extraEnv ? { extraEnv } : {}),
        fn: async ({ env }) => {
          const stdout = await runCapture(process.execPath, [join(rootDir, 'scripts', 'auth.mjs'), ...args, '--json'], { cwd: rootDir, env });
          return stdout.trim() ? JSON.parse(stdout.trim()) : null;
        },
      });
    } else {
      await cmdAuth({ rootDir, stackName, args });
      auth = { ok: true, from: authFrom };
    }
  }

  // 4) Optional: start dev / start.
  if (wantsDev) {
    progress(`[stack] pr: ${stackName}: starting dev...`);
    const args = [
      ...(wantsMobile ? ['--mobile'] : []),
      ...(wantsExpoTailscale ? ['--expo-tailscale'] : []),
      ...(passthrough.length ? ['--', ...passthrough] : []),
    ];
    await cmdRunScript({ rootDir, stackName, scriptPath: resolveTopLevelNodeScriptFile('dev') || 'dev.mjs', args, background });
  } else if (wantsStart) {
    progress(`[stack] pr: ${stackName}: starting...`);
    const args = [
      ...(wantsMobile ? ['--mobile'] : []),
      ...(wantsExpoTailscale ? ['--expo-tailscale'] : []),
      ...(passthrough.length ? ['--', ...passthrough] : []),
    ];
    await cmdRunScript({ rootDir, stackName, scriptPath: resolveTopLevelNodeScriptFile('start') || 'run.mjs', args, background });
  }

  const info = await readStackInfoSnapshot({ rootDir, stackName });

  const out = {
    ok: true,
    stackName,
    created,
    worktrees: worktrees.length ? worktrees : null,
    auth,
    info,
  };

  if (json) {
    printResult({ json, data: out });
    return;
  }
  // Non-JSON mode already streamed output.
}

async function cmdStackDaemon({ rootDir, stackName, argv, json }) {
  await runStackDaemonCommand({ rootDir, stackName, argv, json });
}

async function main() {
  const rootDir = getRootDir(import.meta.url);
  // Some callers pass an extra leading `--` when forwarding args into scripts. Normalize it away so
  // positional slicing behaves consistently.
  const rawArgv = process.argv.slice(2);
  const argv0 = rawArgv[0] === '--' ? rawArgv.slice(1) : rawArgv;
  const argv = normalizeStackNameFirstArgs(argv0, { stackExists: stackExistsSync });

  const helpSepIdx = argv.indexOf('--');
  const helpScopeArgv = helpSepIdx === -1 ? argv : argv.slice(0, helpSepIdx);

  const { flags } = parseArgs(helpScopeArgv);
  const json = wantsJson(helpScopeArgv, { flags });

  const positionals = helpScopeArgv.filter((a) => a && a !== '--' && !a.startsWith('-'));
  const cmd = positionals[0] || 'help';
  const wantsHelpFlag = wantsHelp(helpScopeArgv, { flags });
  const stackNameForHelp = stackNameFromArg(positionals, 1);
  // Subcommand-specific help (so `hstack stack eas --help` works).
  if (wantsHelpFlag && cmd === 'eas') {
    const stackName = stackNameFromArg(positionals, 1);

    const runHelp = async (env) => {
      await run(process.execPath, [join(rootDir, 'scripts', 'eas.mjs'), '--help'], { cwd: rootDir, env });
    };

    if (stackName && stackExistsSync(stackName)) {
      await withStackEnv({
        stackName,
        fn: async ({ env }) => {
          await runHelp(env);
        },
      });
      return;
    }

    await runHelp(process.env);
    return;
  }
  // Allow subcommand-specific help (so `hstack stack pr --help` shows PR stack flags).
  if (wantsHelpFlag && cmd === 'pr') {
    await cmdPrStack({ rootDir, argv });
    return;
  }
  // Allow subcommand-specific help (so `hstack stack daemon <name> --help` works).
  if (wantsHelpFlag && cmd === 'daemon') {
    const stackName = stackNameFromArg(positionals, 1) || 'main';
    const passthrough = argv.slice(2);
    await cmdStackDaemon({ rootDir, stackName, argv: passthrough, json });
    return;
  }
  if (wantsHelpFlag && cmd !== 'help') {
    const handled = await printDelegatedStackHelpIfAvailable({
      rootDir,
      command: cmd,
      stackName: stackNameForHelp,
      json,
    });
    if (handled) {
      return;
    }
  }
  if (wantsHelpFlag && cmd !== 'help') {
    const text = renderStackSubcommandHelpText(cmd);
    if (text) {
      printResult({
        json,
        data: { ok: true, cmd, usage: getStackHelpUsageLine(cmd) },
        text,
      });
      return;
    }
  }
  if (wantsHelpFlag || cmd === 'help') {
    printResult({
      json,
      data: {
        commands: STACK_HELP_COMMANDS,
      },
      text: renderStackRootHelpText(),
    });
    return;
  }

  if (cmd === 'new') {
    await cmdNew({ rootDir, argv: argv.slice(1) });
    return;
  }
  if (cmd === 'edit') {
    await cmdEdit({ rootDir, argv });
    return;
  }
  if (cmd === 'list') {
    const names = (await listAllStackNames()).filter((n) => n !== 'main');
    if (json) {
      printResult({ json, data: { stacks: names } });
    } else {
      await cmdListStacks();
    }
    return;
  }
  if (cmd === 'audit') {
    await cmdAudit({ rootDir, argv });
    return;
  }
  if (cmd === 'duplicate') {
    await cmdDuplicate({ rootDir, argv });
    return;
  }
  if (cmd === 'info') {
    await cmdInfo({ rootDir, argv });
    return;
  }
  if (cmd === 'pr') {
    await cmdPrStack({ rootDir, argv });
    return;
  }
  if (cmd === 'create-dev-auth-seed') {
    await cmdCreateDevAuthSeed({ rootDir, argv });
    return;
  }

  // Commands that need a stack name.
  const stackName = stackNameFromArg(positionals, 1);
  if (!stackName) {
    const helpLines =
      cmd === 'service'
        ? [
            '[stack] usage:',
            '  hstack stack service <name> <install|uninstall|status|start|stop|restart|enable|disable|logs|tail>',
            '',
            'example:',
            '  hstack stack service exp1 status',
          ]
        : cmd === 'wt'
          ? [
              '[stack] usage:',
              '  hstack stack wt <name> -- <wt args...>',
              '',
              'example:',
	              '  hstack stack wt exp1 -- use happier pr/123-fix-thing',
            ]
          : cmd === 'srv'
            ? [
                '[stack] usage:',
                '  hstack stack srv <name> -- status|use ...',
                '',
                'example:',
                '  hstack stack srv exp1 -- status',
              ]
            : cmd === 'env'
              ? [
                  '[stack] usage:',
                  '  hstack stack env <name> set KEY=VALUE [KEY2=VALUE2...]',
                  '  hstack stack env <name> unset KEY [KEY2...]',
                  '  hstack stack env <name> get KEY',
                  '  hstack stack env <name> list',
                  '  hstack stack env <name> path',
                ]
              : cmd === 'eas'
                ? [
                    '[stack] usage:',
                    '  hstack stack eas <name> <eas args...>',
                    '',
                    'examples:',
                    '  hstack stack eas happier android --profile production',
                    '  hstack stack eas happier build --platform android --profile production',
                    '  hstack stack eas happier env:sync --environment production',
                  ]
              : cmd === 'daemon'
                ? [
                    '[stack] usage:',
                    '  hstack stack daemon <name> start|stop|restart|status [--json]',
                  '',
                  'example:',
                  '  hstack stack daemon main status',
                ]
            : cmd.startsWith('tailscale:')
              ? [
                  '[stack] usage:',
                  '  hstack stack tailscale:status|enable|disable|url <name> [-- ...]',
                  '',
                  'example:',
                  '  hstack stack tailscale:status exp1',
                ]
              : [
                  '[stack] missing stack name.',
                  'Run: hstack stack --help',
                ];

    printResult({ json, data: { ok: false, error: 'missing_stack_name', cmd }, text: helpLines.join('\n') });
    process.exit(1);
  }

  // Remaining args after "<cmd> <name>"
  const passthrough = argv.slice(2);

  if (cmd === 'archive') {
    const res = await cmdArchiveStack({ rootDir, argv, stackName });
    if (json) {
      printResult({ json, data: res });
    } else if (res.dryRun) {
      console.log(`[stack] would archive "${stackName}" -> ${res.archivedStackDir} (dry-run)`);
    } else {
      console.log(`[stack] archived "${stackName}" -> ${res.archivedStackDir}`);
    }
    return;
  }

  if (cmd === 'env') {
    const hasPositional = passthrough.some((a) => !a.startsWith('-'));
    const envArgv = hasPositional ? passthrough : ['list', ...passthrough];
    // Forward to scripts/env.mjs under the stack env.
    // This keeps stack env editing behavior unified with `hstack env ...`.
    await withStackEnv({
      stackName,
      fn: async ({ env }) => {
        await run(process.execPath, [join(rootDir, 'scripts', 'env.mjs'), ...envArgv], { cwd: rootDir, env });
      },
    });
    return;
  }
  if (cmd === 'daemon') {
    await cmdStackDaemon({ rootDir, stackName, argv: passthrough, json });
    return;
  }
  if (cmd === 'eas') {
    // Forward EAS commands under the stack env.
    // Example:
    //   hstack stack eas <name> build --platform ios --profile production
    await withStackEnv({
      stackName,
      fn: async ({ env }) => {
        await run(process.execPath, [join(rootDir, 'scripts', 'eas.mjs'), ...passthrough], { cwd: rootDir, env });
      },
    });
    return;
  }
  if (cmd === 'happier') {
    await runStackHappierPassthroughCommand({ rootDir, stackName, passthrough });
    return;
  }
  if (STACK_BACKGROUND_SCRIPT_BY_COMMAND.has(cmd)) {
    const background = passthrough.includes('--background') || passthrough.includes('--bg');
    const args = background ? passthrough.filter((a) => a !== '--background' && a !== '--bg') : passthrough;
    await cmdRunScript({ rootDir, stackName, scriptPath: STACK_BACKGROUND_SCRIPT_BY_COMMAND.get(cmd), args, background });
    return;
  }
  if (STACK_REPO_OVERRIDE_SCRIPT_BY_COMMAND.has(cmd)) {
    const { kv } = parseArgs(passthrough);
    const overrides = resolveTransientRepoOverrides({ rootDir, kv });
    await cmdRunScript({
      rootDir,
      stackName,
      scriptPath: STACK_REPO_OVERRIDE_SCRIPT_BY_COMMAND.get(cmd),
      args: passthrough,
      extraEnv: overrides,
    });
    return;
  }
  if (cmd === 'doctor') {
    await cmdRunScript({ rootDir, stackName, scriptPath: resolveTopLevelNodeScriptFile('doctor') || 'doctor.mjs', args: passthrough });
    return;
  }
  if (cmd === 'mobile') {
    await cmdRunScript({ rootDir, stackName, scriptPath: resolveTopLevelNodeScriptFile('mobile') || 'mobile.mjs', args: passthrough });
    return;
  }
  if (cmd === 'mobile-dev-client') {
    // Stack-scoped wrapper so the dev-client can be built from the stack's active Happier checkout/worktree.
    await cmdRunScript({ rootDir, stackName, scriptPath: resolveTopLevelNodeScriptFile('mobile-dev-client') || 'mobile_dev_client.mjs', args: passthrough });
    return;
  }
  if (cmd === 'mobile:install') {
    await runStackMobileInstallCommand({ rootDir, stackName, passthrough, json });
    return;
  }
  if (cmd === 'resume') {
    await runStackResumeCommand({ rootDir, stackName, passthrough, json });
    return;
  }

  if (cmd === 'stop') {
    await runStackStopCommand({ rootDir, stackName, passthrough, json });
    return;
  }

  if (cmd === 'code' || cmd === 'cursor' || cmd === 'open') {
    await runStackWorkspaceCommand({ command: cmd, rootDir, stackName, json, flags });
    return;
  }

  if (cmd === 'srv') {
    await cmdSrv({ rootDir, stackName, args: passthrough });
    return;
  }
  if (cmd === 'wt') {
    await cmdWt({ rootDir, stackName, args: passthrough });
    return;
  }
  if (cmd === 'auth') {
    await cmdAuth({ rootDir, stackName, args: passthrough });
    return;
  }

  if (cmd === 'service') {
    const svcCmd = passthrough[0];
    if (!svcCmd) {
      printResult({
        json,
        data: { ok: false, error: 'missing_service_subcommand', stackName },
        text: [
          '[stack] usage:',
          '  hstack stack service <name> <install|uninstall|status|start|stop|restart|enable|disable|logs|tail>',
          '',
          'example:',
          `  hstack stack service ${stackName} status`,
        ].join('\n'),
      });
      process.exit(1);
    }
    await cmdService({ rootDir, stackName, svcCmd });
    return;
  }

  if (cmd.startsWith('service:')) {
    const svcCmd = cmd.slice('service:'.length);
    await cmdService({ rootDir, stackName, svcCmd });
    return;
  }
  if (cmd.startsWith('tailscale:')) {
    const subcmd = cmd.slice('tailscale:'.length);
    await cmdTailscale({ rootDir, stackName, subcmd, args: passthrough });
    return;
  }

  if (flags.has('--interactive') && cmd === 'help') {
    // no-op
  }

  console.log(`[stack] unknown command: ${cmd}`);
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error('[stack] failed:', message);
  if (process.env.DEBUG && err instanceof Error && err.stack) {
    console.error(err.stack);
  }
  process.exit(1);
});
