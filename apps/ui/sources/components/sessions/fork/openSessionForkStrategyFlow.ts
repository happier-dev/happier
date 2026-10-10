import type { SessionForkPoint } from '@happier-dev/protocol';
import type { Router } from 'expo-router';

import type { CurrentProjectedAgentCapabilities } from '@/agents/backendCatalog/currentAgentCapabilities';
import { openNewSessionSourceContextNavigation } from '@/components/sessions/new/navigation/newSessionSourceContextNavigation';
import { Modal } from '@/modal';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import type { LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import {
    resolveSessionForkStrategyAvailability,
    type SessionForkSupportSource,
} from '@/sync/domains/sessionFork/forkUiSupport';
import {
    resolveSessionForkReplayOptions,
    type SessionForkReplaySettingsSource,
} from '@/sync/domains/sessionFork/resolveSessionForkReplayOptions';

import {
    openSessionForkStrategyModal,
    type OpenSessionForkStrategyModalParams,
} from './openSessionForkStrategyModal';

export type OpenSessionForkStrategyFlowParams = Readonly<{
    sessionId: string;
    /** The interaction-derived fork source; a read-only transcript supplies null. */
    forkSupportSource: SessionForkSupportSource | null | undefined;
    serverId: string | null;
    machineId: string | null;
    forkPoint: SessionForkPoint;
    settings: SessionForkReplaySettingsSource | null | undefined;
    replayEnabled: boolean | null | undefined;
    /** Exact current external Agent declaration, when this Session has one. */
    currentAgentCapabilities?: CurrentProjectedAgentCapabilities | null;
    executionRunsEnabled: boolean;
    /**
     * The caller's already-resolved `sessions.agentSwitching` decision for THIS
     * Session's server. Required, not optional: source-context continuation is
     * the switching capability reached from the fork surface, and an omitted
     * decision is how the second entry point escaped the gate in the first place.
     */
    agentSwitchingEnabled: boolean;
    restoredDraftText?: string | null;
    sourceMessageId?: string | null;
    sourcePreview?: string | null;
    writeForkInitialPrompt?: boolean;
    navigateToSession: (childSessionId: string, options?: Readonly<{ serverId?: string }>) => void | Promise<void>;
    navigation: Pick<Router, 'push'>;
    navigateToNewSession: (
        route: Readonly<{ pathname: '/new'; params: Readonly<Record<string, string>> }>,
    ) => void;
}>;

/**
 * The single UI entry into forking. Every fork surface — the Session header, the
 * Session info screen and a transcript message — routes through here, so no
 * surface can commit a fork before the user has chosen a strategy.
 *
 * Returns the modal id, or `null` when this Session/cutoff offers no route at
 * all — not merely no *usable* one. A route the user cannot take today is still
 * a route the modal explains: an Agent without native fork opens the modal with
 * the Native card disabled and its reason shown, rather than leaving the reader
 * with an affordance that does nothing or no affordance at all.
 */
export function openSessionForkStrategyFlow(params: OpenSessionForkStrategyFlowParams): string | null {
    const availability = resolveSessionForkStrategyAvailability({
        session: params.forkSupportSource,
        forkPoint: params.forkPoint,
        replayEnabled: params.replayEnabled,
        agentSwitchingEnabled: params.agentSwitchingEnabled,
        currentAgentCapabilities: params.currentAgentCapabilities,
    });
    if (!availability.native && !availability.replay && !availability.configure) return null;

    const replayOptions = resolveSessionForkReplayOptions({
        settings: params.settings,
        executionRunsEnabled: params.executionRunsEnabled,
    });

    const modalParams: OpenSessionForkStrategyModalParams = {
        availability,
        sourcePreview: params.sourcePreview ?? null,
        request: {
            parentSessionId: params.sessionId,
            serverId: params.serverId,
            machineId: params.machineId,
            forkPoint: params.forkPoint,
            restoredDraftText: params.restoredDraftText ?? null,
            sourceMessageId: params.sourceMessageId ?? null,
            writeForkInitialPrompt: params.writeForkInitialPrompt === true,
            ...replayOptions,
        },
        navigate: params.navigateToSession,
        navigation: params.navigation,
        // Configure new Session is the one route here that continues this
        // conversation with another Agent. The decision is not re-derived here:
        // `availability.configure` IS the caller's `sessions.agentSwitching`
        // decision, resolved beside Native and Replay so this flow and the entry
        // points that decide whether to render an affordance at all can never
        // disagree about how many routes exist.
        configureNewSession: !availability.configure ? null : () => {
            fireAndForget((async () => {
                let account: LazyActionAccountContext | null = null;
                try {
                    if (!params.serverId) throw new Error('Session Home is unavailable');
                    const [{ captureLazyActionAccountContext }, { runWithServerRequestAuthorityForServerAccountScope },
                        { readSessionSnapshotForAuthority }] = await Promise.all([
                        import('@/sync/ops/actions/actionAccountContext'),
                        import('@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope'),
                        import('@/sync/runtime/orchestration/serverScopedRpc/readSessionSnapshotForAuthority'),
                    ]);
                    // Configure is a new gesture: its exact Home's current
                    // credential owner admits the read and the resulting draft.
                    account = await captureLazyActionAccountContext(params.serverId);
                    const lifetime = account.accountLifetime;
                    const { session } = await runWithServerRequestAuthorityForServerAccountScope({
                        scope: lifetime.scope, activeRequest: account.request,
                    }, authority => readSessionSnapshotForAuthority({
                        authority, sessionId: params.sessionId, isCurrent: lifetime.isCurrent,
                    }));
                    account.assertCurrent();
                    const outcome = openNewSessionSourceContextNavigation({
                        session, sourceSessionId: params.sessionId, forkPoint: params.forkPoint,
                        serverId: account.serverId,
                        machineId: readSessionOwnerMetadataView(session)?.machineId ?? null,
                        accountLifetime: lifetime,
                        restoredDraftText: params.restoredDraftText ?? null,
                        navigateToNewSession: params.navigateToNewSession,
                    });
                    if (outcome.kind !== 'opened') Modal.alert(t('common.error'), t('common.unavailable'));
                } catch {
                    Modal.alert(t('common.error'), t('common.unavailable'));
                } finally {
                    account?.dispose();
                }
            })(), { tag: 'SessionFork.configureNewSession' });
        },
    };

    return openSessionForkStrategyModal(modalParams);
}
