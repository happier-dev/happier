import type { SavedSecretExternalSourceV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';

import { t } from '@/text';

/**
 * Describe only what recipients receive; this never accepts a vault value. A typed value is shared
 * as a value. A vault field is shared as a reference each person reads with their own sign-in, so the
 * disclosure names where it lives (provider, account, vault › item › field) and the reference itself.
 */
export function savedSecretShareDisclosureMessage(source?: SavedSecretExternalSourceV1, providerTitle?: string): string {
    if (!source) return t('secretsSettings.sharingDescription');
    const provider = providerTitle || source.account || source.reference;
    const path = [source.metadata?.vault.name, source.metadata?.item.title, source.metadata?.field.title]
        .filter((part): part is string => Boolean(part)).join(' › ');
    const where = [providerTitle && source.account ? `${providerTitle} · ${source.account}` : null, path || null]
        .filter((line): line is string => Boolean(line));
    return [t('secretsSettings.sharingReferenceDescription', { provider }), ...where, source.reference].join('\n\n');
}
