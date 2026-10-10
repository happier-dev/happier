import * as React from 'react';

import type { CustomModalInjectedProps } from '@/modal';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SecretsList } from '@/components/secrets/SecretsList';
import { useSavedSecretCatalog } from '@/components/secrets/useSavedSecretCatalog';
import { t } from '@/text';
import type { AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';

export type SavedSecretPickerModalProps = CustomModalInjectedProps & Readonly<{
    selectedId: string | null;
    onSelectId: (id: string | null) => void;
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
}>;

export function SavedSecretPickerModal(props: SavedSecretPickerModalProps) {
    const catalog = useSavedSecretCatalog(Object.prototype.hasOwnProperty.call(props, 'scope')
        ? { scope: props.scope ?? null }
        : undefined);
    const includeNoneRow = props.includeNoneRow !== false;
    const retrySharedCatalog = React.useCallback(() => {
        void catalog.reload().catch(() => {});
    }, [catalog.reload]);

    return (
        <ItemList presentation="grouped" keyboardShouldPersistTaps="handled">
            <SecretsList
                wrapInItemList={false}
                secrets={catalog.personalSecrets}
                sharedEntries={catalog.sharedEntries}
                resolveSharedReference={catalog.resolveReference}
                sharedCatalogStale={catalog.status === 'error' || (catalog.status === 'ready' && catalog.stale)}
                onRetrySharedCatalog={retrySharedCatalog}
                // Add manages a standalone Saved Secret; binding remains a separate row selection.
                onCreatePersonal={catalog.personalMutations.create}
                onRenamePersonal={catalog.personalMutations.rename}
                onRotatePersonal={catalog.personalMutations.rotate}
                onDeletePersonal={catalog.personalMutations.delete}
                selectedId={props.selectedId ?? ''}
                onSelectId={(id) => {
                    props.onSelectId(id ? id : null);
                    props.onClose();
                }}
                includeNoneRow={includeNoneRow}
                noneSubtitle={includeNoneRow ? t('settings.mcpServersPickSecretNoneSubtitle') : undefined}
                allowAdd={props.allowAdd !== false}
                allowEdit={props.allowEdit !== false}
            />
        </ItemList>
    );
}
