import type { Session } from '@/sync/domains/state/storageTypes';
import { deriveTranscriptInteractionFromSession } from '@/utils/sessions/deriveTranscriptInteraction';
import { getInactiveSessionUiState } from '@/components/sessions/model/inactiveSessionUi';
import { getSessionLocalControlState } from '@/sync/domains/session/control/sessionLocalControl';
import { getPreferredLanguage, t } from '@/text';
import { LruMap } from '@/utils/cache/lruMap';
import { readSessionListShellCacheMaxEntriesFromEnv } from '../sessionListShellCacheConfig';

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
    isResumable: boolean;
    isMachineReachable: boolean;
    allowInputWhileInactive: boolean;
    providerName: string;
    machineName: string;
}>;

const SESSION_VIEW_RUNTIME_DISPLAY_STATE_CACHE = new LruMap<string, SessionViewRuntimeDisplayState>({
    maxEntries: readSessionListShellCacheMaxEntriesFromEnv(),
});

function buildCacheKey(input: Input): string {
    return JSON.stringify([
        getPreferredLanguage(),
        input.session.accessLevel ?? '',
        input.session.canApprovePermissions ? 1 : 0,
        input.session.active ? 1 : 0,
        input.session.presence ?? '',
        input.session.agentState?.controlledByUser === true ? 1 : 0,
        input.session.agentState?.localControl ?? null,
        input.isSessionActive ? 1 : 0,
        input.isResumable ? 1 : 0,
        input.isMachineReachable ? 1 : 0,
        input.allowInputWhileInactive ? 1 : 0,
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
        accessLevel: input.session.accessLevel,
        canApprovePermissions: input.session.canApprovePermissions,
        active: input.session.active,
        presence: input.session.presence,
    });
    const inactiveUi = getInactiveSessionUiState({
        isSessionActive: input.isSessionActive,
        isResumable: input.isResumable,
        isMachineOnline: input.isMachineReachable,
        allowInputWhileInactive: input.allowInputWhileInactive,
    });

    const bottomNotice = inactiveUi.noticeKind === 'not-resumable'
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
