import * as React from 'react';
import type { QualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
import { sameQualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
import type { QualifiedConnectedAccountProfileV4 } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import { formatSavedSecretCatalogReferenceV1, type SavedSecretCatalogEntryV1 } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import { listSavedSecretReferenceCatalogRefsV1, type AccountSettingsSavedSecretReference } from '@happier-dev/protocol/account/settings/savedSecretMutationOwner';

import { useSavedSecretCatalogEntries } from '@/components/secrets/useSavedSecretCatalog';
import { useActiveServerAccountScope, useProfile } from '@/sync/store/hooks';
import { projectConnectedAccountCredentialReferenceSources } from '@/sync/domains/connectedServices/connectedAccountCredentialReferenceSources';
import { selectConnectedMetadataLabels, useConnectedMetadataCatalog } from './useConnectedMetadataCatalog';

export type ConnectedAccountCredentialResourceUse = Readonly<{
    account: QualifiedConnectedAccountRef;
    displayName: string | null;
    /** The delete-review owner's reference, never a UI-generated path. */
    reference: AccountSettingsSavedSecretReference;
}>;

export type ConnectedAccountCredentialResource = Readonly<{
    resourceId: string;
    ref: string;
    /** Null is unknown metadata, never proof that a held key was deleted. */
    entry: SavedSecretCatalogEntryV1 | null;
    /** Connected Account uses only; this is not the complete delete-admission census. */
    usedBy: readonly ConnectedAccountCredentialResourceUse[];
}>;

/** Metadata only: profile-held ids, catalog audience/material status, and the existing reference census. */
export function useConnectedAccountCredentialResources(account: QualifiedConnectedAccountRef): Readonly<{
    profile: QualifiedConnectedAccountProfileV4 | null;
    resources: readonly ConnectedAccountCredentialResource[];
}> {
    const profiles = useProfile(profile => profile.connectedAccountsV4);
    const scope = useActiveServerAccountScope();
    const labelsByKey = useConnectedMetadataCatalog(scope, selectConnectedMetadataLabels);
    const profile = profiles.find(profile => sameQualifiedConnectedAccountRef(profile.ref, account)) ?? null;
    const refs = React.useMemo(() => (profile?.savedSecretResourceIds ?? []).map(resourceId =>
        formatSavedSecretCatalogReferenceV1({ kind: 'shared_resource', id: resourceId })), [profile?.savedSecretResourceIds]);
    const entries = useSavedSecretCatalogEntries({ scope: refs.length > 0 ? scope : null, refs });
    const usesByRef = React.useMemo(() => {
        const uses = new Map<string, ConnectedAccountCredentialResourceUse[]>();
        for (const credential of projectConnectedAccountCredentialReferenceSources(profiles, labelsByKey)) {
            for (const reference of listSavedSecretReferenceCatalogRefsV1({ profileRecords: [],
                connectedAccountCredentials: [credential],
            })) {
                const held = uses.get(reference.secretId) ?? [];
                held.push({ account: credential.account, displayName: credential.displayName ?? null,
                    reference: { owner: reference.owner, path: reference.path, referrer: reference.referrer } });
                uses.set(reference.secretId, held);
            }
        }
        return uses;
    }, [profiles, labelsByKey]);
    const resources = React.useMemo((): readonly ConnectedAccountCredentialResource[] => {
        const byRef = new Map(entries.map(entry => [entry.ref, entry]));
        return (profile?.savedSecretResourceIds ?? []).map((resourceId, index) => ({
            resourceId, ref: refs[index]!, entry: byRef.get(refs[index]!) ?? null, usedBy: usesByRef.get(refs[index]!) ?? [],
        }));
    }, [entries, profile?.savedSecretResourceIds, refs, usesByRef]);
    return React.useMemo(() => ({ profile, resources }), [profile, resources]);
}
