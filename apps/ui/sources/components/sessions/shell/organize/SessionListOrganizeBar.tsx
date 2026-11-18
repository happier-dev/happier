import { HAPPIER_COLLECTION_LIST_TEXT, HappierPressable } from '@happier-dev/plugin-ui/presentation';
import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import { sessionListStyles } from '../sessionListStyles';

const stylesheet = StyleSheet.create((theme) => ({
    title: {
        ...Typography.default('semiBold'),
        fontSize: HAPPIER_COLLECTION_LIST_TEXT.title.fontSize,
        lineHeight: HAPPIER_COLLECTION_LIST_TEXT.title.lineHeight,
        color: theme.colors.text.primary,
    },
    done: {
        alignItems: 'flex-end',
        justifyContent: 'center',
    },
    newSectionText: {
        ...Typography.default(),
        color: theme.colors.text.secondary,
    },
    doneText: {
        ...Typography.default('semiBold'),
        color: theme.colors.state.active.textForeground,
    },
}));

/**
 * The title row while the phone list is in Organize mode (lab K1h): the list says what mode it is in,
 * and one Done ends it. It takes the search chrome's place and metrics, so nothing below moves.
 */
export function SessionListOrganizeBar(props: Readonly<{ onDone: () => void; onNewSection?: () => void }>): React.ReactElement {
    const styles = stylesheet;
    return (
        <View style={sessionListStyles.searchChrome} testID="session-list-organize-bar">
            <View style={sessionListStyles.searchChromeControlsRow}>
                <View style={sessionListStyles.searchChromeTitleSlot}>
                    <Text style={styles.title} accessibilityRole="header" numberOfLines={1}>
                        {t('entityDragDrop.organize.title')}
                    </Text>
                </View>
                {props.onNewSection ? (
                    <HappierPressable
                        testID="session-list-organize-new-section"
                        accessibilityRole="button"
                        accessibilityLabel={t('sessionsList.newSection')}
                        onPress={props.onNewSection}
                        style={styles.done}
                    >
                        <Text style={styles.newSectionText}>{t('sessionsList.newSection')}</Text>
                    </HappierPressable>
                ) : null}
                <HappierPressable
                    testID="session-list-organize-done"
                    accessibilityLabel={t('entityDragDrop.organize.done')}
                    onPress={props.onDone}
                    style={styles.done}
                >
                    <Text style={styles.doneText}>{t('entityDragDrop.organize.done')}</Text>
                </HappierPressable>
            </View>
        </View>
    );
}
