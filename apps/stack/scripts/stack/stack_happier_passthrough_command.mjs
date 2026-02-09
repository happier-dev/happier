import { spawn } from 'node:child_process';
import { join } from 'node:path';

import { parseArgs } from '../utils/cli/args.mjs';
import { applyStackActiveServerScopeEnv } from '../utils/auth/stable_scope_id.mjs';
import { resolveStackEnvPath } from '../utils/paths/paths.mjs';
import { parseCliIdentityOrThrow, resolveCliHomeDirForIdentity } from '../utils/stack/cli_identities.mjs';

import { withStackEnv } from './stack_environment.mjs';

export async function runStackHappierPassthroughCommand({ rootDir, stackName, passthrough }) {
  const sepIdx = passthrough.indexOf('--');
  const wrapperArgs = sepIdx === -1 ? passthrough : passthrough.slice(0, sepIdx);
  const forwardedArgsRaw = sepIdx === -1 ? passthrough : passthrough.slice(sepIdx + 1);

  const { kv } = parseArgs(wrapperArgs);
  const identityRaw = (kv.get('--identity') ?? '').toString().trim();
  const identity = identityRaw ? parseCliIdentityOrThrow(identityRaw) : null;

  const forwardedArgs =
    sepIdx === -1
      ? forwardedArgsRaw.filter((arg) => !(identity && typeof arg === 'string' && arg.trim().startsWith('--identity=')))
      : forwardedArgsRaw;

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

      const child = spawn(process.execPath, [join(rootDir, 'scripts', 'happier.mjs'), ...forwardedArgs], {
        cwd: rootDir,
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
