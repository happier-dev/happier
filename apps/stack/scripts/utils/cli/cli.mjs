export function wantsJson(argv, { flags = null } = {}) {
  if (flags?.has('--json')) {
    return true;
  }
  return argv.includes('--json');
}

export function wantsHelp(argv, { flags = null } = {}) {
  if (flags?.has('--help')) {
    return true;
  }
  return argv.includes('--help') || argv.includes('-h');
}

export function printResult({ json, data, text }) {
  if (json) {
    process.stdout.write(JSON.stringify(data ?? null, null, 2) + '\n');
    return;
  }
  if (text) {
    process.stdout.write(text.endsWith('\n') ? text : text + '\n');
  }
}

