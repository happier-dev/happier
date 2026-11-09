import React from 'react';
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';

import type { ExactTurnAutomationPrefill } from '@/components/automations/sessionLifecycle/exactTurnAutomationPrefill';
import { ComposerBannerCollapseProvider } from '@/components/sessions/composerBanners/ComposerBannerCollapseProvider';
import { NewSessionScreen } from '@/components/sessions/new/NewSessionScreen';
import { interceptNewSessionEntry, useNewSessionShellHost } from '@/components/sessions/new/navigation/newSessionEntry';
import type { NewSessionHostParams } from '@/components/sessions/new/navigation/newSessionHost';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';

function NewSessionScreenWithComposerBannerScope(props: Readonly<{
    automationExactTurnRetarget?: ExactTurnAutomationPrefill | null;
}>) {
    const params: NewSessionHostParams = useLocalSearchParams();
    const { draftId } = params;
    const router = useRouter();
    const navigation = useNavigation();
    const docked = useNewSessionShellHost()?.enabled === true;
    React.useEffect(() => {
        if (!docked || !interceptNewSessionEntry({ pathname: '/new', params })) return;
        safeRouterBack({ router, navigation, fallbackHref: '/' });
    }, [docked, navigation, params, router]);
    if (docked) return null;
    return (
        <ComposerBannerCollapseProvider key={typeof draftId === 'string' ? draftId : 'new-session'}>
            <NewSessionScreen presentation="screen" automationExactTurnRetarget={props.automationExactTurnRetarget ?? null} />
        </ComposerBannerCollapseProvider>
    );
}

export default React.memo(NewSessionScreenWithComposerBannerScope);
