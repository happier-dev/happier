/**
 * What a session host held for a Session about to be created (New Session intent) does before that
 * Session arrives: load the runner code the Session's command runs (catalog command, launch
 * preparation and runtime plan), then read the Agent catalog once. The Session's
 * first readers (coding prompt plan, request coverage, follow facts) read that same process-wide
 * built-in registry before its Agent starts, so it is built here, in the person's think time,
 * rather than on the first word. A host with no hold builds it on first read, as before.
 */
export async function preloadSessionRunner(): Promise<void> {
  const [{ readAgentCatalogSnapshot }] = await Promise.all([
    import('@/agent/catalog/snapshot'),
    import('@/agent/catalog/registry'),
    import('@/cli/providerSessionArgPartition'),
    import('@/session/creation/resolveSessionCreationAgentTarget'),
    import('@/cli/runBackendSessionCliCommand'),
    import('@/agent/runtime/bridges/session/SessionHostBridge'),
    import('@/agent/runtime/session/loop/plan'),
  ]);
  readAgentCatalogSnapshot();
}
