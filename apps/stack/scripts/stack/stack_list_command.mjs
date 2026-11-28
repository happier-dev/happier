export function resolveStackListArguments(argv) {
  const separatorIndex = argv.indexOf('--');
  const flags = separatorIndex < 0 ? argv : argv.slice(0, separatorIndex);
  if (flags.find(arg => arg && !arg.startsWith('-')) !== 'list'
      || flags.includes('--help') || flags.includes('-h')) return null;
  return { json: flags.includes('--json') };
}

export async function runStackListCommand({ json }) {
  await import('../utils/env/env.mjs');
  const { listAllStackNames } = await import('../utils/stack/stacks.mjs');
  const names = (await listAllStackNames()).filter(name => name !== 'main');
  if (json) {
    process.stdout.write(`${JSON.stringify({ stacks: names }, null, 2)}\n`);
  } else if (names.length) {
    process.stdout.write(`[stack] stacks:\n${names.map(name => `- ${name}`).join('\n')}\n`);
  } else {
    process.stdout.write('[stack] no stacks found\n');
  }
}
