import './utils/env/env.mjs';
import { normalizeStackNameFirstArgs, stackNameFromArg } from './stack/command_arguments.mjs';
import { getRootDir } from './utils/paths/paths.mjs';
import { stackExistsSync } from './utils/stack/stacks.mjs';

const rawArgv = process.argv.slice(2);
const argv = normalizeStackNameFirstArgs(rawArgv[0] === '--' ? rawArgv.slice(1) : rawArgv,
  { stackExists: stackExistsSync });
const separatorIndex = argv.indexOf('--');
const helpScopeArgv = separatorIndex === -1 ? argv : argv.slice(0, separatorIndex);
const command = helpScopeArgv.find((arg) => arg && !arg.startsWith('-'));
const positionals = helpScopeArgv.filter(arg => arg && !arg.startsWith('-'));
const stackName = stackNameFromArg(positionals, 1);

if ((command === 'happier' || command === 'bug-report') && stackName
  && !helpScopeArgv.includes('--help') && !helpScopeArgv.includes('-h')) {
  // CLI dispatch consumes the selected runtime. Loading every management and
  // lifecycle owner here needlessly prepares their source graph on each call.
  const { runStackHappierPassthroughCommand } = await import('./stack/stack_happier_passthrough_command.mjs');
  let passthrough = argv.slice(2);
  if (command === 'bug-report') {
    const raw = passthrough[0] === '--' ? passthrough.slice(1) : passthrough;
    const separator = raw.indexOf('--');
    passthrough = separator === -1 ? ['bug-report', ...raw]
      : [...raw.slice(0, separator), '--', 'bug-report', ...raw.slice(separator + 1)];
  }
  try {
    await runStackHappierPassthroughCommand({ rootDir: getRootDir(import.meta.url), stackName, passthrough });
  } catch (error) {
    const { reportStackCommandFailure } = await import('./stack/command_failure.mjs');
    reportStackCommandFailure(error);
  }
} else if (command === 'list' && !helpScopeArgv.includes('--help') && !helpScopeArgv.includes('-h')) {
  const { listAllStackNames } = await import('./utils/stack/stacks.mjs');
  const names = (await listAllStackNames()).filter((name) => name !== 'main');
  if (helpScopeArgv.includes('--json')) {
    process.stdout.write(`${JSON.stringify({ stacks: names }, null, 2)}\n`);
  } else if (names.length) {
    process.stdout.write(`[stack] stacks:\n${names.map((name) => `- ${name}`).join('\n')}\n`);
  } else {
    process.stdout.write('[stack] no stacks found\n');
  }
} else {
  await import('./stack_commands.mjs');
}
