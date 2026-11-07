import { t } from '@/text';

/** Present the registry owner's refusal without interpreting private credential material. */
export function describeNpmRegistryOperationError(code: string): string | null {
    let reason: string;
    switch (code) {
        case 'authentication_required': reason = t('settingsPlugins.registriesErrorReason.authentication_required'); break;
        case 'authentication_failed': reason = t('settingsPlugins.registriesErrorReason.authentication_failed'); break;
        case 'offline': reason = t('settingsPlugins.registriesErrorReason.offline'); break;
        case 'unavailable': reason = t('settingsPlugins.registriesErrorReason.unavailable'); break;
        case 'web_login_unsupported': reason = t('settingsPlugins.registriesErrorReason.web_login_unsupported'); break;
        case 'external_link_unavailable': reason = t('settingsPlugins.registriesErrorReason.external_link_unavailable'); break;
        default: return null;
    }
    return `${reason}\n${code}`;
}
