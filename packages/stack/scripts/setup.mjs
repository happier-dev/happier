import './utils/env/env.mjs';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from './utils/cli/args.mjs';
import { printResult, wantsHelp, wantsJson } from './utils/cli/cli.mjs';
import { getDefaultAutostartPaths, getHappyStacksHomeDir, getRootDir, resolveStackEnvPath } from './utils/paths/paths.mjs';
import { isTty, prompt, promptSelect, withRl } from './utils/cli/wizard.mjs';
import { getCanonicalHomeDir } from './utils/env/config.mjs';
import { ensureEnvLocalUpdated } from './utils/env/env_local.mjs';
import { run, runCapture } from './utils/proc/proc.mjs';
import { waitForHappyHealthOk } from './utils/server/server.mjs';
import { tailscaleServeEnable, tailscaleServeHttpsUrlForInternalServerUrl } from './tailscale.mjs';
import { getRuntimeDir } from './utils/paths/runtime.mjs';
import { homedir } from 'node:os';
import { installService } from './service.mjs';
import { getDevAuthKeyPath } from './utils/auth/dev_key.mjs';
import { isSandboxed, sandboxAllowsGlobalSideEffects } from './utils/env/sandbox.mjs';
import { boolFromFlags, boolFromFlagsOrKv } from './utils/cli/flags.mjs';
import { normalizeProfile, normalizeServerComponent } from './utils/cli/normalize.mjs';
import { openUrlInBrowser } from './utils/ui/browser.mjs';
import { commandExists } from './utils/proc/commands.mjs';
import { readServerPortFromEnvFile, resolveServerPortFromEnv } from './utils/server/port.mjs';
import { guidedStackAuthLoginNow } from './utils/auth/stack_guided_login.mjs';
import { getVerbosityLevel } from './utils/cli/verbosity.mjs';
import { runCommandLogged } from './utils/cli/progress.mjs';
import { bold, cyan, dim, green, yellow } from './utils/ui/ansi.mjs';
import { expandHome } from './utils/paths/canonical_home.mjs';
import { listAllStackNames } from './utils/stack/stacks.mjs';
import { detectSwiftbarPluginInstalled } from './utils/menubar/swiftbar.mjs';
import { banner, bullets, cmd as cmdFmt, kv, sectionTitle } from './utils/ui/layout.mjs';
import { applyBindModeToEnv, resolveBindModeFromArgs } from './utils/net/bind_mode.mjs';

function resolveWorkspaceDirDefault() {
  const explicit = (process.env.HAPPIER_STACK_WORKSPACE_DIR ?? '').toString().trim();
  if (explicit) return expandHome(explicit);
  return join(getHappyStacksHomeDir(process.env), 'workspace');
}

function normalizeWorkspaceDirInput(raw, { homeDir }) {
  const trimmed = String(raw ?? '').trim();
  const expanded = expandHome(trimmed);
  if (!expanded) return '';
  // If relative, treat it as relative to the home dir (same rule as init.mjs).
  return expanded.startsWith('/') ? expanded : join(homeDir, expanded);
}

async function resolveMainServerPort() {
  // Priority:
  // - explicit env var
  // - main stack env file (preferred)
  // - default
  const hasEnvOverride =
    (process.env.HAPPIER_STACK_SERVER_PORT ?? '').toString().trim() !== '';
  if (hasEnvOverride) {
    return resolveServerPortFromEnv({ env: process.env, defaultPort: 3005 });
  }
  const envPath = resolveStackEnvPath('main').envPath;
  return await readServerPortFromEnvFile(envPath, { defaultPort: 3005 });
}

function normalizeGithubRepoUrl(raw) {
  const v = String(raw ?? '').trim();
  if (!v) return '';

  // Accept full URLs and ssh URLs as-is.
  if (v.includes('://') || v.startsWith('git@')) return v;

  // Convenience: owner/repo -> https://github.com/owner/repo.git
  const m = v.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (m) {
    const owner = m[1];
    const repo = m[2];
    return `https://github.com/${owner}/${repo}.git`;
  }

  // Fallback: let git try to interpret it (could be a local path).
  return v;
}

async function ensureSetupConfigPersisted({ rootDir, profile, serverComponent, tailscaleWanted, menubarMode, happyRepoUrl }) {
  // Repo source here describes where we clone the main Happy monorepo from (UI + CLI + full server).
  // Server-light (sqlite) remains fork-only for now and is handled separately in bootstrap defaults.
  const repoSourceForProfile = profile === 'selfhost' ? 'upstream' : null;
  const monoRepo = String(happyRepoUrl ?? '').trim();
  const updates = [
    { key: 'HAPPIER_STACK_SERVER_COMPONENT', value: serverComponent },
    // Default for selfhost:
    // - monorepo: upstream (slopus/*)
    // - server-light: fork-only today (handled in bootstrap)
    ...(repoSourceForProfile
      ? [
          { key: 'HAPPIER_STACK_REPO_SOURCE', value: repoSourceForProfile },
        ]
      : []),
    ...(monoRepo
      ? [
          // Override the Happy monorepo clone source (UI + CLI + full server).
          // This is useful for forks that keep the same monorepo layout under a different repo name.
          { key: 'HAPPIER_STACK_UI_REPO_URL', value: monoRepo },
          { key: 'HAPPIER_STACK_CLI_REPO_URL', value: monoRepo },
          { key: 'HAPPIER_STACK_SERVER_FULL_REPO_URL', value: monoRepo },
        ]
      : []),
    { key: 'HAPPIER_STACK_MENUBAR_MODE', value: menubarMode },
    ...(tailscaleWanted
      ? [
          { key: 'HAPPIER_STACK_TAILSCALE_SERVE', value: '1' },
        ]
      : []),
  ];
  await ensureEnvLocalUpdated({ rootDir, updates });
}

async function ensureSystemdAvailable() {
  if (process.platform !== 'linux') return true;
  return (await commandExists('systemctl')) && (await commandExists('journalctl'));
}

async function detectDockerSupport() {
  const installed = await commandExists('docker');
  if (!installed) return { installed: false, running: false };
  try {
    // `docker info` returns non-zero quickly when the daemon isn't running.
    await runCapture('docker', ['info'], { timeoutMs: 2500 });
    return { installed: true, running: true };
  } catch {
    return { installed: true, running: false };
  }
}

async function detectGitSupport() {
  return await commandExists('git');
}

async function detectTailscaleSupport() {
  const installed = await commandExists('tailscale');
  return { installed };
}

function isSwiftbarAppInstalled() {
  if (process.platform !== 'darwin') return false;
  // Best-effort: not exhaustive, but catches the common case.
  return existsSync('/Applications/SwiftBar.app');
}

async function detectIosDevTools() {
  if (process.platform !== 'darwin') return { ok: false, hasXcode: false, hasCocoapods: false };
  const hasXcode = await commandExists('xcodebuild');
  const hasCocoapods = await commandExists('pod');
  return { ok: hasXcode && hasCocoapods, hasXcode, hasCocoapods };
}

async function runSetupPreflight({ profile, serverComponent, tailscaleWanted, menubarWanted, autostartWanted }) {
  // Fail-fast on the truly required bits (so we don't get halfway through and crash).
  const gitOk = await detectGitSupport();
  if (!gitOk) {
    throw new Error(
      `[setup] missing prerequisite: git\n` +
        `Happy Stacks needs git to clone/update component repos.\n` +
        `Fix: install git, then re-run setup.`
    );
  }

  const sandboxed = isSandboxed();
  const allowGlobal = sandboxAllowsGlobalSideEffects();

  const docker = profile === 'selfhost' ? await detectDockerSupport() : { installed: false, running: false };
  const tailscale = tailscaleWanted ? await detectTailscaleSupport() : { installed: false };
  const ios = profile === 'dev' ? await detectIosDevTools() : { ok: false, hasXcode: false, hasCocoapods: false };

  const canInstallAutostart = autostartWanted && (!sandboxed || allowGlobal);
  const canInstallMenubar = menubarWanted && process.platform === 'darwin' && (!sandboxed || allowGlobal);
  const canEnableTailscale = tailscaleWanted && tailscale.installed && (!sandboxed || allowGlobal);

  return {
    gitOk,
    docker,
    tailscale,
    ios,
    sandboxed,
    allowGlobal,
    canInstallAutostart,
    canInstallMenubar,
    canEnableTailscale,
    swiftbarAppInstalled: menubarWanted ? isSwiftbarAppInstalled() : null,
    serverComponent,
  };
}

async function runNodeScript({ rootDir, rel, args = [], env = process.env }) {
  await run(process.execPath, [join(rootDir, rel), ...args], { cwd: rootDir, env });
}

async function spawnDetachedNodeScript({ rootDir, rel, args = [], env = process.env }) {
  const child = spawn(process.execPath, [join(rootDir, rel), ...args], {
    cwd: rootDir,
    env,
    stdio: 'ignore',
    detached: process.platform !== 'win32',
  });
  child.unref();
  return child.pid;
}

function mainCliHomeDirForEnvPath(envPath) {
  const { baseDir } = resolveStackEnvPath('main');
  // Prefer stack base dir; envPath is informational and can be legacy/new.
  return join(baseDir, 'cli');
}

function getMainStacksAccessKeyPath() {
  const cliHomeDir = mainCliHomeDirForEnvPath(resolveStackEnvPath('main').envPath);
  return join(cliHomeDir, 'access.key');
}

function getLegacyHappyAccessKeyPath() {
  return join(homedir(), '.happy', 'cli', 'access.key');
}

function getDevAuthStackAccessKeyPath(stackName = 'dev-auth') {
  const { baseDir, envPath } = resolveStackEnvPath(stackName);
  if (!existsSync(envPath)) return null;
  return join(baseDir, 'cli', 'access.key');
}

function detectAuthSources() {
  const devKeyPath = getDevAuthKeyPath();
  const mainAccessKeyPath = getMainStacksAccessKeyPath();
  const legacyAccessKeyPath = getLegacyHappyAccessKeyPath();
  const devAuthAccessKeyPath = getDevAuthStackAccessKeyPath('dev-auth');
  const allowLegacy = !isSandboxed() || sandboxAllowsGlobalSideEffects();
  return {
    devKeyPath,
    hasDevKey: existsSync(devKeyPath),
    mainAccessKeyPath,
    hasMainAccessKey: existsSync(mainAccessKeyPath),
    legacyAccessKeyPath,
    hasLegacyAccessKey: allowLegacy && existsSync(legacyAccessKeyPath),
    devAuthAccessKeyPath,
    hasDevAuthAccessKey: Boolean(devAuthAccessKeyPath && existsSync(devAuthAccessKeyPath)),
  };
}

async function maybeConfigureAuthDefaults({ rootDir, profile, interactive }) {
  if (!interactive) return;
  if (profile !== 'dev') return;

  const sources = detectAuthSources();
  const autoSeedEnabled =
    (process.env.HAPPIER_STACK_AUTO_AUTH_SEED ?? '').toString().trim() === '1';
  const seedFrom = (process.env.HAPPIER_STACK_AUTH_SEED_FROM ?? '').toString().trim();
  const linkMode =
    (process.env.HAPPIER_STACK_AUTH_LINK ?? '').toString().trim() === '1' ||
    (process.env.HAPPIER_STACK_AUTH_MODE ?? '').toString().trim().toLowerCase() === 'link';

  // If we already have dev-auth seeded and configured, don't ask redundant questions.
  // (User can always re-run setup or use stack/auth commands to change this.)
  const alreadyConfiguredDevAuth = autoSeedEnabled && seedFrom === 'dev-auth' && sources.hasDevAuthAccessKey;
  if (alreadyConfiguredDevAuth) {
    // eslint-disable-next-line no-console
    console.log('');
    // eslint-disable-next-line no-console
    console.log(bold('Authentication (development)'));
    // eslint-disable-next-line no-console
    console.log(`${green('✓')} dev-auth auth seeding is already configured`);
    // eslint-disable-next-line no-console
    console.log(`${dim('Seed from:')} ${cyan('dev-auth')}`);
    // eslint-disable-next-line no-console
    console.log(`${dim('Mode:')} ${linkMode ? 'symlink' : 'copy'}`);
    if (sources.hasDevKey) {
      // eslint-disable-next-line no-console
      console.log(`${dim('Dev key:')} configured`);
    }
    // If a user wants to change or recreate:
    // eslint-disable-next-line no-console
    console.log(dim(`Tip: to recreate the seed stack, run: ${yellow('hapsta stack create-dev-auth-seed')}`));
    return;
  }

  // eslint-disable-next-line no-console
  console.log('');
  // eslint-disable-next-line no-console
  console.log(bold('Authentication (development)'));
  // eslint-disable-next-line no-console
  console.log(
    dim(
      `Recommended: set up a dedicated ${cyan('dev-auth')} seed stack so you authenticate once, then new stacks “just work”.`
    )
  );
  const seedChoice = 'dev-auth';
  const linkChoice = 'link';

  if (!sources.hasDevAuthAccessKey) {
    const wantLoginNow = await withRl(async (rl) => {
      return await promptSelect(rl, {
        title:
          `${bold('Sign in now?')}\n` +
          `${dim('This will create a dedicated dev-auth seed stack and walk you through a guided login in the browser.')}\n` +
          `${dim('After this, new stacks can reuse your auth automatically (recommended).')}`,
        options: [
          { label: `yes (${green('recommended')}) — sign in now`, value: true },
          { label: `no — I will do this later`, value: false },
        ],
        defaultIndex: 0,
      });
    });

    if (!wantLoginNow) {
      // eslint-disable-next-line no-console
      console.log(dim(`Tip: run ${yellow('hapsta stack create-dev-auth-seed dev-auth --login')} anytime to sign in.`));
      return;
    }

    // Guided wizard: creates stack, starts temporary UI/server, stores dev key (optional), logs in CLI.
    await runNodeScript({
      rootDir,
      rel: 'scripts/stack.mjs',
      args: ['create-dev-auth-seed', 'dev-auth', '--login', '--skip-default-seed'],
    });
  } else {
    // eslint-disable-next-line no-console
    console.log(dim(`Found an existing ${cyan('dev-auth')} seed stack; configuring auth reuse for new stacks.`));
  }

  await ensureEnvLocalUpdated({
    rootDir,
    updates: [
      { key: 'HAPPIER_STACK_AUTO_AUTH_SEED', value: '1' },
      { key: 'HAPPIER_STACK_AUTH_SEED_FROM', value: seedChoice },
      { key: 'HAPPIER_STACK_AUTH_LINK', value: linkChoice === 'link' ? '1' : '0' },
    ],
  });

  {
    const envLocalPath = join(getCanonicalHomeDir(), 'env.local');
    // eslint-disable-next-line no-console
    console.log('');
    // eslint-disable-next-line no-console
    console.log(bold('Automatic sign-in for new stacks'));
    // eslint-disable-next-line no-console
    console.log(dim(`Enabled: when you create a new stack, Happy Stacks will reuse auth from ${cyan(seedChoice)} automatically.`));
    // eslint-disable-next-line no-console
    console.log(`${dim('Seed from:')} ${cyan(seedChoice)}`);
    // eslint-disable-next-line no-console
    console.log(`${dim('Mode:')} ${linkChoice === 'link' ? 'symlink' : 'copy'} ${dim(linkChoice === 'link' ? '(recommended)' : '')}`.trim());
    // eslint-disable-next-line no-console
    console.log(dim(`Config: ${envLocalPath}`));
  }

  // Optional: seed existing stacks now (useful if the user already has stacks).
  const allStacks = await listAllStackNames().catch(() => ['main']);
  const candidateTargets = allStacks.filter((s) => s !== 'main' && s !== seedChoice);
  if (candidateTargets.length) {
    const seedNow = await withRl(async (rl) => {
      return await promptSelect(rl, {
        title:
          `${bold('Apply sign-in to existing stacks?')}\n` +
          `${dim(`We found ${candidateTargets.length} existing stack(s) that could reuse your auth automatically.`)}\n` +
          `${dim('This can fix “auth required / no machine” without re-login.')}`,
        options: [
          { label: `yes (${green('recommended')}) — apply to ${candidateTargets.length} stack(s) now`, value: true },
          { label: 'no — leave them as-is', value: false },
        ],
        defaultIndex: 0,
      });
    });
    if (seedNow) {
      const except = ['main'];
      if (seedChoice !== 'main') except.push(seedChoice);
      const args = [
        'copy-from',
        seedChoice,
        '--all',
        `--except=${except.join(',')}`,
        ...(linkChoice === 'link' ? ['--link'] : []),
      ];
      await runNodeScript({ rootDir, rel: 'scripts/auth.mjs', args });
    }
  } else {
    // eslint-disable-next-line no-console
    console.log(dim('No existing stacks detected that need seeding (nothing to do).'));
  }

  // Dev key UX (for phone/Playwright restores).
  const sourcesAfter = detectAuthSources();
  if (sourcesAfter.hasDevKey) {
    // eslint-disable-next-line no-console
    console.log('');
    // eslint-disable-next-line no-console
    console.log(bold('Dev key (optional, sensitive)'));
    // eslint-disable-next-line no-console
    console.log(dim('This lets you restore the UI account quickly (and can help automation).'));
    // eslint-disable-next-line no-console
    console.log(dim(`Stored at: ${sourcesAfter.devKeyPath}`));
    // eslint-disable-next-line no-console
    console.log(dim(`Tip: to print it later, run: ${yellow('hapsta auth dev-key --print')}`));
  } else {
    // eslint-disable-next-line no-console
    console.log(dim(`Tip: to store a dev key later, run: ${yellow('hapsta auth dev-key --set "<key>"')}`));
  }
}

async function cmdSetup({ rootDir, argv }) {
  // Alias: `hapsta setup pr ...` (maintainer-friendly, idempotent PR setup).
  // This delegates to `setup-pr` so the logic stays centralized.
  const firstPositional = argv.find((a) => !a.startsWith('--')) ?? '';
  if (firstPositional === 'pr') {
    const idx = argv.indexOf('pr');
    const forwarded = idx >= 0 ? argv.slice(idx + 1) : [];
    await run(process.execPath, [join(rootDir, 'scripts', 'setup_pr.mjs'), ...forwarded], { cwd: rootDir });
    return;
  }

  const { flags, kv } = parseArgs(argv);
  const json = wantsJson(argv, { flags });

  // Optional: bind mode affects how we print URLs (loopback vs LAN).
  // We apply it early so all downstream helpers inherit the same env.
  const bindMode = resolveBindModeFromArgs({ flags, kv });
  if (bindMode) {
    applyBindModeToEnv(process.env, bindMode);
  }

  if (wantsHelp(argv, { flags })) {
    printResult({
      json,
      data: {
        profiles: ['selfhost', 'dev'],
        flags: [
          '--profile=selfhost|dev',
          '--server=happy-server-light|happy-server',
          '--happy-repo=<owner/repo|url>        # override slopus/happy monorepo clone source',
          '--workspace-dir=/absolute/path   # dev profile only',
          '--install-path',
          '--start-now',
          '--bind=loopback|lan',
          '--loopback',
          '--lan',
          '--auth|--no-auth',
          '--tailscale|--no-tailscale',
          '--autostart|--no-autostart',
          '--menubar|--no-menubar',
          '--json',
        ],
      },
      text: [
        '[setup] usage:',
        '  hapsta setup',
        '  hapsta setup --profile=selfhost',
        '  hapsta setup --profile=dev',
        '  hapsta setup --profile=dev --workspace-dir=~/Development/happy',
        '  hapsta setup --happy-repo=happier-dev/happier',
        '  hapsta setup pr --happy=<pr-url|number> [--happy-server-light=<pr-url|number>]',
        '  hapsta setup --auth',
        '  hapsta setup --no-auth',
        '',
        'notes:',
        '  - selfhost profile is a guided installer for running Happy locally (optionally with Tailscale + autostart).',
        '  - dev profile prepares a development workspace (bootstrap wizard + optional dev tooling).',
        '  - `setup pr` is a non-interactive, idempotent helper for maintainers to run PR stacks (delegates to `hapsta setup-pr`).',
      ].join('\n'),
    });
    return;
  }

  const interactive = isTty();
  let profile = normalizeProfile(kv.get('--profile'));
  if (!profile && interactive) {
    profile = await withRl(async (rl) => {
      return await promptSelect(rl, {
        title: bold(`✨ ${cyan('Happy Stacks')} setup ✨\n\nWhat is your goal?`),
        options: [
          { label: `${cyan('Self-host')}: use Happy on this machine`, value: 'selfhost' },
          { label: `${cyan('Development')}: worktrees + stacks + contributor workflows`, value: 'dev' },
        ],
        defaultIndex: 0,
      });
    });
  }
  if (!profile) {
    profile = 'selfhost';
  }

  const verbosity = getVerbosityLevel(process.env);
  const quietUi = interactive && verbosity === 0 && !json;

  // Optional: override the monorepo clone source (UI + CLI + full server).
  const happyRepoUrl = normalizeGithubRepoUrl(kv.get('--happy-repo'));

  function isInteractiveChildCommand({ rel, args }) {
    // If a child command needs to prompt the user, it must inherit stdin/stdout.
    // Otherwise setup's quiet mode will break the wizard (stdin is intentionally disabled).
    void rel;
    return args.some((a) => String(a).trim() === '--interactive');
  }

  async function runNodeScriptMaybeQuiet({ label, rel, args = [], env = process.env, interactiveChild = null }) {
    const childIsInteractive = interactiveChild ?? isInteractiveChildCommand({ rel, args });
    if (!quietUi || childIsInteractive) {
      await run(process.execPath, [join(rootDir, rel), ...args], { cwd: rootDir, env });
      return;
    }
    const baseLogDir = join(getHappyStacksHomeDir(process.env), 'logs', 'setup');
    const logPath = join(baseLogDir, `${label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.${Date.now()}.log`);
    try {
      await runCommandLogged({
        label,
        cmd: process.execPath,
        args: [join(rootDir, rel), ...args],
        cwd: rootDir,
        env,
        logPath,
        quiet: true,
        showSteps: true,
      });
    } catch (e) {
      const lp = e?.logPath ? String(e.logPath) : logPath;
      // eslint-disable-next-line no-console
      console.error(`[setup] failed: ${label}`);
      // eslint-disable-next-line no-console
      console.error(`${dim('log:')} ${lp}`);
      throw e;
    }
  }

  function printProfileIntro({ profile }) {
    if (!process.stdout.isTTY || json) return;
    const header = profile === 'selfhost' ? `${cyan('Self-host')} setup` : `${cyan('Development')} setup`;
    const lines = [
      '',
      bold(header),
      profile === 'selfhost'
        ? dim('Run Happy locally (optionally with Tailscale + autostart).')
        : dim('Prepare a contributor workspace (components + worktrees + stacks).'),
      '',
      bold('How Happy runs locally:'),
      profile === 'selfhost'
        ? [
            `- ${cyan('server')}: stores sessions + serves the API`,
            `- ${cyan('web UI')}: where you chat + view sessions`,
            `- ${cyan('daemon')}: background process that runs/streams sessions and lets terminal runs show up in the UI`,
            '',
            dim(`A ${cyan('stack')} is one isolated instance (dirs + ports + database). Setup configures the default stack: ${cyan('main')}.`),
          ]
        : [
            `- ${cyan('workspace')}: your git checkouts (components + worktrees)`,
            `- ${cyan('stacks')}: isolated runtimes under ${cyan('~/.happy/stacks/<name>')}`,
            `- ${cyan('daemon')}: runs sessions + connects the UI <-> terminal`,
          ],
      '',
      bold('What will happen:'),
      profile === 'selfhost'
        ? [
            `- ${cyan('init')}: set up Happy Stacks home + shims`,
            `- ${cyan('bootstrap')}: clone/install components`,
            `- ${cyan('start')}: start Happy now (recommended)`,
            `- ${cyan('login')}: guided login (recommended)`,
            '',
            dim(`Tip: ${cyan('happy-server-light')} is the simplest local install (no Docker). ${cyan('happy-server')} needs Docker (Postgres/Redis/Minio).`),
          ]
        : [
            `- ${cyan('workspace')}: choose where components + worktrees live`,
            `- ${cyan('init')}: set up Happy Stacks home + shims`,
            `- ${cyan('bootstrap')}: clone/install components + dev tooling`,
            `- ${cyan('auth')}: (recommended) set up a ${cyan('dev-auth')} seed stack (login once, reuse everywhere)`,
            `- ${cyan('stacks')}: (recommended) next you’ll create an isolated dev stack for day-to-day work (keeps main stable)`,
            `- ${cyan('mobile')}: (optional) install the iOS dev-client (for phone testing)`,
            '',
            dim(`Tip: for PR work, use ${cyan('worktrees')} (isolated branches) + ${cyan('stacks')} (isolated runtime state).`),
          ],
      '',
    ].flat();
    // eslint-disable-next-line no-console
    console.log(lines.join('\n'));
  }

  if (interactive) {
    printProfileIntro({ profile });
  }

  const platform = process.platform;
  const supportsAutostart = platform === 'darwin' || platform === 'linux';
  const supportsMenubar = platform === 'darwin';

  const serverFromArg = normalizeServerComponent(kv.get('--server'));
  let serverComponent = serverFromArg || normalizeServerComponent(process.env.HAPPIER_STACK_SERVER_COMPONENT) || 'happy-server-light';
  if (profile === 'selfhost' && interactive && !serverFromArg) {
    const docker = await detectDockerSupport();
    if (!docker.installed) {
      serverComponent = 'happy-server-light';
      // eslint-disable-next-line no-console
      console.log(`${green('✓')} Server: ${cyan('happy-server-light')} ${dim('(Docker not detected; simplest local install)')}`);
    } else if (!docker.running) {
      serverComponent = 'happy-server-light';
      // eslint-disable-next-line no-console
      console.log(
        `${green('✓')} Server: ${cyan('happy-server-light')} ${dim('(Docker detected but not running; using simplest option)')}`
      );
      // eslint-disable-next-line no-console
      console.log(dim(`Tip: start Docker Desktop, then re-run setup if you want ${cyan('happy-server')} (full server).`));
    } else {
      serverComponent = await withRl(async (rl) => {
        const picked = await promptSelect(rl, {
          title: `${bold('Server flavor')}\n${dim('Pick the backend you want to run locally. You can switch later.')}`,
          options: [
            { label: `happy-server-light (${green('recommended')}) — simplest local install (SQLite)`, value: 'happy-server-light' },
            { label: `happy-server — full server (Postgres/Redis/Minio via Docker)`, value: 'happy-server' },
          ],
          defaultIndex: serverComponent === 'happy-server' ? 1 : 0,
        });
        return picked;
      });
    }
  }
  // If the user explicitly requested full server, enforce Docker availability.
  if (profile === 'selfhost' && serverFromArg === 'happy-server') {
    const docker = await detectDockerSupport();
    if (!docker.installed || !docker.running) {
      throw new Error(
        `[setup] --server=happy-server requires Docker (Postgres/Redis/Minio).\n` +
          `Docker is ${!docker.installed ? 'not installed' : 'not running'}.\n` +
          `Fix: use --server=happy-server-light (simplest), or start Docker and retry.`
      );
    }
  }

  // Dev profile: pick where to store components + worktrees.
  const workspaceDirFlagRaw = (kv.get('--workspace-dir') ?? '').toString().trim();
  const homeDirForWorkspace = getHappyStacksHomeDir(process.env);
  let workspaceDirWanted = workspaceDirFlagRaw ? normalizeWorkspaceDirInput(workspaceDirFlagRaw, { homeDir: homeDirForWorkspace }) : '';
  if (profile === 'dev' && interactive && !workspaceDirWanted) {
    const defaultWorkspaceDir = resolveWorkspaceDirDefault();
    const suggested = defaultWorkspaceDir;
    const helpLines = [
      bold('Workspace location'),
      dim('This is where Happy Stacks will keep:'),
      `- ${dim('components')}: ${cyan(join(suggested, 'components'))}`,
      `- ${dim('worktrees')}:  ${cyan(join(suggested, 'components', '.worktrees'))}`,
      '',
      dim('Pick a stable folder that is easy to open in your editor (example: ~/Development/happy).'),
      '',
    ].join('\n');
    // eslint-disable-next-line no-console
    console.log(helpLines);
    const raw = await withRl(async (rl) => {
      return await prompt(rl, `Workspace dir (default: ${suggested}): `, { defaultValue: suggested });
    });
    workspaceDirWanted = normalizeWorkspaceDirInput(raw, { homeDir: homeDirForWorkspace });
  }
  if (profile === 'dev' && workspaceDirWanted) {
    // eslint-disable-next-line no-console
    console.log(`${dim('Workspace:')} ${cyan(workspaceDirWanted)}`);
  }

  const defaultTailscale = false;
  const defaultAutostart = false;
  const defaultMenubar = false;
  const defaultStartNow = profile === 'selfhost';
  const defaultInstallPath = false;

  let tailscaleWanted = boolFromFlags({ flags, onFlag: '--tailscale', offFlag: '--no-tailscale', defaultValue: defaultTailscale });
  let autostartWanted = boolFromFlags({ flags, onFlag: '--autostart', offFlag: '--no-autostart', defaultValue: defaultAutostart });
  let menubarWanted = boolFromFlags({ flags, onFlag: '--menubar', offFlag: '--no-menubar', defaultValue: defaultMenubar });
  let startNow = boolFromFlags({ flags, onFlag: '--start-now', offFlag: '--no-start-now', defaultValue: defaultStartNow });
  let installPath = flags.has('--install-path') ? true : defaultInstallPath;
  let authWanted = boolFromFlagsOrKv({
    flags,
    kv,
    onFlag: '--auth',
    offFlag: '--no-auth',
    key: '--auth',
    defaultValue: profile === 'selfhost',
  });

  if (interactive) {
    if (profile === 'selfhost') {
      // Avoid asking questions when we can infer an existing setup state (unless the user explicitly passed flags).
      const tailscaleExplicit = flags.has('--tailscale') || flags.has('--no-tailscale');
      const autostartExplicit = flags.has('--autostart') || flags.has('--no-autostart');
      const menubarExplicit = flags.has('--menubar') || flags.has('--no-menubar');
      const authExplicit = flags.has('--auth') || flags.has('--no-auth') || kv.has('--auth');

      // Auth: skip prompt if already configured.
      const mainAccessKeyPath = getMainStacksAccessKeyPath();
      const authAlreadyConfigured = existsSync(mainAccessKeyPath);
      if (!authExplicit && authAlreadyConfigured) {
        authWanted = false;
        // eslint-disable-next-line no-console
        console.log(`${green('✓')} Authentication: already configured ${dim(`(${mainAccessKeyPath})`)}`);
      }
      if (!authExplicit && !authAlreadyConfigured) {
        // Self-host onboarding default: guide login as part of setup.
        authWanted = true;
        // eslint-disable-next-line no-console
        console.log(`${green('✓')} Authentication: will guide you through login ${dim('(recommended)')}`);
      }

      // Tailscale: skip prompt if already enabled for the main internal URL.
      let tailscaleDetectedHttps = null;
      if (!tailscaleExplicit) {
        try {
          const port = await resolveMainServerPort();
          const internal = `http://127.0.0.1:${port}`;
          tailscaleDetectedHttps = await tailscaleServeHttpsUrlForInternalServerUrl(internal);
        } catch {
          tailscaleDetectedHttps = null;
        }
        if (tailscaleDetectedHttps) {
          tailscaleWanted = true;
          // eslint-disable-next-line no-console
          console.log(`${green('✓')} Remote access: Tailscale Serve already enabled ${dim('→')} ${cyan(tailscaleDetectedHttps)}`);
        }
      }

      if (!tailscaleExplicit && tailscaleDetectedHttps) {
        // keep tailscaleWanted=true and skip the question
      } else {
        tailscaleWanted = await withRl(async (rl) => {
          const v = await promptSelect(rl, {
            title: `${bold('Remote access')}\n${dim('Optional: use Tailscale Serve to get an HTTPS URL for Happy (secure, recommended for phone access).')}`,
            options: [
              { label: `yes (${green('recommended for phone')}) — enable Tailscale Serve`, value: true },
              { label: 'no (default)', value: false },
            ],
            defaultIndex: tailscaleWanted ? 0 : 1,
          });
          return v;
        });
      }

      if (supportsAutostart) {
        const a = getDefaultAutostartPaths();
        const autostartAlreadyInstalled =
          process.platform === 'darwin'
            ? Boolean(existsSync(a.plistPath))
            : process.platform === 'linux'
              ? Boolean(existsSync(a.systemdUnitPath))
              : false;
        if (!autostartExplicit && autostartAlreadyInstalled) {
          autostartWanted = false;
          // eslint-disable-next-line no-console
          console.log(`${green('✓')} Autostart: already installed ${dim('(leaving as-is)')}`);
        } else {
          autostartWanted = await withRl(async (rl) => {
            const detail =
              process.platform === 'darwin'
                ? 'macOS: launchd LaunchAgent'
                : process.platform === 'linux'
                  ? 'Linux: systemd --user service'
                  : '';
            const v = await promptSelect(rl, {
              title:
                `${bold('Autostart')}\n` +
                `${dim('Optional: start Happy automatically at login.')}` +
                (detail ? `\n${dim(detail)}` : ''),
              options: [
                { label: 'yes', value: true },
                { label: 'no (default)', value: false },
              ],
              defaultIndex: autostartWanted ? 0 : 1,
            });
            return v;
          });
        }
      } else {
        autostartWanted = false;
      }

      if (supportsMenubar) {
        let menubarInstalled = false;
        if (!menubarExplicit) {
          const swift = await detectSwiftbarPluginInstalled();
          menubarInstalled = Boolean(swift.installed);
          if (menubarInstalled) {
            menubarWanted = false;
            // eslint-disable-next-line no-console
            console.log(`${green('✓')} Menu bar: already installed ${dim('(SwiftBar plugin)')}`);
          }
        }
        if (!menubarExplicit && menubarInstalled) {
          // skip question
        } else {
          menubarWanted = await withRl(async (rl) => {
            const v = await promptSelect(rl, {
              title: `${bold('Menu bar (macOS)')}\n${dim('Optional: install the SwiftBar menu to control stacks quickly.')}`,
              options: [
                { label: 'yes', value: true },
                { label: 'no (default)', value: false },
              ],
              defaultIndex: menubarWanted ? 0 : 1,
            });
            return v;
          });
        }
      } else {
        menubarWanted = false;
      }

      // Self-host onboarding default: start now (end-to-end setup).
      const startNowExplicit = flags.has('--start-now') || flags.has('--no-start-now');
      if (!startNowExplicit) {
        startNow = true;
      }

      // No interactive auth prompt here: we either detected it's already configured, or we default to guiding login.

      // Auth requires the stack to be running; if you chose "authenticate now", implicitly start.
      if (authWanted) {
        startNow = true;
      }
    } else if (profile === 'dev') {
      // Dev profile: auth is handled later (after bootstrap) so we can offer the recommended
      // dev-auth seed stack flow (and optional mobile dev-client install).
    }

    installPath = await withRl(async (rl) => {
      const v = await promptSelect(rl, {
        title:
          `${bold('Command shortcuts')}\n` +
          `${dim(
            `Optional: add ${cyan(join(getCanonicalHomeDir(), 'bin'))} to your shell PATH so you can run ${cyan(
              'hapsta'
            )} from any terminal.`
          )}\n` +
          `${dim(`If you skip this, you can always run commands via ${cyan('npx --yes -p @happier-dev/stack hapsta ...')}.`)}`,
        options: [
          { label: `yes (${green('recommended')}, default) — enable ${cyan('hapsta')} in your terminal`, value: true },
          { label: `no — keep using ${cyan('npx --yes -p @happier-dev/stack hapsta ...')}`, value: false },
        ],
        defaultIndex: 0,
      });
      return v;
    });
  }

  // Enforce OS support gates even if flags were passed.
  if (!supportsAutostart) autostartWanted = false;
  if (!supportsMenubar) menubarWanted = false;

  const menubarMode = profile === 'selfhost' ? 'selfhost' : 'dev';

  // Preflight: warn early + decide what we can actually do this run.
  const preflight = await runSetupPreflight({ profile, serverComponent, tailscaleWanted, menubarWanted, autostartWanted });
  if (interactive && process.stdout.isTTY && !json) {
    // eslint-disable-next-line no-console
    console.log('');
    // eslint-disable-next-line no-console
    console.log(banner('Preflight', { subtitle: profile === 'selfhost' ? 'Check prerequisites for self-hosting.' : 'Check prerequisites for development setup.' }));

    const lines = [];
    if (profile === 'selfhost') {
      if (serverComponent === 'happy-server') {
        lines.push(
          preflight.docker.installed && preflight.docker.running
            ? `${green('✓')} Docker: running`
            : `${yellow('!')} Docker: ${!preflight.docker.installed ? 'not installed' : 'not running'} (full server needs Docker)`
        );
      } else {
        lines.push(
          preflight.docker.installed
            ? `${green('✓')} Docker: detected ${dim('(not required for server-light)')}`
            : `${dim('•')} Docker: not detected ${dim('(server-light does not need it)')}`
        );
      }
      if (tailscaleWanted) {
        lines.push(
          preflight.tailscale.installed
            ? `${green('✓')} Tailscale: detected`
            : `${yellow('!')} Tailscale: not installed ${dim('(remote HTTPS will be available after install)')}`
        );
      }
      if (menubarWanted && process.platform === 'darwin') {
        lines.push(
          preflight.swiftbarAppInstalled
            ? `${green('✓')} SwiftBar: installed`
            : `${yellow('!')} SwiftBar: not detected ${dim('(plugin can be installed, but you need SwiftBar to use it)')}`
        );
      }
    } else {
      // dev profile: iOS tooling is only relevant if user chooses mobile-dev-client later.
      if (process.platform === 'darwin') {
        lines.push(
          preflight.ios.ok
            ? `${green('✓')} iOS tooling: Xcode + CocoaPods detected`
            : `${dim('•')} iOS tooling: ${!preflight.ios.hasXcode ? 'missing Xcode' : ''}${!preflight.ios.hasXcode && !preflight.ios.hasCocoapods ? ' + ' : ''}${!preflight.ios.hasCocoapods ? 'missing CocoaPods' : ''}`.trim()
        );
      }
    }
    // eslint-disable-next-line no-console
    console.log(lines.length ? lines.join('\n') : dim('(no checks)'));
  }

  const config = {
    profile,
    platform,
    interactive,
    serverComponent,
    authWanted,
    tailscaleWanted,
    autostartWanted,
    menubarWanted,
    startNow,
    installPath,
    runtimeDir: getRuntimeDir(),
  };
  if (json) {
    printResult({ json, data: config });
    return;
  }

  if (interactive && process.stdout.isTTY) {
    const summary = [
      '',
      bold('Ready to set up'),
      `${dim('Profile:')} ${cyan(profile)}`,
      ...(profile === 'dev' && workspaceDirWanted ? [`${dim('Workspace:')} ${cyan(workspaceDirWanted)}`] : []),
      ...(profile === 'selfhost' ? [`${dim('Server:')} ${cyan(serverComponent)}`] : []),
      '',
      bold('Press Enter to begin') + dim(' (or Ctrl+C to cancel).'),
    ].join('\n');
    // eslint-disable-next-line no-console
    console.log(summary);
    await withRl(async (rl) => {
      await prompt(rl, '', { defaultValue: '' });
    });
  }

  // 1) Ensure plumbing exists (runtime + shims + pointer env). Avoid auto-bootstrap here; setup drives bootstrap explicitly.
  await runNodeScriptMaybeQuiet({
    label: 'init happy-stacks home',
    rel: 'scripts/init.mjs',
    args: [
      '--no-bootstrap',
      ...(profile === 'dev' && workspaceDirWanted ? [`--workspace-dir=${workspaceDirWanted}`] : []),
      ...(installPath ? ['--install-path'] : []),
    ],
    env: { ...process.env, HAPPIER_STACK_SETUP_CHILD: '1' },
  });

  // 2) Persist profile defaults to stack env (server flavor, repo source, tailscale preference, menubar mode).
  await ensureSetupConfigPersisted({
    rootDir,
    profile,
    serverComponent,
    tailscaleWanted,
    menubarMode,
    happyRepoUrl,
  });

  // Apply repo override to this process too (so the immediately-following install step sees it),
  // even if env.local was already loaded earlier in this process.
  if (happyRepoUrl) {
    process.env.HAPPIER_STACK_UI_REPO_URL = happyRepoUrl;
    process.env.HAPPIER_STACK_CLI_REPO_URL = happyRepoUrl;
    process.env.HAPPIER_STACK_SERVER_FULL_REPO_URL = happyRepoUrl;
  }

  // 3) Bootstrap components.
  if (profile === 'dev') {
    // Developer setup: keep the existing bootstrap wizard.
    await runNodeScriptMaybeQuiet({
      label: 'bootstrap components',
      rootDir,
      rel: 'scripts/install.mjs',
      // Dev setup: use Expo dev server, so exporting a production web bundle is wasted work.
      // Users can always run `hapsta build` later if they want `hapsta start` to serve a prebuilt UI.
      args: ['--interactive', '--clone', '--no-ui-build'],
      interactiveChild: true,
    });

    if (interactive) {
      // Recommended: dev-auth seed stack setup (login once, reuse across stacks).
      await maybeConfigureAuthDefaults({ rootDir, profile, interactive });

      // Optional: mobile dev-client install (macOS only).
      if (process.platform === 'darwin') {
        const installMobile = await withRl(async (rl) => {
          return await promptSelect(rl, {
            title: `${bold('Mobile (iOS)')}\n${dim('Optional: install the shared Happy Stacks dev-client app on your iPhone (install once, reuse across stacks).')}`,
            options: [
              { label: `yes — install iOS dev-client (${yellow('requires Xcode + CocoaPods')})`, value: true },
              { label: 'no (default)', value: false },
            ],
            defaultIndex: 1,
          });
        });
        if (installMobile) {
          await runNodeScriptMaybeQuiet({
            label: 'install iOS dev-client',
            rootDir,
            rel: 'scripts/mobile_dev_client.mjs',
            args: ['--install'],
          });
          // eslint-disable-next-line no-console
          console.log(dim(`Tip: run any stack with ${yellow('--mobile')} to get a QR code / deep link for your phone.`));
        }
      } else {
        // eslint-disable-next-line no-console
        console.log(dim(`Tip: iOS dev-client install is macOS-only. You can still use the web UI on mobile via Tailscale.`));
      }
    }
  } else {
    // Selfhost setup: run non-interactively and keep it simple.
    await runNodeScriptMaybeQuiet({
      label: 'bootstrap components',
      rootDir,
      rel: 'scripts/install.mjs',
      // Self-hosting: always clone the Happy monorepo from upstream.
      // Server-light (sqlite) is still fork-only today and is handled by bootstrap defaults.
      args: [`--server=${serverComponent}`, '--upstream', '--clone'],
    });
  }

  // 4) Optional: install autostart (macOS launchd / Linux systemd user).
  if (autostartWanted) {
    if (isSandboxed() && !sandboxAllowsGlobalSideEffects()) {
      // eslint-disable-next-line no-console
      console.log(dim(`Autostart skipped in sandbox mode. To allow: ${cyan('HAPPIER_STACK_SANDBOX_ALLOW_GLOBAL=1')}`));
    } else {
    if (process.platform === 'linux') {
      const ok = await ensureSystemdAvailable();
      if (!ok) {
        // eslint-disable-next-line no-console
        console.log('[setup] autostart skipped: systemd user services not available on this Linux distro.');
      } else {
        await installService();
      }
    } else {
      await installService();
    }
    }
  }

  // 5) Optional: install menubar assets (macOS only).
  if (menubarWanted && process.platform === 'darwin') {
    if (isSandboxed() && !sandboxAllowsGlobalSideEffects()) {
      // eslint-disable-next-line no-console
      console.log(dim(`Menu bar install skipped in sandbox mode. To allow: ${cyan('HAPPIER_STACK_SANDBOX_ALLOW_GLOBAL=1')}`));
    } else {
      await runNodeScript({ rootDir, rel: 'scripts/menubar.mjs', args: ['install'] });
    }
  }

  // 6) Optional: enable tailscale serve (best-effort).
  if (tailscaleWanted) {
    const tailscaleOk = await commandExists('tailscale');
    if (!tailscaleOk) {
      // eslint-disable-next-line no-console
      console.log(`${yellow('!')} Tailscale not installed. To enable remote HTTPS later: ${cyan('hapsta tailscale enable')}`);
      await openUrlInBrowser('https://tailscale.com/download').catch(() => {});
    } else if (isSandboxed() && !sandboxAllowsGlobalSideEffects()) {
      // eslint-disable-next-line no-console
      console.log(dim(`Tailscale enable skipped in sandbox mode. To allow: ${cyan('HAPPIER_STACK_SANDBOX_ALLOW_GLOBAL=1')}`));
    } else {
    try {
      const internalPort = await resolveMainServerPort();
      const internalServerUrl = `http://127.0.0.1:${internalPort}`;
      const res = await tailscaleServeEnable({ internalServerUrl });
      if (res?.enableUrl && !res?.httpsUrl) {
        // eslint-disable-next-line no-console
        console.log('[setup] tailscale serve requires enabling in your tailnet. Open this URL to continue:');
        // eslint-disable-next-line no-console
        console.log(res.enableUrl);
        // Best-effort open
        await openUrlInBrowser(res.enableUrl).catch(() => {});
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.log('[setup] tailscale not available. Install it from: https://tailscale.com/download');
      await openUrlInBrowser('https://tailscale.com/download').catch(() => {});
    }
    }
  }

  // 7) Optional: start now (without requiring setup to keep running).
  if (startNow) {
    // Self-host UX: ensure the prebuilt UI exists so the light server can serve it immediately.
    // (Without this, `hapsta start` will refuse to serve UI when the build dir is missing.)
    const serveUiWanted = (process.env.HAPPIER_STACK_SERVE_UI ?? '1').toString().trim() !== '0';
    if (profile === 'selfhost' && serveUiWanted) {
      const uiBuildDir = process.env.HAPPIER_STACK_UI_BUILD_DIR?.trim()
        ? process.env.HAPPIER_STACK_UI_BUILD_DIR.trim()
        : join(getDefaultAutostartPaths().baseDir, 'ui');
      if (!existsSync(uiBuildDir)) {
        await runNodeScriptMaybeQuiet({ label: 'build-ui', rel: 'scripts/build.mjs', args: ['--no-tauri'] });
      }
    }

    const port = await resolveMainServerPort();
    const internalServerUrl = `http://127.0.0.1:${port}`;

    if (!autostartWanted) {
      // Detached background start.
      await spawnDetachedNodeScript({ rootDir, rel: 'scripts/run.mjs', args: [] });
    }

    const ready = await waitForHappyHealthOk(internalServerUrl, { timeoutMs: 90_000 });
    if (!ready) {
      // eslint-disable-next-line no-console
      console.log(`[setup] started, but server did not become healthy yet: ${internalServerUrl}`);
    }

    // Prefer tailscale HTTPS URL if available.
    let openTarget = `http://localhost:${port}/`;
    if (tailscaleWanted) {
      const https = await tailscaleServeHttpsUrlForInternalServerUrl(internalServerUrl);
      if (https) {
        openTarget = https.replace(/\/+$/, '') + '/';
      }
    }

    // 8) Optional: auth login (runs interactive browser flow via happy-cli).
    if (authWanted) {
      const cliHomeDir = mainCliHomeDirForEnvPath(resolveStackEnvPath('main').envPath);
      const accessKey = join(cliHomeDir, 'access.key');
      if (existsSync(accessKey)) {
        // eslint-disable-next-line no-console
        console.log('[setup] auth: already configured (access.key exists)');
      } else {
        const env = {
          ...process.env,
          HAPPIER_STACK_SERVER_PORT: String(port),
        };
        if (interactive) {
          await guidedStackAuthLoginNow({ rootDir, stackName: 'main', env });
        } else {
          await runNodeScript({ rootDir, rel: 'scripts/stack.mjs', args: ['auth', 'main', '--', 'login'], env });
        }

        if (!existsSync(accessKey)) {
          // eslint-disable-next-line no-console
          console.log('[setup] auth: not completed yet (missing access.key). You can retry with: hapsta auth login');
        } else {
          // eslint-disable-next-line no-console
          console.log('[setup] auth: complete');
        }
      }
    } else {
      // eslint-disable-next-line no-console
      console.log('[setup] tip: when you are ready, authenticate with: hapsta auth login');
    }

    await openUrlInBrowser(openTarget).catch(() => {});
    // eslint-disable-next-line no-console
    console.log(`[setup] open: ${openTarget}`);
  }
  if (profile === 'selfhost' && authWanted && !startNow) {
    // eslint-disable-next-line no-console
    console.log('[setup] auth: skipped because Happy was not started. When ready:');
    // eslint-disable-next-line no-console
    console.log('  hapsta start');
    // eslint-disable-next-line no-console
    console.log('  hapsta auth login');
  }

  // Final tips (keep short).
  if (profile === 'selfhost') {
    // eslint-disable-next-line no-console
    console.log('');
    // eslint-disable-next-line no-console
    console.log(green('✓ Setup complete'));
    // Keep this minimal for first-time users. Setup already started + opened the UI.
    // eslint-disable-next-line no-console
    console.log(dim('Happy is ready. If you need help later, run:'));
    // eslint-disable-next-line no-console
    console.log(`  ${yellow('hapsta doctor')}`);
    // eslint-disable-next-line no-console
    console.log(`  ${yellow('hapsta stop --yes')}`);
  } else {
    // eslint-disable-next-line no-console
    console.log('');
    // eslint-disable-next-line no-console
    console.log(green('✓ Setup complete'));
    // eslint-disable-next-line no-console
    console.log(dim('Next steps (development):'));
    // eslint-disable-next-line no-console
    console.log(`  ${yellow('hapsta stack new dev --interactive')} ${dim('# create a dedicated dev stack (recommended)')}`);
    // eslint-disable-next-line no-console
    console.log(`  ${yellow('hapsta stack dev dev')}              ${dim('# run that stack (server + daemon + Expo web)')}`);
    // eslint-disable-next-line no-console
    console.log(`  ${yellow('hapsta wt new ...')}   ${dim('# create a worktree for a branch/PR')}`);
    // eslint-disable-next-line no-console
    console.log(`  ${yellow('hapsta stack new ...')} ${dim('# create an isolated runtime stack')}`);
    // eslint-disable-next-line no-console
    console.log(`  ${yellow('hapsta stack dev <name>')} ${dim('# run a specific stack')}`);
  }
}

async function main() {
  const rootDir = getRootDir(import.meta.url);
  const argv = process.argv.slice(2);
  await cmdSetup({ rootDir, argv });
}

main().catch((err) => {
  console.error('[setup] failed:', err);
  process.exit(1);
});
