import * as React from 'react';

import { View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { RestoreIndexEmbedded } from '@/components/onboarding/restore/RestoreIndexEmbedded';
import { AuthRouteStepFrame } from '@/components/onboarding/ui/AuthRouteStepFrame';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';
import { t } from '@/text';
import { LEGACY_PAIRING_UPDATE_REQUIRED_RESTORE_ROUTE_PARAM } from '@/auth/pairing/legacyPairingUpdateRequiredRoute';
import {
    consumeHomeQrInviteRestoreHandoff,
    EXPIRED_HOME_QR_RESTORE_ROUTE_PARAM,
    HOME_QR_INVITE_RESTORE_ROUTE_PARAM,
    parseHomeQrInviteDeepLink,
} from '@/auth/pairing/pairingUrl';
import type { HomeQrInviteV2 } from '@happier-dev/protocol/crypto/qrProvisioningV2';
import {
    HOME_QR_ENTRY_INTENT_ROUTE_PARAM,
    parseHomeQrEntryIntentRouteParam,
} from '@/auth/pairing/homeQrEntryIntent';

export default function RestoreIndex() {
    const router = useRouter();
    const params = useLocalSearchParams<Readonly<{
        pairingHandoff?: string | string[];
        legacyPairingUpdateRequired?: string | string[];
        pairingExpired?: string | string[];
        entryIntent?: string | string[];
        provider?: string | string[];
        reason?: string | string[];
        view?: string | string[];
    }>>();
    const routedEntryIntent = parseHomeQrEntryIntentRouteParam(
        params[HOME_QR_ENTRY_INTENT_ROUTE_PARAM],
    );
    const entryIntent = routedEntryIntent ?? 'enter_home';
    const routedPairingHandoff = Array.isArray(params[HOME_QR_INVITE_RESTORE_ROUTE_PARAM])
        ? params[HOME_QR_INVITE_RESTORE_ROUTE_PARAM][0] ?? null
        : params[HOME_QR_INVITE_RESTORE_ROUTE_PARAM] ?? null;
    const [routedPairingLink] = React.useState(() => (
        routedPairingHandoff && routedEntryIntent
            ? consumeHomeQrInviteRestoreHandoff(routedPairingHandoff)
            : null
    ));
    // A plain Welcome route owns `enter_home`, but routed authority-bearing input
    // must carry its entry point's explicit closed intent.
    const initialPairingLink = routedPairingLink && routedEntryIntent
        ? routedPairingLink
        : null;
    // A reverse-direction invite makes this device the approver: it links the new
    // device to its Home rather than adding or restoring a Home here. The routed
    // link seeds the chrome; the embedded scanner then reports the direction of the
    // invite it is actually processing (including one scanned or pasted in place).
    const [inviteDirection, setInviteDirection] = React.useState<HomeQrInviteV2['direction'] | null>(() => (
        initialPairingLink
            ? parseHomeQrInviteDeepLink(initialPairingLink)?.invite.direction ?? null
            : null
    ));
    const approvesRequesterDevice = inviteDirection === 'requester_displays';
    const [navigationLocked, setNavigationLocked] = React.useState(false);
    // `view=link` (a dead terminal link's "Enter URL manually") opens on the link field.
    const requestedView = Array.isArray(params.view) ? params.view[0] : params.view;
    const restoreRedirectReason = Array.isArray(params.reason) ? params.reason[0] : params.reason;
    const restoreRedirectProvider = Array.isArray(params.provider) ? params.provider[0] : params.provider;
    const hasProviderRestoreRedirect = restoreRedirectReason === 'provider_already_linked'
        && typeof restoreRedirectProvider === 'string'
        && restoreRedirectProvider.trim().length > 0;
    const handleBack = React.useCallback(() => {
        if (navigationLocked) return;
        safeRouterBack({
            router,
            fallbackHref: entryIntent === 'add_home' ? '/settings/account' : '/',
        });
    }, [entryIntent, navigationLocked, router]);
    const legacyPairingUpdateRequiredParam = params[LEGACY_PAIRING_UPDATE_REQUIRED_RESTORE_ROUTE_PARAM];
    const legacyPairingUpdateRequired = (
        Array.isArray(legacyPairingUpdateRequiredParam)
            ? legacyPairingUpdateRequiredParam[0]
            : legacyPairingUpdateRequiredParam
    ) === '1';
    const expiredPairing = params[EXPIRED_HOME_QR_RESTORE_ROUTE_PARAM] === '1';
    return (
        <View
            testID="unauth-shell-route-restore"
            style={{ flex: 1 }}
        >
            <AuthRouteStepFrame
                routeBack
                testID="restore-wizard"
                progress={approvesRequesterDevice ? undefined : { index: 1, count: 3 }}
                title={t(
                    approvesRequesterDevice
                        ? 'connect.approveNewDeviceTitle'
                        : entryIntent === 'add_home'
                            ? 'setupOnboarding.addHomeTitle'
                            : 'setupOnboarding.authRestoreTitle',
                )}
                subtitle={t(
                    approvesRequesterDevice
                        ? 'connect.approveNewDeviceSubtitle'
                        : entryIntent === 'add_home'
                            ? 'setupOnboarding.addHomeSubtitle'
                            : 'setupOnboarding.authRestoreSubtitle',
                )}
                onBack={handleBack}
                backDisabled={navigationLocked}
                // Signing in here, each way titles itself; approving a device or adding a Home keeps the route's title.
                bodyOwnsHeading={entryIntent === 'enter_home' && !approvesRequesterDevice}
            >
                <View testID="restore-route-content">
                    <RestoreIndexEmbedded
                        entryIntent={entryIntent}
                        initialView={hasProviderRestoreRedirect ? 'qr' : requestedView === 'link' ? 'paste' : undefined}
                        onBack={handleBack}
                        initialPairingLink={initialPairingLink}
                        initialResult={legacyPairingUpdateRequired ? 'legacy_pairing' : expiredPairing ? 'expired' : undefined}
                        onNavigationLockChange={setNavigationLocked}
                        onInviteDirectionChange={setInviteDirection}
                    />
                </View>
            </AuthRouteStepFrame>
        </View>
    );
}
