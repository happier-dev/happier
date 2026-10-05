import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';
import { Typography } from '@/constants/Typography';

/** The quiet line every posted snapshot carries (lab VS): it is a copy and it does not update. */
export function WidgetSnapshotNote(): React.ReactElement {
    const { theme } = useUnistyles();
    return (
        <View style={styles.note} testID="widget-snapshot-note">
            <Icon name="cloud" size={13} color={theme.colors.text.tertiary} />
            <Text style={styles.text}>{t('widgetDefinition.snapshotNote')}</Text>
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    note: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingTop: 10 },
    text: { ...Typography.default(), ...happierPageTextMetrics('rowDescription'), flexShrink: 1, color: theme.colors.text.tertiary },
}));
