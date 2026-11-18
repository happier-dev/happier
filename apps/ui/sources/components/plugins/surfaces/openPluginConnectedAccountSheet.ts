import type { PluginUiOpenConnectedAccountsRequestV1 } from '@happier-dev/protocol/plugins/ui/client';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { captureServerProfileScopeResolver } from '@/sync/domains/server/serverProfiles';
import { presentConnectSheet } from '@/components/settings/connectedServices/setup/ConnectedServiceSetupModal';

/** The mounted surface forwards context; purpose setup owns declaration placement. */
export async function openPluginConnectedAccountSheet(input: Readonly<{
    request: PluginUiOpenConnectedAccountsRequestV1;
    scope: ServerAccountScope | null;
    machineId?: string | null;
    serverId?: string | null;
}>) {
    const { request, scope, machineId, serverId } = input;
    const result = await presentConnectSheet({
        scope, intent: 'link',
        ...(machineId && serverId ? { initialMachineTarget: {
            serverIdentityId: captureServerProfileScopeResolver()(serverId), machineId,
        } } : {}),
        ...('purpose' in request && request.purpose && scope ? {
            purpose: request.purpose,
            purposeSettlement: 'resourceDefault' as const,
            purposeRequest: { scope, purpose: request.purpose, ...(machineId ? { machineId } : {}) },
        } : {}),
        ...(request.service ? { service: request.service,
            ...(request.accountId ? { account: { service: request.service, accountId: request.accountId } } : {}) } : {}),
    });
    return result.kind === 'dismissed' ? { kind: result.kind } : { kind: result.kind, account: result.account };
}
