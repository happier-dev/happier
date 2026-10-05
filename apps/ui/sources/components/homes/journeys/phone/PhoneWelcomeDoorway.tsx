import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { WelcomeActionCard } from '@/components/onboarding/preAuth/WelcomeActionCard';
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
 * The phone's doorway on its welcome screen (lab K1p): a phone never hosts a Home, so its first run
 * asks how to reach one. Scan the computer's code (primary), Sign in "with <service> · Change",
 * connect to a Home directly, and — only when the service is also a Home — "No computer yet? Use
 * <service> as your Home". Each opens its path as a sheet (`AlreadyUseHappierSheet`). Rendered inside
 * the welcome's own action list, so one action runs at a time.
 */
export function PhoneWelcomeDoorway(props: Readonly<{
    canScanQr: boolean;
    /** The welcome's existing scan / paste-a-Home-link entry. */
    onScan: () => void;
}>) {
    const service = useJourneyAccountService();
    const admission = React.useContext(WelcomeActionAdmissionContext);
    const { theme } = useUnistyles();
    const serviceUrl = service.discovery?.endpointUrl ?? service.entry.endpoint.url;
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
                    <Text style={styles.serviceText}>·</Text>
                    <HappierPressable
                        testID="welcome-doorway-change-service"
                        accessibilityRole="button"
                        accessibilityLabel={t('homesJourneys.changeServiceLabel', { service: service.name })}
                        onPress={() => { presentAlreadyUseHappierSheet('other_service'); }}
                    >
                        <Text style={styles.changeText}>{t('common.change')}</Text>
                    </HappierPressable>
                </View>
            </View>
            <ListPresentationProvider value="page">
            <ItemGroup>
            <Item
                testID="welcome-doorway-direct"
                title={t('homesJourneys.pathDirectTitle')}
                subtitle={t('homesJourneys.pathDirectSubtitle')}
                icon={<Icon name="hard-drives" size={20} color={theme.colors.text.secondary} />}
                disabled={admission.pendingActionId !== null}
                onPress={() => { void admission.run('welcome-doorway-direct', () => { presentAlreadyUseHappierSheet('direct'); }); }}
            />
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
    signIn: {
        gap: 8,
    },
    serviceLine: {
        flexDirection: 'row',
        justifyContent: 'center',
        alignItems: 'center',
        gap: 6,
    },
    serviceText: {
        ...Typography.default(),
        fontSize: 14,
        lineHeight: 20,
        color: theme.colors.text.secondary,
    },
    changeText: {
        ...Typography.default('medium'),
        fontSize: 14,
        lineHeight: 20,
        color: theme.colors.text.primary,
        textDecorationLine: 'underline',
    },
}));
