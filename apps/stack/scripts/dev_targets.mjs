import './utils/env/env.mjs';
import { spawnSync } from 'node:child_process';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseArgs } from './utils/cli/args.mjs';
import { printResult, wantsHelp, wantsJson } from './utils/cli/cli.mjs';
import {
  loadDevTargetsConfig,
  parseDevTargetsConfig,
  resolveDevTargetsConfigPath,
} from './utils/dev_targets/config.mjs';
import { runDevTargetsDoctor } from './utils/dev_targets/doctor.mjs';
import { provisionPosixDevTarget } from './utils/dev_targets/provision.mjs';
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
  if (config.version === 2) return config;
  return parseDevTargetsConfig({
    version: 2,
    targets: config.targets,
    runtimePlacement: {
      server: { mode: 'local' },
      expo: { mode: 'local' },
      daemon: config.targets.length
        ? { mode: 'local-and-targets', targets: config.targets.map((target) => target.name) }
        : { mode: 'local' },
    },
    commandExecution: config.targets.length ? { mode: 'auto' } : { mode: 'local' },
  });
}

function withTargets(config, targets) {
  if (config.version !== 2 || config.commandExecution.mode !== 'auto') {
    return parseDevTargetsConfig({ ...config, targets });
  }
  const oldNames = config.targets.map((target) => target.name);
  const selected = new Set(config.commandExecution.targets);
  const followedAllTargets = oldNames.every((name) => selected.has(name));
  const nextNames = targets.map((target) => target.name);
  const nextSelected = followedAllTargets
    ? nextNames
    : config.commandExecution.targets.filter((name) => nextNames.includes(name));
  return parseDevTargetsConfig({
    ...config,
    targets,
    commandExecution: nextSelected.length
      ? { ...config.commandExecution, targets: nextSelected }
      : { mode: 'local' },
  });
}

function findPlacementReferences(config, targetName) {
  if (config.version !== 2) return [];
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
  if (!['server', 'expo', 'daemon', 'commands'].includes(normalizedSurface)) {
    throw new Error('[dev-targets] placement surface must be server, expo, daemon, or commands');
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
        '  hstack dev-targets sync NAME [--stack=NAME]',
        '  hstack dev-targets sync-service start [--detached] [--stack=NAME]',
        '  hstack dev-targets sync-service status [--stack=NAME]',
        '  hstack dev-targets sync-service stop [--stack=NAME]',
        '  hstack dev-targets exec NAME|auto [--cwd=PATH] [--env=KEY=VALUE]... [--flush] [--tty] [--stack=NAME] -- COMMAND [ARG...]',
        '  hstack dev-targets placement show [--stack=NAME]',
        '  hstack dev-targets placement set server|expo|daemon local|TARGET [--stack=NAME]',
        '  hstack dev-targets placement set commands local|TARGET|auto [--targets=NAME,...] [--include-local] [--fallback=local|error] [--load-probe-ttl-ms=MS] [--unavailable-probe-ttl-ms=MS] [--stack=NAME]',
        '  hstack dev-targets placement clear --downgrade-v1 [--stack=NAME]',
        '  hstack dev-targets add NAME --host=HOST --user=USER [--repo-dir=PATH] [--cli-home-dir=PATH] [--stack=NAME]',
        '  hstack dev-targets add NAME --platform=posix|windows --ssh=ALIAS --repo-dir=PATH --cli-home-dir=PATH [--ssh-config-file=PATH] [--lima-instance=NAME --lima-home=PATH] [--remote-server-port=PORT] [--stack=NAME]',
        '  hstack dev-targets remove NAME [--stack=NAME]',
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
    const status = await inspectDevTargetSync({
      target,
      stackBaseDir: dirname(loaded.path),
      env: process.env,
    });
    printResult({
      json,
      data: { path, stackName, target, status },
      text: formatSyncStatus(target, status),
    });
    if (status.state !== 'ready') process.exitCode = 1;
    return;
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
          `[dev-targets] synchronization readiness\t${result.preparation?.state ?? 'unknown'}`,
          ...Object.entries(result.preparation?.targets ?? {}).map(([target, preparation]) => (
            `[dev-targets] ${target} synchronization\t${preparation.state}`
              + (preparation.error ? `\t${preparation.error}` : '')
          )),
          ...result.statuses.map(({ target, status }) => `[dev-targets] ${target}\t${status.state}`),
        ].join('\n'),
      });
      if (
        !result.independent
        || result.preparation?.state !== 'ready'
        || result.statuses.some(({ status }) => !['ready', 'synchronizing'].includes(status.state))
      ) {
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
    if (requestedTarget === 'auto') {
      const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
      const invokedCwd = resolve(repoRoot, kv.get('--cwd') ?? '.');
      if (flags.has('--flush') || flags.has('--tty') || wrapperArgs.some((arg) => arg === '--env' || arg.startsWith('--env='))) {
        throw new Error('[dev-targets] auto execution does not accept --flush, --tty, or --env; choose an exact target for those controls');
      }
      const launcher = resolve(repoRoot, 'apps', 'stack', 'bin', 'hstack-exec');
      const execution = spawnSync(launcher, ['--', ...remoteCommandArgs], {
        cwd: invokedCwd,
        env: { ...process.env, HAPPIER_EXEC_CONFIG_PATH: loaded.path },
        stdio: 'inherit',
      });
      result = { code: execution.status, signal: execution.signal, error: execution.error };
    } else {
      const target = requireTarget(loaded.config.targets, requestedTarget, command);
      result = await runDevTargetCommand({
        target,
        stackBaseDir: dirname(loaded.path),
        commandArgs: remoteCommandArgs,
        cwd: kv.get('--cwd') ?? '.',
        environment: parseRemoteEnvironment(wrapperArgs),
        flush: flags.has('--flush'),
        tty: flags.has('--tty'),
        env: process.env,
      });
    }
    process.exitCode = exitCodeForCommandResult(result);
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
    let candidate;
    if (host) {
      if (kv.get('--ssh') || kv.get('--ssh-config-file') || kv.get('--lima-instance') || kv.get('--lima-home')) {
        throw new Error('[dev-targets] --host provisioning cannot be combined with manual SSH or Lima flags');
      }
      const requestedPlatform = String(kv.get('--platform') ?? 'posix').trim().toLowerCase();
      if (requestedPlatform !== 'posix') {
        throw new Error('[dev-targets] one-command --host provisioning currently supports POSIX targets only');
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
      if (kv.get('--remote-server-port') != null) {
        candidate.remoteServerPort = kv.get('--remote-server-port');
      }
    } else {
      candidate = {
        name,
        platform: kv.get('--platform'),
        ssh: kv.get('--ssh'),
        sshConfigFile: kv.get('--ssh-config-file') ?? null,
        limaInstance: kv.get('--lima-instance') ?? null,
        limaHome: kv.get('--lima-home') ?? null,
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
