import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { AccountServiceMark } from '@/components/settings/account/AccountServiceMark';
import { useAccountEntryFlow } from '@/components/navigation/accountEntry/useAccountEntryFlow';
import type { CompletedAccountPostAuthResult } from '@/sync/ops/accountDirectory/completeAccountServicePostAuth';
import type { AuthenticatedAccountEntryRequest } from '@/components/navigation/accountEntry/authenticatedAccountEntryRoute';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import type { CustomModalInjectedProps } from '@/modal/types';
import type { FocusReturnRef } from '@/keyboard/focusReturn';
import { t } from '@/text';
import { readViewportClass, useViewportClass } from '@/utils/platform/useViewportClass';
import { useUsableHomeServerIds } from '@/sync/domains/scope/usableHomeServerIds';
import { shouldFocusConnectedHome } from '../../add/addHomeFlowModel';

import type { ServiceHomeStorage } from '../homesJourneyModel';
import { useJourneyAccountService, useJourneySignInRequest } from '../useJourneyAccountService';
import { EmptyPersonalHomeOption, useEmptyPersonalHomeChoice } from '../reconcile/EmptyPersonalHomeOption';
import {
    areServerProfileIdentifiersEquivalent,
    findPersonalHomeBootstrapCompletedProfile,
    getActiveServerSnapshot,
    listServerProfiles,
    resolveServerProfileScopeId,
} from '@/sync/domains/server/serverProfiles';

/**
 * "Use <service> as your Home" (J3): chosen lightly, never a first-run question. Three outcome facts
 * — always on; this computer keeps running the agents; how the service stores sessions, from the
 * Account modes it creates — then the service's own sign-in. Signing in to a service whose deployment
 * is also a Home enrolls that Home through the existing post-auth owner; it enters only when the
 * device started with no usable Home. Opened only for a service that
 * is a Home (`hostsHome`); names are the configured service's own.
 */
export function UseServiceAsHomeSheet(props: CustomModalInjectedProps) {
    return <UseServiceAsHomeBody onDone={props.onClose} />;
}

/**
 * The body of "Use <service> as your Home": in its sheet, and in place as the Add a Home form's
 * pane. `onDone` runs when the sign-in finishes or the person goes back.
 */
export function UseServiceAsHomeBody(props: Readonly<{ onDone: () => void; shouldFocusNewHome?: boolean }>) {
    const service = useJourneyAccountService();
    const phone = useViewportClass() === 'compact';
    // Standalone sheets capture the same entry policy as the shared Add a Home flow.
    const usableHomesAtEntry = React.useRef(useUsableHomeServerIds()).current;
    const request = useJourneySignInRequest(
        service.discovery,
        props.shouldFocusNewHome ?? shouldFocusConnectedHome(usableHomesAtEntry),
        'use_service_as_home',
    );
    const personal = React.useMemo(() => findPersonalHomeBootstrapCompletedProfile(listServerProfiles()), []);
    const emptyChoice = useEmptyPersonalHomeChoice(personal);
    const { onDone: onClose } = props;
    // The flow also exits when the person goes back. Only a completed entry or
    // enrollment for this service Home may commit the chosen Personal Home removal.
    const done = React.useCallback((completion?: CompletedAccountPostAuthResult) => {
        onClose();
        const completedServiceHome = (completion?.kind === 'home_entered' || completion?.kind === 'home_enrolled')
            && completion.homeServerIdentityId === request?.service.serverIdentityId;
        const leftPersonalHome = completedServiceHome && personal !== null && !areServerProfileIdentifiersEquivalent(
            getActiveServerSnapshot().serverId,
            resolveServerProfileScopeId(personal),
        );
        if (leftPersonalHome) void emptyChoice.commit();
    }, [emptyChoice, onClose, personal, request?.service.serverIdentityId]);
    return (
        <View style={styles.body} testID="use-service-as-home">
            <View style={styles.facts}>
                <Fact icon="wifi-high" title={t('homesJourneys.factAlwaysOn')} detail={t(phone ? 'homesJourneys.phone.factAlwaysOnDetail' : 'homesJourneys.factAlwaysOnDetail')} />
                <Fact icon="laptop" title={t(phone ? 'homesJourneys.phone.factAgents' : 'homesJourneys.factAgents')} detail={t(phone ? 'homesJourneys.phone.factAgentsDetail' : 'homesJourneys.factAgentsDetail')} />
                {service.storage ? <StorageFact storage={service.storage} service={service.name} /> : null}
            </View>
            <EmptyPersonalHomeOption choice={emptyChoice} detail={t('homesJourneys.removeEmptyOfferedDetail')} />
            <Text style={styles.label}>{t('homesJourneys.signInOrCreate', { account: service.accountNoun })}</Text>
            {request ? (
                <ServiceSignIn request={request} onDone={done} />
            ) : service.entry.status === 'loading' ? (
                <SurfaceStateCard testID="use-service-as-home.loading" kind="loading"
                    title={t('homesJourneys.serviceAsHomeTitle', { service: service.name })} accessibilitySemantics="status" />
            ) : (
                <SurfaceStateCard testID="use-service-as-home.unavailable" kind="error"
                    title={t('welcome.signInServiceUnavailableTitle')}
                    reason={t('settingsAccount.accountServiceDiscoveryUnavailableDescription')}
                    accessibilitySemantics="alert"
                    action={{ label: t('common.retry'), onPress: service.entry.retry }} />
            )}
            <Text style={styles.note}>{t('homesJourneys.alreadyUseServiceAsHome', { service: service.name })}</Text>
        </View>
    );
}

function ServiceSignIn(props: Readonly<{ request: AuthenticatedAccountEntryRequest; onDone: (completion?: CompletedAccountPostAuthResult) => void }>) {
    const flow = useAccountEntryFlow({ request: props.request, onExit: (_returnTo, completion) => props.onDone(completion) });
    return <View testID={`use-service-as-home.sign-in.${flow.stage}`}>{flow.content}</View>;
}

function StorageFact(props: Readonly<{ storage: ServiceHomeStorage; service: string }>) {
    switch (props.storage) {
        case 'e2ee':
            return <Fact icon="lock" title={t('homesJourneys.storageE2ee')} detail={t('homesJourneys.storageE2eeDetail', { service: props.service })} />;
        case 'plain':
            return <Fact icon="cloud" title={t('homesJourneys.storagePlain', { service: props.service })} detail={t('homesJourneys.storagePlainDetail')} />;
        case 'e2ee_by_default':
            return <Fact icon="lock" title={t('homesJourneys.storageE2eeByDefault')} detail={t('homesJourneys.storageChoiceDetail')} />;
        case 'plain_by_default':
            return <Fact icon="cloud" title={t('homesJourneys.storagePlainByDefault', { service: props.service })} detail={t('homesJourneys.storageChoiceDetail')} />;
    }
}

function Fact(props: Readonly<{ icon: IconName; title: string; detail: string }>) {
    const { theme } = useUnistyles();
    return (
        <View style={styles.fact}>
            <View style={styles.factIcon}><Icon name={props.icon} size={18} color={theme.colors.text.secondary} /></View>
            <View style={styles.factCopy}>
                <Text style={styles.factTitle}>{props.title}</Text>
                <Text style={styles.factDetail}>{props.detail}</Text>
            </View>
        </View>
    );
}

/** Opens the sheet (from Already use Happier?, About your Home, the laptop nudge or Add a Home). */
export function presentUseServiceAsHomeSheet(input: Readonly<{ serviceName: string; serviceUrl: string; focusReturnRef?: FocusReturnRef }>): string {
    return Modal.show({
        component: UseServiceAsHomeSheet,
        ...(input.focusReturnRef ? { focusReturnRef: input.focusReturnRef } : {}),
        closeOnBackdrop: true,
        chrome: {
            kind: 'card',
            leading: <AccountServiceMark url={input.serviceUrl} size={36} />,
            title: t('homesJourneys.serviceAsHomeTitle', { service: input.serviceName }),
            subtitle: t(readViewportClass() === 'compact' ? 'homesJourneys.phone.serviceAsHomeLead' : 'homesJourneys.serviceAsHomeLead', { service: input.serviceName }),
            dimensions: { width: 560 },
            testID: 'use-service-as-home-sheet',
        },
    });
}

const styles = StyleSheet.create((theme) => ({
    body: {
        gap: 14,
        paddingHorizontal: 20,
        paddingTop: 4,
        paddingBottom: 20,
    },
    facts: {
        gap: 12,
    },
    fact: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 12,
    },
    factIcon: {
        width: 20,
        alignItems: 'center',
        paddingTop: 1,
    },
    factCopy: {
        flex: 1,
        minWidth: 0,
    },
    factTitle: {
        ...Typography.default('semiBold'),
        fontSize: 13.5,
        lineHeight: 19,
        color: theme.colors.text.primary,
    },
    factDetail: {
        ...Typography.default(),
        fontSize: 12.5,
        lineHeight: 17,
        color: theme.colors.text.secondary,
    },
    label: {
        ...Typography.default('semiBold'),
        fontSize: 12.5,
        lineHeight: 17,
        color: theme.colors.text.secondary,
    },
    note: {
        ...Typography.default(),
        fontSize: 12.5,
        lineHeight: 17,
        color: theme.colors.text.secondary,
    },
}));
