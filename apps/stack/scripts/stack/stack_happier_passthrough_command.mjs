import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join, posix, win32 } from 'node:path';

import { parseArgs } from '../utils/cli/args.mjs';
import { getInvokedCwd } from '../utils/cli/cwd_scope.mjs';
import { applyStackActiveServerScopeEnv } from '../utils/auth/stable_scope_id.mjs';
import { resolveStackCredentialPaths } from '../utils/auth/credentials_paths.mjs';
import { resolveStackEnvPath } from '../utils/paths/paths.mjs';
import { resolveStackServerEndpoint } from '../utils/server/urls.mjs';
import { parseCliIdentityOrThrow, resolveCliHomeDirForIdentity } from '../utils/stack/cli_identities.mjs';
import { buildRemoteInstallCredentialCommand, buildRemoteStackHappierCommand, resolveRemoteStackStatePaths, usesRetainedRemoteStackState } from '../utils/dev_targets/remote_commands.mjs';

import { withStackEnv } from './stack_environment.mjs';
import { ensureStackDaemonPreflight, requiresStackDaemonPreflight } from './stack_happier_daemon_preflight.mjs';
import { readPrefixServerSelection, resolveStackHappierCliHome, resolveStackHappierPassthroughEntrypoint, splitHstackHappierWrapperArgs } from './stack_happier_passthrough_entrypoint.mjs';
import { resolveRemoteStackAuthPlacement, runRemoteStackCommand, runRemoteStackOperation } from './remote_stack_operation.mjs';

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
  const { forwardedArgv } = splitHstackHappierWrapperArgs(childArgs);
  // Ephemeral startup projects the default identity from the controller.
  // Retained runtimes and named identities own their auth on the target.
  // Route the auth family as a whole, not a copy of the CLI's writer registry.
  const { commandArgv, hasExplicitSelection, isAuthCommand } = readPrefixServerSelection(forwardedArgv);
  const isLogout = commandArgv[0] === 'logout' || (commandArgv[0] === 'auth' && commandArgv[1] === 'logout');
  const isStackLogout = isLogout && (forwardedArgv.includes('--all')
    || !hasExplicitSelection);

  await withStackEnv({
    stackName,
    // CLI dispatch reads the runtime selected by startup. Session creation's
    // existing daemon preflight owns any needed lifecycle reconciliation.
    reconcileDaemonRuntimeState: false,
    includeRuntimeRelay: true,
    fn: async ({ env, runtimeState }) => {
      const cliIdentity = identity || String(env.HAPPIER_STACK_CLI_IDENTITY ?? '').trim() || 'default';
      const usesControllerAuth = isAuthCommand && cliIdentity === 'default';
      const remotePlacement = await resolveRemoteStackAuthPlacement({ stackName, env, runtimeState, argv: passthrough });
      const runRemoteCommand = (target, remoteCommand) => runRemoteStackCommand({ target, stackName, remoteCommand, env });
      if (remotePlacement && (!usesControllerAuth || usesRetainedRemoteStackState(remotePlacement.runtimeMode))) {
        const { target, runtimeMode } = remotePlacement;
        process.exit(await runRemoteCommand(target, buildRemoteStackHappierCommand(target, { stackName, runtimeMode, passthrough })));
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

      const controllerHome = isStackLogout && remotePlacement
        ? resolveStackHappierCliHome({ env: envForHappy,
          stackBaseDir: resolveStackEnvPath(stackName, envForHappy).baseDir }).cliHomeDir
        : null;
      const controllerAuthPaths = controllerHome ? resolveStackCredentialPaths({ cliHomeDir: controllerHome,
        serverUrl: (await resolveStackServerEndpoint({ stackName, env: envForHappy, runtimeState })).internalServerUrl,
        env: envForHappy }) : null;
      const hadAuthBeforeLogout = controllerAuthPaths !== null && existsSync(controllerAuthPaths.serverScopedPath);
      const hadControllerHome = controllerHome !== null && existsSync(controllerHome);

      const passthroughEntrypoint = resolveStackHappierPassthroughEntrypoint({ rootDir, env: envForHappy });
      if (passthroughEntrypoint.source !== 'stack-repo-wrapper' && requiresStackDaemonPreflight(childArgs)) {
        await ensureStackDaemonPreflight({
          rootDir,
          stackName,
          env,
          argv: passthrough,
          childArgs,
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

      let exitCode = await new Promise((resolvePromise) => {
        child.on('error', () => resolvePromise(1));
        child.on('exit', (code) => resolvePromise(code ?? 1));
      });

      // CLI confirmation owns the decision. Observe its scoped-file deletion
      // (or whole-home deletion for --all), never success plus prior absence.
      // Clear every startup alias before transport or daemon-stop can fail.
      const completedLogout = controllerAuthPaths !== null && (
        (hadAuthBeforeLogout && !existsSync(controllerAuthPaths.serverScopedPath))
        || (forwardedArgv.includes('--all') && hadControllerHome && !existsSync(controllerHome))
      );
      if (isStackLogout && remotePlacement && completedLogout) {
        for (const path of new Set([...controllerAuthPaths.paths, controllerAuthPaths.legacyPath])) rmSync(path, { force: true });
        const { target, runtimeMode } = remotePlacement;
        const clearAll = forwardedArgv.includes('--all');
        const paths = resolveRemoteStackStatePaths(target, { stackName, runtimeMode });
        const pathApi = target.platform === 'windows' ? win32 : posix;
        const code = await runRemoteCommand(target, buildRemoteInstallCredentialCommand(target, {
          stagedPath: null,
          finalPath: pathApi.join(paths.cliHomeDir, 'servers', paths.activeServerId, 'access.key'),
          clearAll,
        }));
        if (code !== 0) exitCode = code;
        await runRemoteStackOperation({ rootDir, stackName, placed: remotePlacement,
          operation: clearAll ? 'happier' : 'daemon',
          passthrough: clearAll
            ? [`--identity=${cliIdentity}`, '--', 'daemon', 'stop', '--all']
            : ['stop', `--identity=${cliIdentity}`],
          env });
      }

      process.exit(exitCode);
    },
  });
}
