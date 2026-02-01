import './utils/env/env.mjs';

import { rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { parseArgs } from './utils/cli/args.mjs';
import { printResult, wantsHelp, wantsJson } from './utils/cli/cli.mjs';
import { expandHome } from './utils/paths/canonical_home.mjs';
import { getHappyStacksHomeDir, getRootDir, getStacksStorageRoot } from './utils/paths/paths.mjs';
import { getRuntimeDir } from './utils/paths/runtime.mjs';
import { getCanonicalHomeEnvPath } from './utils/env/config.mjs';
import { isSandboxed, sandboxAllowsGlobalSideEffects } from './utils/env/sandbox.mjs';
import { removeSwiftbarPlugins, resolveSwiftbarPluginsDir } from './utils/menubar/swiftbar.mjs';
import { banner, bullets, cmd, kv, sectionTitle } from './utils/ui/layout.mjs';
import { cyan, dim, green, yellow } from './utils/ui/ansi.mjs';

function resolveWorkspaceDir({ rootDir, homeDir }) {
  // Uninstall should never default to deleting the repo root (getWorkspaceDir() can fall back to cliRootDir).
  const fromEnv = (process.env.HAPPIER_STACK_WORKSPACE_DIR ?? '').trim();
  if (fromEnv) {
    return expandHome(fromEnv);
  }
  void rootDir;
  return join(homeDir, 'workspace');
}

async function main() {
  const argv = process.argv.slice(2);
  const { flags } = parseArgs(argv);
  const json = wantsJson(argv, { flags });
  if (wantsHelp(argv, { flags }) || argv.includes('help')) {
    printResult({
      json,
      data: { flags: ['--remove-workspace', '--remove-stacks', '--yes', '--global'], json: true },
      text: [
        '[uninstall] usage:',
        '  hapsta uninstall [--json]   # dry-run',
        '  hapsta uninstall --yes [--json]',
        '  hapsta uninstall --remove-workspace --yes',
        '  hapsta uninstall --remove-stacks --yes',
        '  hapsta uninstall --global --yes   # also remove global OS integrations (services/SwiftBar) even in sandbox mode',
        '',
        'notes:',
        '  - default removes: runtime, shims, cache, SwiftBar assets + plugin files, and LaunchAgent services',
        '  - stacks under ~/.happy/stacks are kept unless --remove-stacks is provided',
      ].join('\n'),
    });
    return;
  }

  const rootDir = getRootDir(import.meta.url);
  const homeDir = getHappyStacksHomeDir();
  const runtimeDir = getRuntimeDir();
  const workspaceDir = resolveWorkspaceDir({ rootDir, homeDir });

  const yes = flags.has('--yes');
  const removeWorkspace = flags.has('--remove-workspace');
  const removeStacks = flags.has('--remove-stacks');
  const allowGlobal = flags.has('--global') || sandboxAllowsGlobalSideEffects();

  const dryRun = !yes;

  if (!json) {
    // eslint-disable-next-line no-console
    console.log('');
    // eslint-disable-next-line no-console
    console.log(banner('uninstall', { subtitle: 'Remove Hapsta runtime + shims (and optionally workspace/stacks).' }));
    // eslint-disable-next-line no-console
    console.log('');
  }

  // 1) Stop/uninstall services best-effort.
  if (!dryRun && (!isSandboxed() || allowGlobal)) {
    try {
      spawnSync(process.execPath, [join(rootDir, 'scripts', 'service.mjs'), 'uninstall'], {
        stdio: json ? 'ignore' : 'inherit',
        env: process.env,
        cwd: rootDir,
      });
    } catch {
      // ignore
    }
  }

  // 2) Remove SwiftBar plugin files best-effort.
  const menubar =
    isSandboxed() && !allowGlobal
      ? { ok: true, removed: false, pluginsDir: null, skipped: 'sandbox' }
      : dryRun
        ? { ok: true, removed: false, pluginsDir: resolveSwiftbarPluginsDir() }
        : await removeSwiftbarPlugins().catch(() => ({ ok: false, removed: false, pluginsDir: null }));

  // 3) Remove home-managed runtime + shims + extras + cache + env pointers.
  const canonicalEnv = getCanonicalHomeEnvPath();
  const toRemove = [
    join(homeDir, 'bin'),
    join(homeDir, 'runtime'),
    join(homeDir, 'extras'),
    join(homeDir, 'cache'),
    join(homeDir, '.env'),
    join(homeDir, 'env.local'),
    // Stable pointer file (can differ from homeDir for custom installs).
    canonicalEnv,
  ];
  const removedPaths = [];
  for (const p of toRemove) {
    try {
      if (existsSync(p)) {
        if (!dryRun) {
          await rm(p, { recursive: true, force: true });
        }
        removedPaths.push(p);
      }
    } catch {
      // ignore
    }
  }

  // 4) Optionally remove workspace (repo clone + worktrees).
  if (removeWorkspace) {
    const ws = expandHome(workspaceDir);
    if (existsSync(ws)) {
      if (!dryRun) {
        await rm(ws, { recursive: true, force: true });
      }
      removedPaths.push(ws);
    }
  }

  // 5) Optionally remove stacks data.
  if (removeStacks) {
    const stacksRoot = getStacksStorageRoot();
    if (existsSync(stacksRoot)) {
      if (!dryRun) {
        await rm(stacksRoot, { recursive: true, force: true });
      }
      removedPaths.push(stacksRoot);
    }
  }

  printResult({
    json,
    data: {
      ok: true,
      homeDir,
      runtimeDir,
      workspaceDir,
      removedPaths,
      menubar,
      removeWorkspace,
      removeStacks,
      dryRun,
    },
    text: [
      dryRun ? `${yellow('!')} dry run (no changes made)` : `${green('✓')} complete`,
      dryRun ? `${dim('Re-run with')} ${cmd('hapsta uninstall --yes')} ${dim('to apply removals.')}` : null,
      '',
      sectionTitle('Plan'),
      bullets([
        kv('home:', cyan(homeDir)),
        kv('workspace:', removeWorkspace ? `${cyan(workspaceDir)} ${dim('(will remove)')}` : `${cyan(workspaceDir)} ${dim('(keep)')}`),
        kv('stacks:', removeStacks ? `${cyan(getStacksStorageRoot())} ${dim('(will remove)')}` : `${cyan(getStacksStorageRoot())} ${dim('(keep)')}`),
        menubar?.pluginsDir ? kv('swiftbar:', `${menubar.pluginsDir}${menubar?.skipped ? ` ${dim('(skipped)')}` : ''}`) : null,
      ].filter(Boolean)),
      '',
      sectionTitle('Removed'),
      removedPaths.length ? bullets(removedPaths.map((p) => p)) : dim('(nothing)'),
    ]
      .filter(Boolean)
      .join('\n'),
  });
}

main().catch((err) => {
  console.error('[uninstall] failed:', err);
  process.exit(1);
});
