import * as React from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';

import { useAuth } from '@/auth/context/AuthContext';
import {
    resolveHomeEnrollmentPresentation,
    type HomeEnrollmentPresentationModel,
} from '@/auth/pairing/pairingPresentation';
import { PairingLinkDisclosure } from '@/components/auth/pairing/PairingLinkDisclosure';
import { resolveHomeDisplayName } from '@/components/settings/server/homeDisplayName';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { CopiedPill } from '@/components/ui/copy/CopiedPill';
import { useHappierCopyFeedback } from '@happier-dev/plugin-ui/presentation';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import {
    HAPPIER_APP_STORE_SHORT_URL,
    HAPPIER_APP_STORE_URL,
    HAPPIER_DESKTOP_DOWNLOAD_URL,
    HAPPIER_GOOGLE_PLAY_SHORT_URL,
    HAPPIER_GOOGLE_PLAY_URL,
} from '@/constants/downloadUrls';
import { QRCode } from '@/components/qr/QRCode';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import { Typography } from '@/constants/Typography';
import { usePairingSession, type PairingContext, type PairingFailureCause, type PairingPresentation } from '@/hooks/auth/usePairingSession';
import { Modal } from '@/modal';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { t } from '@/text';
import { useClipboardWrite } from '@/hooks/ui/useClipboardWrite';
import { requestOpenExternalUrl } from '@/utils/url/requestOpenExternalUrl';
import { isTextSharingAvailable, shareTextSafe } from '@/utils/ui/shareText';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';

import { useSetupBlockPanelWidth } from '@/components/ui/setupBlocks/SetupBlockGrid';
import { SetupSteps, type SetupStep } from '@/components/ui/setupBlocks/SetupSteps';

import { PairingQrCode } from './PairingQrCode';
import { PairingCountdown } from './PairingCountdown';
import { PairingQrMomentCanvas } from './PairingQrMoment';
import { usePairingQrMoment, type PairingQrMomentSource } from './usePairingQrMoment';
import { PAIRING_QR_PALETTE } from './pairingQrPalette';

/** Who the code is for: a phone scans it; another computer opens (or pastes) its link. */
export type HomePairingPurpose = 'phone' | 'computer';
/**
 * `inline`: inside Home's Get set up row, drawn on the morph frame's surface (QR beside the text when
 * there is room). `modal`: centred, for entry points with no tile to grow. `page`: the Add your phone
 * page, which also lets the person see the link and cancel the code. `section`: one step of a page that
 * names it itself (Add a machine's Another computer): no heading or lead of its own and no inset, so the
 * code starts at the page's content edge.
 */
export type HomePairingPanelLayout = 'inline' | 'modal' | 'page' | 'section';

/** The paper: a 216 px code (as dense as the Add your phone page's) inside its margin. */
const QR_PAPER_PX = 240;
/** Narrower than this, the text goes under the code instead of beside it. */
const SIDE_BY_SIDE_MIN_WIDTH_PX = 560;

type PanelState =
    | Readonly<{ kind: 'making' }>
    | Readonly<{ kind: 'ready'; link: string; qrAvailable: boolean; expiresAtMs: number }>
    | Readonly<{ kind: 'adding'; device: string; retrying: boolean }>
    | Readonly<{ kind: 'joined'; device: string }>
    | Readonly<{ kind: 'failed'; cause: PairingFailureCause | null }>
    | Readonly<{ kind: 'expired' }>
    | Readonly<{ kind: 'updateRequired' }>
    | Readonly<{ kind: 'stopped' }>;

function resolvePanelState(presentation: PairingPresentation, isStarting: boolean, stopped: boolean): PanelState {
    switch (presentation.phase) {
        case 'ready':
            return { kind: 'ready', link: presentation.deepLink, qrAvailable: presentation.qrAvailable, expiresAtMs: presentation.context.expiresAtMs };
        case 'adding':
        case 'retryable_error':
            return {
                kind: 'adding',
                device: presentation.requestedDeviceLabel ?? t('homeDeviceApproval.deviceFallback'),
                retrying: presentation.phase === 'retryable_error',
            };
        case 'succeeded':
            return { kind: 'joined', device: presentation.requestedDeviceLabel ?? t('homeDeviceApproval.deviceFallback') };
        case 'invalid_request':
            return { kind: 'failed', cause: presentation.cause ?? null };
        case 'update_required':
            return { kind: 'updateRequired' };
        // A code that ran its course is replaced at once (the panel asks for a new one); one the Home
        // gave up on early is not renewed behind the person's back.
        case 'expired':
            return isRenewableExpiry(presentation.context.expiresAtMs) ? { kind: 'making' } : { kind: 'expired' };
        case 'generating':
            return stopped && !isStarting ? { kind: 'stopped' } : { kind: 'making' };
    }
}

/**
 * Whether an expired code reached the end of its life (and "New code in 0:00" is due), as opposed to
 * the Home forgetting it early. The slack covers the lifecycle noticing expiry a poll after the fact
 * seen from a clock a little ahead of the Home's.
 */
const EXPIRY_CLOCK_SLACK_MS = 1_000;
function isRenewableExpiry(expiresAtMs: number): boolean {
    return Date.now() >= expiresAtMs - EXPIRY_CLOCK_SLACK_MS;
}

function readHomeName(targetProfileId: string | null | undefined): string {
    const profileId = targetProfileId ?? getActiveServerSnapshot().serverId;
    const profile = profileId ? getServerProfileById(profileId) : null;
    return resolveHomeDisplayName(profile) ?? t('homeSetup.thisHome');
}

/**
 * The one surface that adds a device to a Home with a code: the QR (with the Happier mark), what to
 * do, the store links, the link itself, and the live state ("Waiting for your phone…", "New code in
 * 4:32", then who joined). It runs on the canonical pairing owner (`usePairingSession`): the code
 * exists only while this panel is mounted, a code that expires is replaced while it stays open, and
 * unmounting it cancels the live code. Home's Get set up tile grows into it, the modal shows it for
 * entry points with no tile, and the Add your phone page is built on it.
 */
export const HomePairingPanel = React.memo(function HomePairingPanel(props: Readonly<{
    purpose: HomePairingPurpose;
    layout: HomePairingPanelLayout;
    testIDPrefix: string;
    /** The saved Home the code adds a device to; the focused Home when omitted. */
    targetProfileId?: string | null;
    onClose?: () => void;
    onCompleted?: (context: PairingContext) => void;
}>) {
    const { theme } = useUnistyles();
    const auth = useAuth();
    const prefix = props.testIDPrefix;
    const writeClipboard = useClipboardWrite(props.targetProfileId ?? undefined);
    // Focused-Home authentication is only an admission hint. A retained Home's actual
    // credentials and identity are checked by the pairing owner, never borrowed from focus.
    const canRequestPairing = auth.isAuthenticated || Boolean(props.targetProfileId);
    const { presentation, isStarting, startPairing, cancelPairing } = usePairingSession({
        enabled: canRequestPairing,
        isAuthenticated: canRequestPairing,
        targetProfileId: props.targetProfileId ?? null,
        onCompleted: props.onCompleted,
    });
    const [stopped, setStopped] = React.useState(false);
    const [cancelling, setCancelling] = React.useState(false);
    const [width, setWidth] = React.useState(0);
    // Inside a growing set-up block the row's width is known before this panel measures itself.
    const hintedWidth = useSetupBlockPanelWidth();

    const start = React.useCallback(async () => {
        setStopped(false);
        await startPairing();
    }, [startPairing]);

    // The code lives while the panel is on screen: it is made when the panel mounts (and again when
    // its target Home changes), and `usePairingSession` cancels it when the panel unmounts.
    React.useEffect(() => {
        if (!canRequestPairing) return;
        void start();
    }, [canRequestPairing, start]);

    // "New code in m:ss" is a promise: when the code runs out, the next one is made while the panel
    // stays open. Once per expired code, so a failure to make one ends in the failed state, not a loop.
    const expiredPairId = presentation.phase === 'expired' && isRenewableExpiry(presentation.context.expiresAtMs)
        ? presentation.context.pairId
        : null;
    React.useEffect(() => {
        if (expiredPairId) void start();
    }, [expiredPairId, start]);

    const cancel = React.useCallback(async () => {
        setCancelling(true);
        try {
            const cancelled = await cancelPairing();
            if (!cancelled.ok) throw new Error(`Failed to cancel pairing session: ${cancelled.status}`);
            setStopped(true);
        } catch {
            await Modal.alertAsync(t('common.error'), t('errors.operationFailed'));
        } finally {
            setCancelling(false);
        }
    }, [cancelPairing]);

    const onLayout = React.useCallback((event: LayoutChangeEvent) => {
        const next = event.nativeEvent.layout.width;
        if (Number.isFinite(next) && next > 0) setWidth((current) => (current === next ? current : next));
    }, []);

    const state = resolvePanelState(presentation, isStarting, stopped);
    const homeName = readHomeName(props.targetProfileId);
    const laidOutWidth = width > 0 ? width : hintedWidth ?? 0;
    const sideBySide = props.layout !== 'modal' && laidOutWidth >= SIDE_BY_SIDE_MIN_WIDTH_PX;
    const centred = !sideBySide;
    const phone = props.purpose === 'phone';
    const link = state.kind === 'ready' ? state.link : null;
    const enrollment = resolveHomeEnrollmentPresentation({
        kind: 'trusted_home_display',
        phase: presentation.phase,
    });
    const status = (
        <View testID={`${prefix}-status`} accessibilityLiveRegion="polite" style={styles.stepStatus}>
            <PairingStatusLine
                testIDPrefix={prefix}
                state={state}
                purpose={props.purpose}
                homeName={homeName}
                phaseBodyKey={enrollment.primaryTranslationKey}
                centred
                accent={theme.colors.accent.blue}
                onNewCode={start}
                starting={isStarting}
            />
        </View>
    );

    if (props.layout === 'section' && !phone) {
        return (
            <View testID={`${prefix}-panel`} onLayout={onLayout}>
                <ComputerPairingSections
                    testIDPrefix={prefix}
                    state={state}
                    homeName={homeName}
                    link={link}
                    writeClipboard={writeClipboard}
                    status={status}
                />
            </View>
        );
    }

    return (
        <View
            testID={`${prefix}-panel`}
            onLayout={onLayout}
            style={[styles.root, props.layout === 'page' || props.layout === 'section' ? styles.rootPage : null, props.layout === 'modal' ? styles.rootModal : null]}
        >
            {props.onClose ? (
                <View style={styles.close}>
                    <IconButton
                        testID={`${prefix}-close`}
                        iconName="x"
                        variant="plain"
                        size={24}
                        accessibilityLabel={t('homeSetup.close')}
                        onPress={props.onClose}
                    />
                </View>
            ) : null}
            <View style={sideBySide ? styles.sideBySide : styles.stacked}>
                <PairingCodeBlock testIDPrefix={prefix} state={state} homeName={homeName} />
                <View style={sideBySide ? styles.bodySide : styles.bodyStacked}>
                    {props.layout !== 'section' ? (
                        <>
                            <Text style={[styles.title, centred ? styles.centredText : null]}>
                                {t(phone ? 'homeSetup.pairingPhoneTitle' : 'homeSetup.pairingComputerTitle')}
                            </Text>
                            <Text style={[styles.body, centred ? styles.centredText : null]}>
                                {phone ? t('homeSetup.pairingPhoneBody', { home: homeName }) : t('homeSetup.pairingComputerBody', { home: homeName })}
                            </Text>
                        </>
                    ) : null}
                    {props.layout !== 'modal' ? <PairingSteps purpose={props.purpose} /> : null}
                    <View style={[styles.actions, centred ? styles.actionsCentred : null]}>
                        {phone ? (
                            // At a computer a store button cannot reach the phone: the stores are codes the
                            // phone's camera opens, quieter than the pairing code (a click opens the listing).
                            <View style={styles.stores}>
                                <StoreQr
                                    testID={`${prefix}-app-store`}
                                    store={t('homeSetup.appStore')}
                                    qrLink={HAPPIER_APP_STORE_SHORT_URL}
                                    listingUrl={HAPPIER_APP_STORE_URL}
                                />
                                <StoreQr
                                    testID={`${prefix}-google-play`}
                                    store={t('homeSetup.googlePlay')}
                                    qrLink={HAPPIER_GOOGLE_PLAY_SHORT_URL}
                                    listingUrl={HAPPIER_GOOGLE_PLAY_URL}
                                />
                            </View>
                        ) : (
                            <RoundButton
                                testID={`${prefix}-desktop-download`}
                                size="small"
                                display="secondary"
                                title={t('homeSetup.getDesktopApp')}
                                onPress={() => { void requestOpenExternalUrl(HAPPIER_DESKTOP_DOWNLOAD_URL); }}
                            />
                        )}
                        {sideBySide ? <View style={styles.grow} /> : null}
                        {props.layout !== 'page' ? <CopyLinkButton testIDPrefix={prefix} link={link} writeClipboard={writeClipboard} /> : null}
                    </View>
                    <View
                        testID={`${prefix}-status`}
                        accessibilityLiveRegion="polite"
                        style={[styles.status, centred ? styles.statusCentred : null]}
                    >
                        <PairingStatusLine
                            testIDPrefix={prefix}
                            state={state}
                            purpose={props.purpose}
                            homeName={homeName}
                            phaseBodyKey={enrollment.primaryTranslationKey}
                            centred={centred}
                            accent={theme.colors.accent.blue}
                            onNewCode={start}
                            starting={isStarting}
                        />
                        {props.layout === 'page' && state.kind === 'ready' ? (
                            <RoundButton
                                testID={`${prefix}-cancel`}
                                size="small"
                                display="secondary"
                                title={t('homeSetup.cancelCode')}
                                action={cancel}
                                disabled={cancelling}
                                loading={cancelling}
                            />
                        ) : null}
                    </View>
                    {props.layout === 'page' && link ? (
                        <PairingLinkDisclosure testIDPrefix={`${prefix}-pairing-link`} link={link} />
                    ) : null}
                </View>
            </View>
        </View>
    );
});

/** Why no code could be made, said after "Couldn't make a code for this Home." */
function describePairingFailure(cause: PairingFailureCause, home: string): string {
    switch (cause) {
        case 'home_unreachable': return t('homeSetup.codeFailedUnreachable', { home });
        case 'home_identity_unverified': return t('homeSetup.codeFailedIdentity', { home });
        case 'signed_out': return t('homeSetup.codeFailedSignedOut', { home });
        case 'invite_too_large': return t('homeSetup.codeFailedTooLarge');
        case 'home_refused': return t('homeSetup.codeFailedRefused', { home });
        case 'unexpected': return t('homeSetup.codeFailedUnexpected');
    }
}

const STORE_QR_PX = 72;

/** A store listing as a small code the phone's camera opens, with the store's name under it. */
function StoreQr(props: Readonly<{ testID: string; store: string; qrLink: string; listingUrl: string }>) {
    return (
        <HappierPressable
            testID={props.testID}
            accessibilityRole="link"
            accessibilityLabel={t('homeSetup.storeQrLabel', { store: props.store })}
            onPress={() => { void requestOpenExternalUrl(props.listingUrl); }}
            style={styles.store}
        >
            <View style={styles.storePaper}>
                <QRCode data={props.qrLink} size={STORE_QR_PX} />
            </View>
            <Text style={styles.storeLabel}>{props.store}</Text>
        </HappierPressable>
    );
}

/** The facts of the panel's state that the QR and pairing moments answer. */
function pairingQrMomentSource(state: PanelState): PairingQrMomentSource {
    switch (state.kind) {
        case 'making':
            return state;
        case 'ready':
            return { kind: 'ready', link: state.link, qrAvailable: state.qrAvailable };
        case 'adding':
            return { kind: 'adding', device: state.device };
        case 'joined':
            return { kind: 'joined', device: state.device };
        default:
            return { kind: 'other' };
    }
}

/** The code on its paper, or what stands in its place while there is none. */
function PairingCodeBlock(props: Readonly<{ testIDPrefix: string; state: PanelState; homeName: string }>) {
    const { theme } = useUnistyles();
    const { state } = props;
    const moment = usePairingQrMoment(pairingQrMomentSource(state));
    const showsCode = state.kind === 'making' || state.kind === 'ready';
    const label = state.kind === 'ready'
        ? state.qrAvailable
            ? t('homeSetup.qrLabel', { home: props.homeName })
            : `${t('connect.pairingQrTooLargeTitle')}. ${t('connect.pairingQrTooLargeBody')}`
        : undefined;
    return (
        <View
            testID={showsCode ? `${props.testIDPrefix}-qr` : `${props.testIDPrefix}-qr-placeholder`}
            accessible={label !== undefined}
            accessibilityRole={label !== undefined ? 'image' : undefined}
            accessibilityLabel={label}
            style={styles.codeSlot}
        >
            {moment.drawing ? (
                <PairingQrMomentCanvas
                    size={QR_PAPER_PX}
                    scene={moment.scene}
                    theme={moment.theme}
                    reducedMotion={moment.reducedMotion}
                    pairing={moment.pairing}
                    machines={moment.machines}
                />
            ) : state.kind === 'ready' && state.qrAvailable ? (
                <PairingQrCode link={state.link} size={QR_PAPER_PX} />
            ) : (
                <View style={styles.codeStandIn}>
                    {state.kind === 'ready' ? (
                        <>
                            <Text style={styles.standInTitle}>{t('connect.pairingQrTooLargeTitle')}</Text>
                            <Text style={styles.standInBody}>{t('connect.pairingQrTooLargeBody')}</Text>
                        </>
                    ) : state.kind === 'making' || state.kind === 'adding' ? (
                        <ActivitySpinner size="small" color={theme.colors.text.secondary} />
                    ) : state.kind === 'joined' ? (
                        <Icon name="check-circle" size={40} color={theme.colors.state.success.foreground} />
                    ) : (
                        <Icon name="qr-code" size={40} color={theme.colors.text.tertiary} />
                    )}
                </View>
            )}
        </View>
    );
}

function PairingSteps(props: Readonly<{ purpose: HomePairingPurpose }>) {
    const steps: readonly SetupStep[] = props.purpose === 'phone'
        ? [
            { key: 'install', title: t('homeSetup.pairingPhoneStepInstall') },
            { key: 'scan', title: t('homeSetup.pairingPhoneStepScan') },
            { key: 'join', title: t('homeSetup.pairingPhoneStepJoin') },
        ]
        : [
            { key: 'install', title: t('homeSetup.pairingComputerStepInstall') },
            { key: 'open', title: t('homeSetup.pairingComputerStepOpen') },
            { key: 'join', title: t('homeSetup.pairingComputerStepJoin') },
        ];
    return (
        <View style={styles.steps}>
            <SetupSteps plain steps={steps} />
        </View>
    );
}

/**
 * Another machine joins by its link (lab p5 pair): three worded steps (install there, open this link
 * on it, it shows up), the link and its handover inside step 2, the live state under step 3, and the
 * same code in its own section for a device with a camera.
 */
function ComputerPairingSections(props: Readonly<{
    testIDPrefix: string;
    state: PanelState;
    homeName: string;
    link: string | null;
    writeClipboard: ReturnType<typeof useClipboardWrite>;
    status: React.ReactNode;
}>) {
    const prefix = props.testIDPrefix;
    const link = props.link;
    // Asked per render, as the Team link handover does: a Share that does nothing is worse than none.
    const sharingAvailable = isTextSharingAvailable();
    const steps: readonly SetupStep[] = [
        {
            key: 'install',
            title: t('homeSetup.pairingComputerStepInstallTitle'),
            detail: t('homeSetup.pairingComputerStepInstallDetail'),
            action: (
                <RoundButton
                    testID={`${prefix}-desktop-download`}
                    size="small"
                    display="secondary"
                    title={t('homeSetup.getDesktopApp')}
                    onPress={() => { void requestOpenExternalUrl(HAPPIER_DESKTOP_DOWNLOAD_URL); }}
                />
            ),
        },
        {
            key: 'open',
            title: t('homeSetup.pairingComputerStepOpenTitle'),
            detail: t('homeSetup.pairingComputerBody', { home: props.homeName }),
            body: (
                <View style={styles.handover}>
                    {link ? (
                        <View style={styles.linkBox}>
                            <Text testID={`${prefix}-link`} numberOfLines={1} ellipsizeMode="middle" style={styles.linkText}>{link}</Text>
                        </View>
                    ) : null}
                    <View style={styles.handoverActions}>
                        <CopyLinkButton testIDPrefix={prefix} link={link} writeClipboard={props.writeClipboard} align="start" />
                        {sharingAvailable ? (
                            <RoundButton
                                testID={`${prefix}-share-link`}
                                size="small"
                                display="secondary"
                                title={t('homeSetup.shareLink')}
                                disabled={!link}
                                action={async () => {
                                    if (link) await shareTextSafe(link);
                                }}
                            />
                        ) : null}
                    </View>
                </View>
            ),
        },
        {
            key: 'join',
            title: t('homeSetup.pairingComputerStepJoinTitle'),
            detail: t('homeSetup.pairingComputerStepJoin'),
            body: props.status,
        },
    ];
    return (
        <>
            <ItemGroup testID={`${prefix}-steps`}>
                <SectionContentRow>
                    <SetupSteps steps={steps} />
                </SectionContentRow>
            </ItemGroup>
            <ItemGroup testID={`${prefix}-scan`} title={t('homeSetup.pairingScanTitle')} description={t('homeSetup.pairingScanBody')}>
                <SectionContentRow>
                    <View style={styles.scanCode}>
                        <PairingCodeBlock testIDPrefix={prefix} state={props.state} homeName={props.homeName} />
                    </View>
                </SectionContentRow>
            </ItemGroup>
        </>
    );
}

/**
 * Copies the code's link (the same token as the QR, so it expires with it). The link is a secret
 * that adds a device, so copying it says so right there.
 */
function CopyLinkButton(props: Readonly<{
    testIDPrefix: string;
    link: string | null;
    writeClipboard: ReturnType<typeof useClipboardWrite>;
    /** `start` inside a step, under its words; the default sits at the end of the panel's action row. */
    align?: 'start' | 'end';
}>) {
    const { theme } = useUnistyles();
    const feedback = useHappierCopyFeedback(4000);
    const link = props.link;
    const start = props.align === 'start';
    return (
        <View style={[styles.copy, start ? styles.copyStart : null]}>
            <RoundButton
                testID={`${props.testIDPrefix}-copy-link`}
                size="small"
                display="secondary"
                title={t('homeSetup.copyLink')}
                leading={<Icon name="copy" size={14} color={theme.colors.text.secondary} />}
                disabled={!link}
                action={async () => {
                    if (!link) return;
                    const copied = await props.writeClipboard(link);
                    if (!copied) {
                        await Modal.alertAsync(t('common.error'), t('items.failedToCopyToClipboard'));
                        return;
                    }
                    feedback.markCopied();
                }}
            />
            <CopiedPill visible={feedback.isCopied()} testID={`${props.testIDPrefix}-copy-link-feedback`} />
            {feedback.isCopied() ? (
                <Text testID={`${props.testIDPrefix}-copy-link-warning`} style={[styles.copyWarning, start ? styles.copyWarningStart : null]}>
                    {t('connect.pairingLinkSecurityWarning')}
                </Text>
            ) : null}
        </View>
    );
}

/** The live line under the actions: what the panel is doing right now. */
function PairingStatusLine(props: Readonly<{
    testIDPrefix: string;
    state: PanelState;
    purpose: HomePairingPurpose;
    homeName: string;
    /** What the lifecycle owner says for this phase (the update requirement, the retry). */
    phaseBodyKey: HomeEnrollmentPresentationModel['primaryTranslationKey'];
    centred: boolean;
    accent: string;
    starting: boolean;
    onNewCode: () => Promise<void>;
}>) {
    const { theme } = useUnistyles();
    const prefix = props.testIDPrefix;
    const { state } = props;
    switch (state.kind) {
        case 'ready':
            // Two quiet lines, the countdown under the sentence: side by side they overflow a phone's step
            // column and the sentence broke mid-phrase.
            return (
                <View style={styles.statusColumn}>
                    <View style={styles.statusRow}>
                        <View style={[styles.pulse, { backgroundColor: props.accent, boxShadow: `0 0 0 4px ${theme.colors.state.active.background}` }]} />
                        <Text style={styles.statusText}>
                            {t(props.purpose === 'phone' ? 'homeSetup.waitingForPhone' : 'homeSetup.waitingForComputer')}
                        </Text>
                    </View>
                    <PairingCountdown testID={`${prefix}-countdown`} expiresAtMs={state.expiresAtMs}
                        style={[styles.countdown, styles.underStatusText]} />
                </View>
            );
        case 'making':
            return (
                <View style={styles.statusRow}>
                    <ActivitySpinner size="small" color={theme.colors.text.secondary} />
                    <Text style={styles.statusText}>{t('homeSetup.makingCode')}</Text>
                </View>
            );
        case 'adding':
            return (
                <View testID={`${prefix}-request-card`} style={styles.statusRow}>
                    <ActivitySpinner size="small" color={theme.colors.text.secondary} />
                    <Text style={styles.statusText}>
                        {state.retrying ? t(props.phaseBodyKey) : t('homeSetup.addingDevice', { device: state.device })}
                    </Text>
                </View>
            );
        case 'joined':
            return (
                <View testID={`${prefix}-complete`} style={styles.statusRow}>
                    <Icon name="check-circle" size={16} color={theme.colors.state.success.foreground} />
                    <Text style={styles.statusStrong}>
                        {t('homeSetup.deviceJoined', { device: state.device, home: props.homeName })}
                    </Text>
                </View>
            );
        case 'failed':
            return (
                <View testID={`${prefix}-invalid-request`} style={styles.statusRow}>
                    <Text style={[styles.statusText, props.centred ? null : styles.grow]}>
                        {state.cause ? `${t('homeSetup.codeFailed')} ${describePairingFailure(state.cause, props.homeName)}` : t('homeSetup.codeFailed')}
                    </Text>
                    <RoundButton
                        testID={`${prefix}-generate`}
                        size="small"
                        display="secondary"
                        title={t('surfaceState.tryAgain')}
                        action={props.onNewCode}
                        disabled={props.starting}
                    />
                </View>
            );
        case 'expired':
            return (
                <View testID={`${prefix}-expired`} style={styles.statusRow}>
                    <Text style={[styles.statusText, props.centred ? null : styles.grow]}>{t('connect.pairingQrExpired')}</Text>
                    <RoundButton
                        testID={`${prefix}-generate`}
                        size="small"
                        display="secondary"
                        title={t('homeSetup.newCode')}
                        action={props.onNewCode}
                        disabled={props.starting}
                    />
                </View>
            );
        case 'stopped':
            return (
                <View style={styles.statusRow}>
                    {props.centred ? null : <View style={styles.grow} />}
                    <RoundButton
                        testID={`${prefix}-generate`}
                        size="small"
                        display="secondary"
                        title={t('homeSetup.newCode')}
                        action={props.onNewCode}
                        disabled={props.starting}
                    />
                </View>
            );
        case 'updateRequired':
            return (
                <View testID={`${prefix}-update-required`} style={styles.statusColumn}>
                    <Text style={styles.statusStrong}>{t('connect.updateRequiredTitle')}</Text>
                    <Text style={styles.statusText}>{t(props.phaseBodyKey)}</Text>
                </View>
            );
    }
}

const PAIRING_PULSE_SIZE_PX = 8;

const styles = StyleSheet.create((theme) => ({
    root: {
        position: 'relative',
        paddingTop: 22,
        paddingBottom: 22,
        paddingLeft: 22,
        paddingRight: theme.space.s24,
    },
    rootPage: {
        paddingLeft: 0,
        paddingRight: 0,
        paddingTop: theme.space.s4,
    },
    rootModal: {
        paddingTop: 26,
        paddingBottom: 22,
        paddingHorizontal: 28,
    },
    close: {
        position: 'absolute',
        top: 10,
        right: 10,
        zIndex: 1,
    },
    sideBySide: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 30,
    },
    stacked: {
        alignItems: 'center',
        gap: theme.space.s20,
    },
    bodySide: {
        flex: 1,
        minWidth: 0,
    },
    bodyStacked: {
        width: '100%',
        alignItems: 'center',
    },
    codeSlot: {
        width: QR_PAPER_PX,
        height: QR_PAPER_PX,
        flexShrink: 0,
    },
    codeStandIn: {
        flex: 1,
        borderRadius: 18,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.inset,
        alignItems: 'center',
        justifyContent: 'center',
        padding: theme.space.s16,
        gap: theme.space.s6,
    },
    standInTitle: {
        ...Typography.default('semiBold'),
        ...happierPageTextMetrics('rowTitle'),
        color: theme.colors.text.primary,
        textAlign: 'center',
    },
    standInBody: {
        ...Typography.default(),
        ...happierPageTextMetrics('rowDescription'),
        color: theme.colors.text.secondary,
        textAlign: 'center',
    },
    title: {
        ...Typography.default('semiBold'),
        fontSize: 18,
        lineHeight: 24,
        letterSpacing: -0.2,
        color: theme.colors.text.primary,
        paddingRight: 28,
    },
    body: {
        ...Typography.default(),
        ...happierPageTextMetrics('pageDescription'),
        marginTop: theme.space.s4,
        maxWidth: 460,
        color: theme.colors.text.secondary,
    },
    centredText: {
        textAlign: 'center',
        paddingRight: 0,
        alignSelf: 'center',
    },
    steps: {
        // The centred panel must give flex-based step words a width on native.
        alignSelf: 'stretch',
        marginTop: theme.space.s16,
    },
    stepText: {
        ...Typography.default(),
        ...happierPageTextMetrics('rowDescription'),
        color: theme.colors.text.primary,
    },
    stores: {
        flexDirection: 'row',
        gap: 14,
    },
    store: {
        alignItems: 'center',
        gap: theme.space.s6,
    },
    storePaper: {
        padding: theme.space.s4,
        borderRadius: 10,
        backgroundColor: PAIRING_QR_PALETTE.paper,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.default,
    },
    storeLabel: {
        ...Typography.default('medium'),
        ...happierPageTextMetrics('meta'),
        color: theme.colors.text.secondary,
    },
    actions: {
        marginTop: 18,
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'flex-start',
        gap: theme.space.s8,
    },
    actionsCentred: {
        justifyContent: 'center',
    },
    grow: {
        flex: 1,
    },
    copy: {
        alignItems: 'flex-end',
        gap: theme.space.s6,
    },
    copyStart: {
        alignItems: 'flex-start',
    },
    copyWarningStart: {
        textAlign: 'left',
    },
    /** Step 2's handover: the link on its own line, then Copy and Share beneath it. */
    /** A step's body lays its parts in a wrapping row: the handover takes the whole line. */
    handover: {
        width: '100%',
        minWidth: 0,
        gap: theme.space.s8,
    },
    stepStatus: {
        width: '100%',
        minWidth: 0,
    },
    linkBox: {
        alignSelf: 'stretch',
        overflow: 'hidden',
        paddingHorizontal: theme.space.s10,
        paddingVertical: theme.space.s6,
        borderRadius: theme.borderRadius.md,
        backgroundColor: theme.colors.surface.inset,
    },
    linkText: {
        ...Typography.mono(),
        ...happierPageTextMetrics('meta'),
        color: theme.colors.text.primary,
    },
    handoverActions: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'flex-start',
        gap: theme.space.s8,
    },
    /** The code stands centred in its section's sheet. */
    scanCode: {
        alignItems: 'center',
        paddingVertical: theme.space.s8,
    },
    copyWarning: {
        ...Typography.default(),
        ...happierPageTextMetrics('meta'),
        maxWidth: 280,
        color: theme.colors.text.secondary,
        textAlign: 'right',
    },
    status: {
        marginTop: theme.space.s16,
        paddingTop: 14,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.border.default,
        alignSelf: 'stretch',
        gap: theme.space.s10,
    },
    statusCentred: {
        alignItems: 'center',
    },
    statusRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s10,
    },
    statusColumn: {
        gap: theme.space.s2,
    },
    // Under the sentence, past the pulse and the row's gap.
    underStatusText: {
        marginLeft: PAIRING_PULSE_SIZE_PX + theme.space.s10,
    },
    pulse: {
        width: PAIRING_PULSE_SIZE_PX,
        height: PAIRING_PULSE_SIZE_PX,
        borderRadius: PAIRING_PULSE_SIZE_PX / 2,
    },
    statusText: {
        ...Typography.default(),
        ...happierPageTextMetrics('meta'),
        color: theme.colors.text.secondary,
        flexShrink: 1,
    },
    statusStrong: {
        ...Typography.default('medium'),
        ...happierPageTextMetrics('meta'),
        color: theme.colors.text.primary,
        flexShrink: 1,
    },
    countdown: {
        ...Typography.default(),
        ...happierPageTextMetrics('meta'),
        color: theme.colors.text.tertiary,
        fontVariant: ['tabular-nums'],
        // The countdown is one figure: on a narrow row the sentence beside it wraps, never the time.
        flexShrink: 0,
    },
}));
