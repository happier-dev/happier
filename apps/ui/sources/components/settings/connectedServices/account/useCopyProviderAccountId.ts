import * as React from 'react';

import { publishPresentationNotice } from '@/components/sessions/presentation/presentationNotices';
import { useClipboardWrite } from '@/hooks/ui/useClipboardWrite';
import { t } from '@/text';

/** Keep the detail menu's existing notice while sharing native clipboard admission. */
export function useCopyProviderAccountId() {
    const [enabled, onMenuOpenChange] = React.useState(false);
    const writeClipboard = useClipboardWrite(undefined, { enabled });
    const copyProviderAccountId = async (value: string): Promise<void> => {
        const copied = await writeClipboard(value);
        publishPresentationNotice({
            key: 'connected-services.account.copyAccountId',
            severity: copied ? 'info' : 'error',
            message: copied
                ? t('items.copiedToClipboard', { label: t('connectedServices.profile.providerAccountId') })
                : t('items.failedToCopyToClipboard'),
        });
    };
    return { copyProviderAccountId, onMenuOpenChange };
}
