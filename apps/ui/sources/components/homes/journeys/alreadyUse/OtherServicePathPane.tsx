import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { useAccountServiceSelection } from '@/components/account/auth/useAccountServiceSelection';
import { readAccountServiceDisplayName } from '@/components/account/auth/accountServiceDisplayName';
import { AccountServiceMark } from '@/components/settings/account/AccountServiceMark';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { OrganizationPolicyFieldNotice, readOrganizationPolicyFieldState } from '@/components/organizationPolicy/OrganizationPolicyFieldNotice';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { formatAccountServiceHost } from '@/sync/domains/accountDirectory/accountDirectoryEndpoint';
import {
    applyCheckedAccountServiceEndpoint,
    checkAccountServiceEndpoint,
    type CheckAccountServiceEndpointResult,
} from '@/sync/ops/accountDirectory/selectAccountServiceEndpoint';
import { t } from '@/text';

import { PaneConfirmed, PaneHeader, PaneHelp, PaneIdentityRow, PaneLabel } from './journeyPaneKit';

type Verified = Extract<CheckAccountServiceEndpointResult, { kind: 'verified' }>;

const ADDRESS_LABEL_ID = 'already-use-happier-service-address-label';

/**
 * Path (b): a sign-in service someone runs themselves, by its address. Check reads what it offers
 * before anything is saved (the chooser's own `checkAccountServiceEndpoint`); only "Sign in with …"
 * makes it this device's service, and the panel continues on path (a) with its methods. An address
 * the check identifies as a Home (`home_endpoint`) hands over to path (c) with the Home's own address
 * filled in, instead of stopping at an error; anything else it cannot classify stays an error.
 */
export function OtherServicePathPane(props: Readonly<{
    initialAddress?: string;
    onUseService: () => void;
    onConnectAsHome: (address: string) => void;
}>) {
    const [address, setAddress] = React.useState(props.initialAddress ?? '');
    const policy = readOrganizationPolicyFieldState('accountService');
    const [verified, setVerified] = React.useState<Verified | null>(null);
    // A Home at this address (it answered with a Home identity but offers no account sign-in).
    const [homeAddress, setHomeAddress] = React.useState<string | null>(null);
    const [using, setUsing] = React.useState(false);
    const selection = useAccountServiceSelection(checkAccountServiceEndpoint);
    const checking = selection.pendingUrl !== null;

    const check = React.useCallback(async () => {
        setVerified(null);
        setHomeAddress(null);
        const outcome = await selection.submit(address);
        if (!outcome) return;
        if (outcome.kind === 'verified') setVerified(outcome);
        else if (outcome.kind === 'home_endpoint') setHomeAddress(outcome.homeUrl);
    }, [address, selection.submit]);

    const verifiedName = verified
        ? readAccountServiceDisplayName({
            url: verified.endpoint.url,
            serverIdentityId: verified.endpoint.serverIdentityId,
            savedName: verified.endpoint.displayName,
            advertisedName: verified.discovery.accountServiceDisplayName,
        }) ?? formatAccountServiceHost(verified.endpoint.url)
        : null;

    const use = React.useCallback(async () => {
        if (!verified || using) return;
        setUsing(true);
        try {
            await applyCheckedAccountServiceEndpoint(verified);
            props.onUseService();
        } finally {
            setUsing(false);
        }
    }, [props.onUseService, using, verified]);

    return (
        <View style={styles.pane} testID="already-use-happier.pane.other-service">
            <OrganizationPolicyFieldNotice field="accountService" />
            <PaneHeader title={t('homesJourneys.pathOtherServiceTitle')} lead={t('homesJourneys.otherServiceLead')} />
            <View style={styles.field}>
                <PaneLabel nativeID={ADDRESS_LABEL_ID}>{t('homesJourneys.serviceAddressLabel')}</PaneLabel>
                <View style={styles.fieldRow}>
                    <FieldTextInput
                        testID="already-use-happier.service-address"
                        editable={!policy.disabled}
                        accessibilityHint={policy.accessibilityHint}
                        value={address}
                        onChangeText={(value) => {
                            setAddress(value);
                            setVerified(null);
                            setHomeAddress(null);
                            if (selection.error) selection.clearError();
                        }}
                        accessibilityLabel={t('homesJourneys.serviceAddressLabel')}
                        accessibilityLabelledBy={ADDRESS_LABEL_ID}
                        placeholder={t('common.urlPlaceholder')}
                        keyboardType="url"
                        autoCapitalize="none"
                        returnKeyType="go"
                        onSubmitEditing={policy.disabled ? undefined : () => { void check(); }}
                        style={styles.fieldInput}
                    />
                    <RoundButton
                        testID="already-use-happier.service-check"
                        disabled={policy.disabled}
                        size="small"
                        display="secondary"
                        title={t('settingsAccount.accountServiceCheck')}
                        loading={checking}
                        onPress={() => { void check(); }}
                    />
                </View>
            </View>
            {verified && verifiedName ? (
                <>
                    <PaneIdentityRow
                        testID="already-use-happier.service-found"
                        mark={<AccountServiceMark url={verified.endpoint.url} size={24} fallback="cloud" />}
                        title={verifiedName}
                        subtitle={formatAccountServiceHost(verified.endpoint.url)}
                        trailing={<PaneConfirmed label={t('homesJourneys.serviceFound')} />}
                    />
                    <View style={styles.actions}>
                        <RoundButton
                            testID="already-use-happier.service-use"
                            disabled={policy.disabled}
                            size="small"
                            title={t('homesJourneys.useThisService', { service: verifiedName })}
                            loading={using}
                            onPress={() => { void use(); }}
                        />
                    </View>
                </>
            ) : homeAddress ? (
                <View style={styles.handoff}>
                    <PaneHelp testID="already-use-happier.service-not-a-service">{t('homesJourneys.addressIsNotAService')}</PaneHelp>
                    <View style={styles.actions}>
                        <RoundButton
                            testID="already-use-happier.connect-as-home"
                            size="small"
                            display="secondary"
                            title={t('homesJourneys.connectAsHome')}
                            onPress={() => props.onConnectAsHome(homeAddress)}
                        />
                    </View>
                </View>
            ) : selection.error ? (
                <PaneHelp tone="error" testID="already-use-happier.service-error">{selection.error}</PaneHelp>
            ) : (
                <PaneHelp>{t('settingsAccount.accountServiceChooserAddressHelp')}</PaneHelp>
            )}
        </View>
    );
}

const styles = StyleSheet.create(() => ({
    pane: {
        gap: 14,
    },
    field: {
        gap: 6,
    },
    fieldRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    // The field gives way to its button at any width (a phone keeps both on screen).
    fieldInput: {
        flex: 1,
        minWidth: 0,
    },
    handoff: {
        gap: 10,
    },
    actions: {
        flexDirection: 'row',
    },
}));
