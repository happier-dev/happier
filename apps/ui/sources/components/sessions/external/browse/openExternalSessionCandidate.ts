import { makeExternalSessionHistoricalImportLocalId, type ExternalSessionsAgentId, type ExternalSessionsSource } from '@happier-dev/protocol';
import type { ChatFindSeed } from '@/components/appShell/panes/fileFindSeedHandoff';

import { Modal } from '@/modal';
import { captureActiveServerAccountScopeCurrentness } from '@/sync/domains/scope/activeServerAccountScope';
import { machineExternalSessionLinkEnsure } from '@/sync/ops/machineExternalSessions';
import { t } from '@/text';

import { resolveExternalSessionBrowseRpcErrorMessage, resolveExternalSessionBrowseThrownErrorMessage } from './externalSessionBrowseErrorPresentation';
import { isExternalSessionBrowseCandidateOfflineInert } from './resolveExternalSessionBrowseCandidateOfflineInert';
import { resolveExternalSessionBrowseCompatibleLinkSource, resolveExternalSessionBrowseLinkEnsureRequestExtras } from './resolveExternalSessionBrowseSourceOptions';
import { readExternalSessionBrowseCandidateKey, readExternalSessionBrowseCandidatePath, type ExternalSessionBrowseCandidate } from './useExternalSessionBrowseCandidates';

export type ExternalSessionCandidateFind = Readonly<{ query: string; sourceItemId: string }>;
export type ExternalSessionCandidateFindSeed = ChatFindSeed;
export type ExternalSessionCandidateOpenTarget = Readonly<{ machineId: string; serverId: string | null }>;
export type ExternalSessionCandidateOpenState = {
    requestToken: number;
    linkingCandidateKey: string | null;
};

/** The browser and Search share the same guarded link/open operation. */
export async function openExternalSessionCandidate(params: Readonly<{
    candidate: ExternalSessionBrowseCandidate;
    agentId: ExternalSessionsAgentId | null;
    source: ExternalSessionsSource | null;
    interaction?: 'openSession' | 'pickRemoteSessionId';
    actionsAllowed: boolean;
    offline: boolean;
    isSelectionCurrent(): boolean;
    resolveCurrentTarget(): ExternalSessionCandidateOpenTarget | null;
    state: ExternalSessionCandidateOpenState;
    onLinkingChange(candidateKey: string | null): void;
    onPickRemoteSessionId?(remoteSessionId: string): void;
    /** Exact selected Home authority; browser callers default to the active Account. */
    accountCurrentness?: Readonly<{ isCurrent(): boolean }>;
    openSession(sessionId: string, target: ExternalSessionCandidateOpenTarget, find?: ExternalSessionCandidateFindSeed): void | Promise<void>;
    find?: ExternalSessionCandidateFind;
}>): Promise<'opened' | 'picked' | 'ignored' | 'failed'> {
    const { candidate, agentId, source, state } = params;
    const interaction = params.interaction ?? 'openSession';
    if (!params.actionsAllowed || !params.isSelectionCurrent()
        || params.accountCurrentness?.isCurrent() === false) return 'ignored';
    if (isExternalSessionBrowseCandidateOfflineInert({ offline: params.offline, interaction, linkedSessionId: candidate.linkedSessionId })) return 'ignored';
    if (!agentId || !source) return 'ignored';
    const target = params.resolveCurrentTarget();
    if (!target || state.linkingCandidateKey !== null) return 'ignored';
    const find: ExternalSessionCandidateFindSeed | undefined = params.find ? {
        query: params.find.query,
        options: { matchCase: false, regex: false },
        target: {
            kind: 'route-message-id',
            routeMessageId: makeExternalSessionHistoricalImportLocalId({
                agentId, remoteSessionId: candidate.remoteSessionId, directItemId: params.find.sourceItemId,
            }),
        },
    } : undefined;
    if (interaction === 'pickRemoteSessionId') {
        params.onPickRemoteSessionId?.(candidate.remoteSessionId);
        return 'picked';
    }
    if (candidate.linkedSessionId) {
        await params.openSession(candidate.linkedSessionId, target, find);
        return 'opened';
    }
    const requestToken = ++state.requestToken;
    state.linkingCandidateKey = readExternalSessionBrowseCandidateKey(candidate);
    params.onLinkingChange(state.linkingCandidateKey);
    const accountCurrentness = params.accountCurrentness ?? captureActiveServerAccountScopeCurrentness();
    const requestIsCurrent = () => state.requestToken === requestToken
        && params.isSelectionCurrent() && accountCurrentness.isCurrent();
    try {
        const extras = resolveExternalSessionBrowseLinkEnsureRequestExtras({
            providerId: agentId, machineId: target.machineId, source, candidate,
        });
        const candidateSource = extras.source && typeof extras.source === 'object'
            ? extras.source as ExternalSessionsSource : undefined;
        const effectiveSource = resolveExternalSessionBrowseCompatibleLinkSource({
            providerId: agentId, machineId: target.machineId, selectedSource: source, candidateSource,
        });
        const directoryHint = readExternalSessionBrowseCandidatePath(candidate.details);
        const request = {
            machineId: target.machineId, agentId, remoteSessionId: candidate.remoteSessionId,
            ...(candidate.linkData ? { linkData: candidate.linkData } : {}),
            ...(candidate.title ? { titleHint: candidate.title } : {}),
            ...(directoryHint ? { directoryHint } : {}),
            ...extras, source: effectiveSource,
        };
        const result = target.serverId
            ? await machineExternalSessionLinkEnsure(request, { serverId: target.serverId })
            : await machineExternalSessionLinkEnsure(request);
        if (!requestIsCurrent()) return 'ignored';
        if (!result.ok) {
            Modal.alert(t('common.error'), resolveExternalSessionBrowseRpcErrorMessage(result.errorCode, 'link'));
            return 'failed';
        }
        await params.openSession(result.sessionId, target, find);
        return 'opened';
    } catch (error) {
        if (!requestIsCurrent()) return 'ignored';
        Modal.alert(t('common.error'), resolveExternalSessionBrowseThrownErrorMessage(error, 'link'));
        return 'failed';
    } finally {
        if (state.requestToken === requestToken) {
            state.linkingCandidateKey = null;
            params.onLinkingChange(null);
        }
    }
}
