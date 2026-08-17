import type { SessionForkPoint } from '@happier-dev/protocol';

import { buildNewSessionTempDataFromSessionConfiguration } from '@/components/sessions/authoring/draft/sessionConfigurationSeed';
import type { ExistingSessionAuthoringSnapshotSession } from '@/components/sessions/authoring/draft/sessionAuthoringDraftAdapters';
import { storeTempData } from '@/utils/sessions/tempDataStore';

export type NewSessionSourceContextNavigation = Readonly<{
    pathname: '/new';
    params: Readonly<Record<string, string>>;
}>;

/**
 * Builds the route to the canonical New Session screen with a source Session
 * attached as a continuation recipe.
 *
 * The rich payload rides the existing one-shot `NewSessionData`/`dataId` channel
 * — there is no second navigation-state channel — and the configuration seed
 * comes from the existing "same setup" owner, so the child starts on the source
 * Session's Agent, model, machine and folder with every one of them editable.
 */
export function buildNewSessionSourceContextNavigation(params: Readonly<{
    session: ExistingSessionAuthoringSnapshotSession;
    sourceSessionId: string;
    forkPoint: SessionForkPoint;
    serverId: string | null;
    machineId: string | null;
    /** Restored user text when the fork point is an editable user message. */
    restoredDraftText?: string | null;
    /** Display-only quotation of the message at the cutoff. */
    sourcePreview?: string | null;
}>): NewSessionSourceContextNavigation {
    const seed = buildNewSessionTempDataFromSessionConfiguration({
        session: params.session,
        machineId: params.machineId,
    });
    const restoredDraftText = typeof params.restoredDraftText === 'string' && params.restoredDraftText.trim().length > 0
        ? params.restoredDraftText
        : null;
    const sourcePreview = typeof params.sourcePreview === 'string' && params.sourcePreview.trim().length > 0
        ? params.sourcePreview
        : null;

    const dataId = storeTempData({
        ...seed,
        ...(restoredDraftText ? { prompt: restoredDraftText } : {}),
        sourceContext: {
            v: 1,
            kind: 'session_replay',
            sourceSessionId: params.sourceSessionId,
            forkPoint: params.forkPoint,
        },
        ...(sourcePreview ? { sourceContextPreview: sourcePreview } : {}),
        sourceContextServerId: params.serverId,
    });

    const machineId = typeof seed.machineId === 'string' && seed.machineId.trim().length > 0
        ? seed.machineId.trim()
        : (params.machineId ?? '').trim();
    const directory = typeof seed.directory === 'string' ? seed.directory.trim() : '';
    const serverId = typeof params.serverId === 'string' ? params.serverId.trim() : '';

    return {
        pathname: '/new',
        params: {
            dataId,
            ...(machineId ? { machineId } : {}),
            ...(directory ? { directory } : {}),
            ...(serverId ? { spawnServerId: serverId } : {}),
        },
    };
}
