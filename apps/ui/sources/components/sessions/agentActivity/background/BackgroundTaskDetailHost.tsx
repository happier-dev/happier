import * as React from 'react';

import type { SessionBackgroundTaskRecordV1 } from '@happier-dev/protocol';

import { useBackgroundTaskAcknowledgements } from '@/hooks/session/useBackgroundTaskAcknowledgements';

import { resolveAgentActivityStaleness } from '../presentation/agentActivityStaleness';
import { BackgroundTaskDetail } from './BackgroundTaskDetail';

/**
 * The background-task detail plus its device-local dismissal.
 *
 * A leaf on purpose: only an opened detail subscribes to the acknowledgement setting, so the closed
 * roster rows and the badge never mount this work. Eligibility reuses the one staleness owner; the
 * acknowledgement itself is applied once, upstream of the shared count derivation.
 */
export const BackgroundTaskDetailHost = React.memo<Readonly<{
    sessionId: string;
    record: SessionBackgroundTaskRecordV1;
    onOpenLaunchingCommand?: () => void;
    testID?: string;
}>>((props) => {
    const { onOpenLaunchingCommand, record, sessionId, testID } = props;
    const { acknowledgedUpdatedAtByTaskId, dismiss, undo } = useBackgroundTaskAcknowledgements(sessionId);
    const acknowledged = acknowledgedUpdatedAtByTaskId[record.taskId] === record.updatedAt
        && (record.status === 'running' || record.status === 'starting');
    const stale = !acknowledged && resolveAgentActivityStaleness({
        status: record.status,
        updatedAtMs: record.updatedAt,
        endedAtMs: record.endedAt ?? null,
        nowMs: Date.now(),
    }) === 'stale';

    const handleDismiss = React.useCallback(() => dismiss(record), [dismiss, record]);
    const handleUndo = React.useCallback(() => undo(record.taskId), [record.taskId, undo]);

    return (
        <BackgroundTaskDetail
            record={record}
            {...(testID ? { testID } : null)}
            {...(onOpenLaunchingCommand ? { onOpenLaunchingCommand } : null)}
            {...(acknowledged ? { acknowledged: true, onUndoDismiss: handleUndo } : null)}
            {...(stale ? { onDismiss: handleDismiss } : null)}
        />
    );
});
BackgroundTaskDetailHost.displayName = 'BackgroundTaskDetailHost';
