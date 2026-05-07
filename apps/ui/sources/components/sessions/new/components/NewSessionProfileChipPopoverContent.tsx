import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { ProfilesList } from '@/components/profiles/ProfilesList';

type Props = Readonly<{
    maxHeight: number;
    profilesListProps: React.ComponentProps<typeof ProfilesList>;
}>;

export function NewSessionProfileChipPopoverContent(props: Props) {
    const maxHeight = Math.min(props.maxHeight, 560);
    return (
        <View style={[styles.container, { height: maxHeight, maxHeight }]}>
            <View style={styles.listContainer}>
                <ProfilesList {...props.profilesListProps} />
            </View>
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    container: {
        width: '100%',
        maxWidth: '100%',
        backgroundColor: theme.colors.groupped.background,
    },
    listContainer: {
        flex: 1,
        minHeight: 0,
    },
}));
