import type { SessionForkPoint } from '@happier-dev/protocol';

import { buildNewSessionTempDataFromSessionConfiguration, buildNewSessionConfigurationDraft } from '@/components/sessions/authoring/draft/sessionConfigurationSeed';
import type { ExistingSessionAuthoringSnapshotSession } from '@/components/sessions/authoring/draft/sessionAuthoringDraftAdapters';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { seedAndOpenNewSession } from '../newSessionSeedComposer';

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
export function openNewSessionSourceContextNavigation(params: Readonly<{
    session: ExistingSessionAuthoringSnapshotSession;
    sourceSessionId: string;
    forkPoint: SessionForkPoint;
    serverId: string | null;
    machineId: string | null;
    /** Restored user text when the fork point is an editable user message. */
    restoredDraftText?: string | null;
    createDraftId?: () => string;
    navigateToNewSession: (route: NewSessionSourceContextNavigation) => void;
}>) {
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime) return { kind: 'stale', reason: 'host_retired' } as const;
    const seed = buildNewSessionTempDataFromSessionConfiguration({
        session: params.session,
        machineId: params.machineId,
    });
    const restoredDraftText = typeof params.restoredDraftText === 'string' && params.restoredDraftText.trim().length > 0
        ? params.restoredDraftText
        : null;
    const machineId = typeof seed.machineId === 'string' && seed.machineId.trim().length > 0
        ? seed.machineId.trim()
        : (params.machineId ?? '').trim();
    const directory = typeof seed.directory === 'string' ? seed.directory.trim() : '';
    const serverId = typeof params.serverId === 'string' ? params.serverId.trim() : '';

    return seedAndOpenNewSession({
        seed: { placement: machineId && serverId
            ? { kind: 'exactTarget', machineId, serverId, ...(directory ? { directory } : {}) }
            : { kind: 'currentTarget', ...(directory ? { directory } : {}) } },
        configurationDraft: buildNewSessionConfigurationDraft({ ...seed, ...(restoredDraftText ? { prompt: restoredDraftText } : {}) }),
        sourceContextHandoff: {
            sourceContext: { v: 1, kind: 'session_replay', sourceSessionId: params.sourceSessionId, forkPoint: params.forkPoint },
            sourceContextServerId: params.serverId,
        },
        scope: lifetime.scope, isCurrent: lifetime.isCurrent, createDraftId: params.createDraftId,
        navigateToNewSession: ({ draftId, dataId }) => params.navigateToNewSession({
            pathname: '/new', params: { draftId, ...(dataId ? { dataId } : {}), ...(serverId ? { spawnServerId: serverId } : {}) },
        }),
    });
}
