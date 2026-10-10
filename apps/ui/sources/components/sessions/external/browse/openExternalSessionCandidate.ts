import type { ExternalSessionsAgentId, ExternalSessionsSource } from '@happier-dev/protocol/sessions/external/daemonRpcV1';
import { resolveChatFindSeed, type ChatFindSeed } from '@/components/appShell/panes/fileFindSeedHandoff';

import { Modal } from '@/modal';
import { captureActiveServerAccountScopeCurrentness } from '@/sync/domains/scope/activeServerAccountScope';
import { machineExternalSessionLinkEnsure } from '@/sync/ops/machineExternalSessions';
import { t } from '@/text';

import { resolveExternalSessionBrowseRpcErrorMessage, resolveExternalSessionBrowseThrownErrorMessage } from './externalSessionBrowseErrorPresentation';
import { isExternalSessionBrowseCandidateOfflineInert } from './resolveExternalSessionBrowseCandidateOfflineInert';
import { resolveExternalSessionBrowseCompatibleLinkSource, resolveExternalSessionBrowseLinkEnsureRequestExtras } from './resolveExternalSessionBrowseSourceOptions';
import { readExternalSessionBrowseCandidateKey, readExternalSessionBrowseCandidatePath, type ExternalSessionBrowseCandidate } from './useExternalSessionBrowseCandidates';
import type { FrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { ExternalSessionLinkEnsureResponseSchema } from '@happier-dev/protocol/sessions/external/daemonRpcV1';

export type ExternalSessionCandidateFind = Readonly<{ query: string; sourceItemId: string }>;
export type ExternalSessionCandidateFindSeed = ChatFindSeed;
export type ExternalSessionCandidateOpenTarget = Readonly<{ machineId: string; serverId: string | null; accountId?: string }>;
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
    /** Usage surfaces retain ordinary Action policy/approval at the existing front door. */
    linkActionExecute?: FrontDoorActionExecute;
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
    const openTarget = { machineId: target.machineId, serverId: target.serverId };
    const find: ExternalSessionCandidateFindSeed | undefined = params.find ? resolveChatFindSeed({
        query: params.find.query,
        target: {
            kind: 'native-message', agentId, remoteSessionId: candidate.remoteSessionId, sourceItemId: params.find.sourceItemId,
        },
    }) : undefined;
    if (interaction === 'pickRemoteSessionId') {
        params.onPickRemoteSessionId?.(candidate.remoteSessionId);
        return 'picked';
    }
    if (candidate.linkedSessionId) {
        await params.openSession(candidate.linkedSessionId, openTarget, find);
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
        const action = params.linkActionExecute ? await params.linkActionExecute('sessions.external.link.ensure', request, {
            surface: 'ui', ...(target.serverId ? { serverId: target.serverId } : {}),
            ...(target.accountId ? { expectedAccountId: target.accountId } : {}),
        }) : null;
        if (action && (!action.ok || !ExternalSessionLinkEnsureResponseSchema.safeParse(action.result).success)) return 'failed';
        const result = action?.ok ? ExternalSessionLinkEnsureResponseSchema.parse(action.result) : target.serverId
            ? await machineExternalSessionLinkEnsure(request, { serverId: target.serverId,
                ...(target.accountId ? { accountId: target.accountId } : {}) })
            : await machineExternalSessionLinkEnsure(request);
        if (!requestIsCurrent()) return 'ignored';
        if (!result.ok) {
            Modal.alert(t('common.error'), resolveExternalSessionBrowseRpcErrorMessage(result.errorCode, 'link'));
            return 'failed';
        }
        await params.openSession(result.sessionId, openTarget, find);
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
