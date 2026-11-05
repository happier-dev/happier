import { RegistrySourceStatusV1Schema, type RegistrySourceStatusV1 } from '@happier-dev/protocol/registries';
import { t } from '@/text';

/** One status line shared by registry consumers and the Add-modal source failures. */
export function describeRegistrySourceStatus(status: RegistrySourceStatusV1): string {
    switch (status.state) {
        case 'ok': return '';
        case 'rate_limited': return t('promptLibrary.registriesStatus.limited', {
            time: status.retryAt === undefined ? undefined
                : new Date(status.retryAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }),
        });
        case 'unreachable': return t('promptLibrary.registriesStatus.unreachable');
        case 'auth_failed': return t('promptLibrary.registriesStatus.authFailed');
        case 'needs_machine': return t('promptLibrary.registriesStatus.needsMachine');
        case 'newer_format': return t('promptLibrary.registriesStatus.newerFormat');
        case 'invalid_source': return t('promptLibrary.registriesStatus.invalidSource');
    }
}

export type RegistryFailureStatus = Exclude<RegistrySourceStatusV1, { state: 'ok' }>;

/** Human-facing source identity and typed reason; transport exception text is never presentation input. */
export function describeRegistrySourceFailure(status: RegistryFailureStatus | null, sourceTitle?: string | null): string {
    const reason = status ? describeRegistrySourceStatus(status) : t('common.unavailable');
    return sourceTitle ? `${sourceTitle} · ${reason}` : reason;
}
/** The registry owner's typed failure (rate limited, token rejected, …) as it crosses an Action failure's details. */
export function readRegistryFailureStatus(details: unknown): RegistryFailureStatus | null {
    const status = details && typeof details === 'object'
        ? RegistrySourceStatusV1Schema.safeParse((details as { registryStatus?: unknown }).registryStatus) : null;
    return status?.success && status.data.state !== 'ok' ? status.data : null;
}
