export function buildTuiAuthArgs({ happysBin, stackName, force = false } = {}) {
  const bin = String(happysBin ?? '').trim();
  const name = String(stackName ?? '').trim();
  if (!bin) throw new Error('buildTuiAuthArgs: happysBin is required');
  if (!name) throw new Error('buildTuiAuthArgs: stackName is required');
  return [bin, 'stack', 'auth', name, 'login', ...(force ? ['--force'] : [])];
}

export function buildTuiDaemonStartArgs({ happysBin, stackName } = {}) {
  const bin = String(happysBin ?? '').trim();
  const name = String(stackName ?? '').trim();
  if (!bin) throw new Error('buildTuiDaemonStartArgs: happysBin is required');
  if (!name) throw new Error('buildTuiDaemonStartArgs: stackName is required');
  return [bin, 'stack', 'daemon', name, 'start'];
}

export function shouldHoldAfterAuthExit({ code, signal } = {}) {
  // Success should return immediately to the TUI. Failures should hold so users can read the error output.
  if (signal) return true;
  return Number(code) !== 0;
}

