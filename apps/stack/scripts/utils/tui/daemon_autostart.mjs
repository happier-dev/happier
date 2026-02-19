export function shouldAttemptTuiDaemonAutostart({
  stackName,
  isStartLike,
  startDaemon,
  internalServerUrl,
  authed,
  daemonPid,
  inProgress,
  lastAttemptAtMs,
  nowMs,
  minIntervalMs = 12_000,
} = {}) {
  const name = String(stackName ?? '').trim();
  if (!name) return false;
  if (!isStartLike) return false;
  if (!startDaemon) return false;
  const url = String(internalServerUrl ?? '').trim();
  if (!url) return false;
  if (!authed) return false;
  const pid = Number(daemonPid);
  const daemonRunning = Number.isFinite(pid) && pid > 1;
  if (daemonRunning) return false;
  if (inProgress) return false;

  const now = Number(nowMs);
  const last = Number(lastAttemptAtMs);
  const min = Number(minIntervalMs);
  if (Number.isFinite(now) && Number.isFinite(last) && Number.isFinite(min) && min > 0) {
    if (last > 0 && now - last < min) return false;
  }

  return true;
}

