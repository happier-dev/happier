import React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useHappierMaterialColorResolver } from '@happier-dev/plugin-ui/presentation';

import { useAutomationsSupport } from '@/hooks/server/useAutomationsSupport';
import { ItemList } from '@/components/ui/lists/ItemList';
import { t } from '@/text';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useRouter } from 'expo-router';
import { resolveFeatureToggleHref } from '@/components/settings/features/featuresSettings';
import { useSetting } from '@/sync/domains/state/storage';
import { useEffectiveServerSelection } from '@/hooks/server/useEffectiveServerSelection';
import { getServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';

const stylesheet = StyleSheet.create((theme) => ({
    loadingContainer: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        // The gated pages are paper; the wait before them is the same surface so nothing flashes.
        backgroundColor: theme.colors.surface.base,
    },
}));

export function AutomationsGate(props: { children: React.ReactNode }) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const materialColor = useHappierMaterialColorResolver();
    const support = useAutomationsSupport();
    const router = useRouter();
    const experimentsEnabled = useSetting('experiments') === true;

    if (!support || support.loading) {
        return (
            <View style={[styles.loadingContainer, { backgroundColor: materialColor(theme.colors.surface.base, 'transparent') }]}>
                <ActivitySpinner size="small" color={theme.colors.text.secondary} />
            </View>
        );
    }

    if (!support.enabled) {
        return <AutomationsGateUnavailable support={support} experimentsEnabled={experimentsEnabled} onOpen={(href) => router.push(href as never)} />;
    }

    return <>{props.children}</>;
}

/**
 * Why automations are unavailable, from the canonical availability arm. Each state names its next
 * action only when that action is real: a switch this user can flip links to it; a Home that turned
 * automations off says who can change it; a Home that could not be checked offers to check again and
 * claims nothing about why.
 */
function AutomationsGateUnavailable(props: Readonly<{
    support: ReturnType<typeof useAutomationsSupport>;
    experimentsEnabled: boolean;
    onOpen: (href: string) => void;
}>) {
    const { support } = props;
    const selection = useEffectiveServerSelection();
    const retryProbe = React.useCallback(async () => {
        // The canonical per-Home feature probe, asked again; nothing else can change the answer.
        await Promise.all(selection.serverIds.map((serverId) => getServerFeaturesSnapshot({ serverId, force: true })));
    }, [selection.serverIds]);

    if (support.arm === 'unknown') {
        return (
            <ItemList>
                <SurfaceStateCard
                    testID="automations-gate-unknown"
                    kind="error"
                    iconName="timer"
                    title={t('automationPages.gate.unknownTitle')}
                    reason={t('automationPages.gate.unknownBody')}
                    action={{ label: t('common.retry'), onPress: retryProbe }}
                    accessibilitySemantics="status"
                />
            </ItemList>
        );
    }
    if (support.arm === 'unsupported' || support.arm === 'unsupported_context') {
        const unsupportedHome = support.arm === 'unsupported';
        return (
            <ItemList>
                <SurfaceStateCard
                    testID="automations-gate-unsupported"
                    kind="unavailable"
                    iconName="timer"
                    title={unsupportedHome ? t('automationPages.gate.unsupportedTitle') : t('automationPages.gate.unsupportedContextTitle')}
                    reason={unsupportedHome ? t('automationPages.gate.unsupportedBody') : t('automationPages.gate.unsupportedContextBody')}
                    accessibilitySemantics="status"
                />
            </ItemList>
        );
    }

    const serverBlocked = support.arm === 'server_disabled';
    const settingHref = support.arm === 'policy_disabled' && support.blockedBy === 'local_policy'
        ? resolveFeatureToggleHref('automations', props.experimentsEnabled)
        : undefined;
    return (
        <ItemList>
            <SurfaceStateCard
                testID="automations-gate-disabled"
                kind="unavailable"
                iconName="timer"
                title={serverBlocked ? t('automationPages.gate.serverTitle') : t('automations.gate.disabledTitle')}
                reason={serverBlocked ? t('automationPages.gate.serverBody') : t('automations.gate.disabledBody')}
                {...(settingHref ? {
                    action: {
                        label: t('automationPages.gate.openFeatures'),
                        onPress: () => props.onOpen(settingHref),
                    },
                } : {})}
                accessibilitySemantics="status"
            />
        </ItemList>
    );
}
