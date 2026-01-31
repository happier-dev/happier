function supportsAnsi() {
  if (!process.stdout.isTTY) return false;
  if (process.env.NO_COLOR) return false;
  if ((process.env.TERM ?? '').toLowerCase() === 'dumb') return false;
  return true;
}

function wrap(code, s) {
  return supportsAnsi() ? `\x1b[${code}m${s}\x1b[0m` : String(s);
}

export function ansiEnabled() {
  return supportsAnsi();
}

export function bold(s) {
  return wrap('1', s);
}

export function dim(s) {
  return wrap('2', s);
}

export function red(s) {
  return wrap('31', s);
}

export function green(s) {
  return wrap('32', s);
}

export function yellow(s) {
  return wrap('33', s);
}

export function blue(s) {
  return wrap('34', s);
}

export function magenta(s) {
  return wrap('35', s);
}

export function cyan(s) {
  return wrap('36', s);
}

