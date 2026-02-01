export function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return String(s ?? '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}

export function padRight(s, n) {
  const str = String(s ?? '');
  if (str.length >= n) return str.slice(0, n);
  return str + ' '.repeat(n - str.length);
}

export function parsePrefixedLabel(line) {
  const m = String(line ?? '').match(/^\[([^\]]+)\]\s*/);
  return m ? m[1] : null;
}

