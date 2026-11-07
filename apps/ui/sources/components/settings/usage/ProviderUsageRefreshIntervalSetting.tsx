import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { TextInput } from '@/components/ui/text/Text';
import { useSettingMutable } from '@/sync/domains/state/storage';
import { t } from '@/text';

/** Minutes between automatic usage refreshes for every configured provider. */
export function ProviderUsageRefreshIntervalSetting() {
    const styles = stylesheet;
    const [minutes, setMinutes] = useSettingMutable('providerUsageAutoRefreshMinutes');
    const [draft, setDraft] = React.useState(String(minutes));
    React.useEffect(() => setDraft(String(minutes)), [minutes]);
    return (
        <ItemGroup footer={t('settingsUsage.autoRefreshMinutesDescription')}>
            <Item
                title={t('settingsUsage.autoRefreshMinutes')}
                showChevron={false}
                rightElement={(
                    <View style={styles.inputWrap}>
                        <TextInput
                            testID="settings-usage-auto-refresh-minutes"
                            value={draft}
                            onChangeText={(text) => {
                                const digits = text.replace(/[^0-9.]/g, '');
                                setDraft(digits);
                                const parsed = Number(digits);
                                if (digits !== '' && Number.isFinite(parsed) && parsed > 0) setMinutes(parsed);
                            }}
                            keyboardType="numeric"
                            accessibilityLabel={t('settingsUsage.autoRefreshMinutes')}
                            style={styles.input}
                        />
                    </View>
                )}
            />
        </ItemGroup>
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    inputWrap: { minWidth: 56 },
    input: {
        textAlign: 'right',
        color: theme.colors.text.primary,
        paddingVertical: 4,
    },
}));
