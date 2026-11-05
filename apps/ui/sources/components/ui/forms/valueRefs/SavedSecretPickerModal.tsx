import * as React from 'react';

import type { CustomModalInjectedProps } from '@/modal';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SecretsList } from '@/components/secrets/SecretsList';
import { useSavedSecretCatalog } from '@/components/secrets/useSavedSecretCatalog';
import { t } from '@/text';
import type { AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import { SharedSavedSecretReferenceSelectionV1Schema, type SharedSavedSecretReferenceSelectionV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';

export type SavedSecretPickerModalProps = CustomModalInjectedProps & Readonly<{
    /** The source editor's captured Home, retained when this modal stays mounted. */
    scope?: AccountSettingsScope | null;
    /**
     * Whether the list offers an explicit "None" row. Callers that own their own
     * unbind gesture (and would otherwise show unrelated copy for it) pass false.
     */
    includeNoneRow?: boolean;
    /**
     * Whether a new secret can be created from inside the picker. Callers whose
     * own creation flow carries extra disclosure pass false so this surface
     * stays a pure selector.
     */
    allowAdd?: boolean;
    /**
     * Whether a stored secret can be renamed, replaced or deleted from inside the picker. Callers
     * that own the secret list keep these; a caller that only needs to bind an existing record —
     * and whose own flow carries the disclosure for writing one — passes false so the picker cannot
     * mutate the account from behind that disclosure.
     */
    allowEdit?: boolean;
}> & (Readonly<{ selectedId: string | null; onSelectId: (id: string | null) => void }>
    | Readonly<{ referenceSelection: Readonly<{
        selected: SharedSavedSecretReferenceSelectionV1 | null;
        onSelect: (selection: SharedSavedSecretReferenceSelectionV1) => void;
    }> }>);

export function SavedSecretPickerModal(props: SavedSecretPickerModalProps) {
    const referenceSelection = 'referenceSelection' in props ? props.referenceSelection : null;
    const catalog = useSavedSecretCatalog({
        ...(Object.prototype.hasOwnProperty.call(props, 'scope') ? { scope: props.scope ?? null } : {}),
        includeMaterial: referenceSelection === null,
    });
    const includeNoneRow = referenceSelection === null && props.includeNoneRow !== false;
    const selectedId = referenceSelection?.selected?.ref ?? ('selectedId' in props ? props.selectedId : null);
    const onSelectId = (id: string) => {
        if (referenceSelection) {
            const resolution = catalog.resolveReference(id);
            if (resolution.kind !== 'shared_resource' || resolution.status !== 'ready') return;
            const selection = SharedSavedSecretReferenceSelectionV1Schema.safeParse({ ref: id, resourceRevision: resolution.revision });
            if (!selection.success) return;
            referenceSelection.onSelect(selection.data);
        } else if ('onSelectId' in props) props.onSelectId(id || null);
        props.onClose();
    };
    const retrySharedCatalog = React.useCallback(() => {
        void catalog.reload().catch(() => {});
    }, [catalog.reload]);

    return (
        <ItemList presentation="grouped" keyboardShouldPersistTaps="handled">
            <SecretsList
                wrapInItemList={false}
                secrets={catalog.picker.personalSecrets}
                sharedEntries={catalog.picker.sharedEntries}
                resolveSharedReference={catalog.resolveReference}
                sharedCatalogStale={catalog.status === 'error' || (catalog.status === 'ready' && catalog.stale)}
                onRetrySharedCatalog={retrySharedCatalog}
                // Add manages a standalone Saved Secret; binding remains a separate row selection.
                onCreatePersonal={catalog.personalMutations.create}
                onRenamePersonal={catalog.personalMutations.rename}
                onRotatePersonal={catalog.personalMutations.rotate}
                onDeletePersonal={catalog.personalMutations.delete}
                selectedId={selectedId ?? ''}
                onSelectId={onSelectId}
                includeNoneRow={includeNoneRow}
                noneSubtitle={includeNoneRow ? t('settings.mcpServersPickSecretNoneSubtitle') : undefined}
                allowAdd={props.allowAdd !== false}
                allowEdit={referenceSelection === null && props.allowEdit !== false}
            />
        </ItemList>
    );
}
