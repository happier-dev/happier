import { Modal } from '@/modal';
import { t } from '@/text';
import { setClipboardStringSafe } from '@/utils/ui/clipboard';

import type { SessionDebugInformation } from './sessionDebugInformation';

export async function copySessionDebugInformationToClipboard(
    debugInformation: SessionDebugInformation,
): Promise<boolean> {
    const copied = await setClipboardStringSafe(debugInformation.text);
    if (!copied) {
        Modal.alert(t('common.error'), t('sessionInfo.failedToCopyMetadata'));
        return false;
    }

    return true;
}
