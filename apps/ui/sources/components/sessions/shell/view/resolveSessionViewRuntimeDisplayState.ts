import type { Session } from '@/sync/domains/state/storageTypes';
import { deriveTranscriptInteractionFromSession } from '@/utils/sessions/deriveTranscriptInteraction';
import { getInactiveSessionUiState } from '@/components/sessions/model/inactiveSessionUi';
import { getSessionLocalControlState } from '@/sync/domains/session/control/sessionLocalControl';
import { getPreferredLanguage, t } from '@/text';
import { LruMap } from '@/utils/cache/lruMap';
import { readSessionListShellCacheMaxEntriesFromEnv } from '../sessionListShellCacheConfig';
import type { SessionMachineReachability } from '@/sync/domains/machines/reachability/resolveSessionMachineReachability';
import type { SessionViewExternalControlFooter } from './resolveSessionViewExternalControlFooter';

export type SessionViewRuntimeDisplayState = Readonly<{
    localControlState: ReturnType<typeof getSessionLocalControlState>;
    transcriptInteraction: ReturnType<typeof deriveTranscriptInteractionFromSession>;
    inactiveUi: ReturnType<typeof getInactiveSessionUiState>;
    bottomNotice: Readonly<{
        title: string;
        body: string;
    }> | null;
}>;

type Input = Readonly<{
    session: Session;
    isSessionActive: boolean;
    isResumable: boolean | null;
    isMachineReachable: boolean;
    machineReachability: SessionMachineReachability;
    allowInputWhileInactive: boolean;
    /** A non-terminal external import or takeover operation exists (its card owns the way forward). */
    externalOperationBlocksNewOperation: boolean;
    /** The external control row; the footer resolver renders it only while it offers a way forward. */
    externalControlFooter: SessionViewExternalControlFooter | null;
    providerName: string;
    machineName: string;
}>;

const SESSION_VIEW_RUNTIME_DISPLAY_STATE_CACHE = new LruMap<string, SessionViewRuntimeDisplayState>({
    maxEntries: readSessionListShellCacheMaxEntriesFromEnv(),
});

/** One fact for "the external Session's way forward is on screen", read by the notice below. */
function hasExternalWayForward(input: Input): boolean {
    return input.externalOperationBlocksNewOperation || input.externalControlFooter !== null;
}

function buildCacheKey(input: Input): string {
    return JSON.stringify([
        getPreferredLanguage(),
        input.session.access ?? null,
        input.session.active ? 1 : 0,
        input.session.archivedAt != null ? 1 : 0,
        input.session.lifecycleStateReason ?? input.session.metadata?.lifecycleStateReason ?? null,
        input.session.presence ?? '',
        input.session.agentState?.controlledByUser === true ? 1 : 0,
        input.session.agentState?.localControl ?? null,
        input.isSessionActive ? 1 : 0,
        input.isResumable,
        input.isMachineReachable ? 1 : 0,
        input.machineReachability,
        input.allowInputWhileInactive ? 1 : 0,
        hasExternalWayForward(input) ? 1 : 0,
        input.providerName,
        input.machineName,
    ]);
}

export function resolveSessionViewRuntimeDisplayState(input: Input): SessionViewRuntimeDisplayState {
    const cacheKey = buildCacheKey(input);
    const cached = SESSION_VIEW_RUNTIME_DISPLAY_STATE_CACHE.get(cacheKey);
    if (cached) {
        return cached;
    }

    const localControlState = getSessionLocalControlState(input.session);
    const transcriptInteraction = deriveTranscriptInteractionFromSession({
        access: input.session.access,
        active: input.session.active,
        presence: input.session.presence,
    });
    const inactiveUi = getInactiveSessionUiState({
        lifecycleStateReason: input.session.lifecycleStateReason ?? input.session.metadata?.lifecycleStateReason,
        isSessionActive: input.isSessionActive,
        isResumable: input.isResumable,
        isMachineOnline: input.machineReachability === 'unknown' ? null : input.isMachineReachable,
        isArchived: input.session.archivedAt != null,
        allowInputWhileInactive: input.allowInputWhileInactive,
        externalWayForward: hasExternalWayForward(input),
    });

    const bottomNotice = inactiveUi.inactiveStatusTextKey === 'session.machineDeleted'
        ? { title: t('session.machineDeleted'), body: t('session.machineDeletedBody') }
        : inactiveUi.inactiveStatusTextKey === 'session.accessWithdrawn'
        ? { title: t('session.accessWithdrawn'), body: t('session.accessWithdrawnBody', { machine: input.machineName }) }
        : inactiveUi.noticeKind === 'not-resumable'
        ? {
            title: t('session.inactiveNotResumableNoticeTitle'),
            body: t('session.inactiveNotResumableNoticeBody', { provider: input.providerName }),
        }
        : inactiveUi.noticeKind === 'machine-offline'
            ? {
                title: t('session.machineOfflineNoticeTitle'),
                body: t('session.machineOfflineNoticeBody', { machine: input.machineName }),
            }
            : null;

    const next: SessionViewRuntimeDisplayState = {
        localControlState,
        transcriptInteraction,
        inactiveUi,
        bottomNotice,
    };
    SESSION_VIEW_RUNTIME_DISPLAY_STATE_CACHE.set(cacheKey, next);
    return next;
}
