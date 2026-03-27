import * as React from 'react';

import type { CustomModalInjectedProps } from '@/modal';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SecretsList } from '@/components/secrets/SecretsList';
import { useSettingMutable } from '@/sync/domains/state/storage';
import { t } from '@/text';

export type SavedSecretPickerModalProps = CustomModalInjectedProps & Readonly<{
    selectedId: string | null;
    onSelectId: (id: string | null) => void;
}>;

export function SavedSecretPickerModal(props: SavedSecretPickerModalProps) {
    const [liveSecrets, setLiveSecrets] = useSettingMutable('secrets');

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
                includeNoneRow
                noneSubtitle={t('settings.mcpServersPickSecretNoneSubtitle')}
                allowAdd
                allowEdit
            />
        </ItemList>
    );
}
