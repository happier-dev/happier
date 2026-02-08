import { killProcessTree } from './proc.mjs';

function normalizeChildren(children) {
  if (!Array.isArray(children)) return [];
  return children.filter((c) => c && typeof c === 'object' && 'pid' in c && Number(c.pid) > 1);
}

export function installExitCleanup({ label = 'local', children } = {}) {
  const childrenRef = children;
  let cleaned = false;

  const cleanupSync = () => {
    if (cleaned) return;
    cleaned = true;
    const tracked = normalizeChildren(childrenRef);
    for (const child of tracked) {
      try {
        killProcessTree(child, 'SIGTERM');
      } catch {
        // Best-effort cleanup; keep going.
      }
    }
    // SIGKILL follows immediately as best-effort escalation.
    // For graceful shutdown (with time for handlers to run), callers should invoke cleanup manually.
    for (const child of tracked) {
      try {
        killProcessTree(child, 'SIGKILL');
      } catch {
        // Best-effort cleanup; keep going.
      }
    }
  };

  const fatalSync = (err) => {
    try {
      const msg = err instanceof Error ? err.stack || err.message : String(err);
      // eslint-disable-next-line no-console
      console.error(`[${label}] fatal: ${msg}`);
    } catch {
      // ignore
    }
    cleanupSync();
    try {
      process.exitCode = 1;
      // Ensure we actually terminate; some Node configs do not exit on unhandled rejections.
      process.exit(1);
    } catch {
      // ignore
    }
  };

  process.once('exit', cleanupSync);
  process.once('uncaughtException', fatalSync);
  process.once('unhandledRejection', fatalSync);

  return cleanupSync;
}
