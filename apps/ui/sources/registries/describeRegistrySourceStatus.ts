import { RegistrySourceStatusV1Schema, type RegistrySourceStatusV1 } from '@happier-dev/protocol/registries';
import { t } from '@/text';

/** URL refusals and detected source failures retain the Action owner's typed reason. */
export function describeRegistrySourceInputFailure(error: unknown): string {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
    switch (code) {
        case 'registry_url_https_required': return t('capabilities.registries.add.httpsRequired');
        case 'registry_url_credentials_forbidden': return t('capabilities.registries.add.credentialsInLink');
    }
    const result = error && typeof error === 'object' && 'result' in error ? error.result : null;
    const status = readRegistryFailureStatus(result && typeof result === 'object' && 'details' in result ? result.details : null);
    return status ? describeRegistrySourceStatus(status) : t('capabilities.registries.add.unreachable');
}

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
    // A read that failed without a typed status still says what happened, never a bare "Unavailable".
    const reason = status ? describeRegistrySourceStatus(status) : t('promptLibrary.registriesStatus.unreachable');
    return sourceTitle ? `${sourceTitle} · ${reason}` : reason;
}
/** The registry owner's typed failure (rate limited, token rejected, …) as it crosses an Action failure's details. */
export function readRegistryFailureStatus(details: unknown): RegistryFailureStatus | null {
    const status = details && typeof details === 'object'
        ? RegistrySourceStatusV1Schema.safeParse((details as { registryStatus?: unknown }).registryStatus) : null;
    return status?.success && status.data.state !== 'ok' ? status.data : null;
}
