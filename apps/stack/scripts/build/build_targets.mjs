import { parseArgs } from '../utils/cli/args.mjs';
import { resolveDevTargetServicePlans } from '../utils/dev_targets/service_placement.mjs';
import { resolveDevTargetExecutionPolicy } from '../utils/dev_targets/config.mjs';

function hasRuntimeServiceTargetPlacement(config) {
  return ['server', 'daemon'].some(name => ['prefer-target', 'local-and-targets'].includes(config?.runtimePlacement?.[name]?.mode));
}

export function parseRuntimeBuildTarget({ argv = [], component, config, observedTargets = [],
  hostTarget = { platform: process.platform, arch: process.arch }, placementTargetName,
  placementAware = hasRuntimeServiceTargetPlacement(config),
} = {}) {
  const { kv } = parseArgs(argv);
  let explicitTarget;
  if (kv.has('--target')) {
    const requested = String(kv.get('--target')).trim();
    const match = /^(linux|darwin|windows|win32)-(x64|arm64)$/.exec(requested);
    if (!match) throw new Error(`[build] invalid runtime target: ${requested}. Use <linux|darwin|windows>-<x64|arm64>.`);
    explicitTarget = { platform: match[1] === 'windows' ? 'win32' : match[1], arch: match[2] };
  }
  if (!component || !placementAware) return explicitTarget ?? hostTarget;
  const placement = config?.runtimePlacement?.[component];
  const name = placementTargetName === undefined
    ? placement?.mode === 'prefer-target' ? placement.target : null
    : placementTargetName;
  if (!name) return hostTarget;
  const observation = observedTargets.find(target => target.name === name);
  if (!observation?.ok || !['linux', 'darwin', 'win32'].includes(observation.runtimeTarget?.platform)
    || !['x64', 'arm64'].includes(observation.runtimeTarget?.arch)) {
    throw new Error(`[build] ${component} placement host ${name} is unavailable or has no supported runtime target; cannot choose its artifact target.`);
  }
  return observation.runtimeTarget;
}

/** Service placement owns where components run; this owner groups their build targets. */
export function resolveRuntimeBuildTargetGroups({ argv = [], selection, config = { version: 1, targets: [] }, observedTargets = [],
  hostTarget = { platform: process.platform, arch: process.arch },
}) {
  const plans = resolveDevTargetServicePlans({ targets: config.targets, policy: resolveDevTargetExecutionPolicy(config),
    requested: { server: selection.components.server, daemon: selection.components.daemon, expo: false },
  });
  // Placement applies to each service even when only its local sibling is
  // selected. Otherwise daemon-only --target=<server host> retargets the daemon.
  const placementAware = hasRuntimeServiceTargetPlacement(config)
    && (selection.components.server || selection.components.daemon);
  const groups = new Map();
  const componentTargets = {};
  for (const component of ['web', 'server', 'daemon']) {
    if (!selection.components[component]) continue;
    const names = [
      ...(component === 'web' || plans.local[component] ? [null] : []),
      ...plans.targets.filter(plan => plan.services[component]).map(plan => plan.target.name),
    ];
    for (const placementTargetName of names) {
      const target = parseRuntimeBuildTarget({ argv, component, config, observedTargets, hostTarget, placementAware, placementTargetName });
      const key = `${target.platform}-${target.arch}`;
      componentTargets[component] ??= [];
      if (!componentTargets[component].some(value => value.platform === target.platform && value.arch === target.arch)) componentTargets[component].push(target);
      if (!groups.has(key)) groups.set(key, { target, selection: { ...selection,
        components: { web: false, server: false, daemon: false, tauri: false } } });
      groups.get(key).selection.components[component] = true;
    }
  }
  const { kv } = parseArgs(argv);
  if (placementAware && kv.has('--target')) {
    const explicit = parseRuntimeBuildTarget({ argv, hostTarget });
    if (![...groups.values()].some(group => group.target.platform === explicit.platform && group.target.arch === explicit.arch)) {
      throw new Error(`[build] explicit target ${explicit.platform}-${explicit.arch} does not match any selected component placement; select a matching component or omit --target.`);
    }
  }
  if (groups.size > 1 && selection.activateRuntime) {
    throw new Error('[build] --activate-runtime cannot select components placed on different runtime targets in one snapshot; build without activation, then use stack runtime select for each service target subset.');
  }
  if (groups.size > 1) for (const group of groups.values()) group.selection.publicationRequiredComponents = Object.keys(group.selection.components).filter(component => group.selection.components[component]);
  return { groups: [...groups.values()], componentTargets };
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
