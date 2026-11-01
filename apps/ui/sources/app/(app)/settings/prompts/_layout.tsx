import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { SettingsStack } from '@/components/settings/navigation/SettingsStack';
import { useArtifactsLoaded } from '@/sync/domains/state/storage';

const styles = StyleSheet.create({
    loading: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
    },
});

function PromptArtifactGate({ children }: Readonly<{ children: React.ReactNode }>) {
    const artifactsLoaded = useArtifactsLoaded();
    if (!artifactsLoaded) {
        return (
            <View testID="prompts.artifacts.loading" style={styles.loading}>
                <ActivitySpinner size="small" />
            </View>
        );
    }
    return <>{children}</>;
}

function renderPromptScreen({ children }: Readonly<{ children: React.ReactNode }>) {
    return <PromptArtifactGate>{children}</PromptArtifactGate>;
}

export default React.memo(function PromptsLayoutRoute() {
    return <SettingsStack scope="prompts" screenLayout={renderPromptScreen} />;
});
