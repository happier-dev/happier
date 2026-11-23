import type { SavedSecretReferenceCatalogsV1 } from '@happier-dev/protocol/account/settings/savedSecretMutationOwner';
import type { QualifiedConnectedAccountProfileV4 } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';

import { t } from '@/text';
import { humanizeConnectedServiceIdentity } from './connectedServiceIdentityLabel';
import type { ConnectedAccountIdentityPresenter } from './maskAccountEmail';
import { presentConnectedAccountName } from './qualifiedConnectedAccountTargetPresentation';
import { resolveQualifiedConnectedAccountLabel } from './connectedServiceProfilePreferences';

/** The named, value-free credential inventory used by delete review and passive Used by rows. */
export function projectConnectedAccountCredentialReferenceSources(
    accounts: readonly QualifiedConnectedAccountProfileV4[],
    labelsByKey: Readonly<Record<string, string | undefined>>,
    presentIdentity?: ConnectedAccountIdentityPresenter,
): NonNullable<SavedSecretReferenceCatalogsV1['connectedAccountCredentials']> {
    return accounts.flatMap(account => account.savedSecretResourceIds?.length ? [{
        account: account.ref,
        displayName: presentConnectedAccountName({
            userLabel: resolveQualifiedConnectedAccountLabel({ labelsByKey, service: account.ref.service, accountId: account.ref.accountId }),
            serviceTitle: humanizeConnectedServiceIdentity(account.ref.service.localId) || t('connectedServices.fallbackName'),
            providerDisplayName: account.displayName,
            email: account.providerIdentity?.email,
            presentIdentity,
            accountId: account.ref.accountId,
            providerAccountId: account.providerIdentity?.accountId,
        }).primaryLabel,
        savedSecretResourceIds: account.savedSecretResourceIds,
    }] : []);
}
