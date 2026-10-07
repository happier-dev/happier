import { getRootDir, getStackName, resolveStackBaseDir } from '../../utils/paths/paths.mjs';
import { resolveStackRuntimeMode } from '../shared/runtime_mode.mjs';
import { resolveActiveRuntimeSnapshot } from './resolveActiveRuntimeSnapshot.mjs';
import { resolveRuntimeBuildAuthority } from '../shared/runtime_build_authority.mjs';
import { inspectLatestPublishedRuntimeSnapshot, selectActiveProducerRuntimeSnapshot, validatePublishedRuntimeSnapshot } from '../../build/activate_runtime_snapshot.mjs';
import { inspectActiveRuntimeSnapshot, inspectDaemonDistClosure } from './inspectActiveRuntimeSnapshot.mjs';
import { resolveRuntimeBuildTargetGroups } from '../../build/build_targets.mjs';
import { resolveControlledRuntimePlacement } from '../../utils/dev_targets/service_placement.mjs';
import { resolveStackDaemonStartRequested } from '../../utils/auth/daemon_gate.mjs';
import { validateRuntimeTarget } from '../shared/runtime_manifest.mjs';

/** Compose admitted component snapshots in memory; the consumer pointer remains the primary snapshot. */
export async function resolveStackRuntimeComponentSnapshots({ stackName, stackBaseDir, env = process.env,
  placement, hostTarget = { platform: process.platform, arch: process.arch },
  components = [...(env.HAPPIER_STACK_SHARED_DB_SOURCE_STACK ? ['server'] : ['web', 'server']),
    ...(resolveStackDaemonStartRequested({ env }) ? ['daemon'] : [])],
  snapshotId = '', select = false,
}) {
  const authority = resolveRuntimeBuildAuthority({
    rootDir: getRootDir(new URL('../../runtime_select.mjs', import.meta.url)),
    consumerStackName: stackName, env, createRepoIdentityIfMissing: false,
  });
  placement ??= await resolveControlledRuntimePlacement({ stackName, stackBaseDir, sourceDir: authority.repoDir, env });
  const config = { ...placement.config, runtimePlacement: { ...placement.config.runtimePlacement,
    server: placement.policy.server, daemon: placement.policy.daemons,
  } };
  const observedTargets = [
    ...(placement.target ? [{ name: placement.target.name, ok: true, runtimeTarget: placement.runtimeTarget }] : []),
    ...(placement.daemonTarget ? [{ name: placement.daemonTarget.name, ok: true, runtimeTarget: placement.daemonRuntimeTarget }] : []),
  ];
  const targets = resolveRuntimeBuildTargetGroups({ config, hostTarget, observedTargets,
    selection: { components: Object.fromEntries(['web', 'server', 'daemon', 'tauri'].map(component => [component, components.includes(component)])) },
  });
  const primaryComponent = components.includes('server') ? 'server' : components.includes('daemon') ? 'daemon' : 'web';
  const primaryTarget = targets.componentTargets[primaryComponent][0];
  const primaryRequiredComponents = components.filter(component => component !== 'daemon' || primaryComponent === 'daemon'
    || (!env.HAPPIER_STACK_SHARED_DB_SOURCE_STACK
      && targets.componentTargets.daemon.some(target => target.platform === primaryTarget.platform && target.arch === primaryTarget.arch)));
  let inspection;
  if (snapshotId) {
    const published = await validatePublishedRuntimeSnapshot({ producerStackBaseDir: authority.producerStackBaseDir,
      snapshotId, target: primaryTarget, requiredComponents: primaryRequiredComponents });
    const daemonClosure = published.manifest.components.daemon
      ? await inspectDaemonDistClosure({ snapshotPath: published.producerPaths.snapshotDir }) : { fingerprint: null, errors: [] };
    inspection = { valid: true, missing: false, errors: [], activeSnapshotId: snapshotId, manifest: published.manifest,
      snapshot: { snapshotId, snapshotPath: published.producerPaths.snapshotDir, manifest: published.manifest,
        daemonDistClosureFingerprint: daemonClosure.fingerprint,
        producerStackBaseDir: authority.producerStackBaseDir, producerStackName: authority.producerStackName } };
  } else {
    inspection = select
      ? await inspectLatestPublishedRuntimeSnapshot({ stackBaseDir: authority.producerStackBaseDir,
        target: primaryTarget, requiredComponents: primaryRequiredComponents })
      : await inspectActiveRuntimeSnapshot({ stackBaseDir, env, target: primaryTarget, requiredComponents: primaryRequiredComponents });
  }
  const errors = [...inspection.errors];
  if (!inspection.snapshot && errors.length === 0) errors.push(`[runtime] missing ${primaryComponent} snapshot for ${primaryTarget.platform}/${primaryTarget.arch}.`);
  const componentSnapshots = {};
  const daemonSnapshots = [];
  if (inspection.snapshot) {
    for (const component of components.filter(component => component !== 'daemon')) componentSnapshots[component] = inspection.snapshot;
  }
  for (const daemonTarget of targets.componentTargets.daemon ?? []) {
    const primaryContainsDaemon = inspection.snapshot?.manifest.components.daemon
      && validateRuntimeTarget(inspection.snapshot.manifest, daemonTarget).ok;
    const daemonInspection = primaryContainsDaemon ? inspection : await inspectLatestPublishedRuntimeSnapshot({
      stackBaseDir: authority.producerStackBaseDir, target: daemonTarget, requiredComponents: ['daemon'],
    });
    if (daemonInspection.snapshot) {
      const snapshot = { ...daemonInspection.snapshot, producerStackName: daemonInspection.snapshot.producerStackName ?? authority.producerStackName };
      daemonSnapshots.push({ target: daemonTarget, snapshot });
      componentSnapshots.daemon ??= snapshot;
    } else {
      errors.push(...daemonInspection.errors,
        ...(!daemonInspection.errors.length ? [`[runtime] producer ${authority.producerStackName} has no daemon snapshot for its placement host ${daemonTarget.platform}/${daemonTarget.arch}.`] : []));
    }
  }
  const valid = Boolean(inspection.snapshot) && errors.length === 0;
  let selectedRuntime = null;
  if (select && valid) selectedRuntime = await selectActiveProducerRuntimeSnapshot({
    ...authority, snapshotId: inspection.snapshot.snapshotId, target: primaryTarget, requiredComponents: primaryRequiredComponents,
  });
  return { ...inspection, valid, errors, snapshot: valid ? inspection.snapshot : null,
    componentSnapshots, daemonSnapshots, componentTargets: targets.componentTargets, groups: targets.groups,
    placement, selectedRuntime };
}

export async function resolveNativeDaemonRuntimeSnapshot({ stackName, env = process.env, mode = 'require',
  target = { platform: process.platform, arch: process.arch } }) {
  if (mode === 'source') return null;
  const authority = resolveRuntimeBuildAuthority({
    rootDir: getRootDir(new URL('../../runtime_select.mjs', import.meta.url)),
    consumerStackName: stackName, env, createRepoIdentityIfMissing: false,
  });
  const inspection = await inspectLatestPublishedRuntimeSnapshot({
    stackBaseDir: authority.producerStackBaseDir, requiredComponents: ['daemon'], target,
  });
  if (inspection.snapshot) return { ...inspection.snapshot, producerStackName: authority.producerStackName };
  if (mode === 'prefer') return null;
  throw new Error(inspection.errors[0] ?? `[runtime] producer ${authority.producerStackName} has no native daemon runtime snapshot for ${target.platform}/${target.arch}. Build it through the repository producer with --daemon.`);
}

export async function resolveStackRuntimeLaunchContext({ argv = [], env = process.env, activeRuntimeState = null, target,
  requiredComponents, purpose = 'cli', placement, hostTarget = { platform: process.platform, arch: process.arch } } = {}) {
  const stackName = (env.HAPPIER_STACK_STACK ?? '').toString().trim() || getStackName(env);
  const { baseDir: stackBaseDir } = resolveStackBaseDir(stackName, env);
  const runtimeMode = resolveStackRuntimeMode({ argv, env, activeRuntimeState });
  if (purpose === 'deployment' && runtimeMode.mode !== 'source' && !argv.includes('--no-dev-targets')) {
    const components = env.HAPPIER_STACK_SHARED_DB_SOURCE_STACK ? ['server'] : requiredComponents ?? ['web', 'server'];
    const inspection = await resolveStackRuntimeComponentSnapshots({ stackName, stackBaseDir, env, placement, hostTarget,
      components: [...components, ...(resolveStackDaemonStartRequested({ env, noDaemon: argv.includes('--no-daemon') }) ? ['daemon'] : [])],
    });
    if (!inspection.valid && runtimeMode.mode !== 'prefer') throw new Error(inspection.errors[0]);
    return { stackName, stackBaseDir, runtimeMode, snapshot: inspection.snapshot,
      componentSnapshots: inspection.componentSnapshots, componentTargets: inspection.componentTargets,
      daemonSnapshots: inspection.daemonSnapshots, placement: inspection.placement };
  }
  const components = argv.includes('--no-server') && argv.includes('--no-ui')
    ? ['daemon']
    : requiredComponents ?? (argv.includes('--no-daemon') && argv.includes('--no-ui') ? ['server'] : undefined);
  const snapshot = env.HAPPIER_STACK_SHARED_DB_SOURCE_STACK && components === undefined
    ? await resolveNativeDaemonRuntimeSnapshot({ stackName, env, mode: runtimeMode.mode, target: hostTarget })
    : await resolveActiveRuntimeSnapshot({ mode: runtimeMode.mode, stackBaseDir, target, env, requiredComponents: components });

  return {
    stackName,
    stackBaseDir,
    runtimeMode,
    snapshot,
  };
}
