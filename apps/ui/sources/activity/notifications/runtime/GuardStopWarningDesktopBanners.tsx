import * as React from 'react';

import { isDesktopMainWindowFocused } from '@/desktop/window/desktopMainWindowPresence';
import { selectActiveServerAccountScopeForServer } from '@/sync/domains/scope/activeServerAccountScope';
import { storage } from '@/sync/domains/state/storageStore';
import { readSessionListGuardState } from '@/sync/domains/session/listing/sessionListRenderable';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { isSessionSurfaceVisible } from '@/sync/domains/session/sessionSurfaceVisibility';
import { t } from '@/text';
import { readSessionNameIfNamed } from '@/utils/sessions/sessionUtils';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { buildGuardStopWarningPushDataV1 } from '@happier-dev/protocol/activity/webhookPayload';
import { PUSH_NOTIFICATION_ACTION_IDS } from '@happier-dev/protocol/push/pushNotificationActions';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { desktopHostKind } from '@/utils/platform/desktopHost';
import { useSessionRecordingVisibility } from '@/hooks/session/useSessionListRecordingPrivacy';
import type { SessionRecordingVisibility } from '@/sync/domains/session/listing/recordingPrivacy';

import { sendTauriLocalNotification } from '../channels/sendTauriLocalNotification';

type Warning = Readonly<{ key: string; sessionId: string; serverId: string; accountId: string; machineId: string;
    rule: 'idle_sessions' | 'memory_guard'; stopAt: number; title: string }>;

/** Each warning is announced once on this computer (a Session's stop at one time). */
const announced = new Set<string>();

function selectWarnings(state: ReturnType<typeof storage.getState>, isSessionVisible: SessionRecordingVisibility): string {
    const warnings: Warning[] = [];
    for (const session of Object.values(state.sessions)) {
        if (!session || session.active !== true) continue;
        const guard = readSessionListGuardState(readSessionOwnerMetadataView(session)?.sessionGuardStateV1);
        if (guard?.kind !== 'stopping') continue;
        const serverId = typeof session.serverId === 'string' ? session.serverId : '';
        if (!isSessionVisible({ serverId, sessionId: session.id })) continue;
        const machineId = readSessionOwnerMetadataView(session)?.machineId;
        const scope = selectActiveServerAccountScopeForServer(state.profileScope, serverId);
        if (!scope || !machineId) continue;
        warnings.push({ key: JSON.stringify([serverId, scope.accountId, session.id, guard.stopAt]), sessionId: session.id, serverId,
            accountId: scope.accountId,
            machineId, rule: guard.rule, stopAt: guard.stopAt,
            title: readSessionNameIfNamed(session) ?? t('machineGuard.activity.kinds.something') });
    }
    return JSON.stringify(warnings);
}

/**
 * The guard's stop warning on the computer you are at (plan 50 GRD-7, lab `rg` G3-4): phones get the push
 * with Keep running and Stop now; a desktop gets this banner once per warning, unless the Session is
 * already open in front of you (its composer carries the countdown and Keep running).
 */
export function GuardStopWarningDesktopBanners(): null {
    const isSessionVisible = useSessionRecordingVisibility();
    const selectVisibleWarnings = React.useCallback((state: ReturnType<typeof storage.getState>) =>
        selectWarnings(state, isSessionVisible), [isSessionVisible]);
    const signature = storage(selectVisibleWarnings);
    React.useEffect(() => {
        const now = Date.now();
        for (const warning of JSON.parse(signature) as Warning[]) {
            if (announced.has(warning.key) || warning.stopAt <= now) continue;
            announced.add(warning.key);
            if (isSessionSurfaceVisible(warning.sessionId, warning.serverId) && isDesktopMainWindowFocused()) continue;
            const minutes = Math.max(1, Math.round((warning.stopAt - now) / 60_000));
            const profile = getServerProfileById(warning.serverId);
            const data = { ...buildGuardStopWarningPushDataV1({ topic: 'guard_stop_warning', machineId: warning.machineId,
                sessionId: warning.sessionId, rule: warning.rule, stopAt: warning.stopAt }), serverId: warning.serverId,
                ...(profile?.serverUrl ? { serverUrl: profile.serverUrl } : {}) };
            const native = desktopHostKind() === 'tauri';
            fireAndForget(sendTauriLocalNotification({
                title: t('machineGuard.session.bannerTitle', { title: warning.title, minutes }),
                body: t('machineGuard.session.bannerBody'),
                ...(native ? { interaction: { identifier: warning.key, accountId: warning.accountId, data, actions: [
                    { id: PUSH_NOTIFICATION_ACTION_IDS.guardKeepRunningV1, title: t('machineGuard.session.keepRunning') },
                    { id: PUSH_NOTIFICATION_ACTION_IDS.guardStopNowV1, title: t('common.stop') },
                ] } } : {}),
            }), { tag: 'GuardStopWarningDesktopBanners.send' });
        }
    }, [signature]);
    return null;
}
