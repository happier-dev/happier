import * as React from 'react';

import { useLocalSearchParams, useRouter } from 'expo-router';
import { View } from 'react-native';

import { RestoreQrView } from '@/components/account/restore/RestoreQrView';
import { HOME_QR_ENTRY_INTENT_ROUTE_PARAM, parseHomeQrEntryIntentRouteParam } from '@/auth/pairing/homeQrEntryIntent';
import { AuthRouteStepFrame } from '@/components/onboarding/ui/AuthRouteStepFrame';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';
import { t } from '@/text';

/**
 * The QR this device shows for a known Home, as its own route. It is the same step as the restore
 * route's QR view, so it takes the same frame and heading rather than a body with no title.
 */
export default function RestoreShowQrRoute() {
    const router = useRouter();
    const params = useLocalSearchParams<{ serverId?: string | string[]; entryIntent?: string | string[] }>();
    const rawServerId = Array.isArray(params.serverId) ? params.serverId[0] : params.serverId;
    const targetProfileId = typeof rawServerId === 'string' ? rawServerId.trim() : '';
    const entryIntent = parseHomeQrEntryIntentRouteParam(params[HOME_QR_ENTRY_INTENT_ROUTE_PARAM]) ?? 'enter_home';
    const [navigationLocked, setNavigationLocked] = React.useState(false);
    const handleBack = React.useCallback(() => {
        if (navigationLocked) return;
        safeRouterBack({ router, fallbackHref: '/restore' });
    }, [navigationLocked, router]);

    return (
        <AuthRouteStepFrame
            testID="restore-show-qr"
            title={t(entryIntent === 'add_home' ? 'setupOnboarding.addHomeTitle' : 'setupOnboarding.authRestoreTitle')}
            subtitle={t(entryIntent === 'add_home' ? 'setupOnboarding.addHomeSubtitle' : 'setupOnboarding.authRestoreSubtitle')}
            onBack={handleBack}
            backDisabled={navigationLocked}
        >
            <View testID="restore-route-content">
                {targetProfileId ? (
                    <RestoreQrView
                        entryIntent={entryIntent}
                        targetProfileId={targetProfileId}
                        embedded
                        onBack={handleBack}
                        onNavigationLockChange={setNavigationLocked}
                    />
                ) : null}
            </View>
        </AuthRouteStepFrame>
    );
}
