import * as React from 'react';

import type { CustomModalInjectedProps } from '@/modal';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SecretsList } from '@/components/secrets/SecretsList';
import { useSavedSecretsMutable } from '@/components/secrets/useSavedSecretsMutable';
import { t } from '@/text';

export type SavedSecretPickerModalProps = CustomModalInjectedProps & Readonly<{
    selectedId: string | null;
    onSelectId: (id: string | null) => void;
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
    const [liveSecrets, setLiveSecrets] = useSavedSecretsMutable();
    const includeNoneRow = props.includeNoneRow !== false;

    return (
        <ItemList keyboardShouldPersistTaps="handled">
            <SecretsList
                wrapInItemList={false}
                secrets={liveSecrets}
                onChangeSecrets={setLiveSecrets}
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
