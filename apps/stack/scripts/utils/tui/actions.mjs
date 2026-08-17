export function buildTuiAuthArgs({ happysBin, stackName, force = false } = {}) {
  const bin = String(happysBin ?? '').trim();
  const name = String(stackName ?? '').trim();
  if (!bin) throw new Error('buildTuiAuthArgs: happysBin is required');
  if (!name) throw new Error('buildTuiAuthArgs: stackName is required');
  return [bin, 'stack', 'auth', name, 'login', ...(force ? ['--force'] : [])];
}

export function buildTuiAuthExitNotice({ code, signal } = {}) {
  if (!signal && Number(code) === 0) return null;
  const status = signal ? `signal=${signal}` : `code=${code ?? 'unknown'}`;
  return `auth: failed (${status}); press a to retry or A to force re-authentication`;
}
