import * as React from 'react';
import { useStepFocal } from '@/components/ui/motion/stepMotion/useStepFocal';
import { Platform, ScrollView, View } from 'react-native';
import type { StyleProp, TextStyle, ViewStyle } from 'react-native';
import Constants from 'expo-constants';
import { useRouter } from 'expo-router';
import { resolvePostAuthLanding } from '@/components/onboarding/state/resolvePostAuthLanding';
import { useIsFocused, usePreventRemove } from '@react-navigation/native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { ACCOUNT_DEVICES_APPROVE_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';

import { generateAuthKeyPair, authQRStart } from '@/auth/flows/qrStart';
import { authQRWait } from '@/auth/flows/qrWait';
import { classifyPairingLink } from '@/auth/pairing/classifyPairingLink';
import { openTerminalConnectApproval } from '@/auth/terminal/terminalConnectContinuation';
import { useAuth } from '@/auth/context/AuthContext';
import { t } from '@/text';
import { useFeatureDecision } from '@/hooks/server/useFeatureDecision';
import { pairingConsume, pairingRequest, pairingStart, type PairingRequestResult } from '@/sync/api/account/apiPairingAuth';
import {
    adoptHomeProfileWithCredentials,
    finalizeRetainedHomeProfileAdoption,
    HomeProfileAdoptionPartialCommitError,
    isHomeProfileAdoptionPartialCommitFailure,
    type HomeProfileAdoptionPartialCommitFailure,
} from '@/sync/domains/server/adoptHomeProfile';
import {
    computeHomeQrBindingProofV2,
    deriveHomeQrBindingKeyV2,
    deriveHomeQrRendezvousSecretV2,
    deriveHomeQrRendezvousVerifierV2,
    type HomeQrInviteV2,
} from '@happier-dev/protocol/crypto/qrProvisioningV2';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import type { HomeQrEnrollmentTarget } from '@/auth/flows/qrStart';
import { resolveHomeEnrollmentTransport } from '@/auth/enrollment/homeEnrollmentTransport';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { Text } from '@/components/ui/text/Text';
import { resolveLocalDeviceLabel } from '@/utils/platform/resolveLocalDeviceLabel';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { Typography } from '@/constants/Typography';
import { PairingCountdown } from '@/components/auth/pairing/PairingCountdown';
import { QrCodeScannerView } from '@/components/qr/QrCodeScannerView';
import { trackAccountRestored, trackAuthEnrollmentTransientRetry } from '@/track';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { promptAccountConnectApprovalRequired } from './accountConnectApprovalGuidance';
import { admitDirectHomeQrV2, runDirectHomeQrCompletion } from '@happier-dev/cli-common/homeEnrollment';
import {
    formatEnrollmentExpiry,
    formatHomeEnrollmentTargetLabel,
    resolveHomeEnrollmentPresentation,
    type HomeEnrollmentScannerResult,
} from '@/auth/pairing/pairingPresentation';
import { probeServerFeaturesAtUrl } from '@/sync/api/capabilities/serverFeaturesClient';
import { isServerFeaturesProbeRetryable } from '@/sync/api/capabilities/serverFeaturesProbeRetryability';
import { enrollmentPollingBackoffMs } from '@/auth/enrollment/enrollmentPollingBackoff';
import { createTrustedHomeQrCompletionAdapters } from '@/auth/pairing/trustedHomeQrCompletionAdapters';
import {
    buildHomeConnectionDescriptorForProfile,
    resolveServerProfileForPortableIdentity,
    type ServerProfile,
} from '@/sync/domains/server/serverProfiles';
import type { HomeQrEntryIntent } from '@/auth/pairing/homeQrEntryIntent';
import { openEnrolledHomeOrReturnToShell } from '@/auth/pairing/openEnrolledHome';
import { isDesktopHost } from '@/utils/platform/desktopHost';
import { EnrolledComputerSetup } from './EnrolledComputerSetup';

const DESKTOP_QR_SCAN_FEATURE_ID = 'auth.pairing.boundQrV2' as const;

type ScannedHomeEnrollmentPartialCommit = Readonly<{
    kind: 'partial_commit';
    error: HomeProfileAdoptionPartialCommitFailure;
}>;

function classifyScannedHomeEnrollmentPartialCommit(
    error: unknown,
): ScannedHomeEnrollmentPartialCommit | null {
    return isHomeProfileAdoptionPartialCommitFailure(error)
        ? { kind: 'partial_commit', error }
        : null;
}

function isTransientEnrollmentStatus(status: number): boolean {
    return status === 0 || status === 408 || status === 429 || status >= 500;
}

async function waitForEnrollmentRetry(params: Readonly<{
    expiresAtMs: number;
    failureCount: number;
    signal: AbortSignal;
}>): Promise<boolean> {
    const remainingMs = params.expiresAtMs - Date.now();
    if (remainingMs <= 0 || params.signal.aborted) return false;
    const delayMs = Math.min(enrollmentPollingBackoffMs(params.failureCount), remainingMs);
    return await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
            params.signal.removeEventListener('abort', handleAbort);
            resolve(!params.signal.aborted && Date.now() < params.expiresAtMs);
        }, delayMs);
        const handleAbort = () => {
            clearTimeout(timer);
            resolve(false);
        };
        params.signal.addEventListener('abort', handleAbort, { once: true });
    });
}

/**
 * Best-effort cleanup of a pending reverse-QR rendezvous row through the existing
 * pairing consume owner. Runs without the aborted attempt signal so a cancel or
 * unmount consume is not itself aborted.
 */
async function consumeReversePairingRow(pairId: string, target: HomeQrEnrollmentTarget): Promise<void> {
    await pairingConsume({ pairId, intent: 'cancel' }, target).catch(() => null);
}

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
    title: {
        ...Typography.variant('display'),
        color: theme.colors.text.primary,
        marginBottom: theme.space.s8,
        textAlign: 'center',
    },
    subtitle: {
        fontSize: 16,
        color: theme.colors.text.secondary,
        lineHeight: 24,
        textAlign: 'center',
        ...Typography.default(),
    },
    statusCard: {
        marginTop: theme.space.s12,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        borderRadius: 14,
        paddingHorizontal: theme.space.s16,
        paddingVertical: 14,
        backgroundColor: theme.colors.surface.base,
    },
    embeddedStatusCard: {
        marginTop: theme.space.s10,
    },
    detailLabel: {
        marginTop: theme.space.s12,
        ...Typography.variant('body'),
        color: theme.colors.text.secondary,
    },
    identityValue: {
        marginTop: theme.space.s4,
        ...Typography.variant('heading'),
        color: theme.colors.text.primary,
    },
    footer: {
        marginTop: theme.space.s12,
        alignItems: 'center',
        width: '100%',
        gap: theme.space.s12,
    },
    // Embedded, the view is a step on its host's column: copy and actions start at the column's
    // edge under the host's heading, and the other ways in are quiet text actions.
    embeddedSubtitle: {
        textAlign: 'left',
    },
    embeddedFooter: {
        marginTop: theme.space.s16,
        alignItems: 'flex-start',
        gap: theme.space.s16,
    },
    footerButton: {
        width: '100%',
        maxWidth: 360,
    },
    // On a step column an action spans the column, at the pane's one action height.
    embeddedFooterButton: {
        width: '100%',
    },
}));

function resolveDeviceLabel(): string | null {
    return resolveLocalDeviceLabel({ deviceName: Constants.deviceName, platform: Platform.OS });
}

export type RestoreScanComputerQrViewProps = Readonly<{
    entryIntent: HomeQrEntryIntent;
    embedded?: boolean;
    initialPairingLink?: string | null;
    onBack?: () => void;
    /** False when the host already draws the way back (the welcome pane's chevron, the setup card's back). */
    showBack?: boolean;
    onOpenSecretKeyLogin?: () => void;
    additionalSignInWays?: React.ReactNode;
    onOpenPairingLinkEntry?: () => void;
    onShowQrInstead?: () => void;
    initialResult?: 'legacy_pairing' | 'expired';
    onNavigationLockChange?: (locked: boolean) => void;
    /**
     * Reports changes to the direction of the invite this view is processing (null
     * when none is active), so host chrome matches the body for in-place scans.
     */
    onInviteDirectionChange?: (direction: HomeQrInviteV2['direction'] | null) => void;
    expectedHomeServerIdentityId?: string;
    onCredentials?: (input: Readonly<{ credentials: AuthCredentials; homeServerIdentityId: string }>) => Promise<void>;
    onAuthenticated?: (input: Readonly<{ credentials: AuthCredentials; homeServerIdentityId: string }>) => Promise<void>;
}>;

type RequesterApproval = Readonly<{
    invite: Extract<HomeQrInviteV2, { direction: 'requester_displays' }>;
    profile: ServerProfile;
    descriptor: HomeQrInviteV2['home'];
}>;

function formatApprovalExpiry(time: string): string {
    return t('connect.deviceApprovalExpiresIn', { time });
}

export const RestoreScanComputerQrView = React.memo(function RestoreScanComputerQrView(props: RestoreScanComputerQrViewProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const router = useRouter();
    const auth = useAuth();
    const isFocused = useIsFocused();
    const embedded = props.embedded === true;
    const pairingDecision = useFeatureDecision(DESKTOP_QR_SCAN_FEATURE_ID);
    // The focused Home may decide only its own server capability. Keep its
    // server-axis result out of local scanner admission; after parsing, the
    // exact QR target is probed and decides whether enrollment is supported.
    const pairingState = pairingDecision === null
        ? 'unknown'
        : pairingDecision.blockedBy === 'server'
            ? 'enabled'
            : pairingDecision.state;

    const [phase, setPhase] = React.useState<'idle' | 'requesting' | 'securing'>('idle');
    const scannerFocal = useStepFocal();
    const [enrollmentResult, setEnrollmentResult] = React.useState<HomeEnrollmentScannerResult | null>(props.initialResult ?? null);
    // A pasted terminal link that expired is a link, not a QR: its message says so.
    const [expiredTerminalLink, setExpiredTerminalLink] = React.useState(false);
    // How the code being processed arrived; an expired one is replaced by the same route.
    const [inviteOrigin, setInviteOrigin] = React.useState<'scanned' | 'link'>('scanned');
    const [activeInvite, setActiveInvite] = React.useState<HomeQrInviteV2 | null>(null);
    const [pendingRequesterApproval, setPendingRequesterApproval] = React.useState<RequesterApproval | null>(null);
    const [navigationLocked, setNavigationLocked] = React.useState(false);
    const [shellNavigationRequested, setShellNavigationRequested] = React.useState(false);
    const [desktopEnrollment, setDesktopEnrollment] = React.useState<Readonly<{
        profileId: string;
        targetLabel: string;
        credentials: AuthCredentials;
        homeServerIdentityId: string;
    }> | null>(null);
    const desktopCompletionGenerationRef = React.useRef(0);
    React.useEffect(() => () => { desktopCompletionGenerationRef.current += 1; }, []);
    usePreventRemove(navigationLocked, () => undefined);
    const nextAttemptIdRef = React.useRef(0);
    type EnrollmentAttempt = {
        id: number;
        controller: AbortController;
        cancellable: boolean;
    };
    const activeAttemptRef = React.useRef<EnrollmentAttempt | null>(null);
    const retainedAdoptionRef = React.useRef<Readonly<{
        invite: HomeQrInviteV2;
        credentials: AuthCredentials;
        finish: () => ReturnType<typeof finalizeRetainedHomeProfileAdoption>;
    }> | null>(null);

    const isCurrentAttempt = React.useCallback((attemptId: number) => (
        activeAttemptRef.current?.id === attemptId
        && activeAttemptRef.current.controller.signal.aborted === false
    ), []);

    const beginEnrollmentAttempt = React.useCallback((invite: HomeQrInviteV2) => {
        if (activeAttemptRef.current) return null;
        const attempt: EnrollmentAttempt = {
            id: nextAttemptIdRef.current + 1,
            controller: new AbortController(),
            cancellable: true,
        };
        nextAttemptIdRef.current = attempt.id;
        activeAttemptRef.current = attempt;
        setEnrollmentResult(null);
        setPhase('requesting');
        setActiveInvite(invite);
        return attempt;
    }, []);

    const cancelEnrollmentAttempt = React.useCallback(async () => {
        const attempt = activeAttemptRef.current;
        if (!attempt || !attempt.cancellable) return;
        // Aborting hands a started pairing row's cancel consume to its
        // completion loop, which owns that row.
        attempt.controller.abort();
        activeAttemptRef.current = null;
        setPhase('idle');
        setActiveInvite(null);
    }, []);

    const resetEnrollmentResult = React.useCallback(() => {
        retainedAdoptionRef.current = null;
        setEnrollmentResult(null);
        setExpiredTerminalLink(false);
        setActiveInvite(null);
        setPhase('idle');
    }, []);

    const handleBack = React.useCallback(() => {
        if (props.onBack) {
            props.onBack();
            return;
        }
        router.back();
    }, [props.onBack, router]);

    const showBack = props.showBack !== false;
    const subtitleStyle: StyleProp<TextStyle> = embedded ? [styles.subtitle, styles.embeddedSubtitle] : styles.subtitle;
    const renderAlternative = (testID: string, title: string, onPress: () => void) => (
        embedded ? (
            <TextLinkButton key={testID} testID={testID} label={title} onPress={onPress} />
        ) : (
            <View key={testID} style={styles.footerButton}>
                <RoundButton
                    testID={testID}
                    size="small"
                    title={title}
                    display="inverted"
                    action={async () => {
                        onPress();
                    }}
                />
            </View>
        )
    );

    const openSecretKeyLogin = React.useCallback(() => {
        if (embedded && props.onOpenSecretKeyLogin) {
            props.onOpenSecretKeyLogin();
            return;
        }
        router.push('/restore/manual');
    }, [embedded, props.onOpenSecretKeyLogin, router]);

    const openShowQrInstead = React.useCallback(() => {
        props.onShowQrInstead?.();
    }, [props.onShowQrInstead]);

    const scrollViewStyle: StyleProp<ViewStyle> = props.embedded
        ? [styles.scrollView, { backgroundColor: 'transparent' }]
        : styles.scrollView;
    const containerStyle: StyleProp<ViewStyle> = [styles.container, embedded ? styles.embeddedContainer : null];
    const contentWrapperStyle: StyleProp<ViewStyle> = [styles.contentWrapper, embedded ? styles.embeddedContentWrapper : null];

    const classifyScannedLink = React.useCallback((rawUrl: string) => classifyPairingLink(
        rawUrl,
        props.expectedHomeServerIdentityId
            ? { expectedInvite: { homeServerIdentityId: props.expectedHomeServerIdentityId, direction: 'trusted_home_displays' } }
            : undefined,
    ), [props.expectedHomeServerIdentityId]);

    React.useEffect(() => {
        props.onNavigationLockChange?.(navigationLocked);
        return () => props.onNavigationLockChange?.(false);
    }, [navigationLocked, props.onNavigationLockChange]);

    const activeInviteDirection = activeInvite?.direction ?? null;
    const reportedInviteDirectionRef = React.useRef<HomeQrInviteV2['direction'] | null>(null);
    const onInviteDirectionChange = props.onInviteDirectionChange;
    React.useEffect(() => {
        if (reportedInviteDirectionRef.current === activeInviteDirection) return;
        reportedInviteDirectionRef.current = activeInviteDirection;
        onInviteDirectionChange?.(activeInviteDirection);
    }, [activeInviteDirection, onInviteDirectionChange]);
    React.useEffect(() => () => {
        if (reportedInviteDirectionRef.current === null) return;
        reportedInviteDirectionRef.current = null;
        onInviteDirectionChange?.(null);
    }, [onInviteDirectionChange]);

    React.useEffect(() => {
        if (!shellNavigationRequested || navigationLocked) return;
        resolvePostAuthLanding({ replace: router.replace });
    }, [navigationLocked, router, shellNavigationRequested]);

    /** Persist the enrollment result under the explicit target Home without touching focus. */
    const completeEnrollment = React.useCallback(async (
        credentials: AuthCredentials,
        enrolledIdentity: string | null,
        observedDescriptor: HomeQrInviteV2['home'],
    ): Promise<
        | Readonly<{ kind: 'completed'; profile: ServerProfile }>
        | ScannedHomeEnrollmentPartialCommit
        | Readonly<{ kind: 'failed' }>
    > => {
        try {
            const descriptor = observedDescriptor;
            // A QR credential is authority-bearing. Persist only after the target Home
            // identity has been bound either by the V2 invite or the Home response.
            if (!enrolledIdentity || enrolledIdentity !== descriptor.homeServerIdentityId) return { kind: 'failed' };
            // Lane 04 owns the complete credential/profile transaction, including
            // same-identity canonical URL migration and obsolete-scope cleanup.
            const profile = await adoptHomeProfileWithCredentials({
                descriptor,
                source: 'qr',
                preserveUserLabel: true,
                credentials,
            });
            return { kind: 'completed', profile };
        } catch (error) {
            return classifyScannedHomeEnrollmentPartialCommit(error) ?? { kind: 'failed' };
        }
    }, []);

    const openRetainedHomeOrReturnToShell = React.useCallback(async (
        profileId: string,
        targetLabel: string,
        attemptId: number,
    ): Promise<void> => {
        const result = await openEnrolledHomeOrReturnToShell({
            profileId,
            targetLabel,
            isCurrent: () => isCurrentAttempt(attemptId),
            refreshAuth: auth.refreshFromActiveServer,
        });
        if (result !== 'cancelled' && isCurrentAttempt(attemptId)) {
            setShellNavigationRequested(true);
        }
    }, [auth.refreshFromActiveServer, isCurrentAttempt]);

    const finishEnrolledHome = React.useCallback(async (params: Readonly<{
        profileId: string;
        credentials: AuthCredentials;
        homeServerIdentityId: string;
        targetLabel: string;
        attemptId: number;
    }>): Promise<'succeeded' | null> => {
        if (isDesktopHost()) {
            const { profileId, targetLabel, credentials, homeServerIdentityId } = params;
            setDesktopEnrollment({ profileId, targetLabel, credentials, homeServerIdentityId });
            return null;
        }
        if (props.onAuthenticated) {
            await props.onAuthenticated({ credentials: params.credentials, homeServerIdentityId: params.homeServerIdentityId });
            return null;
        }
        trackAccountRestored();
        if (props.entryIntent === 'add_home') return 'succeeded';
        await openRetainedHomeOrReturnToShell(params.profileId, params.targetLabel, params.attemptId);
        return null;
    }, [openRetainedHomeOrReturnToShell, props.entryIntent, props.onAuthenticated]);

    const retryRetainedHome = React.useCallback(async () => {
        const retry = retainedAdoptionRef.current;
        if (!retry) return;
        const attempt = beginEnrollmentAttempt(retry.invite);
        if (!attempt) return;
        retainedAdoptionRef.current = null;
        attempt.cancellable = false;
        setNavigationLocked(true);
        setPhase('securing');
        let profileCommitted = false;
        try {
            const profile = await retry.finish();
            if (!isCurrentAttempt(attempt.id)) return;
            if (!profile) {
                setEnrollmentResult('partial_commit');
                return;
            }
            profileCommitted = true;
            const result = await finishEnrolledHome({
                profileId: profile.id,
                credentials: retry.credentials,
                homeServerIdentityId: retry.invite.home.homeServerIdentityId,
                targetLabel: formatHomeEnrollmentTargetLabel(retry.invite.home),
                attemptId: attempt.id,
            });
            if (isCurrentAttempt(attempt.id)) setEnrollmentResult(result);
        } catch {
            if (!isCurrentAttempt(attempt.id)) return;
            if (!profileCommitted) retainedAdoptionRef.current = retry;
            setEnrollmentResult(profileCommitted ? 'retryable_error' : 'partial_commit');
        } finally {
            if (activeAttemptRef.current === attempt) {
                activeAttemptRef.current = null;
                setPhase('idle');
                setNavigationLocked(false);
            }
        }
    }, [beginEnrollmentAttempt, finishEnrolledHome, isCurrentAttempt]);

    const processHomeQrInvite = React.useCallback(
        async (link: RequesterApproval | Readonly<{
            invite: Extract<HomeQrInviteV2, { direction: 'trusted_home_displays' }>;
        }>) => {
            const attempt = beginEnrollmentAttempt(link.invite);
            if (!attempt) return;

            let target: HomeQrEnrollmentTarget | null = null;
            let terminalResult: HomeEnrollmentScannerResult | null = null;
            const publishTerminalResult = (result: HomeEnrollmentScannerResult) => {
                terminalResult = result;
                setEnrollmentResult(result);
            };
            try {
                if (Date.now() > link.invite.expiresAtMs) {
                    publishTerminalResult('expired');
                    return;
                }

                if ('profile' in link) {
                    const { createActionExecutor } = await import('@happier-dev/protocol/actions/actionExecutor');
                    if (!isCurrentAttempt(attempt.id)) return;
                    const runRequesterApproval = async () => {
                        const transportResolution = await resolveHomeEnrollmentTransport(link.descriptor);
                        if (!isCurrentAttempt(attempt.id)) {
                            if (transportResolution.ok) await transportResolution.transport.close().catch(() => {});
                            return;
                        }
                        if (!transportResolution.ok) {
                            publishTerminalResult('retryable_error');
                            return;
                        }
                        const approvalTarget = { ...transportResolution.transport, serverId: link.profile.id };
                        target = approvalTarget;
                        const targetFeatureSnapshot = await probeServerFeaturesAtUrl({
                            endpointUrl: approvalTarget.endpointUrl,
                            runtimeOrigin: approvalTarget.runtimeOrigin,
                            ...(approvalTarget.homeCarrier ? { homeCarrier: approvalTarget.homeCarrier } : {}),
                            serverId: link.profile.id,
                            force: true,
                            signal: attempt.controller.signal,
                        });
                        if (!isCurrentAttempt(attempt.id)) return;
                        if (targetFeatureSnapshot.status === 'error') {
                            publishTerminalResult(targetFeatureSnapshot.reason === 'identity_conflict'
                                ? 'wrong_target'
                                : isServerFeaturesProbeRetryable(targetFeatureSnapshot)
                                    ? 'retryable_error'
                                    : 'invalid_request');
                            return;
                        }
                        if (targetFeatureSnapshot.status === 'unsupported') {
                            publishTerminalResult('update_required');
                            return;
                        }
                        if (targetFeatureSnapshot.serverIdentityId !== link.descriptor.homeServerIdentityId) {
                            publishTerminalResult('wrong_target');
                            return;
                        }
                        if (admitDirectHomeQrV2(targetFeatureSnapshot.features).kind !== 'admitted') {
                            publishTerminalResult('update_required');
                            return;
                        }

                        const qrSecret = decodeBase64(link.invite.qrSecretBase64Url, 'base64url');
                        let startFailures = 0;
                        while (true) {
                            const started = await pairingStart({
                                direction: 'requester_displays',
                                secretHash: encodeBase64(deriveHomeQrRendezvousVerifierV2(qrSecret), 'base64url'),
                                pairId: link.invite.pairId,
                                expiresAtMs: link.invite.expiresAtMs,
                            }, approvalTarget, { signal: attempt.controller.signal }).finally(async () => {
                                // A transport abort can hide a start that reached the Home.
                                // Reuse the same best-effort cancellation of this known pair id.
                                if (!isCurrentAttempt(attempt.id)) {
                                    await consumeReversePairingRow(link.invite.pairId, approvalTarget);
                                }
                            });
                            if (!isCurrentAttempt(attempt.id)) {
                                return;
                            }
                            if (started.ok) break;
                            if (!isTransientEnrollmentStatus(started.status)) {
                                publishTerminalResult('retryable_error');
                                return;
                            }
                            startFailures += 1;
                            if (!await waitForEnrollmentRetry({
                                expiresAtMs: link.invite.expiresAtMs,
                                failureCount: startFailures,
                                signal: attempt.controller.signal,
                            })) {
                                if (isCurrentAttempt(attempt.id)) {
                                    publishTerminalResult('expired');
                                }
                                return;
                            }
                        }

                        // The one approver completion loop (shared with the Home-displayed
                        // QR): poll the row, verify the requester's proof against the key
                        // this QR pinned, complete on the Home, reject what fails. It owns
                        // the row's cancel consume through this attempt's signal.
                        const outcome = await runDirectHomeQrCompletion({
                            direction: link.invite.direction,
                            pairId: link.invite.pairId,
                            homeServerIdentityId: link.invite.home.homeServerIdentityId,
                            qrSecret,
                            issuedAtMs: link.invite.issuedAtMs,
                            expiresAtMs: link.invite.expiresAtMs,
                            expectedRequesterPublicKey: decodeBase64(link.invite.requesterPublicKeyBase64Url, 'base64url'),
                            adapters: {
                                ...createTrustedHomeQrCompletionAdapters({
                                    target: approvalTarget,
                                    // Home-authority commit boundary: no cancel past this point.
                                    onCompleting: () => {
                                        if (!isCurrentAttempt(attempt.id)) return;
                                        attempt.cancellable = false;
                                        setNavigationLocked(true);
                                        setPhase('securing');
                                    },
                                }),
                                // This attempt's `finally` owns the transport.
                                close: async () => undefined,
                            },
                            signal: attempt.controller.signal,
                        }).completion;
                        if (!isCurrentAttempt(attempt.id)) return;
                        switch (outcome.kind) {
                            case 'completed':
                                publishTerminalResult('succeeded');
                                return;
                            case 'expired':
                            case 'invalid_request':
                                publishTerminalResult(outcome.kind);
                                return;
                            case 'failed':
                                publishTerminalResult('retryable_error');
                                return;
                            case 'cancelled':
                                return;
                        }
                    };
                    // This executor owns only this press. Pairing material stays in the
                    // attempt closure, outside the Action input and observations.
                    const executor = createActionExecutor({
                        accountDevicesApproveAction: async () => {
                            await runRequesterApproval();
                            return terminalResult === 'succeeded';
                        },
                    });
                    const approval = await executor.execute(ACCOUNT_DEVICES_APPROVE_ACTION_ID_V1, {}, {
                        surface: 'ui',
                        authority: 'present_user',
                        // This screen just obtained the person's Approve press.
                        bypassApprovals: true,
                        signal: attempt.controller.signal,
                    });
                    if (!approval.ok && isCurrentAttempt(attempt.id)) {
                        publishTerminalResult('retryable_error');
                    }
                    return;
                }

                let transportFailureCount = 0;
                while (!target) {
                    const transportResolution = await resolveHomeEnrollmentTransport(link.invite.home);
                    const resolvedTarget = transportResolution.ok
                        ? transportResolution.transport
                        : null;
                    if (!isCurrentAttempt(attempt.id)) {
                        await resolvedTarget?.close().catch(() => {});
                        return;
                    }
                    if (transportResolution.ok) {
                        target = transportResolution.transport;
                        break;
                    }
                    if (transportResolution.reason !== 'iroh_transport_unavailable') {
                        publishTerminalResult('retryable_error');
                        return;
                    }

                    transportFailureCount += 1;
                    trackAuthEnrollmentTransientRetry();
                    const shouldRetry = await waitForEnrollmentRetry({
                        expiresAtMs: link.invite.expiresAtMs,
                        failureCount: transportFailureCount,
                        signal: attempt.controller.signal,
                    });
                    if (!shouldRetry) {
                        if (isCurrentAttempt(attempt.id)) {
                            publishTerminalResult('expired');
                        }
                        return;
                    }
                }

                let featureProbeFailureCount = 0;
                let observedHomeDescriptor: HomeQrInviteV2['home'] | null = null;
                while (true) {
                    const targetFeatureSnapshot = await probeServerFeaturesAtUrl({
                        endpointUrl: target.endpointUrl,
                        runtimeOrigin: target.runtimeOrigin,
                        ...(target.homeCarrier ? { homeCarrier: target.homeCarrier } : {}),
                        serverId: target.serverId ?? link.invite.home.homeServerIdentityId,
                        force: true,
                        signal: attempt.controller.signal,
                    });
                    if (!isCurrentAttempt(attempt.id)) return;

                    if (isServerFeaturesProbeRetryable(targetFeatureSnapshot)) {
                        featureProbeFailureCount += 1;
                        trackAuthEnrollmentTransientRetry();
                        const shouldRetry = await waitForEnrollmentRetry({
                            expiresAtMs: link.invite.expiresAtMs,
                            failureCount: featureProbeFailureCount,
                            signal: attempt.controller.signal,
                        });
                        if (!shouldRetry) {
                            if (isCurrentAttempt(attempt.id)) {
                                publishTerminalResult('expired');
                            }
                            return;
                        }
                        continue;
                    }

                    if (targetFeatureSnapshot.status === 'unsupported') {
                        publishTerminalResult('update_required');
                        return;
                    }
                    if (targetFeatureSnapshot.status === 'error') {
                        publishTerminalResult(targetFeatureSnapshot.reason === 'identity_conflict'
                            ? 'wrong_target'
                            : 'invalid_request');
                        return;
                    }
                    if (targetFeatureSnapshot.serverIdentityId !== link.invite.home.homeServerIdentityId) {
                        publishTerminalResult('wrong_target');
                        return;
                    }
                    if (admitDirectHomeQrV2(targetFeatureSnapshot.features).kind !== 'admitted') {
                        publishTerminalResult('update_required');
                        return;
                    }
                    // The unauthenticated feature projection is advisory. The V2 QR
                    // possession/binding path owns the exact descriptor: transport
                    // selection has already reached that descriptor's endpoint and
                    // the observed stable Home identity above must match it before
                    // the bound request can proceed.
                    observedHomeDescriptor = link.invite.home;
                    break;
                }

                const keypair = generateAuthKeyPair();
                const qrSecret = decodeBase64(link.invite.qrSecretBase64Url, 'base64url');
                const bindingProof = computeHomeQrBindingProofV2({
                    direction: link.invite.direction,
                    qrSecret,
                    pairId: link.invite.pairId,
                    homeServerIdentityId: link.invite.home.homeServerIdentityId,
                    requesterPublicKey: keypair.publicKey,
                    expiresAtMs: link.invite.expiresAtMs,
                });
                const v2RequestContext = {
                    pairId: link.invite.pairId,
                    homeServerIdentityId: link.invite.home.homeServerIdentityId,
                    expiresAtMs: link.invite.expiresAtMs,
                    bindingProof,
                };
                let startFailureCount = 0;
                while (true) {
                    const startResult = await authQRStart(keypair, target, { signal: attempt.controller.signal });
                    if (!isCurrentAttempt(attempt.id)) return;
                    if (startResult.ok) break;
                    if (startResult.reason === 'cancelled') return;
                    if (startResult.reason !== 'transient') {
                        publishTerminalResult('invalid_request');
                        return;
                    }
                    startFailureCount += 1;
                    trackAuthEnrollmentTransientRetry();
                    const shouldRetry = await waitForEnrollmentRetry({
                        expiresAtMs: link.invite.expiresAtMs,
                        failureCount: startFailureCount,
                        signal: attempt.controller.signal,
                    });
                    if (!shouldRetry) {
                        if (isCurrentAttempt(attempt.id)) {
                            publishTerminalResult('expired');
                        }
                        return;
                    }
                }

                // V2 joins derive the rendezvous secret from QR-only material; V1 links
                // keep their released reader semantics.
                const rendezvousSecret = encodeBase64(deriveHomeQrRendezvousSecretV2(qrSecret), 'base64url');

                // Submitting the bound request is the direct-QR authorization boundary.
                // From here, the trusted Home may complete automatically, so local Cancel
                // must not claim the enrollment was revoked.
                attempt.cancellable = false;
                setNavigationLocked(true);
                setPhase('securing');
                const pairingParams = {
                    pairId: link.invite.pairId,
                    secret: rendezvousSecret,
                    publicKey: encodeBase64(keypair.publicKey),
                    deviceLabel: resolveDeviceLabel() ?? undefined,
                    homeServerIdentityId: v2RequestContext.homeServerIdentityId,
                    expiresAtMs: v2RequestContext.expiresAtMs,
                    bindingProof: v2RequestContext.bindingProof,
                };
                let pairingFailureCount = 0;
                let pairingRes: PairingRequestResult;
                while (true) {
                    pairingRes = await pairingRequest(pairingParams, target, { signal: attempt.controller.signal });
                    if (!isCurrentAttempt(attempt.id)) return;
                    if (pairingRes.ok) break;
                    if (pairingRes.reason !== 'http_error' || !isTransientEnrollmentStatus(pairingRes.status)) break;
                    pairingFailureCount += 1;
                    trackAuthEnrollmentTransientRetry();
                    const shouldRetry = await waitForEnrollmentRetry({
                        expiresAtMs: link.invite.expiresAtMs,
                        failureCount: pairingFailureCount,
                        signal: attempt.controller.signal,
                    });
                    if (!shouldRetry) {
                        if (isCurrentAttempt(attempt.id)) {
                            publishTerminalResult('expired');
                        }
                        return;
                    }
                }

                if (!pairingRes.ok) {
                    if (pairingRes.reason === 'not_found') {
                        publishTerminalResult('expired');
                    } else if (pairingRes.reason === 'already_requested') {
                        publishTerminalResult('already_requested');
                    } else {
                        publishTerminalResult('retryable_error');
                    }
                    return;
                }

                const result = await authQRWait(keypair, target, {
                    shouldCancel: () => !isCurrentAttempt(attempt.id),
                    signal: attempt.controller.signal,
                    expiresAtMs: link.invite.expiresAtMs,
                    v2Context: {
                        direction: link.invite.direction,
                        pairId: link.invite.pairId,
                        homeServerIdentityId: link.invite.home.homeServerIdentityId,
                        bindingSecret: deriveHomeQrBindingKeyV2(qrSecret),
                        bindingProof,
                        issuedAtMs: link.invite.issuedAtMs,
                        expiresAtMs: link.invite.expiresAtMs,
                    },
                });

                if (!isCurrentAttempt(attempt.id)) return;

                if (result.ok) {
                    // Credential persistence/profile adoption cannot be rolled back as one unit.
                    // Once authorization succeeds, stop presenting Cancel before entering that
                    // commit boundary so a late press cannot claim the attempt was cancelled.
                    attempt.cancellable = false;
                    setNavigationLocked(true);
                    setPhase('securing');
                    if (!observedHomeDescriptor) return;
                    if (props.onCredentials) {
                        if (!result.homeServerIdentityId || result.homeServerIdentityId !== props.expectedHomeServerIdentityId) return;
                        await props.onCredentials({ credentials: result.credentials, homeServerIdentityId: result.homeServerIdentityId });
                        return;
                    }
                    const stored = await completeEnrollment(
                        result.credentials,
                        result.homeServerIdentityId,
                        observedHomeDescriptor,
                    );
                    if (!isCurrentAttempt(attempt.id)) return;
                    if (stored.kind === 'partial_commit') {
                        const failure = stored.error;
                        if (failure instanceof HomeProfileAdoptionPartialCommitError && failure.canRetry) {
                            const credentials = result.credentials;
                            retainedAdoptionRef.current = {
                                invite: link.invite,
                                credentials,
                                finish: () => finalizeRetainedHomeProfileAdoption({
                                    descriptor: observedHomeDescriptor, source: 'qr', preserveUserLabel: true, credentials,
                                }, failure),
                            };
                        }
                        publishTerminalResult('partial_commit');
                        return;
                    }
                    if (stored.kind === 'failed') {
                        publishTerminalResult('retryable_error');
                        return;
                    }
                    const outcome = await finishEnrolledHome({
                        profileId: stored.profile.id,
                        targetLabel: formatHomeEnrollmentTargetLabel(link.invite.home),
                        credentials: result.credentials,
                        homeServerIdentityId: observedHomeDescriptor.homeServerIdentityId,
                        attemptId: attempt.id,
                    });
                    if (outcome) publishTerminalResult(outcome);
                } else {
                    if (result.reason === 'cancelled') {
                        return;
                    }
                    if (result.reason === 'expired') {
                        publishTerminalResult('expired');
                    } else if (
                        result.reason === 'rejected'
                        || result.reason === 'wrong_target'
                        || result.reason === 'malformed_response'
                        || result.reason === 'update_required'
                    ) {
                        publishTerminalResult(result.reason);
                    } else {
                        publishTerminalResult('invalid_request');
                    }
                }
            } catch {
                if (isCurrentAttempt(attempt.id)) {
                    publishTerminalResult('retryable_error');
                }
            } finally {
                await target?.close().catch(() => {});
                if (activeAttemptRef.current?.id === attempt.id) {
                    setNavigationLocked(false);
                    activeAttemptRef.current = null;
                    setPhase('idle');
                    if (!terminalResult) setActiveInvite(null);
                }
            }
        },
        [beginEnrollmentAttempt, completeEnrollment, finishEnrolledHome, isCurrentAttempt, props.expectedHomeServerIdentityId, props.onCredentials],
    );

    const processPairingLink = React.useCallback(
        async (rawUrl: string) => {
            const link = classifyScannedLink(rawUrl);
            if (link.kind === 'account_connect') {
                const action = await promptAccountConnectApprovalRequired({ showQr: Boolean(props.onShowQrInstead) });
                if (action === 'showQr') {
                    openShowQrInstead();
                }
                return;
            }
            if (link.kind === 'legacy_pairing') {
                setEnrollmentResult('legacy_pairing');
                return;
            }
            if (link.kind === 'expired_home_qr_invite') {
                setEnrollmentResult('expired');
                return;
            }
            if (link.kind === 'team_join' || link.kind === 'source_setup') {
                // A pasted Team join link is a way into a Home too; its join screen owns the rest.
                router.push(link.path);
                return;
            }
            if (link.kind === 'terminal_connect') {
                const result = await openTerminalConnectApproval(link.terminal, {
                    navigate: router.push,
                    refreshAuth: auth.refreshFromActiveServer,
                    isAuthenticated: auth.isAuthenticated,
                });
                if (result === 'expired') {
                    setExpiredTerminalLink(true);
                    setEnrollmentResult('expired');
                }
                return;
            }
            if (link.kind !== 'home_qr_invite') {
                setEnrollmentResult('invalid_request');
                return;
            }

            const invite = link.invite;
            if (invite.direction === 'requester_displays') {
                // Show the Home this device already trusts. The link names its identity
                // but cannot choose the transport or the account receiving the approval.
                const resolution = resolveServerProfileForPortableIdentity(invite.home.homeServerIdentityId);
                const profile = resolution.kind === 'resolved' ? resolution.profile : null;
                const descriptor = profile ? buildHomeConnectionDescriptorForProfile(profile) : null;
                setActiveInvite(invite);
                if (!profile || !descriptor || profile.serverIdentityId !== invite.home.homeServerIdentityId
                    || descriptor.homeServerIdentityId !== invite.home.homeServerIdentityId) {
                    setEnrollmentResult('wrong_target');
                    return;
                }
                setEnrollmentResult(null);
                setPendingRequesterApproval({ invite, profile, descriptor });
                return;
            }
            await processHomeQrInvite({ invite });
        },
        [auth.isAuthenticated, auth.refreshFromActiveServer, classifyScannedLink, openShowQrInstead, processHomeQrInvite, props.onShowQrInstead, router],
    );

    const approveRequester = React.useCallback(async () => {
        if (!pendingRequesterApproval) return;
        setPendingRequesterApproval(null);
        await processHomeQrInvite(pendingRequesterApproval);
    }, [pendingRequesterApproval, processHomeQrInvite]);

    const cancelRequesterApproval = React.useCallback(() => {
        setPendingRequesterApproval(null);
        setActiveInvite(null);
    }, []);

    const processedInitialPairingLinkRef = React.useRef<string | null>(null);
    React.useEffect(() => {
        const initialPairingLink = typeof props.initialPairingLink === 'string'
            ? props.initialPairingLink.trim()
            : '';
        if (
            !initialPairingLink
            || !isFocused
            || pairingState !== 'enabled'
            || phase !== 'idle'
            || pendingRequesterApproval
            || processedInitialPairingLinkRef.current === initialPairingLink
        ) {
            return;
        }
        processedInitialPairingLinkRef.current = initialPairingLink;
        setInviteOrigin('link');
        void processPairingLink(initialPairingLink);
    }, [isFocused, pairingState, pendingRequesterApproval, phase, processPairingLink, props.initialPairingLink]);

    React.useEffect(() => {
        return () => {
            const attempt = activeAttemptRef.current;
            activeAttemptRef.current = null;
            // Irreversible Home-side completion may continue after unmount, but
            // clearing local ownership prevents stale UI/navigation dispatch.
            if (!attempt?.cancellable) return;
            // A started pairing row's completion loop consumes it on abort.
            attempt.controller.abort();
        };
    }, []);

    const enrollmentPresentation = resolveHomeEnrollmentPresentation({
        kind: 'scanner',
        phase,
        ...(activeInvite ? { direction: activeInvite.direction } : {}),
        ...(enrollmentResult ? { result: enrollmentResult } : {}),
        inviteOrigin,
        linkEntryAvailable: typeof props.onOpenPairingLinkEntry === 'function',
        canRetryRetainedHome: retainedAdoptionRef.current !== null,
    });
    const openNewPairingLinkEntry = React.useCallback(() => {
        resetEnrollmentResult();
        props.onOpenPairingLinkEntry?.();
    }, [props.onOpenPairingLinkEntry, resetEnrollmentResult]);
    // The result's one way on: the same code again, a new code by the route the old one came, or done.
    const resultAction = enrollmentPresentation.recoveryAction === 'retry_retained_home' && activeInvite
        ? {
            testID: 'restore-enrollment-retry-retained-home',
            title: t('connect.retryRetainedHome', { home: formatHomeEnrollmentTargetLabel(activeInvite.home) }),
            onPress: retryRetainedHome,
        }
        : enrollmentPresentation.recoveryAction === 'retry'
            ? { testID: 'restore-enrollment-retry', title: t('common.retry'), onPress: resetEnrollmentResult }
            : enrollmentPresentation.recoveryAction === 'scan_new_code'
                ? { testID: 'restore-enrollment-scan-new', title: t('connect.scanNewQr'), onPress: resetEnrollmentResult }
                : enrollmentPresentation.recoveryAction === 'enter_new_link'
                    ? { testID: 'restore-enrollment-paste-new', title: t('connect.pasteNewLink'), onPress: openNewPairingLinkEntry }
                    : { testID: 'restore-enrollment-done', title: t('common.done'), onPress: handleBack };
    const statusText = expiredTerminalLink && enrollmentResult === 'expired'
        ? t('modals.authRequestExpiredDescription')
        : t(enrollmentPresentation.primaryTranslationKey);
    // The card holds progress or the Home being joined; with neither (a link that never named a
    // Home) there is nothing to frame, so no empty capsule is drawn.
    const showStatusCard = enrollmentPresentation.activity
        || (enrollmentPresentation.contextualFacts !== 'none' && activeInvite != null);

    if (pairingState === 'unknown' && !enrollmentResult) {
        const frame = (
            <View style={containerStyle}>
                <View style={contentWrapperStyle}>
                    {embedded ? null : <Text style={styles.title}>{t('connect.restoreAccount')}</Text>}
                    <Text style={subtitleStyle}>{t('common.loading')}</Text>

                    <View style={[styles.statusCard, embedded ? styles.embeddedStatusCard : null]}>
                        <ActivitySpinner size="small" color={theme.colors.text.primary} />
                    </View>

                    <View style={[styles.footer, embedded ? styles.embeddedFooter : null]}>
                        {renderAlternative('restore-open-manual', t('connect.restoreWithSecretKeyInstead'), openSecretKeyLogin)}
                        {props.onShowQrInstead ? renderAlternative('restore-show-qr-instead', t('connect.showQrInstead'), openShowQrInstead) : null}
                        {props.additionalSignInWays}
                        {showBack ? renderAlternative('restore-scan-cancel', t('common.back'), handleBack) : null}
                    </View>
                </View>
            </View>
        );

        return embedded ? frame : (
            <ScrollView style={scrollViewStyle} contentContainerStyle={{ flexGrow: 1 }}>
                {frame}
            </ScrollView>
        );
    }

    if (pairingState !== 'enabled' && !enrollmentResult) {
        const frame = (
            <View style={containerStyle}>
                <View style={contentWrapperStyle}>
                    {embedded ? null : <Text style={styles.title}>{t('connect.restoreAccount')}</Text>}
                    <Text style={subtitleStyle}>{t('connect.scanComputerQrUnavailableBody')}</Text>

                    <View style={[styles.statusCard, embedded ? styles.embeddedStatusCard : null]}>
                        <Text style={styles.detailLabel}>{t('connect.scanComputerQrUnavailableTitle')}</Text>
                    </View>

                    <View style={[styles.footer, embedded ? styles.embeddedFooter : null]}>
                        {renderAlternative('restore-open-manual', t('connect.restoreWithSecretKeyInstead'), openSecretKeyLogin)}
                        {props.onShowQrInstead ? renderAlternative('restore-show-qr-instead', t('connect.showQrInstead'), openShowQrInstead) : null}
                        {showBack ? renderAlternative('restore-scan-cancel', t('common.back'), handleBack) : null}
                    </View>
                </View>
            </View>
        );

        return embedded ? frame : (
            <ScrollView style={scrollViewStyle} contentContainerStyle={{ flexGrow: 1 }}>
                {frame}
            </ScrollView>
        );
    }

    if (desktopEnrollment) {
        const frame = <View style={containerStyle}><View style={contentWrapperStyle}>
            <EnrolledComputerSetup profileId={desktopEnrollment.profileId} onBack={handleBack} onSucceeded={() => {
                const generation = desktopCompletionGenerationRef.current;
                void (async () => {
                    if (props.onAuthenticated) {
                        await props.onAuthenticated({ credentials: desktopEnrollment.credentials,
                            homeServerIdentityId: desktopEnrollment.homeServerIdentityId });
                        return;
                    }
                    trackAccountRestored();
                    if (props.entryIntent === 'add_home') {
                        setEnrollmentResult('succeeded');
                        setDesktopEnrollment(null);
                        return;
                    }
                    const result = await openEnrolledHomeOrReturnToShell({
                        profileId: desktopEnrollment.profileId,
                        targetLabel: desktopEnrollment.targetLabel,
                        isCurrent: () => desktopCompletionGenerationRef.current === generation,
                        refreshAuth: auth.refreshFromActiveServer,
                    });
                    if (result !== 'cancelled' && desktopCompletionGenerationRef.current === generation) {
                        setShellNavigationRequested(true);
                    }
                })();
            }} />
        </View></View>;
        return embedded ? frame : <ScrollView style={scrollViewStyle} contentContainerStyle={{ flexGrow: 1 }}>{frame}</ScrollView>;
    }

    if (pendingRequesterApproval) {
        const { invite, profile, descriptor } = pendingRequesterApproval;
        const frame = (
            <View style={containerStyle}>
                <View style={contentWrapperStyle}>
                    <Text style={subtitleStyle}>
                        {t('connect.confirmDeviceApproval', {
                            device: invite.requestedDeviceLabel ? `“${invite.requestedDeviceLabel}”` : t('homeDeviceApproval.deviceFallback'),
                            home: profile.name || formatHomeEnrollmentTargetLabel(descriptor),
                        })}
                    </Text>
                    <PairingCountdown
                        testID="restore-enrollment-approval-expiry"
                        expiresAtMs={invite.expiresAtMs}
                        formatLabel={formatApprovalExpiry}
                        style={subtitleStyle}
                    />
                    <View style={[styles.footer, embedded ? styles.embeddedFooter : null]}>
                        <View style={embedded ? styles.embeddedFooterButton : styles.footerButton}>
                            <RoundButton
                                testID="restore-enrollment-approve"
                                size={embedded ? 'large' : 'normal'}
                                title={t('homeDeviceApproval.approve')}
                                action={approveRequester}
                            />
                        </View>
                        {renderAlternative('restore-enrollment-cancel', t('common.cancel'), cancelRequesterApproval)}
                    </View>
                </View>
            </View>
        );
        return embedded ? frame : (
            <ScrollView style={scrollViewStyle} contentContainerStyle={{ flexGrow: 1 }}>{frame}</ScrollView>
        );
    }

    if (phase === 'idle' && !enrollmentResult) {
        return (
            <QrCodeScannerView
                previewRef={scannerFocal}
                active={isFocused}
                testIDPrefix="restore-scan"
                title={t('connect.scanExistingHomeQrTitle')}
                subtitle={t('connect.scanComputerQrInstructions')}
                permissionRequiredMessage={t('modals.cameraPermissionsRequiredToScanQr')}
                embedded={props.embedded}
                onCancel={showBack ? handleBack : undefined}
                onScan={async (data) => {
                    if (typeof data === 'string' && data.trim()) {
                        setInviteOrigin('scanned');
                        await processPairingLink(data.trim());
                    }
                }}
                footer={
                    <>
                        {/* On a step column the scanner's own state (Retry) is the one primary and link entry is
                            one more quiet way in, like the others; standalone it stays the filled action. */}
                        {props.onOpenPairingLinkEntry ? (embedded
                            ? renderAlternative('restore-enter-pairing-link', t('connect.pairingLinkPlaceholder'), props.onOpenPairingLinkEntry)
                            : <View style={styles.footerButton}>
                                <RoundButton
                                    testID="restore-enter-pairing-link"
                                    size="normal"
                                    title={t('connect.pairingLinkPlaceholder')}
                                    onPress={props.onOpenPairingLinkEntry}
                                />
                            </View>) : null}
                        {renderAlternative('restore-open-manual', t('connect.restoreWithSecretKeyInstead'), openSecretKeyLogin)}
                        {props.onShowQrInstead ? renderAlternative('restore-show-qr-instead', t('connect.showQrInstead'), openShowQrInstead) : null}
                    </>
                }
            />
        );
    }

    const frame = (
        <View style={containerStyle}>
            <View style={contentWrapperStyle}>
                {embedded ? null : <Text style={styles.title}>{t('connect.restoreAccount')}</Text>}
                <Text
                    testID={phase === 'securing' ? 'restore-enrollment-securing' : undefined}
                    style={subtitleStyle}
                    accessibilityLiveRegion={enrollmentPresentation.liveRegion}
                >
                    {statusText}
                </Text>

                {showStatusCard ? <View style={[styles.statusCard, embedded ? styles.embeddedStatusCard : null]}>
                    {enrollmentPresentation.activity ? (
                        <ActivitySpinner size="small" color={theme.colors.text.primary} />
                    ) : null}
                    {enrollmentPresentation.contextualFacts !== 'none' && activeInvite ? (
                        <>
                            <Text style={styles.detailLabel}>{t('common.homeProductName')}</Text>
                            <Text style={styles.identityValue} numberOfLines={2}>
                                {formatHomeEnrollmentTargetLabel(activeInvite.home)}
                            </Text>
                            <Text style={styles.detailLabel}>
                                {t('connect.requestingDeviceLabel')}: {activeInvite.direction === 'requester_displays'
                                    ? activeInvite.requestedDeviceLabel ?? t('homeDeviceApproval.deviceFallback')
                                    : resolveDeviceLabel() ?? t('connect.thisDevice')}
                            </Text>
                            <Text style={styles.detailLabel}>
                                {t('connect.expiresAtLabel')}: {formatEnrollmentExpiry(activeInvite.expiresAtMs)}
                            </Text>
                        </>
                    ) : null}
                </View> : null}

                {enrollmentResult ? (
                    <View style={[styles.footer, embedded ? styles.embeddedFooter : null]}>
                        {/* Embedded, the result's one way on is the step's primary, the same height as the
                            Continue that led here; standalone it keeps the dialog-sized quiet button. */}
                        <View style={embedded ? styles.embeddedFooterButton : styles.footerButton}>
                            <RoundButton
                                testID={resultAction.testID}
                                size={embedded ? 'large' : 'small'}
                                title={resultAction.title}
                                display={embedded ? 'default' : 'inverted'}
                                onPress={resultAction.onPress}
                            />
                        </View>
                    </View>
                ) : phase !== 'securing' ? (
                    <View style={[styles.footer, embedded ? styles.embeddedFooter : null]}>
                        {embedded ? renderAlternative('restore-enrollment-cancel', t('common.cancel'), cancelEnrollmentAttempt) : (
                            <View style={styles.footerButton}>
                                <RoundButton
                                    testID="restore-enrollment-cancel"
                                    size="small"
                                    title={t('common.cancel')}
                                    display="inverted"
                                    onPress={cancelEnrollmentAttempt}
                                />
                            </View>
                        )}
                    </View>
                ) : null}
            </View>
        </View>
    );

    return embedded ? frame : (
        <ScrollView style={scrollViewStyle} contentContainerStyle={{ flexGrow: 1 }}>
            {frame}
        </ScrollView>
    );
});
