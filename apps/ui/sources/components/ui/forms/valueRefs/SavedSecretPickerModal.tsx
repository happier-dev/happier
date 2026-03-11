import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { CustomModalInjectedProps } from '@/modal';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SecretsList } from '@/components/secrets/SecretsList';
import type { SavedSecret } from '@/sync/domains/settings/savedSecretTypes';
import { useSettingMutable } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { Typography } from '@/constants/Typography';
import { Text } from '@/components/ui/text/Text';

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        width: '100%',
        maxWidth: 720,
        maxHeight: 720,
        backgroundColor: theme.colors.groupped.background,
        borderRadius: 14,
        overflow: 'hidden',
    },
    header: {
        paddingHorizontal: 16,
        paddingTop: 16,
        paddingBottom: 12,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.divider,
    },
    headerText: {
        ...Typography.default('semiBold'),
        fontSize: 16,
        color: theme.colors.text,
    },
}));

export type SavedSecretPickerModalProps = CustomModalInjectedProps & Readonly<{
    secrets: SavedSecret[];
    onChangeSecrets: (next: SavedSecret[]) => void;
    selectedId: string | null;
    onSelectId: (id: string | null) => void;
}>;

export function SavedSecretPickerModal(props: SavedSecretPickerModalProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const [liveSecrets, setLiveSecrets] = useSettingMutable('secrets');
    void theme;

    return (
        <View style={styles.container}>
            <View style={styles.header}>
                <Text style={styles.headerText}>{t('settings.mcpServersPickSecretTitle')}</Text>
            </View>

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
        </View>
    );
}
