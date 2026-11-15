import type { SessionForkPoint } from '@happier-dev/protocol/sessions/fork';

import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { openSessionAuthoringSeed } from '@/sync/ops/actions/openSessionAuthoringSeed';
import { interceptNewSessionEntry } from './newSessionEntry';

export type NewSessionSourceContextNavigation = Readonly<{
    pathname: '/new';
    params: Readonly<Record<string, string>>;
}>;

/**
 * Opens the canonical durable New Session draft with a source Session
 * attached as a continuation recipe.
 *
 * Configuration is written before navigation through the seed settlement.
 * Only the continuation recipe rides the incumbent one-shot channel, so the child starts on the source
 * Session's Agent, model, machine and folder with every one of them editable.
 */
export async function openNewSessionSourceContextNavigation(params: Readonly<{
    sourceSessionId: string;
    forkPoint: SessionForkPoint;
    serverId: string | null;
    accountLifetime?: ServerAccountScopeLifetime | null;
    /** Restored user text when the fork point is an editable user message. */
    restoredDraftText?: string | null;
    createDraftId?: () => string;
    navigateToNewSession: (route: NewSessionSourceContextNavigation) => void;
}>) {
    const lifetime = params.accountLifetime === undefined
        ? captureActiveServerAccountScopeLifetime()
        : params.accountLifetime;
    if (!lifetime || !lifetime.isCurrent()
        || !params.serverId || !areServerProfileIdentifiersEquivalent(lifetime.scope.serverId, params.serverId)) {
        return { kind: 'stale', reason: 'host_retired' } as const;
    }
    const serverId = params.serverId;
    return openSessionAuthoringSeed({
        sourceSession: { serverId, sessionId: params.sourceSessionId },
        replay: params.forkPoint,
        seed: params.restoredDraftText?.trim() ? { prompt: params.restoredDraftText } : {},
        accountLifetime: lifetime,
        scope: lifetime.scope, isCurrent: lifetime.isCurrent, createDraftId: params.createDraftId,
        navigateToNewSession: ({ draftId, dataId }) => {
            const href: NewSessionSourceContextNavigation = {
                pathname: '/new', params: {
                    draftId, draftServerId: lifetime.scope.serverId, draftAccountId: lifetime.scope.accountId,
                    ...(dataId ? { dataId } : {}), ...(serverId ? { spawnServerId: serverId } : {}),
                },
            };
            if (!interceptNewSessionEntry(href)) params.navigateToNewSession(href);
        },
    });
}
