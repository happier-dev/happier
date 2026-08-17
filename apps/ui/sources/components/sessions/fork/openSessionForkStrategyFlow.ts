import type { SessionForkPoint } from '@happier-dev/protocol';

import { buildNewSessionSourceContextNavigation } from '@/components/sessions/new/navigation/newSessionSourceContextNavigation';
import { storage } from '@/sync/domains/state/storage';
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
    navigateToSession: (childSessionId: string) => void | Promise<void>;
    navigateToNewSession: (
        route: Readonly<{ pathname: '/new'; params: Readonly<Record<string, string>> }>,
    ) => void;
}>;

/**
 * The single UI entry into forking. Every fork surface — the Session header, the
 * Session info screen and a transcript message — routes through here, so no
 * surface can commit a fork before the user has chosen a strategy.
 *
 * Returns the modal id, or `null` when this Session/cutoff offers no fork route
 * at all (the caller's affordance should already be hidden in that case).
 */
export function openSessionForkStrategyFlow(params: OpenSessionForkStrategyFlowParams): string | null {
    const availability = resolveSessionForkStrategyAvailability({
        session: params.forkSupportSource,
        forkPoint: params.forkPoint,
        replayEnabled: params.replayEnabled,
    });
    if (!availability.native && !availability.replay) return null;

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
        // Configure new Session is the one route here that continues this
        // conversation with another Agent, so it consults the same decision the
        // in-Session picker does rather than a second interpretation of it. The
        // same-engine routes above are the pre-existing fork product and stay
        // available either way, so a closed gate narrows this modal instead of
        // emptying it — nobody is left mid-flow with nothing to choose.
        configureNewSession: !params.agentSwitchingEnabled ? null : () => {
            // Read the Session at the moment the user chooses Configure, so the
            // seed reflects current configuration rather than menu-open state.
            const session = storage.getState().sessions[params.sessionId] ?? null;
            if (!session) return;
            params.navigateToNewSession(buildNewSessionSourceContextNavigation({
                session,
                sourceSessionId: params.sessionId,
                forkPoint: params.forkPoint,
                serverId: params.serverId,
                machineId: params.machineId,
                restoredDraftText: params.restoredDraftText ?? null,
            }));
        },
    };

    return openSessionForkStrategyModal(modalParams);
}
