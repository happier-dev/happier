import * as React from 'react';

import type { SessionBackgroundTaskRecordV1 } from '@happier-dev/protocol';

import { useLocalSetting } from '@/sync/domains/state/storage';
import { getStorage } from '@/sync/domains/state/storageStore';
import { useApplyLocalSettings } from '@/sync/store/settingsWriters';

/**
 * The stale background-command reports the user dismissed on this device, for one session.
 *
 * Device-local on purpose: a dismissal is presentation, not an outcome, and it must not write the
 * provider record the CLI publisher owns. Persisted as the dismissed report's `updatedAt` per
 * session and task, so newer evidence stops matching and the row speaks for itself again. One entry
 * per task, replaced in place, so the setting cannot grow without bound.
 */

function buildAcknowledgementKey(sessionId: string, taskId: string): string {
    return `${sessionId}\u0000${taskId}`;
}

/**
 * The store's value at the moment of the action, not the last render's: dismissing two rows before
 * a re-render must not lose the first through a stale closure.
 */
function readCurrentAcknowledgements(): Readonly<Record<string, number>> {
    return getStorage().getState().localSettings.backgroundTaskAcknowledgedReports;
}

const NO_ACKNOWLEDGEMENTS: Readonly<Record<string, number>> = Object.freeze({});

export type BackgroundTaskAcknowledgements = Readonly<{
    /** Per task id, the `updatedAt` of the report the user dismissed. */
    acknowledgedUpdatedAtByTaskId: Readonly<Record<string, number>>;
    dismiss: (record: SessionBackgroundTaskRecordV1) => void;
    undo: (taskId: string) => void;
}>;

export function useBackgroundTaskAcknowledgements(sessionId: string): BackgroundTaskAcknowledgements {
    const persisted = useLocalSetting('backgroundTaskAcknowledgedReports');
    const applyLocalSettings = useApplyLocalSettings();

    const prefix = buildAcknowledgementKey(sessionId, '');
    const acknowledgedUpdatedAtByTaskId = React.useMemo(() => {
        let scoped: Record<string, number> | null = null;
        for (const [key, updatedAt] of Object.entries(persisted)) {
            if (!key.startsWith(prefix)) continue;
            scoped ??= {};
            scoped[key.slice(prefix.length)] = updatedAt;
        }
        return scoped ?? NO_ACKNOWLEDGEMENTS;
    }, [persisted, prefix]);

    const dismiss = React.useCallback((record: SessionBackgroundTaskRecordV1) => {
        applyLocalSettings({
            backgroundTaskAcknowledgedReports: {
                ...readCurrentAcknowledgements(),
                [buildAcknowledgementKey(sessionId, record.taskId)]: record.updatedAt,
            },
        });
    }, [applyLocalSettings, sessionId]);

    const undo = React.useCallback((taskId: string) => {
        const { [buildAcknowledgementKey(sessionId, taskId)]: _removed, ...rest } = readCurrentAcknowledgements();
        applyLocalSettings({ backgroundTaskAcknowledgedReports: rest });
    }, [applyLocalSettings, sessionId]);

    return { acknowledgedUpdatedAtByTaskId, dismiss, undo };
}
