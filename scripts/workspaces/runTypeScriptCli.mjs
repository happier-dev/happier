import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exitWithCommandResult, runCommand } from '../../apps/stack/scripts/utils/proc/proc.mjs';

import { prepareTypeScriptProjectBuildFromArgs } from './prepareTypeScriptProjectBuild.mjs';
import {
  resolveTypeScriptCliInvocation,
  shouldRouteTypeScriptCliThroughHstack,
} from './resolveTypeScriptCliInvocation.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..', '..');
const args = process.argv.slice(2);
// Automatic command placement is POSIX-only; Windows compilation stays local.
if (process.platform !== 'win32' && shouldRouteTypeScriptCliThroughHstack({ args, env: process.env })) {
  const launcher = resolve(repoRoot, 'apps', 'stack', 'bin', 'hstack-exec');
  const scriptFromWorkspace = relative(process.cwd(), fileURLToPath(import.meta.url));
  const routedResult = await runCommand(launcher, ['--', 'node', scriptFromWorkspace, ...args], {
    ownedProcessGroup: true,
    cwd: process.cwd(),
    stdio: 'inherit',
    env: process.env,
  });
  exitWithCommandResult(routedResult);
} else {
  const invocation = resolveTypeScriptCliInvocation({
    repoRoot,
    workspaceDir: process.cwd(),
    processExecPath: process.execPath,
  });
  const projects = [];
  const commonArgs = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if ((arg === '--project' || arg === '-p') && args[index + 1]) {
      projects.push(args[++index]);
    } else if (arg.startsWith('--project=')) {
      projects.push(arg.slice('--project='.length));
    } else {
      commonArgs.push(arg);
    }
  }
  // Separate programs bound live checker state without losing test diagnostics when source fails.
  const programs = projects.length > 1
    ? projects.map((project) => [...commonArgs, '--project', project])
    : [args];
  let result = { status: 0, signal: null };
  for (const programArgs of programs) {
    prepareTypeScriptProjectBuildFromArgs(programArgs, { cwd: process.cwd() });
    const current = await runCommand(invocation.command, [...invocation.argsPrefix, ...programArgs], {
      ownedProcessGroup: true,
      cwd: process.cwd(),
      stdio: 'inherit',
      env: process.env,
    });
    if (current.error || current.signal) {
      result = current;
      break;
    }
    if (current.status !== 0) result = current;
  }
  exitWithCommandResult(result);
}
