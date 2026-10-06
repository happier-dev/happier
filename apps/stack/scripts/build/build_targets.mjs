import { parseArgs } from '../utils/cli/args.mjs';

export function parseRuntimeBuildTarget({ argv = [] } = {}) {
  const { kv } = parseArgs(argv);
  if (!kv.has('--target')) return { platform: process.platform, arch: process.arch };
  const requested = String(kv.get('--target')).trim();
  const match = /^(linux|darwin|windows|win32)-(x64|arm64)$/.exec(requested);
  if (!match) throw new Error(`[build] invalid runtime target: ${requested}. Use <linux|darwin|windows>-<x64|arm64>.`);
  return { platform: match[1] === 'windows' ? 'win32' : match[1], arch: match[2] };
}

function hasAnyExplicitComponent(selection) {
  return Object.values(selection).some(Boolean);
}

function expandAllComponents(selection) {
  return {
    ...selection,
    web: true,
    server: true,
    daemon: true,
  };
}

export function parseBuildSelection({ argv = [] } = {}) {
  const { flags } = parseArgs(Array.isArray(argv) ? argv : []);

  let components = {
    web: flags.has('--web'),
    server: flags.has('--server'),
    daemon: flags.has('--daemon'),
    tauri: flags.has('--tauri'),
  };

  if (flags.has('--all')) {
    components = expandAllComponents(components);
  }

  const activateRuntime = flags.has('--activate-runtime');
  if (activateRuntime && !hasAnyExplicitComponent(components)) {
    components = expandAllComponents(components);
  }

  const explicitComponentSelection =
    flags.has('--all') ||
    flags.has('--web') ||
    flags.has('--server') ||
    flags.has('--daemon') ||
    flags.has('--tauri');

  if (!explicitComponentSelection && !activateRuntime) {
    components.web = true;
  }

  if (activateRuntime && (!components.web || !components.server || !components.daemon)) {
    throw new Error('[build] --activate-runtime requires web, server, and daemon artifacts in v1.');
  }

  if (
    components.tauri &&
    (activateRuntime || flags.has('--all') || flags.has('--web') || flags.has('--server') || flags.has('--daemon') || flags.has('--force-rebuild'))
  ) {
    throw new Error('[build] --tauri cannot be combined with stack-local artifact or runtime flags in v1.');
  }

  return {
    components,
    activateRuntime,
    forceRebuild: flags.has('--force-rebuild'),
    explicitComponentSelection,
  };
}
