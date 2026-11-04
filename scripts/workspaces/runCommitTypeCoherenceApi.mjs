#!/usr/bin/env node
// The synchronous native API accepts an executable without an argument prefix.
// Keep its binary pipes intact while the existing admission owner runs it.
import { fileURLToPath } from 'node:url';
import { exitWithCommandResult, runCommand } from '../../apps/stack/scripts/utils/proc/proc.mjs';
import { resolveTypeScriptCliInvocation } from './resolveTypeScriptCliInvocation.mjs';

const compiler = resolveTypeScriptCliInvocation({ args: ['--api'], invocationKind: 'build' });
const launcher = fileURLToPath(new URL('../../apps/stack/bin/hstack-exec', import.meta.url));
const result = await runCommand(launcher, ['--heavyweight-admission', '--class=compilation',
  `--machine=${process.env.HAPPIER_DEV_TARGET_EXECUTION === '1' ? 'worker' : 'local'}`,
  '--exec-admitted', '--', compiler.apiExecutable, ...process.argv.slice(2)],
{ cwd: process.cwd(), env: process.env, stdio: 'inherit', ownedProcessGroup: true });
exitWithCommandResult(result);
