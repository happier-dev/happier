/** A failed native start has no child custody to retire. Keep its refusal while
 * attempting both resource cleanups; diagnostics never carry cleanup contents. */
export async function cleanupUnstartedLaunch(input: Readonly<{
  cleanupSpawnResources: () => void | Promise<void>;
  spawnLifecycleCallbacks: Readonly<{ cleanupPendingSessionAttach: () => void | Promise<void> }>;
  logDebug: (message: string, payload?: unknown) => void;
}>): Promise<void> {
  for (const [code, cleanup] of [
    ['spawn_resource_cleanup_failed', () => input.cleanupSpawnResources()],
    ['pending_session_attach_cleanup_failed', () => input.spawnLifecycleCallbacks.cleanupPendingSessionAttach()],
  ] as const) {
    try {
      await cleanup();
    } catch {
      input.logDebug('[DAEMON RUN] Unstarted launch cleanup failed', { code });
    }
  }
}
