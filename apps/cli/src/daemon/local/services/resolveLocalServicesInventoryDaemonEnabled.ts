import { resolveCliFeatureDecisionForServer } from '@/features/featureDecisionService';

/**
 * Resolve whether the daemon may run the local-service inventory scan for this server.
 *
 * `localServices.inventory` is server-represented (default-allow): mirrors the connected-service
 * quotas daemon gate. The server is the gate, so a server that sets the bit to `false` disables
 * inventory scanning for its users. With no server snapshot the decision is fail-closed
 * (unknown / probe_failed), so the daemon does not scan.
 */
export async function resolveLocalServicesInventoryDaemonEnabled(params: {
  env: NodeJS.ProcessEnv;
  serverUrl: string;
  timeoutMs?: number;
}): Promise<boolean> {
  const resolved = await resolveCliFeatureDecisionForServer({
    featureId: 'localServices.inventory',
    env: params.env,
    serverUrl: params.serverUrl,
    timeoutMs: params.timeoutMs,
  });

  return resolved.decision.state === 'enabled';
}
