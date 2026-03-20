import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { ProfilesList } from '@/components/profiles/ProfilesList';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

type Props = Readonly<{
    maxHeight: number;
    profilesListProps: React.ComponentProps<typeof ProfilesList>;
}>;

export function NewSessionProfileChipPopoverContent(props: Props) {
    return (
        <View style={[styles.container, { height: Math.min(props.maxHeight, 560) }]}>
            <View style={styles.header}>
                <Text style={styles.title}>
                    {t('newSession.selectAiProfileTitle')}
                </Text>
            </View>

            <View style={styles.listContainer}>
                <ProfilesList {...props.profilesListProps} />
            </View>
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    container: {
        width: 560,
        maxWidth: '100%',
        backgroundColor: theme.colors.groupped.background,
    },
    header: {
        paddingHorizontal: 16,
        paddingTop: 14,
        paddingBottom: 8,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.divider,
    },
    title: {
        fontSize: 12,
        fontWeight: '700',
        letterSpacing: 0.8,
        textTransform: 'uppercase',
        color: theme.colors.textSecondary,
    },
    listContainer: {
        flex: 1,
        minHeight: 0,
    },
}));
