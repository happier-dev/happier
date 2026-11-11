import * as React from 'react';
import { isActionApprovalDeclinedErrorCode } from '@happier-dev/protocol/actions/actionExecutionResult';

import { useSettingActionWriter } from '@/components/settings/catalog/useSettingActionWriter';
import { presentActionTurnedOffNoticeIfOff } from '@/sync/ops/actions/actionTurnedOffNotice';
import { requireActionSuccess } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { Modal } from '@/modal';
import { t } from '@/text';
import { EXTERNAL_SESSIONS_SETTINGS } from './externalSessionsSettings';

/** Both painted controls submit the same admitted, field-scoped Settings intent. */
export function useRestartFollowSetting(confirmedEnabled: boolean) {
    const write = useSettingActionWriter();
    const active = React.useRef<{ desired: boolean; completion: Promise<void> } | null>(null);
    const [desired, setDesired] = React.useState<boolean | null>(null);
    const setEnabled = React.useCallback((enabled: boolean) => {
        setDesired(enabled);
        if (active.current) {
            active.current.desired = enabled;
            return active.current.completion;
        }
        const mutation = { desired: enabled, completion: Promise.resolve() };
        active.current = mutation;
        mutation.completion = (async () => {
            let failed = false;
            try {
                let attempted = enabled;
                for (;;) {
                    const result = await write(EXTERNAL_SESSIONS_SETTINGS.settings.keepFollowingAfterRestart, attempted);
                    if (!write.isCurrent(EXTERNAL_SESSIONS_SETTINGS.settings.keepFollowingAfterRestart)) return;
                    if (!result.ok && (isActionApprovalDeclinedErrorCode(result.errorCode)
                        || presentActionTurnedOffNoticeIfOff(result, 'settings.set'))) return;
                    requireActionSuccess(result);
                    if (mutation.desired === attempted) return;
                    attempted = mutation.desired;
                }
            } catch {
                failed = write.isCurrent(EXTERNAL_SESSIONS_SETTINGS.settings.keepFollowingAfterRestart);
            } finally {
                active.current = null;
                setDesired(null);
            }
            // The switch already shows the saved value when the alert says the change failed.
            if (failed) await Modal.alertAsync(t('common.error'), t('externalSessions.settingsRestoreUpdateFailed'));
        })();
        return mutation.completion;
    }, [write]);
    return { enabled: desired ?? confirmedEnabled, setEnabled };
}
