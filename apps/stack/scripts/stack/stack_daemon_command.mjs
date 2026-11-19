import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { findExistingStackCredentialPath } from '../utils/auth/credentials_paths.mjs';
import { parseArgs } from '../utils/cli/args.mjs';
import { printResult, wantsHelp } from '../utils/cli/cli.mjs';
import { isTty, promptSelect, withRl } from '../utils/cli/wizard.mjs';
import { checkDaemonState, daemonStatusSummary, startLocalDaemonWithAuth, stopLocalDaemon } from '../daemon.mjs';
import { getComponentDir, getRepoDir, resolveStackBaseDir, resolveStackEnvPath } from '../utils/paths/paths.mjs';
import { redactFailureDiagnostic, run } from '../utils/proc/proc.mjs';
import { resolveServerUrls } from '../utils/server/urls.mjs';
import { parseCliIdentityOrThrow, resolveCliHomeDirForIdentity } from '../utils/stack/cli_identities.mjs';
import { recordStackRuntimeDaemonDesiredState, syncStackRuntimeDaemonPidFromDaemonState } from '../utils/stack/runtime_daemon_state.mjs';
import { withStackDaemonLifecycleLock } from '../utils/stack/daemon_lifecycle_lock.mjs';
import { withStackEnv } from './stack_environment.mjs';
import { banner, cmd as cmdFmt, sectionTitle } from '../utils/ui/layout.mjs';
import { cyan, green } from '../utils/ui/ansi.mjs';
import { resolveStackRuntimeLaunchContext } from '../runtime/launch/resolveStackRuntimeLaunchContext.mjs';
import {
  applyCliRuntimeLaunchProvenanceEnv,
  resolveCliRuntimeLaunchProvenance,
  resolveCliRuntimeLaunchSpec,
} from '../runtime/launch/resolveCliRuntimeLaunchSpec.mjs';
import { hasExplicitStackRuntimeModeArg } from '../runtime/shared/runtime_mode.mjs';
import { applyStackActiveServerScopeEnv } from '../utils/auth/stable_scope_id.mjs';
import { loadDevTargetsConfig } from '../utils/dev_targets/config.mjs';
import { resolveObservedDevTargetService } from '../utils/dev_targets/service_placement.mjs';
import { runRemoteStackOperation } from './remote_stack_operation.mjs';
import { readSelectedSourceRuntimeRecord } from '../runtime/shared/source_bundle_record.mjs';

export async function resolveStackDaemonCommandContext({
  rootDir,
  stackName,
  env,
  identity,
  argv = [],
  activeRuntimeState = null,
}) {
  const preparesDaemonLaunch = argv.includes('start') || argv.includes('restart');
  // A revision-tree daemon is its Stack's revision (with the tree's own native
  // support, e.g. the Iroh addon): a restart relaunches it.
  // Selecting a capture here would swap in the producer's bundle of another
  // revision; moving the Stack to another revision is a reload (`--rev`).
  const relaunchesSelectedTree = preparesDaemonLaunch && Boolean((await readSelectedSourceRuntimeRecord({
    stackBaseDir: resolveStackBaseDir(stackName, env).baseDir, component: 'daemon', required: false }))?.sourceTree);
  const preparesSourceReplacement = preparesDaemonLaunch && !relaunchesSelectedTree;
  const runtimeLaunchContext = await resolveStackRuntimeLaunchContext({ argv, env, activeRuntimeState,
    purpose: argv.includes('stop') ? 'stop' : preparesSourceReplacement ? 'restart' : 'cli' });
  let sourceRuntimeLaunchUpdate = null;
  if (runtimeLaunchContext.runtimeMode.mode === 'source-snapshot' && preparesSourceReplacement) {
    const { buildSourceRuntimeBundle } = await import('../build/build_source_runtime.mjs');
    const built = await buildSourceRuntimeBundle({ repoDir: getRepoDir(rootDir, env),
      stackBaseDir: runtimeLaunchContext.stackBaseDir, component: 'daemon', env,
      sourceCapturedAfter: parseArgs(argv).kv.get('--source-after') });
    sourceRuntimeLaunchUpdate = { launch: { entrypoint: built.entrypoint, cliDir: built.cliDir, env: built.env ?? {} }, identity: built.identity };
    runtimeLaunchContext.cliLaunchSpec = await resolveCliRuntimeLaunchSpec({ sourceRuntimeLaunch: sourceRuntimeLaunchUpdate.launch });
  }
  const runtimeSnapshot = runtimeLaunchContext.snapshot;
  const cliLaunchSpec = runtimeLaunchContext.cliLaunchSpec
    ?? (runtimeSnapshot ? await resolveCliRuntimeLaunchSpec({ snapshot: runtimeSnapshot }) : null);
  if (relaunchesSelectedTree && cliLaunchSpec?.sourceSnapshot === true) {
    // Carry the selected tree launch to the existing Session-preserving restart owner.
    sourceRuntimeLaunchUpdate = {
      launch: { entrypoint: cliLaunchSpec.entrypoint, cliDir: cliLaunchSpec.cliDir, env: cliLaunchSpec.env },
      identity: activeRuntimeState?.sourceRuntimeIdentities?.daemon?.selected,
    };
  }
  const cliDir = cliLaunchSpec?.cliDir ?? getComponentDir(rootDir, 'happier-cli', env);
  const cliBin = join(cliDir, 'bin', 'happier.mjs');
  const cliEntrypoint = cliLaunchSpec?.entrypoint ?? '';
  const cliNodeEntrypoint = cliLaunchSpec?.nodeEntrypoint ?? '';
  const cliCommand = cliLaunchSpec?.command ?? '';
  const cliCommandArgs = cliLaunchSpec?.args ?? [];
  const runtimeProvenance = resolveCliRuntimeLaunchProvenance(cliLaunchSpec);
  const baseCliHomeDir = (env.HAPPIER_STACK_CLI_HOME_DIR ?? join(resolveStackEnvPath(stackName).baseDir, 'cli')).toString();
  const cliHomeDir = resolveCliHomeDirForIdentity({ cliHomeDir: baseCliHomeDir, identity });

  const runtimePath = (env.HAPPIER_STACK_RUNTIME_STATE_PATH ?? '').toString().trim();
  const urls = await resolveServerUrls({ env, allowEnable: false });
  const internalServerUrl = urls.internalServerUrl;
  const publicServerUrl = urls.publicServerUrl;
  const envForIdentity = applyCliRuntimeLaunchProvenanceEnv({
    cliLaunchSpec,
    env: {
      ...env,
      HAPPIER_STACK_CLI_IDENTITY: identity,
      ...(identity !== 'default'
        ? {
            HAPPIER_STACK_MIGRATE_CREDENTIALS: '0',
            HAPPIER_STACK_AUTO_AUTH_SEED: '0',
          }
        : {}),
    },
  });
  const scopedEnvForIdentity = applyStackActiveServerScopeEnv({
    env: envForIdentity,
    stackName,
    cliIdentity: identity,
  });

  await mkdir(cliHomeDir, { recursive: true }).catch(() => {});

  return {
    cliBin,
    cliEntrypoint,
    cliNodeEntrypoint,
    cliCommand,
    cliCommandArgs,
    runtimeProvenance,
    cliHomeDir,
    runtimePath,
    internalServerUrl,
    publicServerUrl,
    envForIdentity,
    scopedEnvForIdentity,
    sourceRuntimeLaunchUpdate,
  };
}

async function startStackDaemonIdentity({ context, stackName, identity, restart = false,
  refreshSelectedSource = false, forRetirement = false }) {
  const { cliBin, cliEntrypoint, cliNodeEntrypoint, cliCommand, cliCommandArgs, cliHomeDir,
    internalServerUrl, publicServerUrl, runtimePath, envForIdentity, runtimeProvenance,
    sourceRuntimeLaunchUpdate } = context;
  if (!refreshSelectedSource) {
    await recordStackRuntimeDaemonDesiredState(runtimePath, 'running', { cliIdentity: identity });
  }
  return await startLocalDaemonWithAuth({
    cliBin,
    cliEntrypoint,
    cliNodeEntrypoint,
    cliCommand,
    cliCommandArgs,
    cliHomeDir,
    internalServerUrl,
    publicServerUrl,
    runtimeStatePath: runtimePath,
    isShuttingDown: () => false,
    forceRestart: !forRetirement && (restart || Boolean(sourceRuntimeLaunchUpdate)),
    includeStatus: !forRetirement,
    env: envForIdentity,
    stackName,
    cliIdentity: identity,
    ...runtimeProvenance,
    sourceRuntimeLaunchUpdate,
    preserveSessionsOnRestart: !forRetirement && Boolean(sourceRuntimeLaunchUpdate),
    refreshSelectedSource,
    ...(forRetirement ? { ensureRunningOnly: true, allowSignInRequired: true, progressToStderr: true } : {}),
  });
}

export async function runStackDaemonCommand({ rootDir, stackName, argv, json, emitResult = true, env = {} }) {
  const { flags, kv } = parseArgs(argv);
  const wantsHelpFlag = wantsHelp(argv, { flags });

  const positionals = argv.filter((a) => a && a !== '--' && !a.startsWith('--'));
  const action = (positionals[0] ?? 'status').toString().trim();
  const identity = parseCliIdentityOrThrow((kv.get('--identity') ?? '').trim());
  const noOpen = flags.has('--no-open') || flags.has('--no-browser') || flags.has('--no-browser-open');
  const refreshSelectedSource = flags.has('--if-source-stale');
  const retire = flags.has('--retire');

  if (wantsHelpFlag || !action || action === 'help') {
    printResult({
      json,
      data: { ok: true, stackName, commands: ['start', 'stop', 'restart', 'status'], flags: ['--identity=<name>', '--runtime=source', '--retire'] },
      text: [
        banner('stack daemon', { subtitle: `Manage the happier-cli daemon for stack ${cyan(stackName || 'main')}.` }),
        '',
        sectionTitle('usage:'),
        `  ${cyan('hstack stack daemon')} <name> status [--identity=<name>] [--json]`,
        `  ${cyan('hstack stack daemon')} <name> start [--identity=<name>] [--json]`,
        `  ${cyan('hstack stack daemon')} <name> stop [--identity=<name>] [--retire] [--json]`,
        '  --retire ends hosted Sessions before shutdown and requires a named identity.',
        `  ${cyan('hstack stack daemon')} <name> restart [--runtime=source] [--identity=<name>] [--json]`,
        '  Commands follow the observed daemon host. Source start and restart build current daemon/plugin source and preserve Session runners without restarting the server or UI.',
        '',
        sectionTitle('example:'),
        `  ${cmdFmt(`hstack stack daemon ${stackName || 'main'} restart`)}`,
        `  ${cmdFmt(`hstack stack daemon ${stackName || 'main'} start --identity=account-b`)}`,
      ].join('\n'),
    });
    return;
  }

  if (!['start', 'stop', 'restart', 'status'].includes(action)) {
    printResult({
      json,
      data: { ok: false, error: 'invalid_daemon_subcommand', stackName, action },
      text: [
        `[stack] invalid daemon subcommand: ${action}`,
        '',
        'usage:',
        '  hstack stack daemon <name> start|stop|restart|status [--json]',
      ].join('\n'),
    });
    process.exit(1);
  }

  const retirementError = retire && (action !== 'stop' ? 'retire_requires_stop'
    : identity === 'default' && 'retire_requires_named_identity');
  const res = retirementError
    ? { ok: false, retired: false, error: retirementError, action, cliIdentity: identity }
    : await withStackEnv({
    stackName,
    includeRuntimeRelay: true,
    extraEnv: {
      ...env,
      ...(action === 'status' && !hasExplicitStackRuntimeModeArg(argv)
        ? { HAPPIER_STACK_RUNTIME_MODE: 'source' }
        : {}),
    },
    fn: async ({ env, runtimeState }) => {
      if (env.HAPPIER_DEV_TARGET_EXECUTION !== '1') {
        const { config } = await loadDevTargetsConfig({ stackName, env });
        const placed = resolveObservedDevTargetService({ config, runtimeState, service: 'daemon' });
        if (placed) {
          const exitCode = await runRemoteStackOperation({ rootDir, stackName, placed, operation: 'daemon',
            passthrough: argv, env, relayResult: retire });
          return { delegated: true, exitCode };
        }
      }
      const resolveContext = commandArgv => resolveStackDaemonCommandContext({
        rootDir, stackName, env, identity, argv: commandArgv, activeRuntimeState: runtimeState,
      });
      const context = await resolveContext(argv);
      const {
        cliBin,
        cliEntrypoint,
        cliNodeEntrypoint,
        cliCommand,
        cliCommandArgs,
        cliHomeDir,
        runtimePath,
        internalServerUrl,
        publicServerUrl,
        envForIdentity,
        scopedEnvForIdentity,
      } = context;

      if (retire) {
        const { retireDaemonIdentity } = await import('./retire_daemon_identity.mjs');
        const outcome = await retireDaemonIdentity({
          cliHomeDir, internalServerUrl, stackName, env: envForIdentity, identity, runtimePath,
          startIdentity: async () => {
            try {
              const startContext = await resolveContext(['start', ...argv.filter(arg => arg !== 'stop' && arg !== '--retire')]);
              const started = await startStackDaemonIdentity({ context: startContext, stackName, identity,
                forRetirement: true });
              return started?.ok === false
                ? { ok: false, error: 'daemon_start_failed', reason: redactFailureDiagnostic(started.reason, env) }
                : { ok: true };
            } catch (error) {
              return { ok: false, error: 'daemon_start_failed',
                reason: error?.code ?? redactFailureDiagnostic(error?.message, env) };
            }
          },
        });
        return { action, cliIdentity: identity, cliHomeDir, ...outcome };
      }

      if (action === 'start' || action === 'restart') {
        // UX: if this identity is not authenticated yet and we're in a real TTY, offer to run the
        // guided login flow inline (instead of failing or asking for a second terminal).
        //
        // Important: never prompt in --json mode (automation must not hang).
        const hasCreds = Boolean(findExistingStackCredentialPath({
          cliHomeDir,
          serverUrl: internalServerUrl,
          env: scopedEnvForIdentity,
        }));

        if (!hasCreds) {
          if (json) {
            const loginCmd = `hstack stack auth ${stackName} login${identity !== 'default' ? ` --identity=${identity} --no-open` : ''}`;
            return { ok: false, action, error: 'auth_required', cliIdentity: identity, cliHomeDir, loginCmd };
          }

          if (isTty()) {
            const choice = await withRl(async (rl) => {
              return await promptSelect(rl, {
                title:
                  `Daemon identity "${identity}" is not authenticated yet.\n` +
                  `Authenticate now? (recommended)\n`,
                options: [
                  { label: 'yes (run guided login now)', value: 'yes' },
                  { label: 'no (show command and exit)', value: 'no' },
                ],
                defaultIndex: 0,
              });
            });

            if (choice === 'yes') {
              const authArgs = [
                'login',
                ...(identity !== 'default' ? [`--identity=${identity}`] : []),
                ...(identity !== 'default' || noOpen ? ['--no-open'] : []),
              ];
              await run(process.execPath, [join(rootDir, 'scripts', 'auth.mjs'), ...authArgs], {
                cwd: rootDir,
                env: scopedEnvForIdentity,
                stdio: 'inherit',
              });
            } else {
              const loginCmd = `hstack stack auth ${stackName} login${identity !== 'default' ? ` --identity=${identity} --no-open` : ''}`;
              throw new Error(`[stack] daemon auth required. Run:\n${loginCmd}`);
            }
          }
        }

        const startResult = await startStackDaemonIdentity({ context, stackName, identity,
          restart: action === 'restart', refreshSelectedSource });
        if (startResult?.ok === false) {
          return {
            ok: false,
            action,
            error: 'daemon_start_failed',
            reason: startResult.reason || startResult.startOutput || startResult.excerpt || `Failed to start daemon (exit=${startResult.exitCode ?? 'unknown'})`,
            cliIdentity: identity,
            cliHomeDir,
          };
        }

        return { ok: true, action, cliIdentity: identity, cliHomeDir, status: startResult.status?.trim() ?? '',
          ...(startResult?.started === false ? { started: false, reason: startResult.reason } : {}) };
      }

      if (action === 'stop') {
        // Publish desire before retirement. Join the existing launch lock so a
        // start already in flight cannot outlive a completed explicit stop.
        await recordStackRuntimeDaemonDesiredState(runtimePath, 'stopped', { cliIdentity: identity });
        await withStackDaemonLifecycleLock({ cliHomeDir, internalServerUrl, stackName }, () => stopLocalDaemon({
          cliBin,
          cliEntrypoint,
          cliNodeEntrypoint,
          cliCommand,
          cliCommandArgs,
          internalServerUrl,
          publicServerUrl,
          cliHomeDir,
          runtimeStatePath: runtimePath,
          env: envForIdentity,
          stackName,
          cliIdentity: identity,
        }));
        const status = await daemonStatusSummary({
          cliBin,
          cliEntrypoint,
          cliNodeEntrypoint,
          cliCommand,
          cliCommandArgs,
          cliHomeDir,
          internalServerUrl,
          publicServerUrl,
          env: envForIdentity,
          stackName,
          cliIdentity: identity,
        }).catch(() => '');
        return { ok: true, action, cliIdentity: identity, cliHomeDir, status: status.trim() || null };
      }

      const status = await daemonStatusSummary({
        cliBin,
        cliEntrypoint,
        cliNodeEntrypoint,
        cliCommand,
        cliCommandArgs,
        cliHomeDir,
        internalServerUrl,
        publicServerUrl,
        env: envForIdentity,
        stackName,
        cliIdentity: identity,
      });

      // Best-effort: when someone runs `status`, persist the observed PID so the TUI can show
      // "running" even if the daemon was started outside of stack orchestration.
      await syncStackRuntimeDaemonPidFromDaemonState(
        {
          runtimeStatePath: runtimePath,
          cliHomeDir,
          internalServerUrl,
          env: envForIdentity,
        },
        { checkDaemonStateImpl: checkDaemonState },
      ).catch(() => {});

      return { ok: true, action, cliIdentity: identity, cliHomeDir, status: status.trim() };
    },
  });

  if (res?.delegated) {
    if (res.exitCode) process.exitCode = res.exitCode;
    return;
  }

  if (res?.ok === false && emitResult) process.exitCode = 1;

  if (!emitResult) return res;

  if (json && emitResult) {
    printResult({ json, data: { stackName, ...res } });
    return;
  }

  const sessionLines = (res?.sessionResults ?? []).map(({ sessionId, result }) =>
    `  ${sessionId}: ${result.status}${result.reason ? ` (${result.reason})` : ''}`);
  if (res?.retired === false) {
    const detail = res.reason ? `: ${res.reason}` : res.httpStatus ? ` (HTTP ${res.httpStatus})` : '';
    console.error([`[stack] Retirement incomplete (${res.error})${detail}`, ...sessionLines].join('\n'));
    return;
  }

  if (res?.ok === false) {
    console.error(`[stack] ${res.reason || res.error}${res.loginCmd ? `\nRun: ${res.loginCmd}` : ''}`);
    return;
  }

  if (res?.status) {
    console.log('');
    console.log(sectionTitle('Daemon'));
    console.log([res.status, ...sessionLines].join('\n'));
    return;
  }

  console.log(`${green('✓')} daemon command completed`);
}
