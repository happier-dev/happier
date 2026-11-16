import * as React from 'react';
import { Platform, useWindowDimensions } from 'react-native';

import { isRunningOnMac } from '@/utils/platform/platform';
import { isDesktopHost } from '@/utils/platform/desktopHost';
import { canUseCurrentDeviceQrScanner } from '@/utils/platform/qrScannerSupport';
import { isWebMobileLikeQrScannerHost } from '@/utils/platform/webMobileHeuristics';

import { RestoreQrView } from '@/components/account/restore/RestoreQrView';
import {
    RestoreScanComputerQrView,
    type RestoreScanComputerQrViewProps,
} from '@/components/account/restore/RestoreScanComputerQrView';
import type { HomeQrEntryIntent } from '@/auth/pairing/homeQrEntryIntent';
import { buildHomeConnectionDescriptorForProfile, listServerProfiles } from '@/sync/domains/server/serverProfiles';

import { RestoreSignInWays } from './RestoreSignInWays';

/**
 * The requester-displayed direction needs one unambiguous saved Home to display a
 * QR for. Resolve it from the saved profiles this device already knows, and only
 * when exactly one of them can produce an established connection descriptor;
 * ambiguity stays on the scanner rather than guessing an enrollment target.
 */
export function resolveReverseQrTargetProfileId(): string | null {
    let resolved: string | null = null;
    for (const profile of listServerProfiles()) {
        const descriptor = buildHomeConnectionDescriptorForProfile(profile);
        if (!descriptor || profile.serverIdentityId !== descriptor.homeServerIdentityId) continue;
        if (resolved) return null;
        resolved = profile.id;
    }
    return resolved;
}

export type RestoreIndexEmbeddedProps = Readonly<{
    entryIntent: HomeQrEntryIntent;
    /** `paste` when the entry the person chose promised link entry (a device that cannot scan). */
    initialView?: 'qr' | 'scanner' | 'paste';
    reverseTargetProfileId?: string | null;
    onBack: () => void;
    onOpenSecretKeyLogin?: () => void;
    initialPairingLink?: string | null;
    onNavigationLockChange?: (locked: boolean) => void;
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
        () => props.reverseTargetProfileId ?? resolveReverseQrTargetProfileId(),
        [props.reverseTargetProfileId],
    );
    // A pasted link is handed to the embedded scanner, the one owner that
    // classifies and enrolls scanned and pasted links alike.
    const [pastedPairingLink, setPastedPairingLink] = React.useState<string | null>(null);
    const showScannerFirst =
        Boolean(props.initialPairingLink)
        || props.entryIntent === 'add_home'
        || !reverseTargetProfileId
        || isNativePhone
        || isWebPhoneWithCamera;
    const [currentView, setCurrentView] = React.useState<'qr' | 'scanner' | 'paste' | null>(null);
    const defaultView = props.initialView ?? (showScannerFirst ? 'scanner' : 'qr');
    const activeView = currentView ?? defaultView;
    const openPasteEntry = React.useCallback(() => setCurrentView('paste'), []);

    const submitPastedPairingLink = React.useCallback(async (link: string) => {
        setPastedPairingLink(link);
        setCurrentView('scanner');
        return true;
    }, []);

    // Login's one screen (and link entry from the scanner or the QR): every way in, each explained, with
    // the camera and the QR this device can show one press away instead of a separate way back.
    if (activeView === 'paste') {
        return (
            <RestoreSignInWays
                onSubmitLink={submitPastedPairingLink}
                onOpenScanner={canUseScanner ? () => setCurrentView('scanner') : undefined}
                onShowQr={reverseTargetProfileId ? () => setCurrentView('qr') : undefined}
                offerSecretKey={props.entryIntent === 'enter_home'}
            />
        );
    }

    return activeView === 'scanner' ? (
        <RestoreScanComputerQrView
            entryIntent={props.entryIntent}
            embedded
            initialPairingLink={pastedPairingLink ?? props.initialPairingLink}
            onBack={props.onBack}
            showBack={false}
            onOpenSecretKeyLogin={props.onOpenSecretKeyLogin}
            onOpenPairingLinkEntry={openPasteEntry}
            onShowQrInstead={reverseTargetProfileId ? () => setCurrentView('qr') : undefined}
            onNavigationLockChange={props.onNavigationLockChange}
            onInviteDirectionChange={props.onInviteDirectionChange}
        />
    ) : (
        <RestoreQrView
            entryIntent={props.entryIntent}
            targetProfileId={reverseTargetProfileId}
            embedded
            onBack={props.onBack}
            onOpenSecretKeyLogin={props.onOpenSecretKeyLogin}
            onOpenScanQr={canUseScanner ? () => setCurrentView('scanner') : undefined}
            onOpenPairingLinkEntry={openPasteEntry}
            onNavigationLockChange={props.onNavigationLockChange}
        />
    );
});
