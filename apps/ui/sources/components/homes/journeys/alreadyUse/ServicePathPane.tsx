import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { AccountServiceMark } from '@/components/settings/account/AccountServiceMark';
import type { AuthenticatedAccountEntryRequest } from '@/components/navigation/accountEntry/authenticatedAccountEntryRoute';
import { useAccountEntryFlow } from '@/components/navigation/accountEntry/useAccountEntryFlow';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';
import { useViewportClass } from '@/utils/platform/useViewportClass';

import { useJourneySignInRequest, type JourneyAccountService } from '../useJourneyAccountService';
import { PaneHeader, PaneHelp, PaneIdentityRow, PaneLink } from './journeyPaneKit';

/**
 * Path (a): the sign-in service this device finds its Homes with. The service comes first — its
 * mark, name and address, with Change beside it — then only the methods it offers, through the one
 * account-entry owner (`useAccountEntryFlow` → `completeAccountServicePostAuth`).
 */
export function ServicePathPane(props: Readonly<{
    service: JourneyAccountService;
    onChangeService: () => void;
    /** Captured when Add a Home opened; unrelated callers keep the usual enter behavior. */
    shouldFocusNewHome?: boolean;
    /** The sign-in finished (or the person left it): the panel closes. */
    onDone: () => void;
}>) {
    const { service } = props;
    const phone = useViewportClass() === 'compact';
    const request = useJourneySignInRequest(service.discovery, props.shouldFocusNewHome);
    const serviceUrl = service.discovery?.endpointUrl ?? service.entry.endpoint.url;
    return (
        <View style={styles.pane} testID="already-use-happier.pane.service">
            <PaneHeader
                title={t('homesJourneys.pathServiceTitle', { service: service.name })}
                lead={t(phone ? 'homesJourneys.phone.serviceLead' : 'homesJourneys.serviceLead')}
            />
            <PaneIdentityRow
                testID="already-use-happier.service-identity"
                mark={<AccountServiceMark url={serviceUrl} size={24} />}
                title={service.name}
                subtitle={service.isDefault
                    ? `${service.host} · ${t('homesJourneys.defaultServiceFact')}`
                    : service.host}
                trailing={<PaneLink testID="already-use-happier.service-change" label={t('common.change')} onPress={props.onChangeService} />}
            />
            {request ? (
                <ServiceSignIn key={`${request.service.endpointUrl}|${request.service.serverIdentityId}`} request={request} onDone={props.onDone} />
            ) : service.entry.status === 'loading' ? (
                <SurfaceStateCard testID="already-use-happier.service-loading" kind="loading"
                    title={t('homesJourneys.pathServiceTitle', { service: service.name })} accessibilitySemantics="status" />
            ) : service.entry.status === 'unsupported' ? (
                // The service answers but offers no account sign-in: another service is the way on.
                <SurfaceStateCard
                    testID="already-use-happier.service-unsupported"
                    kind="error"
                    title={t('welcome.signInServiceUnsupportedTitle')}
                    reason={t('welcome.signInServiceUnsupportedBody')}
                    accessibilitySemantics="alert"
                    action={{ label: t('homesJourneys.pathOtherServiceTitle'), onPress: props.onChangeService }}
                />
            ) : (
                <SurfaceStateCard
                    testID="already-use-happier.service-unavailable"
                    kind="error"
                    title={t('welcome.signInServiceUnavailableTitle')}
                    reason={t('settingsAccount.accountServiceDiscoveryUnavailableDescription')}
                    accessibilitySemantics="alert"
                    action={{ label: t('common.retry'), onPress: service.entry.retry }}
                />
            )}
            <PaneHelp>{t('homesJourneys.serviceMethodsHelp', { service: service.name })}</PaneHelp>
        </View>
    );
}

/** The service's methods and the sign-in that follows, hosted in place. */
function ServiceSignIn(props: Readonly<{ request: AuthenticatedAccountEntryRequest; onDone: () => void }>) {
    const flow = useAccountEntryFlow({ request: props.request, onExit: props.onDone });
    return <View testID={`already-use-happier.sign-in.${flow.stage}`}>{flow.content}</View>;
}

const styles = StyleSheet.create(() => ({
    pane: {
        gap: 14,
    },
}));
