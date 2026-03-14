import { parseArgs } from '../utils/cli/args.mjs';

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
