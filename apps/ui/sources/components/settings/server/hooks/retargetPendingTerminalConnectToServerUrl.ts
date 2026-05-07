import { getPendingTerminalConnect, setPendingTerminalConnect } from '@/sync/domains/pending/pendingTerminalConnect';
import { canonicalizeServerUrl, createServerUrlComparableKey } from '@/sync/domains/server/url/serverUrlCanonical';

export function retargetPendingTerminalConnectToServerUrl(serverUrl: string): void {
    const targetServerUrl = canonicalizeServerUrl(serverUrl);
    if (!targetServerUrl) return;

    const pending = getPendingTerminalConnect();
    if (!pending) return;

    const pendingKey = createServerUrlComparableKey(pending.serverUrl);
    const targetKey = createServerUrlComparableKey(targetServerUrl);
    if (pendingKey && targetKey && pendingKey === targetKey) return;

    setPendingTerminalConnect({
        publicKeyB64Url: pending.publicKeyB64Url,
        serverUrl: targetServerUrl,
    });
}
