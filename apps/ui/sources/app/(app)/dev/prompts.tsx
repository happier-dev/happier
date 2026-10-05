import * as React from 'react';
import { useLocalSearchParams } from 'expo-router';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { PromptsSpecimen, type PromptsSpecimenState } from '@/components/dev/prompts/PromptsSpecimen';

const STATES: readonly PromptsSpecimenState[] = ['picker', 'nothingSaved', 'noMatches', 'olderLoading', 'composer', 'message', 'save', 'saveInPlace'];

/** Dev-only: the composer prompt picker and library button in the lab's states, credential-free for clean-browser visual QA. */
export default function PromptsDevScreen() {
    const params = useLocalSearchParams<{ state?: string; q?: string; touch?: string }>();
    const state = STATES.find((candidate) => candidate === params.state) ?? 'picker';
    return (
        <View style={styles.container} testID="dev-prompts-screen">
            <PromptsSpecimen state={state} query={params.q} touch={params.touch === '1'} />
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    container: { flex: 1, backgroundColor: theme.colors.background.canvas },
}));
