import { useHappyAction } from '@/hooks/ui/useHappyAction';
import { t } from '@/text';
import { HappyError } from '@/utils/errors/errors';
import { openExternalUrl } from '@/utils/url/openExternalUrl';

export function useOpenExternalUrl(url: string) {
    return useHappyAction(async () => {
        if (!await openExternalUrl(url)) {
            throw new HappyError(t('connectedServices.oauthPaste.alerts.failedToOpenUrl'), false);
        }
    });
}
