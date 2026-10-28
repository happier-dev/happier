import { Modal } from '@/modal';
import { t } from '@/text';
import { setClipboardStringSafe } from '@/utils/ui/clipboard';

import type { SessionDebugInformation } from './sessionDebugInformation';

export const SESSION_COPY_DEBUG_INFORMATION_MENU_ITEM_ID = 'session.copyDebugInformation';
export const SESSION_COPY_ID_MENU_ITEM_ID = 'session.copySessionId';
export const SESSION_COPY_PROVIDER_ID_MENU_ITEM_ID = 'session.copyProviderSessionId';

export type SessionCopyActionId =
    | typeof SESSION_COPY_DEBUG_INFORMATION_MENU_ITEM_ID
    | typeof SESSION_COPY_ID_MENU_ITEM_ID
    | typeof SESSION_COPY_PROVIDER_ID_MENU_ITEM_ID;

export function isSessionCopyActionId(id: string): id is SessionCopyActionId {
    return id === SESSION_COPY_DEBUG_INFORMATION_MENU_ITEM_ID
        || id === SESSION_COPY_ID_MENU_ITEM_ID
        || id === SESSION_COPY_PROVIDER_ID_MENU_ITEM_ID;
}

export async function copySessionDebugInformationToClipboard(
    debugInformation: SessionDebugInformation,
    actionId: SessionCopyActionId = SESSION_COPY_DEBUG_INFORMATION_MENU_ITEM_ID,
): Promise<boolean> {
    const text = actionId === SESSION_COPY_ID_MENU_ITEM_ID
        ? debugInformation.happierSessionId
        : actionId === SESSION_COPY_PROVIDER_ID_MENU_ITEM_ID
            ? debugInformation.providerSessionId
            : debugInformation.text;
    if (!text) return false;
    const copied = await setClipboardStringSafe(text);
    if (!copied) {
        Modal.alert(t('common.error'), t('sessionInfo.failedToCopyMetadata'));
        return false;
    }

    return true;
}
