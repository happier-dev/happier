import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { ProfilesList } from '@/components/profiles/ProfilesList';

type Props = Readonly<{
    maxHeight: number;
    profilesListProps: React.ComponentProps<typeof ProfilesList>;
}>;

const MAX_PROFILE_LIST_HEIGHT = 560;

export function NewSessionProfileChipPopoverContent(props: Props) {
    const boundedHeight = Math.min(props.maxHeight, MAX_PROFILE_LIST_HEIGHT);

    return (
        <View style={[styles.container, { height: boundedHeight, maxHeight: boundedHeight }]}>
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
        backgroundColor: theme.colors.background.canvas,
    },
    listContainer: {
        flex: 1,
        minHeight: 0,
    },
}));
