import { router, useLocalSearchParams } from 'expo-router';
import * as React from 'react';

import { useAuth } from '@/auth/context/AuthContext';
import { AuthRouteStepFrame } from '@/components/onboarding/ui/AuthRouteStepFrame';
import { StepMark } from '@/components/onboarding/unauthShell/StepMark';
import { t } from '@/text';

export default function LegacyAccountRoute() {
    const params = useLocalSearchParams();
    const auth = useAuth();
    const decision = React.useMemo(() => {
        if (typeof params.accountConnectKey === 'string' && params.accountConnectKey.trim()) {
            return { kind: 'legacy-account-connect' as const };
        }
        if (typeof params.server === 'string' && params.server) {
            return {
                kind: 'redirect' as const,
                href: { pathname: '/settings/account' as const, params: { server: params.server } },
            };
        }
        return { kind: 'redirect' as const, href: '/settings/account' as const };
    }, [params.accountConnectKey, params.server]);
    React.useEffect(() => {
        if (decision.kind === 'redirect') {
            router.replace(decision.href);
        }
    }, [decision]);

    if (decision.kind === 'redirect') return null;
    return <AuthRouteStepFrame
        testID="legacy-account-qr"
        status
        mark={<StepMark iconName="key" />}
        title={t('connect.updateRequiredTitle')}
        subtitle={t('connect.legacyAccountQrUnavailable')}
        onBack={() => router.replace(auth.isAuthenticated ? '/settings/account' : '/')}
        primary={{
            testID: 'legacy-account-create-new-qr',
            label: t(auth.isAuthenticated ? 'connect.generateNewQrCode' : 'connect.scanNewQr'),
            onPress: () => router.replace(auth.isAuthenticated ? '/settings/add-phone' : '/restore'),
        }}
    >{null}</AuthRouteStepFrame>;
}
