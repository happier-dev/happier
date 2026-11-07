import { ActionSessionAddressV1Schema } from '@happier-dev/protocol/actions/sessionTargetV1';
import { isLoopbackHostname } from '@happier-dev/protocol/server/urls/loopbackHostname';
import { readServerIdentityIdFromFeaturesSnapshot, type CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';

/** A device route uses the captured public Home URL, never its local transport. */
export function readPluginSessionDestination(input: Readonly<{
  sessionId: string;
  serverUrl?: string;
  serverFeaturesSnapshot?: CliServerFeaturesSnapshot;
}>): Readonly<{ sessionId: string; serverId: string; serverUrl: string }> | null {
  const address = ActionSessionAddressV1Schema.safeParse({ sessionId: input.sessionId,
    serverId: readServerIdentityIdFromFeaturesSnapshot(input.serverFeaturesSnapshot) });
  if (!address.success || !input.serverUrl) return null;
  try {
    const url = new URL(input.serverUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:' || url.username || url.password
      || url.search || url.hash || isLoopbackHostname(url.hostname) || url.hostname === '0.0.0.0') return null;
    return { ...address.data, serverUrl: url.toString().replace(/\/+$/, '') };
  } catch { return null; }
}
