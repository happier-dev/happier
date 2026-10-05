import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { FindBarSpecimen } from '@/components/dev/pluginUi/FindBarSpecimen';
import { NextPendingSpecimen } from '@/components/dev/pluginUi/NextPendingSpecimen';
import { SearchTextInFilesSpecimen } from '@/components/dev/pluginUi/SearchTextInFilesSpecimen';
import { HistoryPreviewSpecimen } from '@/components/dev/pluginUi/HistoryPreviewSpecimen';

/** Dev-only: the shared Find bar in every Find lab state (`fx` / `ffind`) and Next (`fnext`), credential-free for clean-browser visual QA. */
export default function FindDevScreen() {
    return (
        <ScrollView style={styles.container} testID="dev-find-screen">
            <View style={styles.content}>
                <FindBarSpecimen />
                <NextPendingSpecimen />
                <SearchTextInFilesSpecimen />
                <HistoryPreviewSpecimen />
            </View>
        </ScrollView>
    );
}

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.background.canvas,
    },
    content: {
        padding: 28,
    },
}));
