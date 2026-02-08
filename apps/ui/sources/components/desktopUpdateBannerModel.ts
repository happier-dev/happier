type DesktopUpdateBannerTranslationKey =
    | 'common.error'
    | 'updateBanner.updateAvailable'
    | 'common.loading'
    | 'common.retry'
    | 'updateBanner.pressToApply';

type DesktopUpdateBannerStatus =
    | 'idle'
    | 'checking'
    | 'available'
    | 'installing'
    | 'error'
    | 'dismissed'
    | 'upToDate';

export function getDesktopUpdateBannerModel(params: {
    status: DesktopUpdateBannerStatus;
    availableVersion: string | null;
    error: string | null;
    t: (key: DesktopUpdateBannerTranslationKey) => string;
}): { message: string; actionLabel: string; actionDisabled: boolean } {
    const { status, availableVersion, error, t } = params;

    const message =
        status === 'error'
            ? t('common.error')
            : availableVersion
                ? `${t('updateBanner.updateAvailable')}: v${availableVersion}`
                : t('updateBanner.updateAvailable');

    const actionLabel =
        status === 'installing'
            ? t('common.loading')
            : status === 'error'
                ? t('common.retry')
                : t('updateBanner.pressToApply');

    return {
        message,
        actionLabel,
        actionDisabled: status === 'installing',
    };
}
