import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { WelcomeActionCard } from '@/components/onboarding/preAuth/WelcomeActionCard';
import { readOrganizationPolicyFieldState } from '@/components/organizationPolicy/OrganizationPolicyFieldNotice';
import { WelcomeActionAdmissionContext } from '@/components/onboarding/preAuth/WelcomeActionList';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { Icon } from '@/components/ui/icons/Icon';
import { AccountServiceMark } from '@/components/settings/account/AccountServiceMark';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import { presentUseServiceAsHomeSheet } from '../serviceHome/UseServiceAsHomeSheet';
import { useJourneyAccountService } from '../useJourneyAccountService';
import { PaneServiceLabel } from '../alreadyUse/journeyPaneKit';
import { presentAlreadyUseHappierSheet } from './AlreadyUseHappierSheet';

/**
 * The Welcome's first-run doorway on every width (lab K1p, first drawn for phones; UI refinements 11-13: one
 * first run, wide only has more room): it asks how to reach a Home. Scan the computer's code (primary),
 * Sign in "with <service> · Change", connect to a Home directly, and — only when the service is also a Home — "No computer yet? Use
 * <service> as your Home". Connecting directly continues as the welcome's own step; the sign-in
 * service ways open as sheets (`AlreadyUseHappierSheet`). Rendered inside the welcome's own action
 * list, so one action runs at a time.
 */
export function PhoneWelcomeDoorway(props: Readonly<{
    canScanQr: boolean;
    /** The welcome's existing scan / paste-a-Home-link entry. */
    onScan: () => void;
    /** The welcome's own step for a Home reached directly (its link or address, then its sign-in); absent when policy denies it. */
    onConnectDirectly?: () => void;
}>) {
    const service = useJourneyAccountService();
    const servicePolicy = readOrganizationPolicyFieldState('accountService');
    const admission = React.useContext(WelcomeActionAdmissionContext);
    const { theme } = useUnistyles();
    const serviceUrl = service.discovery?.endpointUrl ?? service.entry.endpoint.url;
    const { onConnectDirectly } = props;
    return (
        <>
            <WelcomeActionCard
                testID="welcome-doorway-scan"
                primary
                presentation="button"
                title={t(props.canScanQr ? 'homesJourneys.phone.scanComputerCode' : 'connect.enterUrlManually')}
                iconName={props.canScanQr ? 'qr-code' : 'link'}
                onPress={props.onScan}
            />
            <View style={styles.signIn}>
                <WelcomeActionCard
                    testID="welcome-doorway-sign-in"
                    presentation="button"
                    title={t('homesJourneys.signIn')}
                    onPress={() => { presentAlreadyUseHappierSheet('service'); }}
                />
                <View style={styles.serviceLine}>
                    <PaneServiceLabel service={service.name} style={styles.serviceText} />
                    {/* A service fixed by the organization stays named; there is nothing to change it to. */}
                    {servicePolicy.disabled ? null : <>
                        <Text style={styles.serviceText}>·</Text>
                        <HappierPressable
                            testID="welcome-doorway-change-service"
                            accessibilityRole="button"
                            accessibilityLabel={t('homesJourneys.changeServiceLabel', { service: service.name })}
                            onPress={() => { presentAlreadyUseHappierSheet('other_service'); }}
                        >
                            <Text style={styles.changeText}>{t('common.change')}</Text>
                        </HappierPressable>
                    </>}
                </View>
            </View>
            <ListPresentationProvider value="page">
            {/* The welcome panel already draws the box edge its buttons stand on; the sheet stands there too,
                not a page's sheet inset further in (L2: card at 40 under buttons at 24). */}
            <ItemGroup containerStyle={styles.doorwaySheet}>
            {onConnectDirectly ? (
                <Item
                    testID="welcome-doorway-direct"
                    title={t('homesJourneys.pathDirectTitle')}
                    subtitle={t('homesJourneys.pathDirectSubtitle')}
                    icon={<Icon name="hard-drives" size={20} color={theme.colors.text.secondary} />}
                    disabled={admission.pendingActionId !== null}
                    onPress={() => { void admission.run('welcome-doorway-direct', onConnectDirectly); }}
                />
            ) : null}
            {service.hostsHome ? (
                <Item
                    testID="welcome-doorway-service-as-home"
                    title={t('homesJourneys.noComputerYet')}
                    subtitle={t('homesJourneys.serviceAsHomeTitle', { service: service.name })}
                    icon={<AccountServiceMark url={serviceUrl} size={20} />}
                    disabled={admission.pendingActionId !== null}
                    onPress={() => { void admission.run('welcome-doorway-service-as-home', () => { presentUseServiceAsHomeSheet({ serviceName: service.name, serviceUrl }); }); }}
                />
            ) : null}
            </ItemGroup>
            </ListPresentationProvider>
        </>
    );
}

const styles = StyleSheet.create((theme) => ({
    doorwaySheet: {
        marginHorizontal: 0,
    },
    signIn: {
        gap: theme.space.s8,
    },
    serviceLine: {
        flexDirection: 'row',
        justifyContent: 'center',
        alignItems: 'center',
        gap: theme.space.s6,
    },
    serviceText: {
        ...Typography.default(),
        fontSize: 14,
        lineHeight: 20,
        color: theme.colors.text.secondary,
    },
    changeText: {
        ...Typography.variant('label'),
        color: theme.colors.text.primary,
        textDecorationLine: 'underline',
    },
}));
