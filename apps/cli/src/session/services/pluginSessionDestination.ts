import type { SessionSummary } from '@happier-dev/plugin-sdk/sessions';
import { ActionSessionAddressV1Schema } from '@happier-dev/protocol/actions/sessionTargetV1';
import { isLoopbackHostname } from '@happier-dev/protocol/server/urls/loopbackHostname';
import { readServerIdentityIdFromFeaturesSnapshot, type CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';

/** The verified Home identity is also used by host operations without a device route. */
export function projectPluginSessionPlacement(input: Readonly<{
  sessionId: string;
  serverUrl?: string;
  serverFeaturesSnapshot?: CliServerFeaturesSnapshot;
}>): Pick<SessionSummary, 'serverId' | 'address'> {
  const address = ActionSessionAddressV1Schema.safeParse({ sessionId: input.sessionId,
    serverId: readServerIdentityIdFromFeaturesSnapshot(input.serverFeaturesSnapshot) });
  if (!address.success) return {};
  const home = { serverId: address.data.serverId };
  if (!input.serverUrl) return home;
  try {
    const url = new URL(input.serverUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:' || url.username || url.password
      || url.search || url.hash || isLoopbackHostname(url.hostname) || url.hostname === '0.0.0.0') return home;
    return { ...home, address: { ...address.data, serverUrl: url.toString().replace(/\/+$/, '') } };
  } catch { return home; }
}
/** Project the routable device address for notification and navigation callers. */
export function readPluginSessionDestination(input: Parameters<typeof projectPluginSessionPlacement>[0]): SessionSummary['address'] | null {
  return projectPluginSessionPlacement(input).address ?? null;

}
