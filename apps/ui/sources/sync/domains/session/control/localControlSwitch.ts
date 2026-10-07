import type { Session } from '@/sync/domains/state/storageTypes';
import type { CliAuthStatusData } from '@/sync/api/capabilities/capabilitiesProtocol';
import { getSessionLocalControlState, isSessionExclusiveLocalControl } from '@/sync/domains/session/control/sessionLocalControl';
import { getAgentCore, resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';
import { ConnectedServiceBindingsV2IngressSchema, readBuiltInLegacyConnectedAccountServiceKeyIngress } from '@happier-dev/protocol/connect/connected-service-bindings';
import type { ResolvedAgentCatalogEntry } from '@/agents/backendCatalog/agentCatalogProjection';
import { resolveProjectedConnectedAccountServiceKeys } from '@/sync/domains/connectedServices/qualifiedConnectedAccountServiceOptions';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';

type SessionControlAuthState = CliAuthStatusData['state'] | null | undefined;

export function shouldRequestRemoteControl(
    session: Session | null,
    authState?: SessionControlAuthState,
    agentCatalogEntry?: Pick<ResolvedAgentCatalogEntry, 'agentId' | 'qualifiedId' | 'connectedAccounts'> | null,
): boolean {
    if (!session || !isSessionExclusiveLocalControl(session)) return false;
    if (authState !== 'logged_out') return true;

    const metadata = readSessionOwnerMetadataView(session);
    const agentId = resolveAgentIdFromSessionMetadata(metadata);
    if (!agentId) return false;
    if (agentCatalogEntry && agentCatalogEntry.agentId !== agentId && agentCatalogEntry.qualifiedId !== agentId) return false;
    const supportedServices = agentCatalogEntry
        ? resolveProjectedConnectedAccountServiceKeys(agentCatalogEntry.connectedAccounts)
        : (getAgentCore(agentId)?.connectedServices?.supportedServiceIds ?? [])
            .map(readBuiltInLegacyConnectedAccountServiceKeyIngress)
            .filter((key) => key !== null);
    const bindings = ConnectedServiceBindingsV2IngressSchema.safeParse(metadata?.connectedServices);
    if (!bindings.success) return false;
    // Selected account or Team credentials are not proof of login. They only make the machine's
    // ambient login result unrelated; the runtime/provider still validates it.
    return supportedServices.some((key) => {
        const binding = bindings.data.bindingsByServiceId[key];
        return binding !== undefined && binding.source !== 'native';
    });
}

/** An explicit shared release detaches the runner-owned terminal, not model control. */
export function shouldOfferLocalControlRelease(
    session: Session | null,
    authState?: SessionControlAuthState,
    agentCatalogEntry?: Pick<ResolvedAgentCatalogEntry, 'agentId' | 'qualifiedId' | 'connectedAccounts'> | null,
): boolean {
    const localControl = getSessionLocalControlState(session);
    if (localControl?.topology === 'shared') return localControl.attached && localControl.canDetach;
    return shouldRequestRemoteControl(session, authState, agentCatalogEntry);
}

export function shouldRequestRemoteControlAfterPendingEnqueue(session: Session | null, authState?: SessionControlAuthState): boolean {
    void session;
    void authState;
    return false;
}

export function shouldRenderChatTimelineForSession(opts: {
    committedMessagesCount: number;
    pendingMessagesCount: number;
    controlledByUser: boolean;
    forceRenderFooter?: boolean;
}): boolean {
    return opts.committedMessagesCount > 0
        || opts.pendingMessagesCount > 0
        || opts.controlledByUser === true
        || opts.forceRenderFooter === true;
}
