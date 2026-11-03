import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { describeAccountServiceAuthenticationAction } from '@/components/account/auth/accountServiceAuthenticationActions';
import { useAccountServiceSelection } from '@/components/account/auth/useAccountServiceSelection';
import { resolveAccountServiceDisplayName } from '@/components/account/auth/accountServiceDisplayName';
import { resolveHomeDisplayName } from '@/components/settings/server/homeDisplayName';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';
import { StatusPill } from '@/components/ui/status/StatusPill';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { getCachedServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { formatAccountServiceHost, normalizeAccountDirectoryEndpoint } from '@/sync/domains/accountDirectory/accountDirectoryEndpoint';
import {
    DEFAULT_ACCOUNT_SERVICE_ENDPOINT,
    type AccountServiceEndpointV1,
    type ServerProfile,
} from '@/sync/domains/server/serverProfiles';
import {
    applyCheckedAccountServiceEndpoint,
    checkAccountServiceEndpoint,
    type CheckAccountServiceEndpointResult,
} from '@/sync/ops/accountDirectory/selectAccountServiceEndpoint';
import { t } from '@/text';

import { AccountServiceMark } from './AccountServiceMark';

type VerifiedService = Extract<CheckAccountServiceEndpointResult, { kind: 'verified' }>;
type KnownService = Readonly<{
    id: string;
    url: string;
    title: string;
    description: string;
    mark: 'cloud' | 'hard-drives';
    /** The name the user gave a Home; it names the service when the service presents none. */
    homeName?: string;
}>;
const ANOTHER_SERVICE = 'another';

function sameService(left: string, right: string): boolean {
    const a = normalizeAccountDirectoryEndpoint(left);
    return a !== null && a === normalizeAccountDirectoryEndpoint(right);
}

const hostOf = formatAccountServiceHost;

/**
 * The services the contract knows about, and nothing invented: Happier Cloud, the current choice,
 * and Homes this device already uses whose cached features say they also offer sign-in (read from
 * the cache — opening the chooser never probes a Home).
 */
export function listKnownAccountServices(
    current: AccountServiceEndpointV1,
    profiles: readonly ServerProfile[],
    homeTitle: (profile: ServerProfile) => string,
    activeServerId: string | null,
): readonly KnownService[] {
    const currentLabel = t('settingsAccount.accountServiceChooserCurrent');
    const defaultUrl = DEFAULT_ACCOUNT_SERVICE_ENDPOINT.url;
    const services: KnownService[] = defaultUrl ? [{
        id: 'default',
        url: defaultUrl,
        title: DEFAULT_ACCOUNT_SERVICE_ENDPOINT.displayName ?? hostOf(defaultUrl),
        description: [
            sameService(current.url, defaultUrl) ? currentLabel : null,
            t('settingsAccount.accountServiceChooserDefault'),
            hostOf(defaultUrl),
        ].filter(Boolean).join(' · '),
        mark: 'cloud',
    }] : [];
    if (current.url && !sameService(current.url, defaultUrl)) {
        services.push({
            id: 'current',
            url: current.url,
            // A choice row may fall back to the address: it is what tells two unnamed services apart.
            title: resolveAccountServiceDisplayName({
                url: current.url, serverIdentityId: current.serverIdentityId, savedName: current.displayName,
                profiles, activeServerId,
            }) ?? hostOf(current.url),
            description: `${currentLabel} · ${hostOf(current.url)}`,
            mark: 'cloud',
        });
    }
    for (const profile of profiles) {
        const snapshot = getCachedServerFeaturesSnapshot({ serverId: profile.id });
        if (snapshot?.status !== 'ready' || snapshot.features.capabilities.accountDirectory?.homeDirectory !== true) continue;
        const url = snapshot.features.capabilities.server.canonicalServerUrl ?? profile.serverUrl;
        if (services.some((service) => sameService(service.url, url))) continue;
        services.push({
            id: `home:${profile.id}`,
            url,
            title: homeTitle(profile),
            description: t('settingsAccount.accountServiceChooserHomeOffersSignIn'),
            mark: 'hard-drives',
            ...(resolveHomeDisplayName(profile) ? { homeName: resolveHomeDisplayName(profile)! } : {}),
        });
    }
    return services;
}

/**
 * Changing the sign-in service in place: a short list of the services this device knows, and an
 * address field for any other. Choosing checks what the service offers before anything is saved;
 * only "Use …" makes it the selected service. The sign-in of the service being left stays saved on
 * this device, so switching back is the same choice.
 */
export const AccountServiceChooser = React.memo(function AccountServiceChooser(props: Readonly<{
    currentEndpoint: AccountServiceEndpointV1;
    profiles: readonly ServerProfile[];
    /** How the page names a Home ("This Home" for the unnamed Home in focus). */
    homeTitle: (profile: ServerProfile) => string;
    activeServerId: string | null;
    /** Whether this device is signed in to the current service (its sign-in is kept on switch). */
    signedIn: boolean;
    /** Shows the chooser's own heading (it is omitted under a notice that already explains it). */
    showHeading: boolean;
    onClose: () => void;
}>) {
    const { theme } = useUnistyles();
    const known = React.useMemo(
        () => listKnownAccountServices(props.currentEndpoint, props.profiles, props.homeTitle, props.activeServerId),
        [props.activeServerId, props.currentEndpoint, props.homeTitle, props.profiles],
    );
    const currentId = known.find((service) => sameService(service.url, props.currentEndpoint.url))?.id ?? ANOTHER_SERVICE;
    const [choice, setChoice] = React.useState(currentId);
    const [address, setAddress] = React.useState('');
    const [verified, setVerified] = React.useState<Readonly<{ choice: string; service: VerifiedService }> | null>(null);
    const [using, setUsing] = React.useState(false);
    const selection = useAccountServiceSelection(checkAccountServiceEndpoint);

    const check = React.useCallback(async (nextChoice: string, url: string, homeName?: string) => {
        setVerified(null);
        const outcome = await selection.submit(url);
        if (outcome?.kind !== 'verified') return;
        // A Home the user named keeps that name when it presents none of its own as a service.
        const service = homeName && !outcome.discovery.accountServiceDisplayName?.trim()
            ? { ...outcome, endpoint: { ...outcome.endpoint, displayName: homeName } }
            : outcome;
        setVerified({ choice: nextChoice, service });
    }, [selection.submit]);

    const choose = React.useCallback((service: KnownService | null) => {
        selection.cancel();
        selection.clearError();
        setVerified(null);
        if (!service) {
            setChoice(ANOTHER_SERVICE);
            return;
        }
        setChoice(service.id);
        if (service.id !== currentId) void check(service.id, service.url, service.homeName);
    }, [check, currentId, selection.cancel, selection.clearError]);

    const verifiedService = verified?.choice === choice ? verified.service : null;
    const checking = selection.pendingUrl !== null;
    const nameOf = (endpoint: AccountServiceEndpointV1, advertisedName?: string | null) => resolveAccountServiceDisplayName({
        url: endpoint.url, serverIdentityId: endpoint.serverIdentityId, savedName: endpoint.displayName, advertisedName,
        profiles: props.profiles, activeServerId: props.activeServerId,
    });
    const verifiedName = verifiedService
        ? nameOf(verifiedService.endpoint, verifiedService.discovery.accountServiceDisplayName) ?? hostOf(verifiedService.endpoint.url)
        : null;
    const currentName = nameOf(props.currentEndpoint) ?? t('welcome.yourSignInService');

    const use = React.useCallback(async () => {
        if (!verifiedService || using) return;
        setUsing(true);
        try {
            await applyCheckedAccountServiceEndpoint(verifiedService);
            props.onClose();
        } finally {
            setUsing(false);
        }
    }, [props.onClose, using, verifiedService]);

    const cancel = React.useCallback(() => {
        selection.cancel();
        props.onClose();
    }, [props.onClose, selection.cancel]);

    const selectedMark = <Icon name="check" size={16} color={theme.colors.text.primary} />;
    const result = selection.error ? (
        <Text testID="settings-account-service-chooser-error" accessibilityRole="alert" accessibilityLiveRegion="polite" style={styles.error}>
            {selection.error}
        </Text>
    ) : verifiedService && verifiedName ? (
        <View testID="settings-account-service-chooser-verified" style={styles.verified}>
            <View style={styles.verifiedTitleRow}>
                <Icon name="check-circle" size={16} color={theme.colors.state.success.foreground} />
                <Text style={styles.verifiedTitle}>{verifiedName}</Text>
                {verifiedName !== hostOf(verifiedService.endpoint.url) ? (
                    <Text style={styles.verifiedHost}>{hostOf(verifiedService.endpoint.url)}</Text>
                ) : null}
            </View>
            <View style={styles.facts}>
                {verifiedService.discovery.capability.homeDirectory ? (
                    <StatusPill variant="neutral" label={t('settingsAccount.accountServiceFindsHomes')} labelVariant="phrase" />
                ) : null}
                {verifiedService.discovery.capability.homeEnrollment ? (
                    <StatusPill variant="neutral" label={t('settingsAccount.accountServiceSignsInToHomes')} labelVariant="phrase" />
                ) : null}
                {verifiedService.discovery.authenticationActions
                    .filter(({ action }) => action.id === 'login')
                    .map((entry) => {
                        const presentation = describeAccountServiceAuthenticationAction(entry, verifiedName);
                        return <StatusPill key={presentation.slug} variant="neutral" label={presentation.title} labelVariant="phrase" />;
                    })}
            </View>
            {props.signedIn ? (
                <Text style={styles.note}>{t('settingsAccount.accountServiceKeepsSignIn', { accountService: currentName })}</Text>
            ) : null}
        </View>
    ) : null;

    return (
        <View testID="settings-account-service-chooser">
            {props.showHeading ? (
                <View style={styles.heading}>
                    <Text style={styles.headingTitle}>{t('settingsAccount.accountServiceChooserTitle')}</Text>
                    <Text style={styles.headingDescription}>{t('settingsAccount.accountServiceChooserDescription')}</Text>
                </View>
            ) : null}
            <View
                accessibilityRole="radiogroup"
                accessibilityLabel={t('settingsAccount.accountServiceChooserTitle')}
            >
                {known.map((service) => (
                    <View key={service.id}>
                        <Item
                            testID={`settings-account-service-choice-${service.id}`}
                            icon={<AccountServiceMark url={service.url} fallback={service.mark} />}
                            title={service.title}
                            subtitle={service.description}
                            accessibilityRole="radio"
                            webRole="radio"
                            selected={choice === service.id}
                            rightElement={choice === service.id ? selectedMark : undefined}
                            loading={choice === service.id && checking}
                            showChevron={false}
                            onPress={() => choose(service)}
                        />
                        {choice === service.id && service.id !== currentId ? (
                            <View style={styles.result}>{result}</View>
                        ) : null}
                    </View>
                ))}
                <Item
                    testID="settings-account-service-choice-another"
                    icon={<Icon name="globe" size={20} color={theme.colors.text.secondary} />}
                    title={t('settingsAccount.accountServiceChooserAnother')}
                    subtitle={t('settingsAccount.accountServiceChooserAnotherDescription')}
                    accessibilityRole="radio"
                    webRole="radio"
                    selected={choice === ANOTHER_SERVICE}
                    rightElement={choice === ANOTHER_SERVICE ? selectedMark : undefined}
                    showChevron={false}
                    onPress={() => choose(null)}
                />
            </View>
            {choice === ANOTHER_SERVICE ? (
                <View style={styles.field}>
                    <View style={styles.fieldRow}>
                        <FieldTextInput
                            testID="settings-account-service-address"
                            value={address}
                            onChangeText={(value) => {
                                setAddress(value);
                                setVerified(null);
                                if (selection.error) selection.clearError();
                            }}
                            accessibilityLabel={t('settingsAccount.accountServiceChooserAddressLabel')}
                            placeholder={t('common.urlPlaceholder')}
                            keyboardType="url"
                            returnKeyType="go"
                            autoFocus
                            onSubmitEditing={() => { void check(ANOTHER_SERVICE, address); }}
                            style={styles.fieldInput}
                        />
                        <RoundButton
                            testID="settings-account-service-check"
                            size="small"
                            display="secondary"
                            title={t('settingsAccount.accountServiceCheck')}
                            loading={checking}
                            onPress={() => { void check(ANOTHER_SERVICE, address); }}
                        />
                    </View>
                    {result ?? <Text style={styles.help}>{t('settingsAccount.accountServiceChooserAddressHelp')}</Text>}
                </View>
            ) : null}
            <View style={styles.actions}>
                <RoundButton
                    testID="settings-account-service-chooser-cancel"
                    size="small"
                    display="inverted"
                    title={t('common.cancel')}
                    onPress={cancel}
                />
                <RoundButton
                    testID="settings-account-service-use"
                    size="small"
                    title={verifiedName
                        ? t('settingsAccount.accountServiceUse', { accountService: verifiedName })
                        : t('settingsAccount.accountServiceUseThis')}
                    disabled={!verifiedService || using}
                    loading={using}
                    onPress={() => { void use(); }}
                />
            </View>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    heading: {
        paddingHorizontal: PAGE_LIST_METRICS.rowPaddingHorizontalPx,
        paddingTop: theme.space.s12,
        paddingBottom: theme.space.s4,
    },
    headingTitle: {
        color: theme.colors.text.primary,
        ...Typography.variant('label'),
    },
    headingDescription: {
        color: theme.colors.text.secondary,
        ...Typography.variant('body'),
        marginTop: theme.space.s2,
    },
    result: {
        paddingHorizontal: PAGE_LIST_METRICS.rowPaddingHorizontalPx,
        paddingBottom: theme.space.s12,
    },
    field: {
        paddingHorizontal: PAGE_LIST_METRICS.rowPaddingHorizontalPx,
        paddingTop: theme.space.s8,
        paddingBottom: theme.space.s12,
        gap: theme.space.s8,
    },
    fieldRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'flex-start',
        gap: theme.space.s8,
    },
    fieldInput: {
        flexGrow: 1,
        flexShrink: 1,
        flexBasis: 220,
        minWidth: 0,
    },
    help: {
        color: theme.colors.text.secondary,
        ...Typography.variant('meta'),
    },
    error: {
        color: theme.colors.state.danger.foreground,
        ...Typography.variant('body'),
    },
    verified: {
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.default,
        borderRadius: 10,
        backgroundColor: theme.colors.surface.inset,
        padding: theme.space.s12,
        gap: theme.space.s8,
    },
    verifiedTitleRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: theme.space.s8,
    },
    verifiedTitle: {
        color: theme.colors.text.primary,
        ...Typography.variant('label'),
    },
    verifiedHost: {
        color: theme.colors.text.secondary,
        ...Typography.variant('body'),
    },
    facts: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: theme.space.s6,
    },
    note: {
        color: theme.colors.text.secondary,
        ...Typography.variant('meta'),
    },
    actions: {
        flexDirection: 'row',
        justifyContent: 'flex-end',
        alignItems: 'center',
        gap: theme.space.s8,
        paddingHorizontal: PAGE_LIST_METRICS.rowPaddingHorizontalPx,
        paddingVertical: theme.space.s10,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.border.subtle,
    },
}));
