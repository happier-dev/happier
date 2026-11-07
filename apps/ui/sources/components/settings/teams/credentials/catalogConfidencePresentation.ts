import type { TeamCredentialProviderModelCatalogEntryV1 } from '@happier-dev/protocol/teams';
import { t } from '@/text';

/** Catalog observation, not route availability or experimental-model consent. */
export function teamCredentialCatalogConfidenceLabel(
    row: Pick<TeamCredentialProviderModelCatalogEntryV1, 'confidence'>,
): string | null {
    return row.confidence === 'account_unverified' ? t('settingsProviders.status.notChecked') : null;
}
