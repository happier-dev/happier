import { router, useLocalSearchParams } from 'expo-router';
import * as React from 'react';

import { useAuth } from '@/auth/context/AuthContext';
import { buildAccountConnectDeepLink } from '@/auth/pairing/accountConnectUrl';
import { promptAccountConnectApprovalRequired } from '@/components/account/restore/accountConnectApprovalGuidance';
import { useConnectAccount } from '@/hooks/auth/useConnectAccount';
import { fireAndForget } from '@/utils/system/fireAndForget';

export default function LegacyAccountRoute() {
    const params = useLocalSearchParams();
    const auth = useAuth();
    const { processAuthUrl } = useConnectAccount();
    const decision = React.useMemo(() => {
        if (typeof params.accountConnectKey === 'string' && params.accountConnectKey.trim()) {
            return {
                kind: 'approve' as const,
                authUrl: buildAccountConnectDeepLink({ publicKeyB64Url: params.accountConnectKey }),
            };
        }
        if (typeof params.server === 'string' && params.server) {
            return {
                kind: 'redirect' as const,
                href: { pathname: '/settings/account' as const, params: { server: params.server } },
            };
        }
        return { kind: 'redirect' as const, href: '/settings/account' as const };
    }, [params.accountConnectKey, params.server]);
    const handledRequestRef = React.useRef<string | null>(null);

    React.useEffect(() => {
        const requestKey = decision.kind === 'approve'
            ? `approve:${decision.authUrl}`
            : `redirect:${JSON.stringify(decision.href)}`;
        if (handledRequestRef.current === requestKey) return;
        handledRequestRef.current = requestKey;

        if (decision.kind === 'redirect') {
            router.replace(decision.href);
            return;
        }

        fireAndForget((async () => {
            if (auth.isAuthenticated) {
                await processAuthUrl(decision.authUrl);
                router.replace('/settings/account');
                return;
            }

            const action = await promptAccountConnectApprovalRequired();
            router.replace(action === 'showQr' ? '/restore/show-qr' : '/');
        })(), { tag: 'LegacyAccountRoute.processAccountConnect' });
    }, [auth.isAuthenticated, decision, processAuthUrl]);

    return null;
}
