import * as React from 'react';
import { isActionApprovalDeclinedErrorCode } from '@happier-dev/protocol/actions/actionExecutionResult';

import { useSettingActionWriter } from '@/components/settings/catalog/useSettingActionWriter';
import { presentActionTurnedOffNoticeIfOff } from '@/sync/ops/actions/actionTurnedOffNotice';
import { requireActionSuccess } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { Modal } from '@/modal';
import { t } from '@/text';
import { EXTERNAL_SESSIONS_SETTINGS } from './externalSessionsSettings';

/** Both painted controls submit the same admitted, field-scoped Settings intent. */
export function useRestartFollowSetting() {
    const write = useSettingActionWriter();
    const pendingRef = React.useRef(false);
    const [pending, setPending] = React.useState(false);
    const setEnabled = React.useCallback(async (enabled: boolean) => {
        if (pendingRef.current) return;
        pendingRef.current = true;
        setPending(true);
        try {
            const result = await write(EXTERNAL_SESSIONS_SETTINGS.settings.keepFollowingAfterRestart, enabled);
            if (!write.isCurrent(EXTERNAL_SESSIONS_SETTINGS.settings.keepFollowingAfterRestart)) return;
            if (!result.ok && (isActionApprovalDeclinedErrorCode(result.errorCode)
                || presentActionTurnedOffNoticeIfOff(result, 'settings.set'))) return;
            requireActionSuccess(result);
        } catch {
            if (write.isCurrent(EXTERNAL_SESSIONS_SETTINGS.settings.keepFollowingAfterRestart)) {
                await Modal.alertAsync(t('common.error'), t('externalSessions.settingsRestoreUpdateFailed'));
            }
        } finally {
            pendingRef.current = false;
            setPending(false);
        }
    }, [write]);
    return { pending, setEnabled };
}
