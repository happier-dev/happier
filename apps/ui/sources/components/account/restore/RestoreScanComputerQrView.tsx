import * as React from 'react';
import { Platform, ScrollView, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import Constants from 'expo-constants';
import { useRouter } from 'expo-router';
import { useIsFocused, usePreventRemove } from '@react-navigation/native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { generateAuthKeyPair, authQRStart } from '@/auth/flows/qrStart';
import { authQRWait } from '@/auth/flows/qrWait';
import { classifyPairingLink } from '@/auth/pairing/classifyPairingLink';
import { useAuth } from '@/auth/context/AuthContext';
import { promptLegacyPairingUpdateRequired } from '@/auth/pairing/legacyPairingUpdateRequired';
import { t } from '@/text';
import { useFeatureDecision } from '@/hooks/server/useFeatureDecision';
import { pairingConsume, pairingRequest, pairingStart, type PairingRequestResult } from '@/sync/api/account/apiPairingAuth';
import {
    adoptHomeProfileWithCredentials,
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
import { Typography } from '@/constants/Typography';
import { QrCodeScannerView } from '@/components/qr/QrCodeScannerView';
import { trackAccountRestored, trackAuthEnrollmentTransientRetry } from '@/track';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { promptAccountConnectApprovalRequired } from './accountConnectApprovalGuidance';
import { admitDirectHomeQrV2, runDirectHomeQrCompletion } from '@happier-dev/cli-common/homeEnrollment';
import {
    formatEnrollmentExpiry,
    formatHomeEnrollmentTargetLabel,
    resolveHomeEnrollmentPresentation,
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

export type ScannedHomeEnrollmentPartialCommit = Readonly<{
    kind: 'partial_commit';
    error: HomeProfileAdoptionPartialCommitFailure;
}>;

/** Keeps owner-provided recovery facts intact at the forward QR caller boundary. */
export function classifyScannedHomeEnrollmentPartialCommit(
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
        paddingHorizontal: 24,
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
        fontSize: 28,
        lineHeight: 34,
        letterSpacing: -0.56,
        color: theme.colors.text.primary,
        marginBottom: 8,
        textAlign: 'center',
        ...Typography.default('semiBold'),
    },
    subtitle: {
        fontSize: 16,
        color: theme.colors.text.secondary,
        lineHeight: 24,
        textAlign: 'center',
        ...Typography.default(),
    },
    statusCard: {
        marginTop: 12,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        borderRadius: 14,
        paddingHorizontal: 16,
        paddingVertical: 14,
        backgroundColor: theme.colors.surface.base,
    },
    embeddedStatusCard: {
        marginTop: 10,
    },
    detailLabel: {
        marginTop: 12,
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.text.secondary,
        ...Typography.default(),
    },
    identityValue: {
        marginTop: 4,
        fontSize: 16,
        lineHeight: 22,
        color: theme.colors.text.primary,
        ...Typography.default('semiBold'),
    },
    footer: {
        marginTop: 12,
        alignItems: 'center',
        width: '100%',
        gap: 12,
    },
    embeddedFooter: {
        marginTop: 10,
    },
    footerButton: {
        width: '100%',
        maxWidth: 360,
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
    onOpenSecretKeyLogin?: () => void;
    onOpenPairingLinkEntry?: () => void;
    onShowQrInstead?: () => void;
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

type ScannerEnrollmentResult =
    | 'succeeded'
    | 'partial_commit'
    | 'retryable_error'
    | 'expired'
    | 'invalid_request'
    | 'already_requested'
    | 'rejected'
    | 'wrong_target'
    | 'malformed_response'
    | 'update_required'
    | 'update_required';

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
    const [enrollmentResult, setEnrollmentResult] = React.useState<ScannerEnrollmentResult | null>(null);
    const [activeInvite, setActiveInvite] = React.useState<HomeQrInviteV2 | null>(null);
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
        setEnrollmentResult(null);
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
        router.replace('/');
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
                const action = await promptLegacyPairingUpdateRequired();
                if (action === 'cancel') handleBack();
                return;
            }
            if (link.kind === 'team_join') {
                // A pasted Team join link is a way into a Home too; its join screen owns the rest.
                router.push(link.path);
                return;
            }
            if (link.kind !== 'home_qr_invite') {
                setEnrollmentResult('invalid_request');
                return;
            }

            const attempt = beginEnrollmentAttempt(link.invite);
            if (!attempt) return;

            let target: HomeQrEnrollmentTarget | null = null;
            let terminalResult: ScannerEnrollmentResult | null = null;
            const publishTerminalResult = (result: ScannerEnrollmentResult) => {
                terminalResult = result;
                setEnrollmentResult(result);
            };
            try {
                if (Date.now() > link.invite.expiresAtMs) {
                    publishTerminalResult('expired');
                    return;
                }

                if (link.invite.direction === 'requester_displays') {
                    // The enrolled scanner resolves the trusted Home from its stored registry by
                    // the invite identity. Focus is neither a selector nor a fallback.
                    const storedProfileResolution = resolveServerProfileForPortableIdentity(
                        link.invite.home.homeServerIdentityId,
                    );
                    const storedProfile = storedProfileResolution.kind === 'resolved'
                        ? storedProfileResolution.profile
                        : null;
                    const storedDescriptor = storedProfile
                        ? buildHomeConnectionDescriptorForProfile(storedProfile)
                        : null;
                    if (
                        !storedProfile
                        || !storedDescriptor
                        || storedProfile.serverIdentityId !== link.invite.home.homeServerIdentityId
                        || storedDescriptor.homeServerIdentityId !== link.invite.home.homeServerIdentityId
                    ) {
                        publishTerminalResult('wrong_target');
                        return;
                    }
                    const transportResolution = await resolveHomeEnrollmentTransport(storedDescriptor);
                    if (!isCurrentAttempt(attempt.id)) {
                        if (transportResolution.ok) await transportResolution.transport.close().catch(() => {});
                        return;
                    }
                    if (!transportResolution.ok) {
                        publishTerminalResult('retryable_error');
                        return;
                    }
                    target = { ...transportResolution.transport, serverId: storedProfile.id };
                    const targetFeatureSnapshot = await probeServerFeaturesAtUrl({
                        endpointUrl: target.endpointUrl,
                        runtimeOrigin: target.runtimeOrigin,
                        ...(target.homeCarrier ? { homeCarrier: target.homeCarrier } : {}),
                        serverId: storedProfile.id,
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
                    if (targetFeatureSnapshot.serverIdentityId !== storedDescriptor.homeServerIdentityId) {
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
                        }, target, { signal: attempt.controller.signal });
                        if (!isCurrentAttempt(attempt.id)) {
                            // Cancellation raced the in-flight start; the row may exist
                            // server-side. Consume that exact row before leaving.
                            await consumeReversePairingRow(link.invite.pairId, target);
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
                                target,
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
                        publishTerminalResult('partial_commit');
                        return;
                    }
                    if (stored.kind === 'failed') {
                        publishTerminalResult('retryable_error');
                        return;
                    }
                    if (stored.kind !== 'completed') return;
                    if (isDesktopHost() && result.homeServerIdentityId) {
                        setDesktopEnrollment({
                            profileId: stored.profile.id,
                            targetLabel: formatHomeEnrollmentTargetLabel(link.invite.home),
                            credentials: result.credentials,
                            homeServerIdentityId: result.homeServerIdentityId,
                        });
                        return;
                    }
                    if (props.onAuthenticated && result.homeServerIdentityId) {
                        await props.onAuthenticated({ credentials: result.credentials, homeServerIdentityId: result.homeServerIdentityId });
                        return;
                    }
                    trackAccountRestored();
                    if (props.entryIntent === 'add_home') {
                        publishTerminalResult('succeeded');
                        return;
                    }

                    await openRetainedHomeOrReturnToShell(
                        stored.profile.id,
                        formatHomeEnrollmentTargetLabel(link.invite.home),
                        attempt.id,
                    );
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
        [beginEnrollmentAttempt, classifyScannedLink, completeEnrollment, handleBack, isCurrentAttempt, openRetainedHomeOrReturnToShell, openShowQrInstead, props.entryIntent, props.expectedHomeServerIdentityId, props.onCredentials, props.onAuthenticated, props.onShowQrInstead, router],
    );

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
            || processedInitialPairingLinkRef.current === initialPairingLink
        ) {
            return;
        }
        processedInitialPairingLinkRef.current = initialPairingLink;
        void processPairingLink(initialPairingLink);
    }, [isFocused, pairingState, phase, processPairingLink, props.initialPairingLink]);

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
    });
    const statusText = t(enrollmentPresentation.primaryTranslationKey);

    if (pairingState === 'unknown') {
        const frame = (
            <View style={containerStyle}>
                <View style={contentWrapperStyle}>
                    {embedded ? null : <Text style={styles.title}>{t('connect.restoreAccount')}</Text>}
                    <Text style={styles.subtitle}>{t('common.loading')}</Text>

                    <View style={[styles.statusCard, embedded ? styles.embeddedStatusCard : null]}>
                        <ActivitySpinner size="small" color={theme.colors.text.primary} />
                    </View>

                    <View style={[styles.footer, embedded ? styles.embeddedFooter : null]}>
                        <View style={styles.footerButton}>
                            <RoundButton
                                testID="restore-open-manual"
                                size="small"
                                title={t('connect.restoreWithSecretKeyInstead')}
                                display="inverted"
                                action={async () => {
                                    openSecretKeyLogin();
                                }}
                            />
                        </View>
                        {props.onShowQrInstead ? <View style={styles.footerButton}>
                            <RoundButton
                                testID="restore-show-qr-instead"
                                size="small"
                                title={t('connect.showQrInstead')}
                                display="inverted"
                                action={async () => {
                                    openShowQrInstead();
                                }}
                            />
                        </View> : null}
                        <View style={styles.footerButton}>
                            <RoundButton
                                testID="restore-scan-cancel"
                                size="small"
                                title={t('common.back')}
                                display="inverted"
                                onPress={handleBack}
                            />
                        </View>
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

    if (pairingState !== 'enabled') {
        const frame = (
            <View style={containerStyle}>
                <View style={contentWrapperStyle}>
                    {embedded ? null : <Text style={styles.title}>{t('connect.restoreAccount')}</Text>}
                    <Text style={styles.subtitle}>{t('connect.scanComputerQrUnavailableBody')}</Text>

                    <View style={[styles.statusCard, embedded ? styles.embeddedStatusCard : null]}>
                        <Text style={styles.detailLabel}>{t('connect.scanComputerQrUnavailableTitle')}</Text>
                    </View>

                    <View style={[styles.footer, embedded ? styles.embeddedFooter : null]}>
                        <View style={styles.footerButton}>
                            <RoundButton
                                testID="restore-open-manual"
                                size="small"
                                title={t('connect.restoreWithSecretKeyInstead')}
                                display="inverted"
                                action={async () => {
                                    openSecretKeyLogin();
                                }}
                            />
                        </View>
                        {props.onShowQrInstead ? <View style={styles.footerButton}>
                            <RoundButton
                                testID="restore-show-qr-instead"
                                size="small"
                                title={t('connect.showQrInstead')}
                                display="inverted"
                                action={async () => {
                                    openShowQrInstead();
                                }}
                            />
                        </View> : null}
                        <View style={styles.footerButton}>
                            <RoundButton
                                testID="restore-scan-cancel"
                                size="small"
                                title={t('common.back')}
                                display="inverted"
                                onPress={handleBack}
                            />
                        </View>
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

    if (phase === 'idle' && !enrollmentResult) {
        return (
            <QrCodeScannerView
                active={isFocused}
                testIDPrefix="restore-scan"
                title={t('connect.scanExistingHomeQrTitle')}
                subtitle={t('connect.scanComputerQrInstructions')}
                permissionRequiredMessage={t('modals.cameraPermissionsRequiredToScanQr')}
                embedded={props.embedded}
                onCancel={handleBack}
                onScan={async (data) => {
                    if (typeof data === 'string' && data.trim()) {
                        await processPairingLink(data.trim());
                    }
                }}
                footer={
                    <>
                        {props.onOpenPairingLinkEntry ? <View style={styles.footerButton}>
                            <RoundButton
                                testID="restore-enter-pairing-link"
                                size="normal"
                                title={t('connect.enterUrlManually')}
                                onPress={props.onOpenPairingLinkEntry}
                            />
                        </View> : null}
                        <View style={styles.footerButton}>
                            <RoundButton
                                testID="restore-open-manual"
                                size="small"
                                title={t('connect.restoreWithSecretKeyInstead')}
                                display="inverted"
                                action={async () => {
                                    openSecretKeyLogin();
                                }}
                            />
                        </View>
                        {props.onShowQrInstead ? (
                            <View style={styles.footerButton}>
                                <RoundButton
                                    testID="restore-show-qr-instead"
                                    size="small"
                                    title={t('connect.showQrInstead')}
                                    display="inverted"
                                    action={async () => {
                                        openShowQrInstead();
                                    }}
                                />
                            </View>
                        ) : null}
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
                    style={styles.subtitle}
                    accessibilityLiveRegion={enrollmentPresentation.liveRegion}
                >
                    {statusText}
                </Text>

                <View style={[styles.statusCard, embedded ? styles.embeddedStatusCard : null]}>
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
                </View>

                {enrollmentResult ? (
                    <View style={[styles.footer, embedded ? styles.embeddedFooter : null]}>
                        <View style={styles.footerButton}>
                            <RoundButton
                                testID={enrollmentPresentation.recoveryAction === 'retry'
                                    ? 'restore-enrollment-retry'
                                    : 'restore-enrollment-done'}
                                size="small"
                                title={t(enrollmentPresentation.recoveryAction === 'retry' ? 'common.retry' : 'common.done')}
                                display="inverted"
                                onPress={enrollmentPresentation.recoveryAction === 'retry'
                                    ? resetEnrollmentResult
                                    : handleBack}
                            />
                        </View>
                    </View>
                ) : phase !== 'securing' ? (
                    <View style={[styles.footer, embedded ? styles.embeddedFooter : null]}>
                        <View style={styles.footerButton}>
                            <RoundButton
                                testID="restore-enrollment-cancel"
                                size="small"
                                title={t('common.cancel')}
                                display="inverted"
                                onPress={cancelEnrollmentAttempt}
                            />
                        </View>
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
