import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { SettingAnchor } from '@/components/settings/shell/SettingRow';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { ProviderIcon } from '@/providers/connection/ProviderIcon';
import { t } from '@/text';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { PROVIDERS_SETTINGS } from '../providersSettings';
import type { ProviderAvailableContribution } from './providerCollectionModel';

/** How many providers an invitation to connect shows before "Browse all": its marks here, its rows on the home. */
export const INVITATION_MARK_COUNT = 5;
const CONNECTED_SERVICES_ROUTE = '/(app)/settings/connected-services';

/**
 * The empty Providers collection, wide or narrow (lab PI1 / PI1p): the catalog's marks, one promise,
 * Add provider leading with Custom endpoint beside it, and the pointer for subscriptions. Both
 * entry controls open the same Add picker; its selected continuation owns authoring navigation.
 */
export const ProviderCollectionInvitation = React.memo(function ProviderCollectionInvitation(props: Readonly<{
    available: ReadonlyArray<ProviderAvailableContribution>;
    onAdd: () => void;
}>) {
    const router = useRouter();
    const { theme } = useUnistyles();
    const marks = props.available.slice(0, INVITATION_MARK_COUNT);
    const openConnectedServices = () => {
        const result = runGuardedNavigation(() => router.push(CONNECTED_SERVICES_ROUTE as never));
        if (result !== true) fireAndForget(result, { tag: 'ProviderCollectionInvitation.connectedServices' });
    };
    return (
        <SettingAnchor setting={PROVIDERS_SETTINGS.settings.connections}>
        <EmptyState
            testID="settings-providers-invitation"
            layout="page"
            icon={marks.length > 0 ? (
                <View style={styles.marks}>
                    {marks.map((provider) => (
                        <ProviderIcon key={provider.contributionKey} contributionKey={provider.contributionKey} icon={provider.icon} size={24} color={theme.colors.text.secondary} />
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
                        <SettingAnchor setting={PROVIDERS_SETTINGS.settings.add}>
                            <RoundButton
                                testID="settings-providers-invitation-add"
                                // One size family for the pair: the fill, not the size, says which leads.
                                size="small"
                                title={t('settingsProvidersCollection.addProvider')}
                                onPress={props.onAdd}
                            />
                        </SettingAnchor>
                        <SettingAnchor setting={PROVIDERS_SETTINGS.settings.custom}>
                        <RoundButton
                            testID="settings-providers-invitation-custom"
                            size="small"
                            display="secondary"
                            title={t('settingsProvidersCollection.customEndpoint')}
                            onPress={props.onAdd}
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
    );
});

const styles = StyleSheet.create((theme) => ({
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
        gap: theme.space.s8,
    },
    pointer: {
        ...Typography.variant('meta'),
        textAlign: 'center',
        color: theme.colors.text.tertiary,
    },
    pointerLink: {
        color: theme.colors.text.secondary,
        textDecorationLine: 'underline',
    },
}));
