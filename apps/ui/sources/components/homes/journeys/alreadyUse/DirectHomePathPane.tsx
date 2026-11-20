import * as React from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { classifyPairingLink } from '@/auth/pairing/classifyPairingLink';
import { ADD_HOME_RESTORE_PATH } from '@/auth/pairing/homeQrEntryIntent';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Icon } from '@/components/ui/icons/Icon';
import type { EndpointReachabilityRemediation } from '@/components/serverReachability/remediation';
import { ServerReachabilityRemediationCard } from '@/components/settings/server/sections/ServerReachabilityRemediationCard';
import { useEndpointReachabilityRemediationController } from '@/components/settings/server/hooks/useEndpointReachabilityRemediationController';
import type { ServerProfile } from '@/sync/domains/server/serverProfiles';
import { connectHomeAtAddress } from '@/sync/ops/home/connectHomeAtAddress';
import { t } from '@/text';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { useViewportClass } from '@/utils/platform/useViewportClass';

import { StepFieldGroup, StepFieldHelp, StepFieldLabel, StepOrDivider } from '@/components/onboarding/unauthShell/StepFormParts';
import { JourneyPanePresentationContext, PaneHeader } from './journeyPaneKit';
import {
    confirmCanonicalHomeUrl,
    confirmInsecureHomeHttp,
    homeConnectFailureMessage,
    resolveHomeConnectLink,
} from '../../add/homeConnectPresentation';

const LINK_LABEL_ID = 'already-use-happier-home-link-label';
const ADDRESS_LABEL_ID = 'already-use-happier-home-address-label';

type AddressState =
    | Readonly<{ kind: 'idle' }>
    | Readonly<{ kind: 'connecting' }>
    | Readonly<{
        kind: 'failed';
        message: string;
        endpoint: string;
        remediation: EndpointReachabilityRemediation | null;
    }>;

/**
 * Path (c): a Home run without an account service. Two honest ways in, in the order people usually
 * have them: from a device already connected (its Home link, pasted, or its code through the camera
 * — both the canonical restore owner's), or by the Home's address. Connect proves the address
 * answers (`/health`) before anything is saved, then saves it through the one "add by address"
 * owner; the Home's own sign-in follows in the next pane.
 */
export function DirectHomePathPane(props: Readonly<{
    /** An address handed over from path (b), when it turned out not to be a sign-in service. */
    initialAddress?: string;
    onHomeConnected: (profile: ServerProfile) => void | Promise<void>;
    /** A flow that continues on its own screen (the camera, a Home link): the panel closes. */
    onLeave: () => void;
    /** The address as it is typed (Settings' draft row is titled by it). */
    onAddressChange?: (address: string) => void;
}>) {
    const router = useRouter();
    const isStep = React.useContext(JourneyPanePresentationContext) === 'step';
    const { theme } = useUnistyles();
    const phone = useViewportClass() === 'compact';
    const [link, setLink] = React.useState('');
    const [linkError, setLinkError] = React.useState<string | null>(null);
    const [address, setAddress] = React.useState(props.initialAddress ?? '');
    const [addressState, setAddressState] = React.useState<AddressState>({ kind: 'idle' });
    const attemptRef = React.useRef<AbortController | null>(null);
    React.useEffect(() => () => attemptRef.current?.abort(), []);

    const { onLeave, onHomeConnected } = props;
    const leaveFor = React.useCallback((href: string, tag: string) => {
        onLeave();
        const navigation = runGuardedNavigation(() => router.push(href as never));
        if (navigation !== true) fireAndForget(navigation, { tag });
    }, [onLeave, router]);

    const openLink = React.useCallback(() => {
        const destination = resolveHomeConnectLink(classifyPairingLink(link));
        if (destination) leaveFor(destination, 'AlreadyUseHappier.homeLink');
        else setLinkError(t('homesJourneys.notAHomeLink'));
    }, [leaveFor, link]);

    const connect = React.useCallback(async (requestedAddress = address) => {
        attemptRef.current?.abort();
        const controller = new AbortController();
        attemptRef.current = controller;
        setAddressState({ kind: 'connecting' });
        let result: Awaited<ReturnType<typeof connectHomeAtAddress>>;
        try {
            result = await connectHomeAtAddress({
                serverUrl: requestedAddress,
                signal: controller.signal,
                confirmInsecureHttp: confirmInsecureHomeHttp,
                confirmCanonicalUrl: confirmCanonicalHomeUrl,
            });
            if (controller.signal.aborted) return;
            if (result.kind === 'connected') {
                await onHomeConnected(result.profile);
                if (!controller.signal.aborted) setAddressState({ kind: 'idle' });
                return;
            }
        } catch (error) {
            if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) return;
            setAddressState({
                kind: 'failed',
                message: t('errors.operationFailed'),
                endpoint: requestedAddress,
                remediation: null,
            });
            return;
        }
        if (controller.signal.aborted) return;
        const message = homeConnectFailureMessage(result);
        if (message) {
            setAddressState({
                kind: 'failed',
                message,
                endpoint: requestedAddress,
                remediation: result.kind === 'unreachable' ? result.remediation : null,
            });
        } else {
            setAddressState({ kind: 'idle' });
        }
    }, [address, onHomeConnected]);

    const submitAddress = React.useCallback(() => {
        if (isStep) {
            const destination = resolveHomeConnectLink(classifyPairingLink(address));
            if (destination) {
                leaveFor(destination, 'AlreadyUseHappier.homeLink');
                return;
            }
            if (destination === null) {
                setAddressState({ kind: 'failed', message: t('homesJourneys.notAHomeLink'), endpoint: '', remediation: null });
                return;
            }
        }
        void connect();
    }, [address, connect, isStep, leaveFor]);

    const remediation = addressState.kind === 'failed' ? addressState.remediation : null;
    const remediationController = useEndpointReachabilityRemediationController({
        remediation,
        endpoint: addressState.kind === 'failed' ? addressState.endpoint : null,
        onRetryEndpoint: connect,
    });

    const hasLink = link.trim().length > 0;
    return (
        <View style={styles.pane} testID="already-use-happier.pane.direct">
            <PaneHeader
                title={t(isStep ? 'setupOnboarding.homeAddressStep.title' : 'homesJourneys.pathDirectTitle')}
                lead={t(isStep ? 'homesJourneys.byAddressHelp' : 'homesJourneys.directLead')}
            />
            {!isStep ? <>
                <StepFieldGroup>
                    <StepFieldLabel nativeID={LINK_LABEL_ID}>{t('homesJourneys.fromDeviceLabel')}</StepFieldLabel>
                    <View style={styles.fieldRow}>
                        <FieldTextInput
                            testID="already-use-happier.home-link"
                            value={link}
                            onChangeText={(value) => {
                                setLink(value);
                                if (linkError) setLinkError(null);
                            }}
                            accessibilityLabel={t('homesJourneys.homeLinkLabel')}
                            accessibilityLabelledBy={LINK_LABEL_ID}
                            placeholder={t('homesJourneys.homeLinkPlaceholder')}
                            autoCapitalize="none"
                            keyboardType="url"
                            returnKeyType="go"
                            onSubmitEditing={openLink}
                            error={linkError}
                            style={styles.fieldInput}
                        />
                        {hasLink ? (
                            <RoundButton
                                testID="already-use-happier.home-link-open"
                                size="normal"
                                display="secondary"
                                title={t('homesJourneys.openLink')}
                                onPress={openLink}
                            />
                        ) : (
                            <RoundButton
                                testID="already-use-happier.use-camera"
                                size="normal"
                                display="secondary"
                                title={t(phone ? 'homesJourneys.phone.scan' : 'homesJourneys.useCamera')}
                                leading={<Icon name="camera" size={14} color={theme.colors.text.secondary} />}
                                onPress={() => leaveFor(ADD_HOME_RESTORE_PATH, 'AlreadyUseHappier.camera')}
                            />
                        )}
                    </View>
                    {linkError ? null : (
                        <StepFieldHelp>{t(phone ? 'homesJourneys.phone.fromDeviceHelp' : 'homesJourneys.fromDeviceHelp')}</StepFieldHelp>
                    )}
                </StepFieldGroup>
                <StepOrDivider label={t('common.or')} />
            </> : null}
            <StepFieldGroup>
                {!isStep ? <StepFieldLabel nativeID={ADDRESS_LABEL_ID}>{t('homesJourneys.byAddressLabel')}</StepFieldLabel> : null}
                <View style={styles.fieldRow}>
                    <FieldTextInput
                        testID="already-use-happier.home-address"
                        value={address}
                        onChangeText={(value) => {
                            setAddress(value);
                            props.onAddressChange?.(value);
                            if (addressState.kind === 'failed') setAddressState({ kind: 'idle' });
                        }}
                        accessibilityLabel={t('homesJourneys.byAddressLabel')}
                        accessibilityLabelledBy={isStep ? undefined : ADDRESS_LABEL_ID}
                        placeholder={t('homesJourneys.homeAddressPlaceholder')}
                        autoCapitalize="none"
                        keyboardType="url"
                        returnKeyType="go"
                        onSubmitEditing={submitAddress}
                        style={styles.fieldInput}
                    />
                    <RoundButton
                        testID="already-use-happier.home-connect"
                        size="normal"
                        title={t('homesJourneys.connect')}
                        loading={addressState.kind === 'connecting'}
                        onPress={submitAddress}
                    />
                </View>
                {addressState.kind === 'failed' ? (
                    <StepFieldHelp tone="error" testID="already-use-happier.home-address-error">{addressState.message}</StepFieldHelp>
                ) : (
                    <StepFieldHelp>{t(isStep ? 'setupOnboarding.homeAddressStep.pairingHelp' : 'homesJourneys.byAddressHelp')}</StepFieldHelp>
                )}
                {remediation ? (
                    <ServerReachabilityRemediationCard
                        remediation={remediation}
                        taskSnapshot={remediationController.taskSnapshot}
                        onAction={remediationController.onAction}
                    />
                ) : null}
                {remediationController.error ? (
                    <StepFieldHelp tone="error">{remediationController.error}</StepFieldHelp>
                ) : null}
            </StepFieldGroup>
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    // The heading, then two ways in a section apart with "or" between them (StepFormParts anatomy).
    pane: {
        gap: theme.space.s24,
    },
    // A field and its action share one height (the page control), so they align on one line.
    fieldRow: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: theme.space.s8,
    },
    // The field gives way to its button at any width (a phone keeps both on screen).
    fieldInput: {
        flex: 1,
        minWidth: 0,
    },
}));
