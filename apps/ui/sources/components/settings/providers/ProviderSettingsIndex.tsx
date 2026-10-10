import * as React from 'react';
import { View } from 'react-native';
import { Redirect, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useIsFocused } from '@/components/appShell/workspace/destinationRoute';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Text } from '@/components/ui/text/Text';
import { SettingAnchor, SettingSection, useSettingRevealRequested } from '@/components/settings/shell/SettingRow';
import { Typography } from '@/constants/Typography';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { ProviderIcon } from '@/providers/connection/ProviderIcon';
import { useProviderSettingsTarget } from '@/providers/hooks/targetMachine';
import { useProviderConnections } from '@/providers/hooks/useProviderConnections';
import { t } from '@/text';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { ProviderConnectionsSettingsScreen } from './ProviderConnectionsSettingsScreen';
import { useClaimProviderCollectionPane } from './ProviderSettingsLayout';
import { PROVIDERS_SETTINGS } from './providersSettings';
import { ProviderErrorItems } from './ProviderErrorItems';
import { ProviderFeatureAvailabilityNotice, useProviderFeatureAvailability } from './ProviderFeatureAvailability';
import { AddProviderMenu, newProviderRoute } from './collection/AddProviderMenu';
import {
    buildProviderCollection,
    providerConnectionDetailRoute,
    readLastVisitedProviderConnectionId,
    resolveProviderCollectionLandingId,
} from './collection/providerCollectionModel';
import { useHappierCollectionIndexView } from '@happier-dev/plugin-ui/presentation';

/** How many catalog marks the invitation shows. */
const INVITATION_MARK_COUNT = 5;
const PROVIDER_COLLECTION_SETTINGS = Object.values(PROVIDERS_SETTINGS.settings);
const CONNECTED_SERVICES_ROUTE = '/(app)/settings/connected-services';

/**
 * `/settings/providers`. Beside the rail the index normally lands on a selected provider;
 * with nothing to select it is a warm invitation to add the first. Where no rail shows, the index is
 * the provider list and each row pushes its detail. Search keeps requested collection controls visible.
 */
export const ProviderSettingsIndex = React.memo(function ProviderSettingsIndex() {
    const view = useHappierCollectionIndexView();
    const collectionSettingRequested = useSettingRevealRequested(PROVIDER_COLLECTION_SETTINGS);
    if (view === 'pending') return null;
    if (view === 'land' && !collectionSettingRequested) return <ProviderCollectionLanding />;
    return <ProviderConnectionsSettingsScreen variant="page" />;
});

const ProviderCollectionLanding = React.memo(function ProviderCollectionLanding() {
    const router = useRouter();
    const focused = useIsFocused();
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const { enabled, presentation: availabilityPresentation } = useProviderFeatureAvailability();
    const localDiscoveryEnabled = useFeatureEnabled('providers.localDiscovery');
    const providerTarget = useProviderSettingsTarget();
    const { machineId, serverId } = providerTarget;
    const { data, error, loading, refresh } = useProviderConnections({ enabled, active: focused, machineId, serverId });
    const collection = React.useMemo(() => buildProviderCollection({
        data, query: '', localDiscoveryEnabled,
    }), [data, localDiscoveryEnabled]);
    const navigate = React.useCallback((href: string) => {
        const result = runGuardedNavigation(() => router.replace(href as never));
        if (result !== true) fireAndForget(result, { tag: 'ProviderCollectionLanding.navigate' });
    }, [router]);

    const landingId = resolveProviderCollectionLandingId(collection.connections, readLastVisitedProviderConnectionId());
    const unreadable = !availabilityPresentation && !data && Boolean(error) && !loading;
    // Wait for the collection's answer so the invitation never flashes over an existing collection.
    const waiting = !availabilityPresentation && !unreadable && (loading || !data);
    // Every state but a landing on a provider (or the wait for one) is a whole-page state.
    useClaimProviderCollectionPane(!landingId && !waiting);

    if (landingId) return <Redirect href={providerConnectionDetailRoute(landingId) as never} />;

    if (availabilityPresentation) {
        return (
            <ItemList>
                <SettingSection section={PROVIDERS_SETTINGS.sectionRefs.connections} answersFor={[PROVIDERS_SETTINGS.sectionRefs.local]}>
                    <ItemGroup><ProviderFeatureAvailabilityNotice presentation={availabilityPresentation} /></ItemGroup>
                </SettingSection>
            </ItemList>
        );
    }
    // The collection could not be read: say what failed with its recovery, never a blank pane.
    if (unreadable && error) {
        return (
            <ItemList>
                <SettingSection section={PROVIDERS_SETTINGS.sectionRefs.connections} answersFor={[PROVIDERS_SETTINGS.sectionRefs.local]}>
                <ItemGroup>
                    <ProviderErrorItems error={error} retry={async () => { await refresh(); }} />
                </ItemGroup>
                </SettingSection>
            </ItemList>
        );
    }
    if (waiting) return <ItemList>{null}</ItemList>;
    if (!data) return <ItemList>{null}</ItemList>;

    const available = data.available;
    const marks = available.filter((provider) => provider.icon).slice(0, INVITATION_MARK_COUNT);
    const openConnectedServices = () => {
        const result = runGuardedNavigation(() => router.push(CONNECTED_SERVICES_ROUTE as never));
        if (result !== true) fireAndForget(result, { tag: 'ProviderCollectionLanding.connectedServices' });
    };
    return (
        <ItemList>
            <SettingSection section={PROVIDERS_SETTINGS.sectionRefs.connections} answersFor={[PROVIDERS_SETTINGS.sectionRefs.local]}>
                <SettingAnchor setting={PROVIDERS_SETTINGS.settings.connections}>
                <EmptyState
                    testID="settings-providers-invitation"
                    layout="page"
                    icon={marks.length > 0 ? (
                        <View style={styles.marks}>
                            {marks.map((provider) => (
                                <ProviderIcon key={provider.contributionKey} icon={provider.icon} size={24} color={theme.colors.text.secondary} />
                            ))}
                        </View>
                    ) : (
                        <ProviderIcon icon={null} size={29} color={theme.colors.text.secondary} />
                    )}
                    title={t('settingsProvidersCollection.invitationTitle')}
                    subtitle={t('settingsProvidersCollection.invitationAccountDescription')}
                    action={(
                        <View style={styles.invitationActions}>
                            <View style={styles.actions}>
                                <AddProviderMenu
                                    available={available}
                                    include="catalog"
                                    onAdd={navigate}
                                    renderTrigger={(toggle) => (
                                        <RoundButton
                                            testID="settings-providers-invitation-add"
                                            size="normal"
                                            title={t('settingsProvidersCollection.addProvider')}
                                            disabled={available.length === 0}
                                            onPress={toggle}
                                        />
                                    )}
                                />
                                <SettingAnchor setting={PROVIDERS_SETTINGS.settings.custom}>
                                <RoundButton
                                    testID="settings-providers-invitation-custom"
                                    size="normal"
                                    display="secondary"
                                    title={t('settingsProvidersCollection.customEndpoint')}
                                    onPress={() => navigate(newProviderRoute(null))}
                                />
                                </SettingAnchor>
                            </View>
                            {/* The most common confusion: subscriptions are not providers. */}
                            <Text style={styles.pointer}>
                                {t('settingsProvidersCollection.subscriptionsPointerLead')}
                                <Text
                                    testID="settings-providers-invitation-connected-services"
                                    accessibilityRole="link"
                                    style={styles.pointerLink}
                                    onPress={openConnectedServices}
                                >
                                    {t('settingsProvidersCollection.subscriptionsPointerLink')}
                                </Text>
                                {t('settingsProvidersCollection.subscriptionsPointerTail')}
                            </Text>
                        </View>
                    )}
                />
                </SettingAnchor>
            </SettingSection>
        </ItemList>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    marks: {
        flexDirection: 'row',
        gap: 14,
    },
    invitationActions: {
        alignItems: 'center',
        gap: 14,
    },
    actions: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        justifyContent: 'center',
        gap: 8,
    },
    pointer: {
        ...Typography.default(),
        fontSize: 12,
        lineHeight: 17,
        textAlign: 'center',
        color: theme.colors.text.tertiary,
    },
    pointerLink: {
        color: theme.colors.text.secondary,
        textDecorationLine: 'underline',
    },
}));
