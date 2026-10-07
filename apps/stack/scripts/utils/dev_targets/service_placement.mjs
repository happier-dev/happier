import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDevTargetsConfig, parseDevTargetsConfig } from './config.mjs';
import { redactFailureDiagnostic, runCaptureResult } from '../proc/proc.mjs';
import { writeJsonAtomic } from '../fs/json.mjs';
import { getRootDir, getRepoDir } from '../paths/paths.mjs';
import { resolveRuntimeBuildAuthority } from '../../runtime/shared/runtime_build_authority.mjs';
import { getServerLightDataDirFromEnvOrDefault } from '../stack/dirs.mjs';
import { hasRetainedServerData } from './retained_server_data.mjs';

export async function loadControlledRuntimeConfig({ stackName, sourceDir, preserveLocalPlacement = false, env = process.env },
  { logger = console } = {}) {
  const rootDir = getRootDir(import.meta.url);
  const authority = resolveRuntimeBuildAuthority({ rootDir, consumerStackName: stackName,
    env: { ...env, ...(sourceDir ? { HAPPIER_STACK_REPO_DIR: sourceDir } : {}) }, createRepoIdentityIfMissing: false });
  const isProducer = stackName === authority.producerStackName;
  const own = await loadDevTargetsConfig({ stackName, env, logger,
    ...(!isProducer ? { buildPlacementOwnerPath: join(authority.producerStackBaseDir, 'dev-targets.json') } : {}),
  });
  const qaExplicitlySet = own.config.runtimePlacement?.qa != null;
  if (preserveLocalPlacement && own.config.runtimePlacement?.server?.mode !== 'prefer-target') {
    const explicitLocalQa = qaExplicitlySet && own.config.runtimePlacement.qa.mode === 'local';
    const localData = await hasRetainedServerData(getServerLightDataDirFromEnvOrDefault({ stackBaseDir: authority.consumerStackBaseDir, env }));
    if (localData || explicitLocalQa) {
      return { ...own, config: parseDevTargetsConfig({ version: 3, targets: own.config.targets,
        runtimePlacement: { ...own.config.runtimePlacement, qa: { mode: 'local' } },
        commandExecution: own.config.commandExecution,
      }), authority, producer: stackName === authority.producerStackName, qaExplicitlySet,
      localPlacementReason: localData ? 'retained-local-data' : 'explicit-local' };
    }
  }
  const producer = await loadDevTargetsConfig({ stackName: authority.producerStackName, env });
  const targets = own.config.targets.length ? own.config.targets : producer.config.targets;
  // Commands can move between workers; a Machine's sessions and workspace
  // cannot. Only this consumer's explicit daemon pin can place its Machine.
  const qa = own.config.runtimePlacement?.qa ?? { mode: 'local' };
  const config = parseDevTargetsConfig({ version: 3, targets,
    runtimePlacement: { ...own.config.runtimePlacement, qa },
    commandExecution: own.config.commandExecution ?? producer.config.commandExecution,
  });
  return { ...own, config, authority, producer: stackName === authority.producerStackName,
    qaExplicitlySet };
}

// Awaited at the supervisor's server dispatch boundary, before the child can
// create data. An uncertain dispatch must retain the selected data authority.
export async function persistControlledServerPlacement({ stackName, sourceDir, targetName, env = process.env }) {
  const loaded = await loadControlledRuntimeConfig({ stackName, sourceDir, env });
  const retained = loaded.config.runtimePlacement.server;
  if (retained.mode === 'prefer-target' && retained.target !== targetName) {
    throw new Error(`[dev-targets] persisted server placement is authoritative on ${retained.target}; use the explicit retained-data move`);
  }
  if (!loaded.config.targets.some(target => target.name === targetName)) {
    throw new Error(`[dev-targets] unknown QA target: ${targetName}`);
  }
  const persisted = parseDevTargetsConfig({ ...loaded.config,
    runtimePlacement: { ...loaded.config.runtimePlacement,
      server: { mode: 'prefer-target', target: targetName, fallback: 'local' },
    },
  });
  if (!loaded.daemonExplicitlySet) delete persisted.runtimePlacement.daemon;
  await writeJsonAtomic(loaded.path, persisted);
}

function qaProbeFailure(message, result, env) {
  return new Error(`[dev-targets] ${message}; stdout=${JSON.stringify(redactFailureDiagnostic(result?.out, env))}; stderr=${JSON.stringify(redactFailureDiagnostic(result?.err, env))}`);
}

// Ask the existing commands-auto owner to select and run a read-only host
// probe. The temporary config is only its invocation projection of the QA
// policy, parsed by the same dev-targets owner, not a second placement store.
async function probeControlledPlacement({ config, sourceDir, syncStackBaseDir, env, targetName }, runCaptureResultImpl) {
  const directory = await mkdtemp(join(tmpdir(), 'hstack-qa-placement-'));
  try {
    const path = join(directory, 'dev-targets.json');
    // The native selector derives synchronization state from the config's
    // directory. Reuse the producer's existing mirror sessions, never create
    // consumer sessions over the same source and target.
    await symlink(join(syncStackBaseDir, 'mutagen'), join(directory, 'mutagen'), process.platform === 'win32' ? 'junction' : 'dir');
    const qa = config.runtimePlacement.qa;
    const commandExecution = targetName
      ? { mode: 'prefer-target', target: targetName, fallback: 'local' }
      : { ...qa, includeLocal: false };
    await writeJsonAtomic(path, parseDevTargetsConfig({ ...config, commandExecution }));
    return await runCaptureResultImpl(join(sourceDir, 'apps/stack/bin/hstack-exec'), [
      ...(targetName ? [`--target=${targetName}`] : []), '--', 'node', '-e',
      'process.stdout.write("HSTACK_QA_HOST="+JSON.stringify({platform:process.platform,arch:process.arch,remote:process.env.HAPPIER_DEV_TARGET_EXECUTION===\"1\"})+"\\n")',
    ], { cwd: sourceDir, env: { ...env, HAPPIER_EXEC_CONFIG_PATH: path, HAPPIER_DEV_TARGET_EXECUTION: '' } });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function resolveControlledRuntimePlacement({ stackName, stackBaseDir, sourceDir, excludeTargetNames = [], env = process.env },
  { runCaptureResult: runCaptureResultImpl = runCaptureResult, logger = console } = {}) {
  const loaded = await loadControlledRuntimeConfig({ stackName, sourceDir, preserveLocalPlacement: true, env }, { logger });
  sourceDir ||= getRepoDir(getRootDir(import.meta.url), env);
  const { config } = loaded;
  const local = { ...loaded, target: null, runtimeTarget: { platform: process.platform, arch: process.arch },
    policy: { server: { mode: 'local' }, daemons: { mode: 'local' }, expo: { mode: 'local' }, commands: { mode: 'local' } }, targetPlans: [] };
  if (loaded.producer || env.HAPPIER_STACK_NO_DEV_TARGETS === '1') return local;
  const retained = config.runtimePlacement.server.mode === 'prefer-target' ? config.runtimePlacement.server.target : null;
  if (!retained && loaded.localPlacementReason) {
    if (loaded.localPlacementReason === 'retained-local-data') {
      logger.warn?.(`[dev-targets] retained local server data keeps ${stackName} local; use explicit move-server before remote placement`);
    }
  }
  const configuredQa = config.runtimePlacement.qa;
  const qa = retained ? { mode: 'prefer-target', targets: [retained], fallback: 'error' }
    : configuredQa.mode === 'local' ? configuredQa
      : { ...configuredQa, targets: configuredQa.targets.filter(name => !excludeTargetNames.includes(name)) };
  if (qa.mode !== 'local' && qa.targets.length === 0) {
    logger.warn?.('[dev-targets] QA targets unavailable; using local runtime placement');
  }
  const selected = qa.mode !== 'local' && qa.targets.length
    ? await selectControlledTarget({ loaded, config, qa, retained, sourceDir, env, logger, runCaptureResultImpl }) : null;
  const target = selected?.target ?? null;
  const runtimeTarget = selected?.runtimeTarget ?? local.runtimeTarget;
  const daemonOverride = loaded.daemonExplicitlySet ? config.runtimePlacement.daemon : null;
  if (daemonOverride?.mode === 'local-and-targets') {
    throw new Error('[dev-targets] controlled QA Machine placement requires one named daemon host');
  }
  const daemon = daemonOverride?.mode === 'prefer-target'
    ? await selectControlledTarget({ loaded, config,
      qa: { mode: 'prefer-target', targets: [daemonOverride.target], fallback: 'error' },
      retained: daemonOverride.target, authorityLabel: 'daemon', sourceDir, env, logger, runCaptureResultImpl }) : null;
  const policy = { server: target ? { mode: 'prefer-target', target: target.name, fallback: 'error' } : { mode: 'local' },
    daemons: daemon ? { mode: 'prefer-target', target: daemon.target.name, fallback: 'error' } : { mode: 'local' },
    expo: { mode: 'local' }, commands: { mode: 'local' } };
  const serviceTargets = [target, daemon?.target].filter((candidate, index, all) => candidate && all.findIndex(other => other?.name === candidate.name) === index);
  const plans = resolveDevTargetServicePlans({ targets: serviceTargets, policy, requested: { server: true, daemon: true, expo: false } });
  return { ...loaded, target, runtimeTarget, policy, targetPlans: plans.targets, stackBaseDir,
    daemonTarget: daemon?.target ?? null, daemonRuntimeTarget: daemon?.runtimeTarget ?? null };
}

async function selectControlledTarget({ loaded, config, qa, retained, authorityLabel = 'server', sourceDir, env, logger, runCaptureResultImpl }) {
  const attempts = qa.mode === 'auto' ? [null] : qa.targets;
  for (const targetName of attempts) {
    let result;
    let probeError;
    const failure = message => {
      probeError = qaProbeFailure(message, result, env);
      return probeError;
    };
    try {
      result = await probeControlledPlacement({ config: retained ? config : { ...config, runtimePlacement: { ...config.runtimePlacement, qa } },
        syncStackBaseDir: loaded.authority.producerStackBaseDir, sourceDir, env, targetName }, runCaptureResultImpl);
      const diagnostic = redactFailureDiagnostic(result.err, env);
      if (diagnostic) logger.warn?.(diagnostic);
      if (!result.ok) {
        throw failure(`QA target ${targetName ?? 'pool'} unavailable: ${diagnostic || redactFailureDiagnostic(result.error?.message, env) || result.exitCode}`);
      }
      let host;
      const identity = String(result.out ?? '').split(/[\r\n]/).map(line => line.trim()).find(line => line.startsWith('HSTACK_QA_HOST='));
      try { host = JSON.parse(identity?.slice('HSTACK_QA_HOST='.length)); } catch { throw failure('QA host probe returned malformed target identity'); }
      if (!host || !['linux', 'darwin', 'win32'].includes(host.platform) || !['x64', 'arm64'].includes(host.arch) || typeof host.remote !== 'boolean') {
        throw failure('QA host probe returned an unsupported platform or architecture');
      }
      if (host.remote !== true) {
        if (retained) throw failure('QA host probe returned local execution for explicit remote server authority');
        if (targetName) {
          logger.warn?.(`[dev-targets] QA target ${targetName} unavailable; skipping its local fallback to try the next worker`);
          continue;
        }
        logger.warn?.('[dev-targets] QA selector exhausted available targets; using local runtime placement');
        return null;
      }
      const selected = targetName ?? [...diagnostic.matchAll(/\[preferred-execution\] selected ([a-z0-9._-]+) \(/g)].at(-1)?.[1];
      const target = config.targets.find(candidate => candidate.name === selected);
      if (!target || (qa.mode === 'auto' && !qa.targets.includes(target.name))) {
        throw failure('QA host probe did not identify a configured selected target');
      }
      return { target, runtimeTarget: { platform: host.platform, arch: host.arch } };
    } catch (error) {
      const message = error === probeError ? error.message : redactFailureDiagnostic(error instanceof Error ? error.message : String(error), env);
      if (retained) throw new Error(`[dev-targets] persisted ${authorityLabel} placement is authoritative and ${retained} is unavailable: ${message}`);
      logger.warn?.(`[dev-targets] QA placement skipped; keeping local fallback available: ${message}`);
    }
  }
  logger.warn?.('[dev-targets] QA targets unavailable; using local runtime placement');
  return null;
}

function requestedPlacement(placement, requested) {
  return requested ? placement : { mode: 'disabled' };
}

function commandExecutionUsesTarget(commands, targetName) {
  if (commands.mode === 'prefer-target') return commands.target === targetName;
  return commands.mode === 'auto' && commands.targets.includes(targetName);
}

export function resolveDevTargetServicePlans({ targets, policy, requested }) {
  const placements = {
    server: requestedPlacement(policy.server, requested.server),
    expo: requestedPlacement(policy.expo, requested.expo),
    daemon: requestedPlacement(policy.daemons, requested.daemon),
  };
  const local = {
    server: placements.server.mode === 'local',
    expo: placements.expo.mode === 'local',
    daemon: placements.daemon.mode === 'local' || placements.daemon.mode === 'local-and-targets',
  };
  const targetPlans = targets.map((target) => ({
    target,
    commands: commandExecutionUsesTarget(policy.commands, target.name),
    services: {
      server: placements.server.mode === 'prefer-target' && placements.server.target === target.name,
      expo: placements.expo.mode === 'prefer-target' && placements.expo.target === target.name,
      daemon:
        (placements.daemon.mode === 'prefer-target' && placements.daemon.target === target.name)
        || (placements.daemon.mode === 'local-and-targets' && placements.daemon.targets.includes(target.name)),
    },
  })).filter((plan) => plan.commands || Object.values(plan.services).some(Boolean));
  return { local, targets: targetPlans };
}

export function resolveServicePlansAfterTargetPreflight({
  configured,
  mutagenAvailable,
  reachableTargets,
}) {
  const unavailableServerPlan = configured.targets.find((plan) => (
    plan.services.server
    && (!mutagenAvailable || !reachableTargets.has(plan.target.name))
  ));
  if (unavailableServerPlan) {
    throw new Error(
      `[dev-targets] persisted server placement is authoritative and ${unavailableServerPlan.target.name} `
      + 'is unavailable during target preflight',
    );
  }
  const local = { ...configured.local };
  const fallbacks = [];
  const targets = configured.targets.map((plan) => {
    const reachable = mutagenAvailable && reachableTargets.has(plan.target.name);
    const services = { ...plan.services };
    const fallbackServices = [];
    if (!reachable) {
      for (const [service, enabled] of Object.entries(services)) {
        if (!enabled || local[service]) continue;
        services[service] = false;
        local[service] = true;
        fallbackServices.push(service);
      }
    }
    if (fallbackServices.length > 0) {
      fallbacks.push({
        target: plan.target.name,
        services: fallbackServices,
        reason: mutagenAvailable ? 'target-unreachable' : 'mutagen-unavailable',
      });
    }
    return { ...plan, services };
  }).filter((plan) => plan.commands || Object.values(plan.services).some(Boolean));
  return { local, targets, fallbacks };
}
