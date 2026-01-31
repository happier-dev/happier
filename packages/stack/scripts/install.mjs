import './utils/env/env.mjs';
import { parseArgs } from './utils/cli/args.mjs';
import { pathExists } from './utils/fs/fs.mjs';
import { run, runCapture } from './utils/proc/proc.mjs';
import { commandExists } from './utils/proc/commands.mjs';
import { getComponentDir, getComponentRepoDir, getRootDir, isHappyMonorepoRoot } from './utils/paths/paths.mjs';
import { getServerComponentName } from './utils/server/server.mjs';
import { ensureCliBuilt, ensureDepsInstalled, ensureHappyCliLocalNpmLinked } from './utils/proc/pm.mjs';
import { dirname, join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { installService, uninstallService } from './service.mjs';
import { printResult, wantsHelp, wantsJson } from './utils/cli/cli.mjs';
import { ensureEnvLocalUpdated } from './utils/env/env_local.mjs';
import { isTty, prompt, promptSelect, withRl } from './utils/cli/wizard.mjs';
import { isSandboxed, sandboxAllowsGlobalSideEffects } from './utils/env/sandbox.mjs';
import { bold, cyan, dim, green } from './utils/ui/ansi.mjs';
import { getVerbosityLevel } from './utils/cli/verbosity.mjs';
import { createStepPrinter } from './utils/cli/progress.mjs';

/**
 * Install/setup the local stack:
 * - ensure components exist (optionally clone if missing)
 * - install dependencies where needed
 * - build happy-cli (optional) and install `happy`/`happys` shims under `<homeDir>/bin`
 * - build the web UI bundle (so `run` can serve it)
 * - optional macOS autostart (LaunchAgent)
 */

const DEFAULT_FORK_REPOS = {
  serverLight: 'https://github.com/leeroybrun/happy-server-light.git',
  // Monorepo fork (slopus/happy):
  // - packages/happy-app (mobile app)
  // - packages/happy-cli (happy-cli)
  // - packages/happy-server (happy-server)
  // (legacy checkouts used expo-app/cli/server)
  serverFull: 'https://github.com/leeroybrun/happy.git',
  cli: 'https://github.com/leeroybrun/happy.git',
  ui: 'https://github.com/leeroybrun/happy.git',
};

const DEFAULT_UPSTREAM_REPOS = {
  // Server-light is not upstreamed yet; for now, use the maintained fork.
  // When upstream ships server-light, this default can switch to slopus/*.
  serverLight: 'https://github.com/leeroybrun/happy-server-light.git',
  serverFull: 'https://github.com/slopus/happy.git',
  // slopus/happy is now a monorepo that contains:
  // - packages/happy-app (mobile app)
  // - packages/happy-cli (happy-cli)
  // - packages/happy-server (happy-server)
  // (legacy checkouts used expo-app/cli/server)
  cli: 'https://github.com/slopus/happy.git',
  ui: 'https://github.com/slopus/happy.git',
};

function repoUrlsFromOwners({ forkOwner, upstreamOwner }) {
  const fork = (name) => `https://github.com/${forkOwner}/${name}.git`;
  const up = (name) => `https://github.com/${upstreamOwner}/${name}.git`;
  return {
    forks: {
      serverLight: fork('happy-server-light'),
      // Monorepo: UI + CLI + full server share a single repo.
      serverFull: fork('happy'),
      cli: fork('happy'),
      ui: fork('happy'),
    },
    upstream: {
      // Monorepo: UI + CLI + full server share a single repo.
      // Server-light is not upstreamed yet; default to the maintained fork.
      serverLight: DEFAULT_UPSTREAM_REPOS.serverLight,
      serverFull: up('happy'),
      cli: up('happy'),
      ui: up('happy'),
    },
  };
}

function resolveRepoSource({ flags }) {
  if (flags.has('--forks')) {
    return 'forks';
  }
  if (flags.has('--upstream')) {
    return 'upstream';
  }
  const fromEnv = (process.env.HAPPY_STACKS_REPO_SOURCE ?? process.env.HAPPY_LOCAL_REPO_SOURCE ?? '').trim().toLowerCase();
  if (fromEnv === 'fork' || fromEnv === 'forks') {
    return 'forks';
  }
  if (fromEnv === 'upstream') {
    return 'upstream';
  }
  // Default for external contributors.
  return 'upstream';
}

function getRepoUrls({ repoSource }) {
  const defaults = repoSource === 'upstream' ? DEFAULT_UPSTREAM_REPOS : DEFAULT_FORK_REPOS;
  const ui =
    process.env.HAPPY_STACKS_UI_REPO_URL?.trim() ||
    process.env.HAPPY_LOCAL_UI_REPO_URL?.trim() ||
    defaults.ui;
  const cli =
    process.env.HAPPY_STACKS_CLI_REPO_URL?.trim() ||
    process.env.HAPPY_LOCAL_CLI_REPO_URL?.trim() ||
    defaults.cli ||
    ui;

  // Server-light is special while it remains fork-only:
  // - if repoSource is upstream, we still default server-light to the maintained fork,
  //   unless the user explicitly overrides via env.
  const serverLightDefault = repoSource === 'upstream' ? DEFAULT_FORK_REPOS.serverLight : defaults.serverLight;
  return {
    // Backwards compatible: HAPPY_LOCAL_SERVER_REPO_URL historically referred to the server-light component.
    serverLight:
      process.env.HAPPY_STACKS_SERVER_LIGHT_REPO_URL?.trim() ||
      process.env.HAPPY_LOCAL_SERVER_LIGHT_REPO_URL?.trim() ||
      process.env.HAPPY_STACKS_SERVER_REPO_URL?.trim() ||
      process.env.HAPPY_LOCAL_SERVER_REPO_URL?.trim() ||
      serverLightDefault,
    // Default to the UI repo when using a monorepo (override to keep split repos).
    serverFull:
      process.env.HAPPY_STACKS_SERVER_FULL_REPO_URL?.trim() ||
      process.env.HAPPY_LOCAL_SERVER_FULL_REPO_URL?.trim() ||
      defaults.serverFull ||
      ui,
    cli,
    ui,
  };
}

async function ensureGitBranchCheckedOut({ repoDir, branch, label }) {
  if (!(await pathExists(join(repoDir, '.git')))) return;
  const b = String(branch ?? '').trim();
  if (!b) return;

  try {
    const head = (await runCapture('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoDir })).trim();
    if (head && head === b) return;
  } catch {
    // ignore
  }

  // Ensure branch exists locally, otherwise fetch it from origin.
  let hasLocal = true;
  try {
    await run('git', ['show-ref', '--verify', '--quiet', `refs/heads/${b}`], { cwd: repoDir });
  } catch {
    hasLocal = false;
  }
  if (!hasLocal) {
    try {
      await run('git', ['fetch', '--quiet', 'origin', b], { cwd: repoDir });
    } catch {
      throw new Error(
        `[local] ${label}: expected branch "${b}" to exist in ${repoDir}.\n` +
          `[local] Fix: use --forks for happy-server-light (sqlite), or use --server=happy-server with --upstream.`
      );
    }
  }

  try {
    await run('git', ['checkout', '-q', b], { cwd: repoDir });
  } catch {
    // If remote-tracking branch exists but local doesn't, create it.
    try {
      await run('git', ['checkout', '-q', '-B', b, `origin/${b}`], { cwd: repoDir });
    } catch {
      throw new Error(
        `[local] ${label}: failed to checkout branch "${b}" in ${repoDir}.\n` +
          `[local] Fix: re-run with --force in worktree flows, or delete the checkout and re-run install/bootstrap.`
      );
    }
  }
}

async function ensureComponentPresent({ dir, label, repoUrl, allowClone, quiet = false, runMaybeVerbose = null }) {
  if (await pathExists(dir)) {
    return;
  }
  if (!allowClone) {
    throw new Error(`[local] missing ${label} at ${dir} (run with --clone or add it under components/)`);
  }
  if (!repoUrl) {
    throw new Error(
      `[local] missing ${label} at ${dir} and no repo URL configured.\n` +
        `Set HAPPY_LOCAL_${label}_REPO_URL, or run: happys bootstrap -- --forks / --upstream`
    );
  }
  await mkdir(dirname(dir), { recursive: true });
  if (!quiet) {
    // eslint-disable-next-line no-console
    console.log(`[local] cloning ${label} into ${dir}...`);
    await run('git', ['clone', repoUrl, dir]);
    return;
  }

  // Quiet-by-default: avoid spamming the terminal with git output.
  // If it fails, we re-run with full logs so the user can see the root cause.
  if (runMaybeVerbose) {
    await runMaybeVerbose({ label: `clone ${label.toLowerCase()}`, cmd: 'git', args: ['clone', repoUrl, dir], cwd: dirname(dir) });
    return;
  }
  await run('git', ['clone', repoUrl, dir], { stdio: 'ignore' });
}

async function ensureUpstreamRemote({ repoDir, upstreamUrl }) {
  if (!(await pathExists(join(repoDir, '.git')))) {
    return;
  }
  try {
    // Use capture here to avoid printing scary errors like:
    //   "error: No such remote 'upstream'"
    // when we're just probing for existence.
    await runCapture('git', ['remote', 'get-url', 'upstream'], { cwd: repoDir });
    // Upstream remote exists; best-effort update if different.
    await runCapture('git', ['remote', 'set-url', 'upstream', upstreamUrl], { cwd: repoDir }).catch(() => {});
  } catch {
    await runCapture('git', ['remote', 'add', 'upstream', upstreamUrl], { cwd: repoDir });
  }
}

async function interactiveWizard({ rootDir, defaults }) {
  return await withRl(async (rl) => {
    // Repo source is intentionally not prompted during bootstrap:
    // - default: upstream (best for external contributors)
    // - advanced: pass --forks (then we prompt for fork owner)
    const repoSource = defaults.repoSource;

    // eslint-disable-next-line no-console
    console.log(
      dim(
        `Repo source: ${cyan(repoSource)}${
          repoSource === 'upstream' ? ` ${green('(recommended)')}` : ''
        }${repoSource === 'forks' ? ` ${dim('(advanced)')}` : ''}`
      )
    );
    if (repoSource === 'upstream') {
      // eslint-disable-next-line no-console
      console.log(
        dim(
          `Note: ${cyan('happy-server-light')} is not upstreamed yet, so we clone it from the maintained fork (${DEFAULT_FORK_REPOS.serverLight}).`
        )
      );
      // eslint-disable-next-line no-console
      console.log(dim(`Tip: to use forks, re-run: ${cyan('happys bootstrap --interactive --forks')}`));
    }

    let forkOwner = defaults.forkOwner;
    let upstreamOwner = defaults.upstreamOwner;

    if (repoSource === 'forks') {
      // eslint-disable-next-line no-console
      console.log(dim('Tip: choose this if you already have a fork of slopus/happy.'));
      forkOwner = (
        await prompt(rl, `GitHub fork owner (default: ${defaults.forkOwner}): `, { defaultValue: defaults.forkOwner })
      ).trim() || defaults.forkOwner;
      upstreamOwner = (
        await prompt(rl, `GitHub upstream owner (default: ${defaults.upstreamOwner}): `, { defaultValue: defaults.upstreamOwner })
      ).trim() || defaults.upstreamOwner;
    }

    const serverMode = await promptSelect(rl, {
      title: `${bold('Server components')}\n${dim('Choose which server repo(s) to clone and install deps for.')}`,
      options: [
        { label: `${cyan('happy-server-light')} only (${green('recommended')})`, value: 'happy-server-light' },
        { label: `${cyan('happy-server')} only — full server (Docker-managed infra)`, value: 'happy-server' },
        { label: `both (${cyan('server-light')} + ${cyan('full server')})`, value: 'both' },
      ],
      defaultIndex: defaults.serverComponentName === 'both' ? 2 : defaults.serverComponentName === 'happy-server' ? 1 : 0,
    });

    // Setup/bootstrap is expected to be able to bring up a working workspace from scratch,
    // so cloning missing repos is the default (and normally required for first-time users).
    const allowClone = defaults.allowClone;

    const supportsAutostart = process.platform === 'darwin' || process.platform === 'linux';
    const enableAutostart = supportsAutostart
      ? await promptSelect(rl, {
          title: isSandboxed()
            ? `${bold('Autostart')}\n${dim('Sandbox mode: this is global OS state; normally disabled in sandbox.')}`
            : `${bold('Autostart')}\n${dim('Start Happy automatically at login?')}\n${dim(
                process.platform === 'darwin' ? 'macOS: launchd LaunchAgent' : 'Linux: systemd --user service'
              )}`,
          options: [
            { label: 'yes', value: true },
            { label: 'no (default)', value: false },
          ],
          defaultIndex: defaults.enableAutostart ? 0 : 1,
        })
      : false;

    const buildTauri = await promptSelect(rl, {
      title: `${bold('Desktop app (optional)')}\n${dim('Build the Tauri desktop app as part of setup? (slow; requires extra toolchain)')}`,
      options: [
        { label: `yes ${dim('(slow)')} — build desktop app`, value: true },
        { label: 'no (default)', value: false },
      ],
      defaultIndex: defaults.buildTauri ? 0 : 1,
    });

    // Keep bootstrap "just works" by default: ensure upstream remotes and mirror branches are configured.
    const configureGit = true;

    return {
      repoSource,
      forkOwner,
      upstreamOwner,
      serverComponentName: serverMode,
      allowClone,
      enableAutostart,
      buildTauri,
      configureGit,
    };
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const { flags, kv } = parseArgs(argv);
  const json = wantsJson(argv, { flags });
  if (wantsHelp(argv, { flags })) {
    printResult({
      json,
      data: {
        flags: [
          '--forks',
          '--upstream',
          '--clone',
          '--no-clone',
          '--autostart',
          '--no-autostart',
          '--server=...',
          '--no-ui-build',
          '--no-ui-deps',
          '--no-cli-deps',
          '--no-cli-build',
        ],
        json: true,
      },
      text: [
        '[bootstrap] usage:',
        '  happys bootstrap [--forks|--upstream] [--server=happy-server|happy-server-light|both] [--json]',
        '  happys bootstrap --interactive',
        '  happys bootstrap --no-clone',
      ].join('\n'),
    });
    return;
  }
  const rootDir = getRootDir(import.meta.url);

  const interactive = flags.has('--interactive') && isTty();
  const allowGlobal = sandboxAllowsGlobalSideEffects();
  const sandboxed = isSandboxed();
  const verbosity = getVerbosityLevel(process.env);
  const quietUi = interactive && !json && verbosity === 0;
  const steps = createStepPrinter({ enabled: quietUi });

  async function runMaybeVerbose({ label, cmd, args, cwd }) {
    if (!quietUi) {
      await run(cmd, args, { cwd });
      return;
    }
    steps.start(label);
    try {
      await run(cmd, args, { cwd, stdio: 'ignore' });
      steps.stop('✓', label);
    } catch (e) {
      steps.stop('x', label);
      // eslint-disable-next-line no-console
      console.error(`[bootstrap] ${label} failed. Re-running with full logs...`);
      await run(cmd, args, { cwd, stdio: 'inherit' });
      throw e;
    }
  }

  async function ensureDepsInstalledMaybeVerbose(dir, label) {
    if (!quietUi) {
      await ensureDepsInstalled(dir, label, { quiet: false, env: process.env });
      return;
    }
    steps.start(`install deps: ${label}`);
    try {
      await ensureDepsInstalled(dir, label, { quiet: true, env: process.env });
      steps.stop('✓', `install deps: ${label}`);
    } catch (e) {
      steps.stop('x', `install deps: ${label}`);
      // eslint-disable-next-line no-console
      console.error(`[bootstrap] dependency install failed for ${label}. Re-running with full logs...`);
      await ensureDepsInstalled(dir, label, { quiet: false, env: process.env });
      throw e;
    }
  }

  async function ensureCliBuiltMaybeVerbose(cliDir, { buildCli }) {
    if (!quietUi) {
      await ensureCliBuilt(cliDir, { buildCli, quiet: false, env: process.env });
      return;
    }
    steps.start('build happy-cli');
    try {
      await ensureCliBuilt(cliDir, { buildCli, quiet: true, env: process.env });
      steps.stop('✓', 'build happy-cli');
    } catch (e) {
      steps.stop('x', 'build happy-cli');
      // eslint-disable-next-line no-console
      console.error('[bootstrap] happy-cli build failed. Re-running with full logs...');
      await ensureCliBuilt(cliDir, { buildCli: true, quiet: false, env: process.env });
      throw e;
    }
  }

  // Defaults for wizard.
  const defaultRepoSource = resolveRepoSource({ flags });
  const defaults = {
    repoSource: defaultRepoSource,
    forkOwner: 'leeroybrun',
    upstreamOwner: 'slopus',
    serverComponentName: getServerComponentName({ kv }),
    allowClone: !flags.has('--no-clone') && ((process.env.HAPPY_LOCAL_CLONE_MISSING ?? '1') !== '0' || flags.has('--clone')),
    enableAutostart: (!sandboxed || allowGlobal) && (flags.has('--autostart') || (process.env.HAPPY_LOCAL_AUTOSTART ?? '0') === '1'),
    buildTauri: flags.has('--tauri') && !flags.has('--no-tauri'),
  };

  const wizard = interactive ? await interactiveWizard({ rootDir, defaults }) : null;
  const repoSource = wizard?.repoSource ?? defaultRepoSource;

  // Persist chosen repo source + URLs into the user config env file:
  // - main stack env by default (recommended; consistent across install modes)
  // - legacy fallback: <repo>/env.local when no home config exists yet
  if (wizard) {
    const owners = repoUrlsFromOwners({ forkOwner: wizard.forkOwner, upstreamOwner: wizard.upstreamOwner });
    const chosen = repoSource === 'upstream' ? owners.upstream : owners.forks;
    await ensureEnvLocalUpdated({
      rootDir,
      updates: [
        { key: 'HAPPY_STACKS_REPO_SOURCE', value: repoSource },
        { key: 'HAPPY_LOCAL_REPO_SOURCE', value: repoSource },
        { key: 'HAPPY_STACKS_UI_REPO_URL', value: chosen.ui },
        { key: 'HAPPY_LOCAL_UI_REPO_URL', value: chosen.ui },
        { key: 'HAPPY_STACKS_CLI_REPO_URL', value: chosen.cli },
        { key: 'HAPPY_LOCAL_CLI_REPO_URL', value: chosen.cli },
        // Backwards compatible: SERVER_REPO_URL historically meant server-light.
        { key: 'HAPPY_STACKS_SERVER_REPO_URL', value: chosen.serverLight },
        { key: 'HAPPY_LOCAL_SERVER_REPO_URL', value: chosen.serverLight },
        { key: 'HAPPY_STACKS_SERVER_LIGHT_REPO_URL', value: chosen.serverLight },
        { key: 'HAPPY_LOCAL_SERVER_LIGHT_REPO_URL', value: chosen.serverLight },
        { key: 'HAPPY_STACKS_SERVER_FULL_REPO_URL', value: chosen.serverFull },
        { key: 'HAPPY_LOCAL_SERVER_FULL_REPO_URL', value: chosen.serverFull },
      ],
    });
  }

  const repos = getRepoUrls({ repoSource });

  // Default: clone missing components (fresh checkouts "just work").
  // Disable with --no-clone or HAPPY_LOCAL_CLONE_MISSING=0.
  const cloneMissingDefault = (process.env.HAPPY_LOCAL_CLONE_MISSING ?? '1') !== '0';
  const allowClone =
    wizard?.allowClone ?? (!flags.has('--no-clone') && (flags.has('--clone') || cloneMissingDefault));
  const enableAutostartRaw = wizard?.enableAutostart ?? (flags.has('--autostart') || (process.env.HAPPY_LOCAL_AUTOSTART ?? '0') === '1');
  const enableAutostart = sandboxed && !allowGlobal ? false : enableAutostartRaw;
  const disableAutostart = flags.has('--no-autostart');

  const serverComponentName = (wizard?.serverComponentName ?? getServerComponentName({ kv })).trim();
  // Repo roots (clone locations)
  const uiRepoDir = getComponentRepoDir(rootDir, 'happy');
  const serverLightRepoDir = getComponentRepoDir(rootDir, 'happy-server-light');

  // Ensure UI exists first (monorepo anchor in slopus/happy).
  await ensureComponentPresent({
    dir: uiRepoDir,
    label: 'UI',
    repoUrl: repos.ui,
    allowClone,
    quiet: quietUi,
    runMaybeVerbose,
  });

  // Package dirs (where we run installs/builds). Recompute after cloning UI.
  const uiDir = getComponentDir(rootDir, 'happy');
  const cliDir = getComponentDir(rootDir, 'happy-cli');
  const serverFullDir = getComponentDir(rootDir, 'happy-server');

  const cliRepoDir = getComponentRepoDir(rootDir, 'happy-cli');
  const serverFullRepoDir = getComponentRepoDir(rootDir, 'happy-server');
  const hasMonorepo = isHappyMonorepoRoot(uiRepoDir);

  // Ensure other components exist.
  // - server-light stays separate for now.
  // - full server + cli may be embedded in the monorepo.
  if (serverComponentName === 'both' || serverComponentName === 'happy-server-light') {
    await ensureComponentPresent({
      dir: serverLightRepoDir,
      label: 'SERVER',
      repoUrl: repos.serverLight,
      allowClone,
      quiet: quietUi,
      runMaybeVerbose,
    });
  }
  if (!hasMonorepo) {
    if (serverComponentName === 'both' || serverComponentName === 'happy-server') {
      await ensureComponentPresent({
        dir: serverFullRepoDir,
        label: 'SERVER_FULL',
        repoUrl: repos.serverFull,
        allowClone,
        quiet: quietUi,
        runMaybeVerbose,
      });
    }
    await ensureComponentPresent({
      dir: cliRepoDir,
      label: 'CLI',
      repoUrl: repos.cli,
      allowClone,
      quiet: quietUi,
      runMaybeVerbose,
    });
  } else {
    if ((serverComponentName === 'both' || serverComponentName === 'happy-server') && !(await pathExists(serverFullDir))) {
      throw new Error(`[bootstrap] expected monorepo server package at ${serverFullDir} (missing).`);
    }
    if (!(await pathExists(cliDir))) {
      throw new Error(`[bootstrap] expected monorepo cli package at ${cliDir} (missing).`);
    }
  }

  // Ensure expected branches are checked out for server flavors (avoids "server-light directory contains full server" mistakes).
  if (serverComponentName === 'both' || serverComponentName === 'happy-server-light') {
    await ensureGitBranchCheckedOut({ repoDir: serverLightRepoDir, branch: 'happy-server-light', label: 'SERVER' });
  }
  if (serverComponentName === 'both' || serverComponentName === 'happy-server') {
    // In fork mode (split repos), full server is a branch in the fork server repo.
    // In upstream mode and in monorepo mode, use main.
    const serverFullBranch = isHappyMonorepoRoot(serverFullRepoDir) ? 'main' : repoSource === 'upstream' ? 'main' : 'happy-server';
    await ensureGitBranchCheckedOut({ repoDir: serverFullRepoDir, branch: serverFullBranch, label: 'SERVER_FULL' });
  }

  const cliDirFinal = cliDir;
  const uiDirFinal = uiDir;

  // Install deps
  const skipUiDeps = flags.has('--no-ui-deps') || (process.env.HAPPY_STACKS_INSTALL_NO_UI_DEPS ?? '').trim() === '1';
  const skipCliDeps = flags.has('--no-cli-deps') || (process.env.HAPPY_STACKS_INSTALL_NO_CLI_DEPS ?? '').trim() === '1';
  if (serverComponentName === 'both' || serverComponentName === 'happy-server-light') {
    await ensureDepsInstalledMaybeVerbose(getComponentDir(rootDir, 'happy-server-light'), 'happy-server-light');
  }
  if (serverComponentName === 'both' || serverComponentName === 'happy-server') {
    await ensureDepsInstalledMaybeVerbose(serverFullDir, 'happy-server');
  }
  if (!skipUiDeps) {
    await ensureDepsInstalledMaybeVerbose(uiDirFinal, 'happy');
  }
  if (!skipCliDeps) {
    await ensureDepsInstalledMaybeVerbose(cliDirFinal, 'happy-cli');
  }

  // CLI build + link
  const skipCliBuild = flags.has('--no-cli-build') || (process.env.HAPPY_STACKS_INSTALL_NO_CLI_BUILD ?? '').trim() === '1';
  if (!skipCliBuild) {
    const buildCli = (process.env.HAPPY_LOCAL_CLI_BUILD ?? '1') !== '0';
    const npmLinkCli = (process.env.HAPPY_LOCAL_NPM_LINK ?? '1') !== '0';
    await ensureCliBuiltMaybeVerbose(cliDirFinal, { buildCli });
    await ensureHappyCliLocalNpmLinked(rootDir, { npmLinkCli, quiet: quietUi });
  }

  // Build UI (so run works without expo dev server)
  const skipUiBuild = flags.has('--no-ui-build') || (process.env.HAPPY_STACKS_INSTALL_NO_UI_BUILD ?? '').trim() === '1';
  const buildArgs = [join(rootDir, 'scripts', 'build.mjs')];
  // Tauri builds are opt-in (slow + requires additional toolchain).
  const buildTauri = wizard?.buildTauri ?? (flags.has('--tauri') && !flags.has('--no-tauri'));
  if (!skipUiBuild) {
    if (buildTauri) {
      buildArgs.push('--tauri');
    } else if (flags.has('--no-tauri')) {
      buildArgs.push('--no-tauri');
    }
    if (quietUi) {
      await runMaybeVerbose({ label: 'build web UI bundle', cmd: process.execPath, args: buildArgs, cwd: rootDir });
    } else {
      await run(process.execPath, buildArgs, { cwd: rootDir });
    }
  }

  // Optional autostart (macOS launchd / Linux systemd --user)
  if (disableAutostart) {
    await uninstallService();
  } else if (enableAutostart) {
    if (process.platform === 'linux') {
      const hasSystemctl = await commandExists('systemctl');
      if (!hasSystemctl) {
        if (!json) {
          // eslint-disable-next-line no-console
          console.log('[bootstrap] autostart skipped: systemd user services not available (missing systemctl)');
        }
      } else {
        await installService();
      }
    } else {
      await installService();
    }
  }

  // Optional git remote + mirror branch configuration
  if (wizard?.configureGit) {
    // Ensure upstream remotes exist so `happys wt sync-all` works consistently.
    const upstreamRepos = getRepoUrls({ repoSource: 'upstream' });
    await ensureUpstreamRemote({ repoDir: uiRepoDir, upstreamUrl: upstreamRepos.ui });
    if (cliRepoDir !== uiRepoDir) {
      await ensureUpstreamRemote({ repoDir: cliRepoDir, upstreamUrl: upstreamRepos.cli });
    }
    // server-light and server-full both track upstream happy-server
    if (await pathExists(serverLightRepoDir)) {
      await ensureUpstreamRemote({ repoDir: serverLightRepoDir, upstreamUrl: upstreamRepos.serverLight });
    }
    if (serverFullRepoDir !== uiRepoDir && (await pathExists(serverFullRepoDir))) {
      await ensureUpstreamRemote({ repoDir: serverFullRepoDir, upstreamUrl: upstreamRepos.serverFull });
    }

    // Create/update mirror branches like slopus/main for each repo (best-effort).
    try {
      if (quietUi) {
        await runMaybeVerbose({
          label: 'update mirror branches (sync-all)',
          cmd: process.execPath,
          args: [join(rootDir, 'scripts', 'worktrees.mjs'), 'sync-all', '--json'],
          cwd: rootDir,
        });
      } else {
        await run(process.execPath, [join(rootDir, 'scripts', 'worktrees.mjs'), 'sync-all', '--json'], { cwd: rootDir });
      }
    } catch {
      // ignore (still useful even if one component fails)
    }
  }

  printResult({
    json,
    data: {
      ok: true,
      repoSource,
      serverComponentName,
      dirs: {
        uiRepoDir,
        uiDir: uiDirFinal,
        cliRepoDir,
        cliDir: cliDirFinal,
        serverLightRepoDir,
        serverLightDir: getComponentDir(rootDir, 'happy-server-light'),
        serverFullRepoDir,
        serverFullDir,
      },
      cloned: allowClone,
      autostart: enableAutostart ? 'enabled' : sandboxed && enableAutostartRaw && !allowGlobal ? 'skipped (sandbox)' : disableAutostart ? 'disabled' : 'unchanged',
      interactive: Boolean(wizard),
    },
    text: '[local] setup complete',
  });
}

main().catch((err) => {
  console.error('[local] install failed:', err);
  process.exit(1);
});
