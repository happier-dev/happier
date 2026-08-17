import { spawn } from 'node:child_process';
import { join } from 'node:path';

import { parseArgs } from '../utils/cli/args.mjs';
import { applyStackActiveServerScopeEnv } from '../utils/auth/stable_scope_id.mjs';
import { resolveStackEnvPath } from '../utils/paths/paths.mjs';
import { parseCliIdentityOrThrow, resolveCliHomeDirForIdentity } from '../utils/stack/cli_identities.mjs';

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
    fn: async ({ env }) => {
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
        cwd: passthroughEntrypoint.cwd,
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
