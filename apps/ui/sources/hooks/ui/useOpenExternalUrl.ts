import { useHappyAction } from '@/hooks/ui/useHappyAction';
import { t } from '@/text';
import { HappyError } from '@/utils/errors/errors';
import { requestOpenExternalUrl } from '@/utils/url/requestOpenExternalUrl';

export async function openExternalUrlOrThrow(url: string): Promise<void> {
    if (!await requestOpenExternalUrl(url)) {
        throw new HappyError(t('connectedServices.oauthPaste.alerts.failedToOpenUrl'), false);
    }
}

export function useOpenExternalUrl(url: string) {
    return useHappyAction(() => openExternalUrlOrThrow(url));
}
