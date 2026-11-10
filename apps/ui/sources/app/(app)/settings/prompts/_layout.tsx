import * as React from 'react';
import { Slot } from '@/components/appShell/workspace/destinationRoute';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { useArtifactInventoryRead } from '@/components/artifacts/useArtifactInventoryRead';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { createSettingsLayoutRoute } from '@/components/settings/navigation/createSettingsLayoutRoute';
import { useArtifactsLoaded } from '@/sync/domains/state/storage';
import { PROMPT_LIBRARY_ARTIFACT_KINDS } from '@/sync/domains/artifacts/artifactInventory';
import { t } from '@/text';

const styles = StyleSheet.create({
    loading: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
    },
});

/**
 * Wait for the library before mounting the active prompt route. The settings stack and each page's
 * PageHeader own navigation and page titles.
 */
const PromptsLayoutRoute = React.memo(function PromptsLayoutRoute() {
    const artifactsLoaded = useArtifactsLoaded(PROMPT_LIBRARY_ARTIFACT_KINDS);
    // The inventory is read while it is unknown; a failed read says so with Retry instead of spinning on.
    const inventory = useArtifactInventoryRead(!artifactsLoaded, PROMPT_LIBRARY_ARTIFACT_KINDS);
    return (
        <>
            {artifactsLoaded ? <Slot /> : inventory.failed ? (
                <SurfaceStateCard
                    testID="prompts.artifacts.failed"
                    kind="error"
                    size="page"
                    title={t('artifacts.browser.loadFailedTitle')}
                    reason={t('artifacts.browser.loadFailedBody')}
                    action={{ label: t('common.retry'), onPress: inventory.retry }}
                />
            ) : (
                <View testID="prompts.artifacts.loading" style={styles.loading}>
                    <ActivitySpinner size="small" />
                </View>
            )}
        </>
    );
});

export default createSettingsLayoutRoute(PromptsLayoutRoute, 'prompts');
