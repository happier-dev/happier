import { SavedSecretCatalogEntryV1Schema } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';

/** Catalog metadata only: the demo never has secret values or usable credentials. */
export function buildDemoSavedSecretMetadata() {
    return [SavedSecretCatalogEntryV1Schema.parse({ ref: formatSharedSavedSecretRefV1('demo-preview-token'), source: 'shared_resource', relationship: 'owner',
        name: 'Preview deploy token', kind: 'token', revision: 1, materialStatus: 'ready',
        capabilities: { use: false, rename: false, rotate: false, manageAccess: false, delete: false } })];
}
