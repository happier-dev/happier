import { ExternalSessionLinkEnsureResponseSchema, type ExternalSessionsAgentId, type ExternalSessionsSource } from '@happier-dev/protocol/sessions/external/daemonRpcV1';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import { resolveChatFindSeed, type ChatFindSeed } from '@/components/appShell/panes/fileFindSeedHandoff';

import { Modal, type CustomModalConfig } from '@/modal';
import { captureActiveServerAccountScopeCurrentness } from '@/sync/domains/scope/activeServerAccountScope';
import { createFrontDoorActionExecute, requireActionSuccess } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { t } from '@/text';

import { resolveExternalSessionBrowseRpcErrorMessage, resolveExternalSessionBrowseThrownErrorMessage } from './externalSessionBrowseErrorPresentation';
import { isExternalSessionBrowseCandidateOfflineInert } from './resolveExternalSessionBrowseCandidateOfflineInert';
import { resolveExternalSessionBrowseCompatibleLinkSource, resolveExternalSessionBrowseLinkEnsureRequestExtras } from './resolveExternalSessionBrowseSourceOptions';
import { readExternalSessionBrowseCandidateKey, readExternalSessionBrowseCandidatePath, type ExternalSessionBrowseCandidate } from './useExternalSessionBrowseCandidates';

const executeLink = createFrontDoorActionExecute();

export type ExternalSessionCandidateFind = Readonly<{ query: string; sourceItemId: string }>;
export type ExternalSessionCandidateFindSeed = ChatFindSeed;
export type ExternalSessionCandidateOpenTarget = Readonly<{ machineId: string; serverId: string | null; accountId?: string }>;
export type ExternalSessionCandidateOpenState = {
    requestToken: number;
    linkingCandidateKey: string | null;
    controller?: AbortController;
};

/** Withdraw this browser's interest; an admitted machine import remains machine-owned. */
export function cancelExternalSessionCandidateOpen(state: ExternalSessionCandidateOpenState): void {
    state.requestToken += 1;
    state.controller?.abort();
    state.controller = undefined;
    state.linkingCandidateKey = null;
}

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
    accountCurrentness?: Readonly<{ isCurrent(): boolean; onRetire?(cancel: () => void): Readonly<{ dispose(): void }> }>;
    signal?: AbortSignal;
    /** Preserve a mounted command's caller for ordinary link admission. */
    actionContext?: ActionExecutorContext;
    commandBridge?: CustomModalConfig['commandBridge'];
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
    const controller = new AbortController();
    state.controller = controller;
    const abort = () => controller.abort();
    const retirement = accountCurrentness.onRetire?.(abort);
    params.signal?.addEventListener('abort', abort, { once: true });
    params.actionContext?.signal?.addEventListener('abort', abort, { once: true });
    if (params.signal?.aborted || params.actionContext?.signal?.aborted) controller.abort();
    const requestIsCurrent = () => state.requestToken === requestToken
        && !controller.signal.aborted && params.isSelectionCurrent() && accountCurrentness.isCurrent();
    try {
        const extras = resolveExternalSessionBrowseLinkEnsureRequestExtras({
            providerId: agentId, machineId: target.machineId, source, candidate,
        });
        const candidateSource = extras.source && typeof extras.source === 'object'
            ? extras.source as ExternalSessionsSource : undefined;
        const effectiveSource = resolveExternalSessionBrowseCompatibleLinkSource({
            providerId: agentId, machineId: target.machineId, selectedSource: source, candidateSource,
        });
        const directoryHint = readExternalSessionBrowseCandidatePath(candidate);
        const request = {
            machineId: target.machineId, agentId, remoteSessionId: candidate.remoteSessionId,
            ...(candidate.linkData ? { linkData: candidate.linkData } : {}),
            ...(candidate.title ? { titleHint: candidate.title } : {}),
            ...(directoryHint ? { directoryHint } : {}),
            ...extras, source: effectiveSource,
        };
        const action = await executeLink('sessions.external.link.ensure', request, {
            ...(params.actionContext ?? { surface: 'ui' as const, authority: 'present_user' as const, actionCaller: { kind: 'host' as const } }),
            ...(target.serverId ? { serverId: target.serverId } : {}),
            ...(target.accountId ? { expectedAccountId: target.accountId } : {}),
            signal: controller.signal,
        });
        requireActionSuccess(action);
        const result = ExternalSessionLinkEnsureResponseSchema.parse(action.result);
        if (!requestIsCurrent()) return 'ignored';
        if (!result.ok) {
            Modal.alert(t('common.error'), resolveExternalSessionBrowseRpcErrorMessage(result.errorCode, 'link'), undefined, { commandBridge: params.commandBridge });
            return 'failed';
        }
        await params.openSession(result.sessionId, openTarget, find);
        return 'opened';
    } catch (error) {
        if (!requestIsCurrent()) return 'ignored';
        Modal.alert(t('common.error'), resolveExternalSessionBrowseThrownErrorMessage(error, 'link'), undefined, { commandBridge: params.commandBridge });
        return 'failed';
    } finally {
        retirement?.dispose();
        params.signal?.removeEventListener('abort', abort);
        params.actionContext?.signal?.removeEventListener('abort', abort);
        if (state.controller === controller) state.controller = undefined;
        if (state.requestToken === requestToken) {
            state.linkingCandidateKey = null;
            params.onLinkingChange(null);
        }
    }
}
