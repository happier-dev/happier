function quoteShArg(raw) {
  const s = String(raw ?? '');
  if (s === '') return "''";
  // POSIX-safe single-quote escaping: ' -> '\''.
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function joinShCommand(argv) {
  const parts = (Array.isArray(argv) ? argv : []).map((a) => quoteShArg(a));
  return parts.join(' ');
}

export function buildScriptPtyArgs({ platform = process.platform, file = '/dev/null', command = [] } = {}) {
  const cmd = 'script';
  const f = String(file ?? '').trim() || '/dev/null';
  const argv = Array.isArray(command) ? command : [];

  // util-linux `script` (common on Linux) requires -c for commands; it does not accept
  // `script <file> <cmd> <args...>` like BSD `script` does.
  if (platform === 'linux') {
    return { cmd, args: ['-q', '-c', joinShCommand(argv), f] };
  }

  // BSD `script` (macOS) supports: script [-q] [file [command ...]]
  return { cmd, args: ['-q', f, ...argv] };
}

