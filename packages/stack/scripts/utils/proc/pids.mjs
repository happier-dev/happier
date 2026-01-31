export function isPidAlive(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 1) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch {
    return false;
  }
}

