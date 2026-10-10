import { spawn } from 'node:child_process';
import { join } from 'node:path';

import { parseArgs } from '../utils/cli/args.mjs';
import { getInvokedCwd } from '../utils/cli/cwd_scope.mjs';
import { applyStackActiveServerScopeEnv } from '../utils/auth/stable_scope_id.mjs';
import { resolveStackEnvPath } from '../utils/paths/paths.mjs';
import { parseCliIdentityOrThrow, resolveCliHomeDirForIdentity } from '../utils/stack/cli_identities.mjs';
import { loadDevTargetsConfig } from '../utils/dev_targets/config.mjs';
import { buildRemoteStackHappierCommand, buildSshWorkerArgs } from '../utils/dev_targets/remote_commands.mjs';
import { resolveDevTargetSshConfigFile } from '../utils/dev_targets/mutagen_runtime.mjs';
import { resolveStackRuntimeMode } from '../runtime/shared/runtime_mode.mjs';

import { withStackEnv } from './stack_environment.mjs';
import { ensureStackDaemonPreflight, requiresStackDaemonPreflight } from './stack_happier_daemon_preflight.mjs';
import { resolveStackHappierPassthroughEntrypoint } from './stack_happier_passthrough_entrypoint.mjs';

export { resolveStackHappierPassthroughEntrypoint } from './stack_happier_passthrough_entrypoint.mjs';

function stripIdentityWrapperArgs(args) {
  const stripped = [];

  for (let idx = 0; idx < args.length; idx += 1) {
    const arg = String(args[idx] ?? '');
    if (!arg) continue;
    if (arg === '--identity') {
      idx += 1;
      continue;
    }
    if (arg.startsWith('--identity=')) {
      continue;
    }
    stripped.push(arg);
  }

  return stripped;
}

function readIdentityWrapperArg(args) {
  for (let idx = 0; idx < args.length; idx += 1) {
    const arg = String(args[idx] ?? '');
    if (!arg) continue;
    if (arg === '--identity') {
      const next = String(args[idx + 1] ?? '').trim();
      return next ? next : null;
    }
    if (arg.startsWith('--identity=')) {
      const value = arg.slice('--identity='.length).trim();
      return value ? value : null;
    }
  }

  return null;
}

export function resolveStackHappierPassthroughInvocation({ passthrough = [] } = {}) {
  const sepIdx = passthrough.indexOf('--');
  const wrapperArgs = sepIdx === -1 ? passthrough : passthrough.slice(0, sepIdx);
  const forwardedArgsRaw = sepIdx === -1 ? passthrough : passthrough.slice(sepIdx + 1);
  const { kv } = parseArgs(wrapperArgs);
  const inlineIdentity = (kv.get('--identity') ?? '').toString().trim();
  const identityRaw = inlineIdentity || readIdentityWrapperArg(wrapperArgs) || '';
  const identity = identityRaw ? parseCliIdentityOrThrow(identityRaw) : null;

  const childArgs = sepIdx === -1 ? stripIdentityWrapperArgs(forwardedArgsRaw) : [...stripIdentityWrapperArgs(wrapperArgs), ...forwardedArgsRaw];

  return {
    identity,
    childArgs,
  };
}

export async function runStackHappierPassthroughCommand({ rootDir, stackName, passthrough }) {
  const { identity, childArgs } = resolveStackHappierPassthroughInvocation({ passthrough });

  await withStackEnv({
    stackName,
    fn: async ({ env, runtimeState }) => {
      if (env.HAPPIER_DEV_TARGET_EXECUTION !== '1') {
        const { config } = await loadDevTargetsConfig({ stackName, env });
        // Observed placement wins over the configured preference: lifecycle
        // may have selected a local fallback before this generation started.
        const daemonPlacement = runtimeState?.placement?.daemon
          ?? (config.runtimePlacement?.daemon?.mode === 'prefer-target' ? config.runtimePlacement.daemon.target : 'local');
        if (!['local', 'disabled'].includes(daemonPlacement)) {
          const target = config.targets.find(candidate => candidate.name === daemonPlacement);
          if (!target) throw new Error(`[stack happier] daemon target ${daemonPlacement} is not configured for ${stackName}.`);
          const mode = resolveStackRuntimeMode({ env, activeRuntimeState: runtimeState }).mode;
          const runtimeMode = runtimeState?.remoteTargets?.[daemonPlacement]?.runtimeMode
            ?? (mode === 'source-snapshot' ? mode : mode === 'require' ? 'controlled' : 'source');
          const remoteCommand = buildRemoteStackHappierCommand(target, { stackName, runtimeMode, passthrough });
          const sshConfigFile = resolveDevTargetSshConfigFile(target, { stackBaseDir: resolveStackEnvPath(stackName).baseDir, env });
          const child = spawn('ssh', buildSshWorkerArgs(target, {
            remoteCommand, tty: Boolean(process.stdin.isTTY && process.stdout.isTTY),
            sshArgs: sshConfigFile ? ['-F', sshConfigFile] : [],
          }), { env, stdio: 'inherit', shell: false });
          const exitCode = await new Promise(resolvePromise => {
            child.on('error', error => { console.error(`[stack happier] ${error.message}`); resolvePromise(1); });
            child.on('exit', code => resolvePromise(code ?? 1));
          });
          process.exit(exitCode);
        }
      }
      const baseCliHomeDir = (env.HAPPIER_STACK_CLI_HOME_DIR ?? join(resolveStackEnvPath(stackName).baseDir, 'cli')).toString();
      const cliHomeDirForIdentity = identity
        ? resolveCliHomeDirForIdentity({ cliHomeDir: baseCliHomeDir, identity })
        : baseCliHomeDir;

      let envForHappy = identity
        ? {
            ...env,
            HAPPIER_STACK_CLI_IDENTITY: identity,
            HAPPIER_HOME_DIR: cliHomeDirForIdentity,
            HAPPIER_STACK_CLI_HOME_DIR: cliHomeDirForIdentity,
          }
        : env;

      envForHappy = applyStackActiveServerScopeEnv({
        env: envForHappy,
        stackName,
        cliIdentity: identity || (envForHappy.HAPPIER_STACK_CLI_IDENTITY ?? '').toString().trim() || 'default',
      });

      const passthroughEntrypoint = resolveStackHappierPassthroughEntrypoint({ rootDir, env: envForHappy });
      if (passthroughEntrypoint.source !== 'stack-repo-wrapper' && requiresStackDaemonPreflight(childArgs)) {
        await ensureStackDaemonPreflight({
          rootDir,
          stackName,
          env,
          argv: passthrough,
          cliIdentity: identity || 'default',
        });
      }

      const child = spawn(process.execPath, [passthroughEntrypoint.entrypoint, ...childArgs], {
        // The entrypoint is absolute, so its package/runtime resolution does
        // not require changing the CLI's working directory. Preserve the
        // caller scope already captured by hstack: relative author paths and
        // every other CLI filesystem argument belong to that scope.
        cwd: getInvokedCwd(envForHappy),
        env: envForHappy,
        stdio: 'inherit',
        shell: false,
      });

      const exitCode = await new Promise((resolvePromise) => {
        child.on('error', () => resolvePromise(1));
        child.on('exit', (code) => resolvePromise(code ?? 1));
      });

      process.exit(exitCode);
    },
  });
}
