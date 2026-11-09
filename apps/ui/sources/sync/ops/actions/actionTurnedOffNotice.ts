import { router } from 'expo-router';
import { isActionTurnedOffErrorCode } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ACTION_IDS, type ActionId } from '@happier-dev/protocol/actions/actionIds';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';

import { Modal } from '@/modal';
import { t } from '@/text';
import { resolveActionTitle } from '@/text/actionTitles';

/** The catalog's name for the Action; a contributed or unknown id reads as the generic "Action". */
function turnedOffActionTitle(actionId: string): string {
    const known = (ACTION_IDS as readonly string[]).includes(actionId);
    return resolveActionTitle(actionId, known ? getActionSpec(actionId as ActionId) : null);
}

/**
 * An Action the person turned off in Settings, Actions did not fail. This is the one in-app
 * presentation: a calm notice that names the Action and leads to that Action's setting.
 */
export function presentActionTurnedOffNotice(actionId: string): void {
    Modal.alert(t('actionConfirmations.turnedOffTitle', { action: turnedOffActionTitle(actionId) }), t('actionConfirmations.turnedOffMessage'), [
        { text: t('common.ok'), style: 'cancel' },
        { text: t('actionConfirmations.openActionSettings'), onPress: () => router.push(`/settings/actions/${encodeURIComponent(actionId)}`) },
    ]);
}

/** Presents the Off notice when the result is exactly that; the caller keeps its own failure path otherwise. */
export function presentActionTurnedOffNoticeIfOff(result: Readonly<{ errorCode?: unknown }>, actionId: string): boolean {
    if (!isActionTurnedOffErrorCode(result.errorCode)) return false;
    presentActionTurnedOffNotice(actionId);
    return true;
}
