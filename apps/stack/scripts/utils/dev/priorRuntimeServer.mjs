import { inspectActiveRuntimeSnapshot } from '../../runtime/launch/inspectActiveRuntimeSnapshot.mjs';
import { resolveServerRuntimeLaunchSpec } from '../../runtime/launch/resolveServerRuntimeLaunchSpec.mjs';

export function shouldPreflightDevRestart({
  startServer = false,
  priorRuntimeServer = null,
  admitPriorBuildsImmediately = false,
} = {}) {
  // Source-output admission is validated by startDevServer, which rebuilds only when its retained
  // outputs are missing or invalid. The outer wrapper must not recreate that freshness gate.
  return Boolean(startServer && priorRuntimeServer?.admitted !== true && !admitPriorBuildsImmediately);
}

export async function resolveDevPriorRuntimeServer(
  { stackBaseDir, serverComponentName } = {},
  { inspectActiveRuntimeSnapshotImpl = inspectActiveRuntimeSnapshot } = {},
) {
  // The light server is self-contained and can safely boot against its retained SQLite data
  // with migration replay disabled. The full server still requires its source-owned managed
  // infrastructure preparation, so it must not use this fast bootstrap path yet.
  if (serverComponentName !== 'happier-server-light') {
    return {
      admitted: false,
      reason: 'unsupported_server_component',
      detail: null,
    };
  }

  const inspection = await inspectActiveRuntimeSnapshotImpl({ stackBaseDir });
  if (!inspection?.snapshot) {
    return {
      admitted: false,
      reason: inspection?.missing === true ? 'missing_snapshot' : 'invalid_snapshot',
      detail: String(inspection?.errors?.[0] ?? '').trim() || null,
    };
  }

  try {
    const launchSpec = resolveServerRuntimeLaunchSpec({
      serverComponent: serverComponentName,
      dbProvider: 'sqlite',
      snapshot: inspection.snapshot,
      migrationsEnabled: false,
    });
    return {
      admitted: true,
      snapshotId: inspection.snapshot.snapshotId ?? null,
      sourceFingerprint: inspection.snapshot.sourceFingerprint ?? null,
      launchSpec,
    };
  } catch (error) {
    return {
      admitted: false,
      reason: error?.code === 'ERUNTIMESERVERCOMPONENTMISMATCH'
        ? 'server_component_mismatch'
        : 'invalid_server_launch',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
