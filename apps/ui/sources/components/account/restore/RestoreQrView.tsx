import React, { useState, useEffect } from 'react';
import { View, ScrollView } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { resolvePostAuthLanding } from '@/components/onboarding/state/resolvePostAuthLanding';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { getReadyServerFeatures } from '@/sync/api/capabilities/getReadyServerFeatures';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { getAuthProvider } from '@/auth/providers/registry';
import type { RestoreRedirectReason, RestoreRedirectNotice } from '@/auth/providers/types';
import { Text } from '@/components/ui/text/Text';
import { canUseCurrentDeviceQrScanner } from '@/utils/platform/qrScannerSupport';
import { useReversePairingSession } from '@/hooks/auth/useReversePairingSession';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import {
    formatHomeEnrollmentTargetLabel,
    resolveHomeEnrollmentPresentation,
} from '@/auth/pairing/pairingPresentation';
import { usePreventRemove } from '@react-navigation/native';
import { RequesterCodeCard } from './RequesterCodeCard';
import { PairingLinkDisclosure } from '@/components/auth/pairing/PairingLinkDisclosure';
import type { HomeQrEntryIntent } from '@/auth/pairing/homeQrEntryIntent';
import { openEnrolledHomeOrReturnToShell } from '@/auth/pairing/openEnrolledHome';
import { useAuth } from '@/auth/context/AuthContext';
import { resolveHomeAuthenticationTarget } from '@/auth/flows/resolveHomeAuthenticationTarget';
import { isDesktopHost } from '@/utils/platform/desktopHost';
import { EnrolledComputerSetup } from './EnrolledComputerSetup';


const stylesheet = StyleSheet.create((theme) => ({
    scrollView: {
        flex: 1,
        backgroundColor: theme.colors.surface.base,
    },
    container: {
        flex: 1,
        alignItems: 'center',
        paddingHorizontal: theme.space.s24,
    },
    embeddedContainer: {
        flex: 0,
        paddingHorizontal: 0,
    },
    contentWrapper: {
        width: '100%',
        maxWidth: 560,
        paddingVertical: 28,
    },
    embeddedContentWrapper: {
        paddingVertical: 0,
    },
    noticeCard: {
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        borderRadius: 14,
        paddingHorizontal: theme.space.s16,
        paddingVertical: 14,
        backgroundColor: theme.colors.surface.base,
    },
    noticeTitle: {
        ...Typography.variant('heading'),
        color: theme.colors.text.primary,
        marginBottom: theme.space.s6,
    },
    noticeBody: {
        fontSize: 14,
        color: theme.colors.text.secondary,
        lineHeight: 20,
        ...Typography.default(),
    },
    sectionLead: {
        fontSize: 16,
        color: theme.colors.text.secondary,
        marginTop: theme.space.s12,
        marginBottom: theme.space.s12,
        textAlign: 'center',
        lineHeight: 24,
        ...Typography.default(),
    },
    // Embedded, the view is a step on its host's column (like the scanner and link entry beside
    // it): copy, the QR and the actions start at the column's edge under the host's heading, the
    // QR stands on the pane without a card, and the other ways in are quiet text actions.
    embeddedSectionLead: {
        marginTop: 0,
        marginBottom: 0,
        textAlign: 'left',
    },
    embeddedNoticeCard: {
        marginBottom: theme.space.s16,
    },
    embeddedStatusCard: {
        marginTop: theme.space.s16,
        borderWidth: 0,
        paddingHorizontal: 0,
        paddingVertical: 0,
        alignItems: 'flex-start',
        backgroundColor: 'transparent',
        gap: theme.space.s12,
    },
    embeddedQrBlockInner: {
        alignItems: 'flex-start',
        paddingVertical: 0,
    },
    embeddedTargetName: {
        marginTop: 0,
        textAlign: 'left',
    },
    embeddedActions: {
        width: '100%',
        marginTop: theme.space.s24,
        alignItems: 'flex-start',
        gap: theme.space.s16,
    },
    embeddedPrimary: {
        width: '100%',
    },
    qrBlock: {
        alignItems: 'center',
        justifyContent: 'center',
        width: '100%',
        paddingVertical: theme.space.s10,
    },
    statusCard: {
        marginTop: theme.space.s12,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        borderRadius: 14,
        paddingHorizontal: theme.space.s16,
        paddingVertical: 14,
        alignItems: 'center',
        backgroundColor: theme.colors.surface.base,
    },
    targetName: {
        marginTop: theme.space.s8,
        ...Typography.variant('heading'),
        textAlign: 'center',
        color: theme.colors.text.primary,
    },
    footer: {
        marginTop: theme.space.s16,
        alignItems: 'center',
        width: '100%',
    },
    footerButton: {
        width: '100%',
        maxWidth: 320,
    },
    footerButtonSpacer: {
        height: 10,
    },
    textInput: {
        backgroundColor: theme.colors.input.background,
        padding: theme.space.s16,
        borderRadius: 8,
        marginBottom: theme.space.s24,
        fontFamily: 'IBMPlexMono-Regular',
        fontSize: 14,
        minHeight: 120,
        textAlignVertical: 'top',
        color: theme.colors.input.text,
    },
}));

function paramString(params: Record<string, unknown>, key: string): string | null {
    const value = params[key];
    if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : null;
    return typeof value === 'string' ? value : null;
}

function parseRestoreRedirectReason(value: unknown): RestoreRedirectReason | null {
    const raw = typeof value === 'string' ? value.trim() : '';
    if (raw === 'provider_already_linked') return raw;
    return null;
}

export type RestoreQrViewProps = Readonly<{
    entryIntent: HomeQrEntryIntent;
    targetProfileId?: string | null;
    embedded?: boolean;
    onBack?: () => void;
    onOpenSecretKeyLogin?: () => void;
    onOpenScanQr?: () => void;
    onOpenPairingLinkEntry?: () => void;
    onNavigationLockChange?: (locked: boolean) => void;
}>;

export const RestoreQrView = React.memo(function RestoreQrView(props: RestoreQrViewProps) {
    useUnistyles();
    const styles = stylesheet;
    const router = useRouter();
    const auth = useAuth();
    const params = useLocalSearchParams() as Readonly<Record<string, string | string[] | undefined>>;
    const [providerResetEnabled, setProviderResetEnabled] = useState(false);
    const embedded = props.embedded === true;
    const canOpenScanner = typeof props.onOpenScanQr === 'function' && canUseCurrentDeviceQrScanner();
    const reversePairing = useReversePairingSession({ enabled: true, targetProfileId: props.targetProfileId ?? null });
    const pairing = reversePairing.presentation;
    const [shellNavigationRequested, setShellNavigationRequested] = React.useState(false);
    const [setupCompletedProfileId, setSetupCompletedProfileId] = React.useState<string | null>(null);
    const requiresComputerSetup = isDesktopHost() && pairing.phase === 'succeeded'
        && setupCompletedProfileId !== pairing.profileId;
    // Keep the approved code in place until the visible entrance has settled and adoption has finished.
    const shownCodeRef = React.useRef<Readonly<{ link: string; qrAvailable: boolean }> | null>(null);
    if (pairing.phase === 'ready') {
        if (shownCodeRef.current?.link !== pairing.link) {
            shownCodeRef.current = { link: pairing.link, qrAvailable: pairing.qrAvailable };
        }
    } else if (pairing.phase !== 'adding' && pairing.phase !== 'succeeded') shownCodeRef.current = null;
    const approvedCode = pairing.phase === 'adding' || pairing.phase === 'succeeded' ? shownCodeRef.current : null;
    const [settledCode, setSettledCode] = React.useState<typeof approvedCode>(null);
    const onApprovedSettled = React.useCallback(() => {
        if (shownCodeRef.current === approvedCode) setSettledCode(approvedCode);
    }, [approvedCode]);
    const canLeaveApproved = approvedCode === null || approvedCode === settledCode;
    const openGenerationRef = React.useRef(0);
    const handledProfileIdRef = React.useRef<string | null>(null);
    const presentation = resolveHomeEnrollmentPresentation({
        kind: 'requester_display',
        phase: pairing.phase,
        ...(pairing.phase === 'retryable_error' ? { partialCommit: pairing.partialCommit !== null } : {}),
        canRetryRetainedHome: reversePairing.canRetryRetainedHome,
    });
    // Once adoption succeeds, leaving is safe: the Home is already retained. Keeping the
    // removal guard active during the explicit open would also block the intentional route
    // replacement after a successful exact-profile switch.
    const claimOwnsNavigation = presentation.phase === 'verifying'
        || presentation.phase === 'adding';
    usePreventRemove(claimOwnsNavigation, () => undefined);
    const targetLabel = 'descriptor' in pairing && pairing.descriptor !== undefined
        ? formatHomeEnrollmentTargetLabel(pairing.descriptor)
        : null;
    const recoveryButton = presentation.recoveryAction === 'retry_retained_home' && targetLabel
        ? {
            testID: 'restore-requester-retry-retained-home',
            title: t('connect.retryRetainedHome', { home: targetLabel }),
            action: reversePairing.retryRetainedHome,
        }
        : presentation.recoveryAction === 'retry'
            ? { testID: 'restore-requester-retry', title: t('common.retry'), action: reversePairing.start }
            : presentation.recoveryAction === 'create_new_qr'
                ? { testID: 'restore-requester-create-new-qr', title: t('connect.generateNewQrCode'), action: reversePairing.start }
                : null;
    const scrollViewStyle: StyleProp<ViewStyle> = embedded
        ? [styles.scrollView, { backgroundColor: 'transparent' }]
        : styles.scrollView;

    React.useEffect(() => {
        props.onNavigationLockChange?.(claimOwnsNavigation);
        return () => props.onNavigationLockChange?.(false);
    }, [claimOwnsNavigation, props.onNavigationLockChange]);

    React.useEffect(() => {
        if (pairing.phase !== 'succeeded' || props.entryIntent !== 'enter_home' || requiresComputerSetup || !canLeaveApproved) return;
        if (handledProfileIdRef.current === pairing.profileId) return;
        handledProfileIdRef.current = pairing.profileId;
        const generation = openGenerationRef.current + 1;
        openGenerationRef.current = generation;
        void openEnrolledHomeOrReturnToShell({
            profileId: pairing.profileId,
            targetLabel: formatHomeEnrollmentTargetLabel(pairing.descriptor),
            isCurrent: () => openGenerationRef.current === generation,
            refreshAuth: auth.refreshFromActiveServer,
        }).then((result) => {
            if (result !== 'cancelled' && openGenerationRef.current === generation) {
                setShellNavigationRequested(true);
            }
        });
    }, [auth.refreshFromActiveServer, canLeaveApproved, pairing, props.entryIntent, requiresComputerSetup]);

    React.useEffect(() => {
        if (!shellNavigationRequested || claimOwnsNavigation) return;
        resolvePostAuthLanding({ replace: router.replace });
    }, [claimOwnsNavigation, router, shellNavigationRequested]);

    React.useEffect(() => () => {
        openGenerationRef.current += 1;
    }, []);

    const restoreRedirectNotice: RestoreRedirectNotice | null = React.useMemo(() => {
        const providerId = (paramString(params, 'provider') ?? '').trim().toLowerCase();
        const reason = parseRestoreRedirectReason(paramString(params, 'reason'));
        if (!providerId || !reason) return null;

        const provider = getAuthProvider(providerId);
        if (!provider?.getRestoreRedirectNotice) return null;
        return provider.getRestoreRedirectNotice({ reason });
    }, [params]);

    useEffect(() => {
        let mounted = true;
        fireAndForget((async () => {
            const features = await getReadyServerFeatures();
            const enabled = features?.features?.auth?.recovery?.providerReset?.enabled === true;
            if (mounted) setProviderResetEnabled(enabled);
        })(), { tag: 'RestoreQrView.loadProviderResetEnabled' });
        return () => {
            mounted = false;
        };
    }, []);

    const hasStatusContent = presentation.activity
        || (presentation.contextualFacts !== 'none' && targetLabel != null)
        || pairing.phase === 'ready'
        || approvedCode !== null;
    const openSecretKeyLogin = () => {
        if (embedded && props.onOpenSecretKeyLogin) {
            props.onOpenSecretKeyLogin();
            return;
        }
        const target = props.targetProfileId
            ? resolveHomeAuthenticationTarget({ kind: 'saved_profile', profileRef: props.targetProfileId })
            : null;
        router.push(props.targetProfileId ? {
            pathname: '/restore/manual',
            params: {
                targetServerId: props.targetProfileId,
                targetServerUrl: target?.canonicalServerUrl ?? '',
            },
        } : '/restore/manual');
    };

    if (requiresComputerSetup && pairing.phase === 'succeeded' && canLeaveApproved) {
        const frame = <View style={[styles.container, embedded ? styles.embeddedContainer : null]}>
            <View style={[styles.contentWrapper, embedded ? styles.embeddedContentWrapper : null]}>
                <EnrolledComputerSetup profileId={pairing.profileId}
                    onSucceeded={() => setSetupCompletedProfileId(pairing.profileId)}
                    onBack={() => { if (props.onBack) props.onBack(); else router.back(); }} />
            </View>
        </View>;
        return embedded ? frame : <ScrollView style={scrollViewStyle} contentContainerStyle={{ flexGrow: 1 }}>{frame}</ScrollView>;
    }

    const content = (
        <View style={[styles.container, embedded ? styles.embeddedContainer : null]}>
            <View style={[styles.contentWrapper, embedded ? styles.embeddedContentWrapper : null]}>
                {restoreRedirectNotice ? (
                    <View style={[styles.noticeCard, embedded ? styles.embeddedNoticeCard : null]}>
                        <Text style={styles.noticeTitle}>{restoreRedirectNotice.title}</Text>
                        <Text style={styles.noticeBody}>{restoreRedirectNotice.body}</Text>
                    </View>
                ) : null}

                <Text style={[styles.sectionLead, embedded ? styles.embeddedSectionLead : null]}>
                    {t(presentation.primaryTranslationKey)}
                </Text>

                {/* On the step column an empty status block (no progress, Home or QR) draws nothing. */}
                {embedded && !hasStatusContent ? null : <View
                    style={[styles.statusCard, embedded ? styles.embeddedStatusCard : null]}
                    accessibilityLiveRegion={presentation.liveRegion}
                >
                    {presentation.activity && approvedCode === null ? (
                        <ActivitySpinner size="small" />
                    ) : null}
                    {presentation.contextualFacts !== 'none' && targetLabel ? (
                        <Text style={[styles.targetName, embedded ? styles.embeddedTargetName : null]}>{targetLabel}</Text>
                    ) : null}
                    {pairing.phase === 'ready' || approvedCode !== null ? (
                        <View style={[styles.qrBlock, embedded ? styles.embeddedQrBlockInner : null]}>
                            <RequesterCodeCard
                                link={pairing.phase === 'ready' ? pairing.link : approvedCode!.link}
                                qrAvailable={pairing.phase === 'ready' ? pairing.qrAvailable : approvedCode!.qrAvailable}
                                expiresAtMs={pairing.phase === 'ready' ? pairing.invite.expiresAtMs : null}
                                approved={approvedCode !== null}
                                onApprovedSettled={onApprovedSettled}
                            />
                        </View>
                    ) : null}
                    {pairing.phase === 'ready' ? (
                        <>
                            <PairingLinkDisclosure
                                testIDPrefix="restore-requester-link"
                                link={pairing.link}
                            />
                        </>
                    ) : null}
                </View>}

                {!claimOwnsNavigation && pairing.phase !== 'succeeded' && embedded ? (
                    <View style={styles.embeddedActions}>
                        {recoveryButton ? (
                            <View style={styles.embeddedPrimary}>
                                <RoundButton {...recoveryButton} size="large" />
                            </View>
                        ) : null}
                        {!props.targetProfileId ? (
                            <TextLinkButton testID="restore-choose-home" label={t('connect.addPhoneChooseHomeTitle')} onPress={() => router.push('/server')} />
                        ) : null}
                        {reversePairing.canCancel ? (
                            <TextLinkButton testID="restore-requester-cancel" label={t('common.cancel')} onPress={reversePairing.cancel} />
                        ) : null}
                        {canOpenScanner && props.onOpenScanQr ? (
                            <TextLinkButton testID="restore-open-scan-qr" label={t('connect.scanQrCodeOnDevice')} onPress={props.onOpenScanQr} />
                        ) : null}
                        {props.onOpenPairingLinkEntry ? (
                            <TextLinkButton testID="restore-enter-pairing-link" label={t('connect.pairingLinkPlaceholder')} onPress={props.onOpenPairingLinkEntry} />
                        ) : null}
                        <TextLinkButton testID="restore-open-manual" label={t('connect.restoreWithSecretKeyInstead')} onPress={openSecretKeyLogin} />
                        {providerResetEnabled ? (
                            <TextLinkButton testID="restore-open-lost-access" label={t('connect.lostAccessLink')} onPress={() => router.push('/restore/lost-access')} />
                        ) : null}
                    </View>
                ) : null}
                {!claimOwnsNavigation && !embedded ? (
                <View style={styles.footer}>
                    {reversePairing.canCancel ? (
                        <>
                            <View style={styles.footerButton}>
                                <RoundButton
                                    testID="restore-requester-cancel"
                                    size="small"
                                    title={t('common.cancel')}
                                    display="inverted"
                                    onPress={reversePairing.cancel}
                                />
                            </View>
                            <View style={styles.footerButtonSpacer} />
                        </>
                    ) : null}
                    {recoveryButton ? (
                        <>
                            <View style={styles.footerButton}>
                                <RoundButton {...recoveryButton} size="small" display="inverted" />
                            </View>
                            <View style={styles.footerButtonSpacer} />
                        </>
                    ) : null}
                    {canOpenScanner ? (
                        <>
                            <View style={styles.footerButton}>
                                <RoundButton
                                    testID="restore-open-scan-qr"
                                    size="small"
                                    title={t('connect.scanQrCodeOnDevice')}
                                    display="inverted"
                                    onPress={props.onOpenScanQr}
                                />
                            </View>
                            <View style={styles.footerButtonSpacer} />
                        </>
                    ) : null}
                    {props.onOpenPairingLinkEntry ? (
                        <>
                            <View style={styles.footerButton}>
                                <RoundButton
                                    testID="restore-enter-pairing-link"
                                    size="small"
                                    title={t('connect.pairingLinkPlaceholder')}
                                    display="inverted"
                                    onPress={props.onOpenPairingLinkEntry}
                                />
                            </View>
                            <View style={styles.footerButtonSpacer} />
                        </>
                    ) : null}
                    <View style={styles.footerButton}>
                        <RoundButton
                            testID="restore-open-manual"
                            size="normal"
                            title={t('connect.restoreWithSecretKeyInstead')}
                            display="inverted"
                            onPress={openSecretKeyLogin}
                        />
                    </View>
                    {providerResetEnabled ? (
                        <>
                            <View style={styles.footerButtonSpacer} />
                            <View style={styles.footerButton}>
                                <RoundButton
                                    testID="restore-open-lost-access"
                                    size="small"
                                    title={t('connect.lostAccessLink')}
                                    display="inverted"
                                    onPress={() => router.push('/restore/lost-access')}
                                />
                            </View>
                        </>
                    ) : null}
                </View>
                ) : null}
            </View>
        </View>
    );

    if (embedded) {
        return content;
    }

    return (
        <ScrollView style={scrollViewStyle} contentContainerStyle={{ flexGrow: 1 }}>
            {content}
        </ScrollView>
    );
});
