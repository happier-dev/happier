export function observePidLiveness(pid, { killImpl = process.kill } = {}) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 1) return { status: 'dead', reason: 'invalid_pid' };
  try {
    killImpl(n, 0);
    return { status: 'alive', reason: 'signal_probe' };
  } catch (error) {
    if (error?.code === 'ESRCH') return { status: 'dead', reason: 'not_found' };
    if (error?.code === 'EPERM') return { status: 'alive', reason: 'permission_denied_but_present' };
    return { status: 'inconclusive', reason: error?.code ?? 'liveness_probe_failed', error };
  }
}

export function isPidAlive(pid) {
  return observePidLiveness(pid).status === 'alive';
}
