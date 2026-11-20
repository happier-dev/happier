import * as React from 'react';
import { Platform, View, useWindowDimensions, type ViewStyle } from 'react-native';

import { isRunningOnMac } from '@/utils/platform/platform';
import { isDesktopHost } from '@/utils/platform/desktopHost';
import { canUseCurrentDeviceQrScanner } from '@/utils/platform/qrScannerSupport';
import { isWebMobileLikeQrScannerHost } from '@/utils/platform/webMobileHeuristics';
import { StepMotionLayer } from '@/components/ui/motion/stepMotion/StepMotionLayer';
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
import { StepRowBack } from '@/components/onboarding/unauthShell/stepBack';
import { t } from '@/text';

type RestoreView = 'qr' | 'scanner' | 'paste';
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
    // A pasted link is handed to the embedded scanner, the one owner that
    // classifies and enrolls scanned and pasted links alike.
    const [pastedPairingLink, setPastedPairingLink] = React.useState<string | null>(null);
    const showScannerFirst =
        Boolean(props.initialPairingLink)
        || Boolean(props.initialResult)
        || props.entryIntent === 'add_home'
        || !reverseTargetProfileId
        || isNativePhone
        || isWebPhoneWithCamera;
    const [currentView, setCurrentView] = React.useState<RestoreView | 'terminal_link' | null>(null);
    const defaultView = props.initialView ?? (showScannerFirst ? 'scanner' : 'qr');
    const activeView = currentView ?? defaultView;
    const openWay = (view: NonNullable<typeof currentView>) => runStepMove({ layer: RESTORE_WAY_LAYER, kind: 'step', commit: () => setCurrentView(view) });
    const openPasteEntry = () => openWay('paste');
    const openScanner = canUseScanner ? () => openWay('scanner') : undefined;
    const openQr = reverseTargetProfileId ? () => openWay('qr') : undefined;

    const submitPastedPairingLink = React.useCallback(async (link: string) => {
        runStepMove({ layer: RESTORE_WAY_LAYER, kind: 'step', commit: () => {
            setPastedPairingLink(link);
            setCurrentView('scanner');
        } });
        return true;
    }, []);

    return <StepMotionLayer layerKey={RESTORE_WAY_LAYER} stepKey={activeView} shareFocalWithParent>
        {activeView === 'terminal_link' ? (
            <View style={VIEW_STYLE}>
                <UnauthenticatedStepHeading title={t('terminal.connectTerminal')} />
                <PairingLinkEntryForm
                    embedded
                    fieldLabel={t('connect.enterUrlManually')}
                    placeholder={t('connect.terminalUrlPlaceholder')}
                    onSubmit={submitPastedPairingLink}
                    onBack={() => openWay('qr')}
                    backLabel={t('common.back')}
                />
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
            <UnauthenticatedStepHeading title={t('setupOnboarding.authRestoreTitle')} subtitle={t('setupOnboarding.authRestoreSubtitle')} />
            <RestoreScanComputerQrView
                entryIntent={props.entryIntent}
                embedded
                initialPairingLink={pastedPairingLink ?? props.initialPairingLink}
                initialResult={props.initialResult}
                onBack={props.onBack}
                showBack={false}
                onOpenSecretKeyLogin={props.onOpenSecretKeyLogin}
                additionalSignInWays={props.renderAdditionalSignInWays?.()}
                onOpenPairingLinkEntry={openPasteEntry}
                onShowQrInstead={openQr}
                onNavigationLockChange={props.onNavigationLockChange}
                onInviteDirectionChange={props.onInviteDirectionChange}
            />
            </View>
        ) : (
            <View style={VIEW_STYLE}>
            <UnauthenticatedStepHeading title={t('connect.approveFromDeviceTitle')} subtitle={t('connect.approveFromDeviceSubtitle')} />
            <RestoreQrView
                entryIntent={props.entryIntent}
                targetProfileId={reverseTargetProfileId}
                embedded
                onBack={props.onBack}
                onOpenSecretKeyLogin={props.onOpenSecretKeyLogin}
                renderAdditionalSignInWays={props.renderAdditionalSignInWays}
                onOpenScanQr={openScanner}
                onOpenPairingLinkEntry={openPasteEntry}
                onNavigationLockChange={props.onNavigationLockChange}
                onOpenTerminalLink={() => openWay('terminal_link')}
            />
            </View>
        )}
    </StepMotionLayer>;
});
