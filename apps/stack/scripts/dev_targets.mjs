import { configureDevTargetPower } from './utils/dev_targets/worker_power.mjs';
import { provisionManagedWslDevTarget } from './utils/dev_targets/managed_wsl.mjs';
import './utils/env/env.mjs';
import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseArgs } from './utils/cli/args.mjs';
import { printResult, wantsHelp, wantsJson } from './utils/cli/cli.mjs';
import {
  loadDevTargetsConfig,
  parseDevTargetsConfig,
  resolveDevTargetsConfigPath,
  upgradeDevTargetsConfigToVersion3,
} from './utils/dev_targets/config.mjs';
import { runDevTargetsDoctor } from './utils/dev_targets/doctor.mjs';
import {
  applyManagedDevTargetCapacity,
  doctorManagedDevTargetRuntime,
} from './utils/dev_targets/managed_runtime.mjs';
import { provisionPosixDevTarget } from './utils/dev_targets/provision.mjs';
import { provisionManagedLimaDevTarget } from './utils/dev_targets/managed_worker.mjs';
import {
  inspectDevTargetSync,
  runDevTargetCommand,
  syncDevTarget,
} from './utils/dev_targets/executor.mjs';
import {
  inspectDevTargetSyncService,
  startDevTargetSyncService,
  stopDevTargetSyncService,
  waitForDevTargetSyncMonitor,
} from './utils/dev_targets/sync_service.mjs';
import { writeNativeExecutionProjection } from './utils/dev_targets/native_execution_projection.mjs';

async function configureWorkerPower(target) {
  const results = await configureDevTargetPower({ target });
  for (const result of results) {
    if (!result.ok) process.stderr.write(`[dev-targets] ${target.name} ${result.role}: sleep configuration failed: ${result.detail}\n`);
  }
  return { name: target.name, results };
}

function splitCommandArguments(argv) {
  const separator = argv.indexOf('--');
  if (separator !== -1) {
    return {
      wrapperArgs: argv.slice(0, separator),
      remoteCommandArgs: argv.slice(separator + 1),
    };
  }
  if (argv[0] !== 'exec') return { wrapperArgs: argv, remoteCommandArgs: [] };

  const spaceValueFlags = new Set(['--stack', '--cwd', '--env']);
  let positionalCount = 0;
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    if (raw.startsWith('--')) {
      if (!raw.includes('=') && spaceValueFlags.has(raw)) index += 1;
      continue;
    }
    positionalCount += 1;
    if (positionalCount === 3) {
      return {
        wrapperArgs: argv.slice(0, index),
        remoteCommandArgs: argv.slice(index),
      };
    }
  }
  return { wrapperArgs: argv, remoteCommandArgs: [] };
}

function collectPositionals(argv, kv) {
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    if (!raw.startsWith('--')) {
      positionals.push(raw);
      continue;
    }
    if (!raw.includes('=') && (kv.has(raw) || raw === '--env')) index += 1;
  }
  return positionals;
}

function parseRemoteEnvironment(argv) {
  const environment = {};
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    let assignment = null;
    if (raw === '--env') {
      assignment = argv[index + 1];
      if (assignment == null) {
        throw new Error('[dev-targets] --env requires KEY=VALUE');
      }
      index += 1;
    } else if (raw.startsWith('--env=')) {
      assignment = raw.slice('--env='.length);
    }
    if (assignment == null) continue;
    const separator = assignment.indexOf('=');
    if (separator <= 0) {
      throw new Error('[dev-targets] --env requires KEY=VALUE');
    }
    environment[assignment.slice(0, separator)] = assignment.slice(separator + 1);
  }
  return environment;
}

function requireTarget(targets, rawName, command) {
  const name = String(rawName ?? '').trim().toLowerCase();
  if (!name) throw new Error(`[dev-targets] ${command} requires a target name`);
  const target = targets.find((entry) => entry.name === name);
  if (!target) throw new Error(`[dev-targets] target not found: ${name}`);
  return target;
}

function formatSyncStatus(target, status) {
  const detail = status.lastError || status.error;
  return `[dev-targets] ${target.name}\t${status.state}${detail ? `\t${detail}` : ''}`;
}

function exitCodeForCommandResult(result) {
  if (Number.isInteger(result?.code)) return result.code;
  if (result?.signal === 'SIGINT') return 130;
  if (result?.signal === 'SIGTERM') return 143;
  return 1;
}

function upgradePlacementConfig(config) {
  return upgradeDevTargetsConfigToVersion3(config);
}

function withTargets(config, targets) {
  const upgraded = upgradeDevTargetsConfigToVersion3(config);
  if (upgraded.commandExecution.mode !== 'auto') {
    return parseDevTargetsConfig({ ...upgraded, targets });
  }
  const oldNames = upgraded.targets.map((target) => target.name);
  const selected = new Set(upgraded.commandExecution.targets);
  const followedAllTargets = oldNames.every((name) => selected.has(name));
  const nextNames = targets.map((target) => target.name);
  const nextSelected = followedAllTargets
    ? nextNames
    : upgraded.commandExecution.targets.filter((name) => nextNames.includes(name));
  return parseDevTargetsConfig({
    ...upgraded,
    targets,
    commandExecution: nextSelected.length
      ? { ...upgraded.commandExecution, targets: nextSelected }
      : { mode: 'local' },
  });
}

function findPlacementReferences(config, targetName) {
  if (config.version !== 2 && config.version !== 3) return [];
  const references = [];
  for (const [surface, placement] of Object.entries(config.runtimePlacement)) {
    if (placement.target === targetName || placement.targets?.includes(targetName)) {
      references.push(surface);
    }
  }
  if (config.commandExecution.mode === 'prefer-target' && config.commandExecution.target === targetName) {
    references.push('commands');
  }
  return references;
}

function setPlacement(config, surface, destination, options = {}) {
  const upgraded = upgradePlacementConfig(config);
  const normalizedSurface = String(surface ?? '').trim().toLowerCase();
  const normalizedDestination = String(destination ?? '').trim().toLowerCase();
  if (!['server', 'expo', 'daemon', 'build', 'commands'].includes(normalizedSurface)) {
    throw new Error('[dev-targets] placement surface must be server, expo, daemon, build, or commands');
  }
  if (!normalizedDestination) {
    throw new Error('[dev-targets] placement destination must be local or a configured target name');
  }
  if (normalizedSurface === 'commands') {
    const placement = normalizedDestination === 'local'
      ? { mode: 'local' }
      : normalizedDestination === 'auto'
        ? {
            mode: 'auto',
            ...(options.targets ? { targets: options.targets } : {}),
            includeLocal: options.includeLocal === true,
            fallback: options.fallback ?? 'local',
            ...(options.loadProbeTtlMs != null
              ? { loadProbeTtlMs: options.loadProbeTtlMs }
              : {}),
            ...(options.unavailableProbeTtlMs != null
              ? { unavailableProbeTtlMs: options.unavailableProbeTtlMs }
              : {}),
          }
        : { mode: 'prefer-target', target: normalizedDestination, fallback: 'local' };
    return parseDevTargetsConfig({ ...upgraded, commandExecution: placement });
  }
  if (normalizedSurface === 'daemon' && normalizedDestination === 'local-and-targets') {
    if (!options.targets?.length) {
      throw new Error('[dev-targets] daemon local-and-targets placement requires --targets=NAME,...');
    }
    return parseDevTargetsConfig({
      ...upgraded,
      runtimePlacement: {
        ...upgraded.runtimePlacement,
        daemon: { mode: 'local-and-targets', targets: options.targets },
      },
    });
  }
  if (normalizedDestination === 'auto') {
    throw new Error('[dev-targets] automatic least-load placement is supported only for commands');
  }
  const placement = normalizedDestination === 'local'
    ? { mode: 'local' }
    : { mode: 'prefer-target', target: normalizedDestination, fallback: 'local' };
  return parseDevTargetsConfig({
    ...upgraded,
    runtimePlacement: {
      ...upgraded.runtimePlacement,
      [normalizedSurface]: placement,
    },
  });
}

function parseTargetNames(raw) {
  if (raw == null) return null;
  const names = String(raw).split(',').map((name) => name.trim().toLowerCase()).filter(Boolean);
  if (names.length === 0) throw new Error('[dev-targets] --targets requires a comma-separated target list');
  return [...new Set(names)];
}

function requireCapacityInteger(raw, option) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`[dev-targets] ${option} must be a positive integer`);
  }
  return value;
}

function setTargetCapacity(config, targetName, mode, kv) {
  const target = requireTarget(config.targets, targetName, 'capacity set');
  if (!target.managedRuntime) {
    throw new Error(`[dev-targets] target ${target.name} has no managed runtime`);
  }
  const normalizedMode = String(mode ?? '').trim().toLowerCase();
  if (normalizedMode !== 'shared' && normalizedMode !== 'dedicated') {
    throw new Error('[dev-targets] capacity mode must be shared or dedicated');
  }
  const previous = target.managedRuntime.capacity;
  const readPreset = (name) => {
    const cpuOption = `--${name}-cpus`;
    const memoryOption = `--${name}-memory-gib`;
    const previousPreset = previous?.[name];
    if (!previousPreset && (kv.get(cpuOption) == null || kv.get(memoryOption) == null)) {
      throw new Error(
        `[dev-targets] initial capacity configuration requires ${cpuOption} and ${memoryOption}`,
      );
    }
    return {
      cpus: kv.get(cpuOption) == null
        ? previousPreset.cpus
        : requireCapacityInteger(kv.get(cpuOption), cpuOption),
      memoryGiB: kv.get(memoryOption) == null
        ? previousPreset.memoryGiB
        : requireCapacityInteger(kv.get(memoryOption), memoryOption),
    };
  };
  const candidate = {
    ...target,
    managedRuntime: {
      ...target.managedRuntime,
      capacity: {
        mode: normalizedMode,
        shared: readPreset('shared'),
        dedicated: readPreset('dedicated'),
      },
    },
  };
  const nextConfig = withTargets(
    config,
    config.targets.map((entry) => entry.name === target.name ? candidate : entry),
  );
  return {
    config: nextConfig,
    target: nextConfig.targets.find((entry) => entry.name === target.name),
  };
}

async function writeConfig(path, config) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
  await writeNativeExecutionProjection({
    configPath: path,
    outputPath: join(dirname(path), 'dev-target-exec-v1.sh'),
    repoRoot: resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'),
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const { wrapperArgs, remoteCommandArgs } = splitCommandArguments(argv);
  const { flags, kv } = parseArgs(wrapperArgs);
  const json = wantsJson(wrapperArgs, { flags });
  const positionals = collectPositionals(wrapperArgs, kv);
  const command = String(positionals[0] ?? '').trim();
  const stackName =
    String(kv.get('--stack') ?? process.env.HAPPIER_STACK_STACK ?? 'main').trim() || 'main';
  const path = resolveDevTargetsConfigPath({ stackName, env: process.env });

  if (wantsHelp(wrapperArgs, { flags }) || !command) {
    printResult({
      json,
      data: { path, stackName },
      text: [
        '[dev-targets] usage:',
        '  hstack dev-targets path [--stack=NAME]',
        '  hstack dev-targets list [--stack=NAME]',
        '  hstack dev-targets show NAME [--stack=NAME]',
        '  hstack dev-targets doctor [NAME] [--stack=NAME]',
        '  hstack dev-targets status NAME [--stack=NAME]',
        '  hstack dev-targets capacity show NAME [--stack=NAME]',
        '  hstack dev-targets capacity set NAME shared|dedicated [--shared-cpus=N --shared-memory-gib=N --dedicated-cpus=N --dedicated-memory-gib=N] [--force] [--stack=NAME]',
        '  hstack dev-targets sync NAME [--stack=NAME]',
        '  hstack dev-targets sync-service start [--detached] [--stack=NAME]',
        '  hstack dev-targets sync-service status [--stack=NAME]',
        '  hstack dev-targets sync-service stop [--stack=NAME]',
        '  hstack dev-targets exec NAME|auto [--cwd=PATH] [--env=KEY=VALUE]... [--flush] [--tty] [--stack=NAME] -- COMMAND [ARG...]',
        '  hstack dev-targets placement show [--stack=NAME]',
        '  hstack dev-targets placement set server|expo|build local|TARGET [--stack=NAME]',
        '  hstack dev-targets placement set daemon local|TARGET|local-and-targets [--targets=NAME,...] [--stack=NAME]',
        '  hstack dev-targets placement set commands local|TARGET|auto [--targets=NAME,...] [--include-local] [--fallback=local|error] [--load-probe-ttl-ms=MS] [--unavailable-probe-ttl-ms=MS] [--stack=NAME]',
        '  hstack dev-targets placement clear --downgrade-v1 [--stack=NAME]',
        '  hstack dev-targets add NAME --host=HOST --user=USER [--managed-lima] [--lima-instance=NAME] [--lima-home=PATH] [--lima-profile=worker-balanced] [--repo-dir=PATH] [--cli-home-dir=PATH] [--stack=NAME]',
        '  hstack dev-targets add NAME --managed-lima --outer-target=NAME [--lima-instance=NAME] [--lima-home=PATH] [--lima-profile=worker-balanced] [--repo-dir=PATH] [--cli-home-dir=PATH] [--stack=NAME]',
        '  hstack dev-targets add NAME --platform=posix|windows --ssh=ALIAS --repo-dir=PATH --cli-home-dir=PATH [--ssh-config-file=PATH] [--lima-instance=NAME --lima-home=PATH --lima-profile=worker-balanced] [--remote-server-port=PORT] [--stack=NAME]',
        '  hstack dev-targets add NAME --managed-wsl --outer-ssh=ALIAS --outer-ssh-config-file=PATH --dedicated-cpus=N --dedicated-memory-gib=N [--wsl-instance=NAME] [--wsl-user=happier] [--shared-cpus=N --shared-memory-gib=N] [--stack=NAME]',
        '  hstack dev-targets remove NAME [--stack=NAME]',
        '',
        '  hstack dev-targets power no-sleep NAME|auto [--stack=NAME]',
        '',
        'Mutagen is intentionally user-installed and remains available as the normal `mutagen` CLI.',
      ].join('\n'),
    });
    return;
  }

  const loaded = await loadDevTargetsConfig({ stackName, env: process.env, allowMissing: true });
  if (command === 'path') {
    printResult({ json, data: { path, stackName }, text: path });
    return;
  }
  if (command === 'list') {
    printResult({
      json,
      data: { path, stackName, targets: loaded.config.targets },
      text: loaded.config.targets.length
        ? loaded.config.targets
            .map((target) => `${target.name}\t${target.platform}\t${target.ssh}:${target.repoDir}`)
            .join('\n')
        : '[dev-targets] no targets configured',
    });
    return;
  }
  if (command === 'show') {
    const name = String(positionals[1] ?? '').trim().toLowerCase();
    if (!name) throw new Error('[dev-targets] show requires a target name');
    const target = loaded.config.targets.find((entry) => entry.name === name);
    if (!target) throw new Error(`[dev-targets] target not found: ${name}`);
    printResult({
      json,
      data: { path, stackName, target },
      text: [
        `${target.name}\t${target.platform}`,
        `ssh\t${target.ssh}`,
        ...(target.sshConfigFile ? [`ssh config\t${target.sshConfigFile}`] : []),
        ...(target.limaInstance ? [`Lima\t${target.limaHome}:${target.limaInstance}`] : []),
        ...(target.managedRuntime
          ? [`managed ${target.managedRuntime.kind}\t${target.managedRuntime.host.kind}:${target.managedRuntime.instance}`]
          : []),
        `repo\t${target.repoDir}`,
        `CLI home\t${target.cliHomeDir}`,
        ...(target.remotePath?.length
          ? [`remote PATH\t${target.remotePath.join(target.platform === 'windows' ? ';' : ':')}`]
          : []),
        ...(target.remoteServerPort ? [`remote server port\t${target.remoteServerPort}`] : []),
      ].join('\n'),
    });
    return;
  }
  if (command === 'doctor') {
    const requestedName = String(positionals[1] ?? '').trim().toLowerCase();
    const targets = requestedName
      ? loaded.config.targets.filter((target) => target.name === requestedName)
      : loaded.config.targets;
    if (requestedName && targets.length === 0) {
      throw new Error(`[dev-targets] target not found: ${requestedName}`);
    }
    const diagnosis = await runDevTargetsDoctor({ targets, env: process.env });
    printResult({
      json,
      data: { path, stackName, ...diagnosis },
      text: [
        `[dev-targets] Mutagen\t${diagnosis.mutagen.ok ? 'ok' : 'failed'}`,
        ...diagnosis.targets.map(
          (target) => `[dev-targets] ${target.name}\t${target.ok ? 'ok' : 'failed'}`,
        ),
        ...(diagnosis.targets.length === 0 ? ['[dev-targets] no targets configured'] : []),
      ].join('\n'),
    });
    if (!diagnosis.ok) process.exitCode = 1;
    return;
  }
  if (command === 'status') {
    const target = requireTarget(loaded.config.targets, positionals[1], command);
    const [status, managedRuntime] = await Promise.all([
      inspectDevTargetSync({
        target,
        stackBaseDir: dirname(loaded.path),
        env: process.env,
      }),
      target.managedRuntime
        ? doctorManagedDevTargetRuntime({ target, env: process.env })
        : null,
    ]);
    printResult({
      json,
      data: {
        path,
        stackName,
        target,
        status,
        ...(managedRuntime ? { managedRuntime } : {}),
      },
      text: [
        formatSyncStatus(target, status),
        ...(managedRuntime
          ? [`[dev-targets] ${target.name} managed ${target.managedRuntime.kind}\t${managedRuntime.status}\t${managedRuntime.ok ? 'ok' : 'failed'}`]
          : []),
      ].join('\n'),
    });
    if (status.state !== 'ready' || managedRuntime?.ok === false) process.exitCode = 1;
    return;
  }
  if (command === 'capacity') {
    const action = String(positionals[1] ?? 'show').trim().toLowerCase();
    if (action === 'show') {
      const target = requireTarget(loaded.config.targets, positionals[2], 'capacity show');
      if (!target.managedRuntime) {
        throw new Error(`[dev-targets] target ${target.name} has no managed runtime`);
      }
      printResult({
        json,
        data: {
          path,
          stackName,
          target,
          capacity: target.managedRuntime.capacity ?? null,
        },
        text: target.managedRuntime.capacity
          ? JSON.stringify(target.managedRuntime.capacity, null, 2)
          : `[dev-targets] ${target.name} uses profile-owned capacity (${target.managedRuntime.profile})`,
      });
      return;
    }
    if (action === 'set') {
      const desired = setTargetCapacity(
        loaded.config,
        positionals[2],
        positionals[3],
        kv,
      );
      const force = flags.has('--force');
      if (force) await writeConfig(path, desired.config);
      const applied = await applyManagedDevTargetCapacity({
        target: desired.target,
        force,
        env: process.env,
      });
      if (!force) await writeConfig(path, desired.config);
      printResult({
        json,
        data: { path, stackName, target: desired.target, applied },
        text: [
          `[dev-targets] ${desired.target.name} capacity mode: ${desired.target.managedRuntime.capacity.mode}`,
          applied.changed
            ? '[dev-targets] managed worker reconciled and capacity applied'
            : '[dev-targets] managed worker already matched the selected capacity',
        ].join('\n'),
      });
      return;
    }
    throw new Error(`[dev-targets] unknown capacity action: ${action}`);
  }
  if (command === 'sync') {
    const target = requireTarget(loaded.config.targets, positionals[1], command);
    const sync = await syncDevTarget({
      target,
      stackBaseDir: dirname(loaded.path),
      env: process.env,
    });
    printResult({
      json,
      data: { path, stackName, target, sync },
      text: `[dev-targets] ${target.name}\tsynchronized`,
    });
    return;
  }
  if (command === 'sync-service') {
    const action = String(positionals[1] ?? 'status').trim().toLowerCase();
    const stackBaseDir = dirname(loaded.path);
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
    if (action === 'start') {
      if (json && !flags.has('--detached')) {
        throw new Error('[dev-targets] foreground sync monitoring streams logs and does not support --json; use --detached --json');
      }
      const result = await startDevTargetSyncService({
        stackBaseDir,
        sourceDir: repoRoot,
        targets: loaded.config.targets,
        detached: flags.has('--detached'),
        env: process.env,
      });
      const summary = result.statuses
        .map(({ target, status }) => `[dev-targets] ${target}\t${status.state}`)
        .join('\n');
      printResult({
        json,
        data: {
          path,
          stackName,
          detached: flags.has('--detached'),
          statuses: result.statuses,
        },
        text: [
          `[dev-targets] independent synchronization active for stack ${stackName}`,
          summary,
          ...(result.monitor ? ['[dev-targets] monitoring live Mutagen activity; Ctrl+C detaches without pausing synchronization'] : []),
        ].filter(Boolean).join('\n'),
      });
      if (result.monitor) {
        const completion = await waitForDevTargetSyncMonitor(result.monitor);
        process.exitCode = completion?.code ?? (completion?.signal === 'SIGINT' ? 130 : 1);
      }
      return;
    }
    if (action === 'status') {
      const result = await inspectDevTargetSyncService({
        stackBaseDir,
        targets: loaded.config.targets,
        env: process.env,
      });
      printResult({
        json,
        data: { path, stackName, ...result },
        text: [
          `[dev-targets] independent synchronization\t${result.independent ? 'active' : 'inactive'}`,
          `[dev-targets] synchronization readiness\t${result.state}`,
          `[dev-targets] startup preparation history\t${result.preparation?.state ?? 'unknown'}`,
          ...Object.entries(result.preparation?.targets ?? {}).map(([target, preparation]) => (
            `[dev-targets] ${target} startup preparation history\t${preparation.state}`
              + (preparation.error ? `\t${preparation.error}` : '')
          )),
          ...result.statuses.map(({ target, status }) => `[dev-targets] ${target}\t${status.state}`),
        ].join('\n'),
      });
      if (result.state !== 'ready') {
        process.exitCode = 1;
      }
      return;
    }
    if (action === 'stop') {
      const result = await stopDevTargetSyncService({ stackBaseDir, env: process.env });
      printResult({
        json,
        data: { path, stackName, ...result },
        text: result.released
          ? `[dev-targets] paused independent synchronization for stack ${stackName}; Stack lifecycle ownership restored`
          : `[dev-targets] independent synchronization is not active for stack ${stackName}`,
      });
      return;
    }
    throw new Error(`[dev-targets] unknown sync-service action: ${action}`);
  }
  if (command === 'exec') {
    if (json) {
      throw new Error('[dev-targets] exec streams command output and does not support wrapper --json; place child --json after --');
    }
    const requestedTarget = String(positionals[1] ?? '').trim().toLowerCase();
    if (!requestedTarget) throw new Error('[dev-targets] exec requires a target name or auto');
    if (remoteCommandArgs.length === 0) {
      throw new Error('[dev-targets] exec requires COMMAND [ARG...] (normally after --)');
    }
    let result;
    const target = requestedTarget === 'auto' ? null : requireTarget(loaded.config.targets, requestedTarget, command);
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
    if (!target || (process.platform !== 'win32' && target.platform !== 'windows')) {
      if (!target && (flags.has('--flush') || flags.has('--tty') || wrapperArgs.some((arg) => arg === '--env' || arg.startsWith('--env=')))) {
        throw new Error('[dev-targets] auto execution does not accept --flush, --tty, or --env; choose an exact target for those controls');
      }
      const launcher = resolve(repoRoot, 'apps', 'stack', 'bin', 'hstack-exec');
      const launcherArgs = target ? [
        `--target=${target.name}`,
        ...(flags.has('--tty') ? ['--tty'] : []),
        `--cwd=${kv.get('--cwd') ?? '.'}`,
        ...Object.entries(parseRemoteEnvironment(wrapperArgs)).map(([key, value]) => `--env=${key}=${value}`),
      ] : [];
      // The native owner performs the one mandatory synchronization barrier;
      // the legacy --flush spelling does not add a second flush here.
      const child = spawn(launcher, [...launcherArgs, '--', ...remoteCommandArgs], {
        cwd: target ? repoRoot : resolve(repoRoot, kv.get('--cwd') ?? '.'),
        env: { ...process.env, HAPPIER_EXEC_CONFIG_PATH: loaded.path },
        stdio: 'inherit',
      });
      // Forward parent-only termination to the native owner and wait for its
      // remote cancellation/barrier cleanup before this CLI exits.
      const signalListeners = new Map(['SIGINT', 'SIGTERM', 'SIGHUP'].map((signal) => [signal, () => child.kill(signal)]));
      for (const [signal, listener] of signalListeners) process.on(signal, listener);
      try {
        result = await new Promise((resolveResult) => {
          child.once('error', (error) => resolveResult({ code: 1, error }));
          child.once('exit', (code, signal) => resolveResult({ code, signal }));
        });
      } finally {
        for (const [signal, listener] of signalListeners) process.removeListener(signal, listener);
      }
    } else {
      // Windows origins and targets require the cross-platform SSH adapter;
      // POSIX-origin command routing uses the native execution owner above.
      result = await runDevTargetCommand({
        target,
        stackBaseDir: dirname(loaded.path),
        sourceDir: repoRoot,
        commandArgs: remoteCommandArgs,
        cwd: kv.get('--cwd') ?? '.',
        environment: parseRemoteEnvironment(wrapperArgs),
        ...(flags.has('--flush') ? { flush: true } : {}),
        tty: flags.has('--tty'),
        env: process.env,
      });
    }
    process.exitCode = exitCodeForCommandResult(result);
    return;
  }
  if (command === 'power') {
    if (positionals[1] !== 'no-sleep') throw new Error('[dev-targets] power requires no-sleep NAME|auto');
    const requested = positionals[2];
    const targets = requested === 'auto'
      ? (loaded.config.commandExecution?.targets ?? []).map((name) => requireTarget(loaded.config.targets, name, 'power'))
      : [requireTarget(loaded.config.targets, requested, 'power')];
    const results = await Promise.all(targets.map(configureWorkerPower));
    printResult({ json, data: { results }, text: results.map((entry) => `[dev-targets] ${entry.name} sleep: ${entry.results.every((result) => result.ok) ? 'disabled' : 'incomplete'}`).join('\n') });
    if (results.some((entry) => entry.results.some((result) => !result.ok))) process.exitCode = 1;
    return;
  }
  if (command === 'placement') {
    const action = String(positionals[1] ?? 'show').trim().toLowerCase();
    if (action === 'show') {
      printResult({
        json,
        data: { path, stackName, config: loaded.config },
        text: JSON.stringify(loaded.config, null, 2),
      });
      return;
    }
    if (action === 'set') {
      const config = setPlacement(loaded.config, positionals[2], positionals[3], {
        targets: parseTargetNames(kv.get('--targets')),
        includeLocal: flags.has('--include-local'),
        fallback: kv.get('--fallback'),
        loadProbeTtlMs: kv.get('--load-probe-ttl-ms'),
        unavailableProbeTtlMs: kv.get('--unavailable-probe-ttl-ms'),
      });
      if (positionals[2] === 'commands' && config.commandExecution?.mode === 'auto') {
        await Promise.all(config.commandExecution.targets.map((name) => configureWorkerPower(requireTarget(config.targets, name, 'placement'))));
      }
      await writeConfig(path, config);
      printResult({
        json,
        data: { path, stackName, config },
        text: `[dev-targets] updated placement for stack ${stackName}\n${JSON.stringify(config, null, 2)}`,
      });
      return;
    }
    if (action === 'clear') {
      if (!flags.has('--downgrade-v1')) {
        throw new Error('[dev-targets] placement clear requires --downgrade-v1');
      }
      const config = parseDevTargetsConfig({ version: 1, targets: loaded.config.targets });
      await writeConfig(path, config);
      printResult({
        json,
        data: { path, stackName, config },
        text: `[dev-targets] cleared placement and restored version 1 behavior for stack ${stackName}`,
      });
      return;
    }
    throw new Error(`[dev-targets] unknown placement action: ${action}`);
  }
  if (command === 'add') {
    const name = String(positionals[1] ?? '').trim();
    if (!name) throw new Error('[dev-targets] add requires a target name');
    const host = kv.get('--host');
    const outerTargetName = String(kv.get('--outer-target') ?? '').trim().toLowerCase();
    let candidate;
    if (flags.has('--managed-wsl')) {
      if (host || flags.has('--managed-lima') || kv.get('--ssh') || kv.get('--ssh-config-file')) {
        throw new Error('[dev-targets] managed WSL requires outer Windows SSH configuration without other provisioning modes');
      }
      if (outerTargetName && (kv.get('--outer-ssh') || kv.get('--outer-ssh-config-file'))) {
        throw new Error('[dev-targets] use either --outer-target or direct outer SSH configuration');
      }
      const outerTarget = outerTargetName
        ? loaded.config.targets.find((entry) => entry.name === outerTargetName)
        : { platform: 'windows', ssh: kv.get('--outer-ssh'), sshConfigFile: kv.get('--outer-ssh-config-file') };
      const cpus = requireCapacityInteger(kv.get('--dedicated-cpus'), '--dedicated-cpus');
      const memoryGiB = requireCapacityInteger(kv.get('--dedicated-memory-gib'), '--dedicated-memory-gib');
      candidate = await provisionManagedWslDevTarget({
        name: name.toLowerCase(), outerTarget, stackBaseDir: dirname(path),
        instance: kv.get('--wsl-instance') ?? `HappierWorker-${name.toLowerCase()}`,
        user: kv.get('--wsl-user') ?? 'happier',
        capacity: {
          mode: 'dedicated',
          shared: {
            cpus: requireCapacityInteger(kv.get('--shared-cpus') ?? cpus, '--shared-cpus'),
            memoryGiB: requireCapacityInteger(kv.get('--shared-memory-gib') ?? memoryGiB, '--shared-memory-gib'),
          },
          dedicated: { cpus, memoryGiB },
        },
        repoDir: kv.get('--repo-dir') ?? null, cliHomeDir: kv.get('--cli-home-dir') ?? null,
        env: process.env,
      });
    } else if (host || outerTargetName) {
      if (host && outerTargetName) {
        throw new Error('[dev-targets] --host and --outer-target are mutually exclusive');
      }
      if (kv.get('--ssh') || kv.get('--ssh-config-file')) {
        throw new Error('[dev-targets] managed provisioning cannot be combined with manual SSH flags');
      }
      const requestedPlatform = String(kv.get('--platform') ?? 'posix').trim().toLowerCase();
      if (requestedPlatform !== 'posix') {
        throw new Error('[dev-targets] one-command --host provisioning currently supports POSIX targets only');
      }
      if (flags.has('--managed-lima')) {
        const outerTarget = outerTargetName
          ? loaded.config.targets.find((target) => target.name === outerTargetName)
          : null;
        if (outerTargetName && !outerTarget) {
          throw new Error(`[dev-targets] outer target not found: ${outerTargetName}`);
        }
        if (outerTarget?.managedRuntime) {
          throw new Error('[dev-targets] --outer-target must name the outer Mac, not another managed guest');
        }
        const guestProvisionScriptSource = await readFile(
          new URL('./provision/linux-ubuntu-provision.sh', import.meta.url),
          'utf8',
        );
        const guestPressureScriptSource = await readFile(
          new URL('./provision/linux-guest-pressure.sh', import.meta.url),
          'utf8',
        );
        candidate = await provisionManagedLimaDevTarget({
          name,
          host,
          user: kv.get('--user'),
          outerTarget,
          stackBaseDir: dirname(path),
          instance: kv.get('--lima-instance') ?? `happier-worker-${String(name).toLowerCase()}`,
          profile: kv.get('--lima-profile') ?? 'worker-balanced',
          limaHome: kv.get('--lima-home') ?? null,
          repoDir: kv.get('--repo-dir') ?? null,
          cliHomeDir: kv.get('--cli-home-dir') ?? null,
          allowInstall: !flags.has('--no-install'),
          env: process.env,
        }, { guestProvisionScriptSource, guestPressureScriptSource });
      } else {
        if (outerTargetName) {
          throw new Error('[dev-targets] --outer-target requires --managed-lima');
        }
        if (kv.get('--lima-instance') || kv.get('--lima-home') || kv.get('--lima-profile')) {
          throw new Error('[dev-targets] Lima flags require --managed-lima when provisioning with --host');
        }
        candidate = await provisionPosixDevTarget({
          name,
          host,
          user: kv.get('--user'),
          stackBaseDir: dirname(path),
          repoDir: kv.get('--repo-dir') ?? null,
          cliHomeDir: kv.get('--cli-home-dir') ?? null,
          env: process.env,
        });
      }
      if (kv.get('--remote-server-port') != null) {
        candidate.remoteServerPort = kv.get('--remote-server-port');
      }
    } else {
      const limaInstance = kv.get('--lima-instance') ?? null;
      const limaHome = kv.get('--lima-home') ?? null;
      if (Boolean(limaInstance) !== Boolean(limaHome)) {
        throw new Error('[dev-targets] --lima-instance and --lima-home must be configured together');
      }
      candidate = {
        name,
        platform: kv.get('--platform'),
        ssh: kv.get('--ssh'),
        sshConfigFile: kv.get('--ssh-config-file') ?? null,
        ...(limaInstance
          ? {
              managedRuntime: {
                kind: 'lima',
                host: { kind: 'local' },
                instance: limaInstance,
                limaHome,
                profile: kv.get('--lima-profile') ?? 'worker-balanced',
              },
            }
          : {}),
        repoDir: kv.get('--repo-dir'),
        cliHomeDir: kv.get('--cli-home-dir'),
        remoteServerPort: kv.get('--remote-server-port') ?? null,
      };
    }
    const remaining = loaded.config.targets.filter(
      (target) => target.name.toLowerCase() !== name.toLowerCase(),
    );
    const config = withTargets(loaded.config, [...remaining, candidate]);
    await writeConfig(path, config);
    const target = config.targets.find((entry) => entry.name === name.toLowerCase());
    if (target.managedRuntime || host) await configureWorkerPower(target);
    printResult({
      json,
      data: { path, stackName, target },
      text: `[dev-targets] configured ${target.name} for stack ${stackName}\n[dev-targets] ${path}`,
    });
    return;
  }
  if (command === 'remove' || command === 'rm') {
    const name = String(positionals[1] ?? '').trim().toLowerCase();
    if (!name) throw new Error('[dev-targets] remove requires a target name');
    const targets = loaded.config.targets.filter((target) => target.name !== name);
    const removed = targets.length !== loaded.config.targets.length;
    const references = removed ? findPlacementReferences(loaded.config, name) : [];
    if (references.length) {
      throw new Error(
        `[dev-targets] target ${name} is referenced by placement: ${references.join(', ')}; set those surfaces to local first`,
      );
    }
    const config = withTargets(loaded.config, targets);
    await writeConfig(path, config);
    printResult({
      json,
      data: { path, stackName, removed, name, config },
      text: removed
        ? `[dev-targets] removed ${name} from stack ${stackName}`
        : `[dev-targets] target not found: ${name}`,
    });
    return;
  }
  throw new Error(`[dev-targets] unknown command: ${command}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
