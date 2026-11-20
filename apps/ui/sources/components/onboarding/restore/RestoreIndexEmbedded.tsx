import * as React from 'react';
import { Platform, View, useWindowDimensions, type ViewStyle } from 'react-native';

import { isRunningOnMac } from '@/utils/platform/platform';
import { isDesktopHost } from '@/utils/platform/desktopHost';
import { canUseCurrentDeviceQrScanner } from '@/utils/platform/qrScannerSupport';
import { isWebMobileLikeQrScannerHost } from '@/utils/platform/webMobileHeuristics';
import { StepEntranceBody } from '@/components/ui/motion/stepMotion/StepEntranceBody';
import { StepMotionLayer, useFirstRunWorkflowMotion } from '@/components/ui/motion/stepMotion/StepMotionLayer';
import { StepTransitionFrame, type StepTransitionDirection } from '@/components/ui/motion/StepTransitionFrame';
import { runStepMove } from '@/components/ui/motion/stepMotion/StepMotionStage';

import { RestoreQrView, type RestoreQrViewProps } from '@/components/account/restore/RestoreQrView';
import { PairingLinkEntryForm } from '@/components/account/restore/PairingLinkEntryForm';
import {
    RestoreScanComputerQrView,
    type RestoreScanComputerQrViewProps,
} from '@/components/account/restore/RestoreScanComputerQrView';
import type { HomeQrEntryIntent } from '@/auth/pairing/homeQrEntryIntent';
import { getActiveServerId } from '@/sync/domains/server/serverProfiles';

import { resolveReverseQrTargetProfileId } from './loginWays';
import { RestoreSignInWays } from './RestoreSignInWays';
import { UnauthenticatedStepHeading } from '@/components/onboarding/unauthShell/UnauthenticatedStep';
import { StepRowBack, useStepBackOverride } from '@/components/onboarding/unauthShell/stepBack';
import { t } from '@/text';

type RestoreView = 'qr' | 'scanner' | 'paste';
type RestoreWay = RestoreView | 'terminal_link';
const RESTORE_WAY_LAYER = 'restore-way';
/** Each way is its own step: its heading, then its body a section below (the step frame's rhythm). */
const VIEW_STYLE: ViewStyle = { width: '100%', gap: 24 };

export type RestoreIndexEmbeddedProps = Readonly<{
    entryIntent: HomeQrEntryIntent;
    /** `paste` when the entry the person chose promised link entry (a device that cannot scan). */
    initialView?: RestoreView;
    reverseTargetProfileId?: string | null;
    onBack: () => void;
    onOpenSecretKeyLogin?: () => void;
    renderAdditionalSignInWays?: RestoreQrViewProps['renderAdditionalSignInWays'];
    initialPairingLink?: string | null;
    initialResult?: RestoreScanComputerQrViewProps['initialResult'];
    onNavigationLockChange?: (locked: boolean) => void;
    onOpenLostAccess?: () => void;
    onInviteDirectionChange?: RestoreScanComputerQrViewProps['onInviteDirectionChange'];
}>;

export const RestoreIndexEmbedded = React.memo(function RestoreIndexEmbedded(props: RestoreIndexEmbeddedProps) {
    const { width, height } = useWindowDimensions();
    const isDesktopShell = React.useMemo(() => isDesktopHost(), []);
    const canUseScanner = canUseCurrentDeviceQrScanner();
    const isNativePhone = (Platform.OS === 'ios' || Platform.OS === 'android') && !isRunningOnMac();
    const heuristicViewport = React.useMemo(() => {
        if (Platform.OS !== 'web') {
            return { width, height };
        }
        if (!isDesktopShell) {
            return { width, height };
        }
        const screen =
            (globalThis as unknown as { screen?: unknown }).screen
            ?? (typeof window !== 'undefined' ? window.screen : null);
        const screenWidth = typeof (screen as { availWidth?: unknown } | null)?.availWidth === 'number'
            ? Number((screen as { availWidth: number }).availWidth)
            : (typeof (screen as { width?: unknown } | null)?.width === 'number' ? Number((screen as { width: number }).width) : 0);
        const screenHeight = typeof (screen as { availHeight?: unknown } | null)?.availHeight === 'number'
            ? Number((screen as { availHeight: number }).availHeight)
            : (typeof (screen as { height?: unknown } | null)?.height === 'number' ? Number((screen as { height: number }).height) : 0);
        if (Number.isFinite(screenWidth) && Number.isFinite(screenHeight) && screenWidth > 0 && screenHeight > 0) {
            return { width: screenWidth, height: screenHeight };
        }
        return { width, height };
    }, [height, isDesktopShell, width]);
    const isWebPhoneWithCamera =
        Platform.OS === 'web' && canUseScanner && isWebMobileLikeQrScannerHost(heuristicViewport);
    // Production entry point for the requester-displayed direction: an explicit
    // caller target wins, otherwise this device's own unambiguous saved Home.
    const reverseTargetProfileId = React.useMemo(
        () => props.reverseTargetProfileId ?? resolveReverseQrTargetProfileId(props.initialView === 'qr' ? getActiveServerId() : undefined),
        [props.initialView, props.reverseTargetProfileId],
    );
    const showScannerFirst =
        Boolean(props.initialPairingLink)
        || Boolean(props.initialResult)
        || props.entryIntent === 'add_home'
        || !reverseTargetProfileId
        || isNativePhone
        || isWebPhoneWithCamera;
    const firstRun = useFirstRunWorkflowMotion();
    const [ways, setWays] = React.useState<Readonly<{ history: readonly RestoreWay[]; direction: StepTransitionDirection; pastedLink?: string }>>({
        history: [], direction: 'replace',
    });
    // The camera says where to point it while it is live; a scan's result keeps the step's own heading.
    const [scannerLive, setScannerLive] = React.useState(() => !props.initialPairingLink && !props.initialResult);
    const defaultView = props.initialView ?? (showScannerFirst ? 'scanner' : 'qr');
    const activeView = ways.history.at(-1) ?? defaultView;
    const move = (kind: 'step' | 'back', history: readonly RestoreWay[], pastedLink?: string) => {
        const commit = () => setWays({ history, direction: kind === 'step' ? 'forward' : 'backward', pastedLink });
        if (firstRun) runStepMove({ layer: RESTORE_WAY_LAYER, kind, commit });
        else commit();
    };
    const openWay = (view: RestoreWay, link?: string) => {
        if (view !== activeView || link) move('step', [...ways.history, view], link);
    };
    const previousWay = ways.history.length > 0 ? () => move('back', ways.history.slice(0, -1)) : undefined;
    const backSlot = useStepBackOverride(previousWay);
    const onBack = backSlot?.onBack ?? previousWay ?? props.onBack;
    const openPasteEntry = () => openWay('paste');
    const openScanner = canUseScanner ? () => openWay('scanner') : undefined;
    const openQr = reverseTargetProfileId ? () => openWay('qr') : undefined;

    // The embedded scanner remains the owner of scanned and pasted link enrollment.
    const submitPastedPairingLink = async (link: string) => {
        openWay('scanner', link);
        return true;
    };

    const content = <>
        {activeView === 'terminal_link' ? (
            <View style={VIEW_STYLE}>
                <UnauthenticatedStepHeading title={t('terminal.connectTerminal')} />
                <PairingLinkEntryForm
                    embedded
                    fieldLabel={t('connect.enterUrlManually')}
                    placeholder={t('connect.terminalUrlPlaceholder')}
                    onSubmit={submitPastedPairingLink}
                    onBack={backSlot ? undefined : onBack}
                    backLabel={t('common.back')}
                />
                <StepRowBack />
            </View>
        ) : activeView === 'paste' ? (
            <View style={VIEW_STYLE}>
                <UnauthenticatedStepHeading title={t('setupOnboarding.authRestoreTitle')} subtitle={t('setupOnboarding.authRestoreSubtitle')} />
                <RestoreSignInWays
                    onSubmitLink={submitPastedPairingLink}
                    onOpenScanner={openScanner}
                    onShowQr={openQr}
                    offerSecretKey={props.entryIntent === 'enter_home'}
                    onLostAccess={props.onOpenLostAccess}
                />
                {props.renderAdditionalSignInWays?.(undefined, <StepRowBack />)}
            </View>
        ) : activeView === 'scanner' ? (
            <View style={VIEW_STYLE}>
            {scannerLive && props.entryIntent === 'enter_home'
                ? <UnauthenticatedStepHeading title={t('connect.pointAtComputerTitle')} subtitle={t('connect.pointAtComputerSubtitle')} />
                : <UnauthenticatedStepHeading title={t('setupOnboarding.authRestoreTitle')} subtitle={t('setupOnboarding.authRestoreSubtitle')} />}
            <StepEntranceBody>
                <RestoreScanComputerQrView
                    entryIntent={props.entryIntent}
                    embedded
                    initialPairingLink={ways.pastedLink ?? props.initialPairingLink}
                    initialResult={props.initialResult}
                    onBack={onBack}
                    showBack={false}
                    onOpenSecretKeyLogin={props.onOpenSecretKeyLogin}
                    renderAdditionalSignInWays={props.renderAdditionalSignInWays}
                    onCameraLiveChange={setScannerLive}
                    onOpenPairingLinkEntry={openPasteEntry}
                    onShowQrInstead={openQr}
                    onNavigationLockChange={props.onNavigationLockChange}
                    onInviteDirectionChange={props.onInviteDirectionChange}
                />
            </StepEntranceBody>
            </View>
        ) : (
            <View style={VIEW_STYLE}>
            <UnauthenticatedStepHeading title={t('connect.approveFromDeviceTitle')} subtitle={t('connect.approveFromDeviceSubtitle')} />
            <StepEntranceBody>
                <RestoreQrView
                    entryIntent={props.entryIntent}
                    targetProfileId={reverseTargetProfileId}
                    embedded
                    onBack={onBack}
                    onOpenSecretKeyLogin={props.onOpenSecretKeyLogin}
                    renderAdditionalSignInWays={props.renderAdditionalSignInWays}
                    onOpenScanQr={openScanner}
                    onOpenPairingLinkEntry={openPasteEntry}
                    onNavigationLockChange={props.onNavigationLockChange}
                    onOpenLostAccess={props.onOpenLostAccess}
                    onOpenTerminalLink={() => openWay('terminal_link')}
                />
            </StepEntranceBody>
            </View>
        )}
    </>;

    return firstRun
        ? <StepMotionLayer layerKey={RESTORE_WAY_LAYER} stepKey={activeView} shareFocalWithParent>{content}</StepMotionLayer>
        : <StepTransitionFrame transitionKey={activeView} direction={ways.direction}>{content}</StepTransitionFrame>;
});
