import { useAuth } from "@/auth/context/AuthContext";
import { Platform, Linking } from 'react-native';
import * as React from 'react';
import { encodeBase64 } from "@/encryption/base64";
import { authGetToken } from "@/auth/flows/getToken";
import { router, useRouter, useLocalSearchParams } from "expo-router";
import { getRandomBytesAsync } from "@/platform/cryptoRandom";
import { useIsLandscape } from "@/utils/platform/responsive";
import { trackAccountCreated } from '@/track';
import { MainView } from "@/components/navigation/shell/MainView";
import { t } from '@/text';
import { TokenStorage } from "@/auth/storage/tokenStorage";
import sodium from '@/encryption/libsodium.lib';
import { getAuthProvider } from "@/auth/providers/registry";
import { Modal } from "@/modal";
import { getPendingTerminalConnect } from "@/sync/domains/pending/pendingTerminalConnect";
import { isSafeExternalAuthUrl } from "@/auth/providers/externalAuthUrl";
import { fireAndForget } from "@/utils/system/fireAndForget";
import { formatOperationFailedDebugMessage } from "@/utils/errors/formatOperationFailedDebugMessage";
import { getActiveServerSnapshot } from "@/sync/domains/server/serverRuntime";
import { buildDataKeyCredentialsForToken } from "@/auth/flows/buildDataKeyCredentialsForToken";
import { digest } from "@/platform/digest";
import { encodeHex } from "@/encryption/hex";
import { resolveAppUrlScheme } from "@/utils/url/appScheme";
import { readConfiguredServerUrlEnv } from "@/sync/domains/server/readConfiguredServerUrlEnv";
import { getPendingSetupIntent } from "@/sync/domains/pending/pendingSetupIntent";
import { isTauriDesktop } from "@/utils/platform/tauri";
import { isAuthenticatedRootDeepLinkRedirectAllowed } from "@/auth/routing/isAuthenticatedRootDeepLinkRedirectAllowed";
import { shouldResumeSetupWizardAfterAuth } from "@/components/onboardingWizard/wizardResume";
import { PreAuthOnboardingWizardEntry } from "@/components/onboardingWizard/PreAuthOnboardingWizardEntry";
import { shouldAutoRedirectToSetupOnFirstLaunch } from '@/utils/platform/firstLaunchSetupRedirectPolicy';

export default function Home() {
    const auth = useAuth();
    if (!auth.isAuthenticated) {
        return <PreAuthOnboardingWizardEntry enableFirstLaunchSetupRedirect />;
    }
    return (
        <Authenticated />
    )
}

function Authenticated() {
    const params = useLocalSearchParams<{ id?: string | string[]; messageId?: string | string[]; jumpChildId?: string | string[] }>();
    const router = useRouter();

    const sessionId = typeof params.id === 'string' ? params.id : Array.isArray(params.id) ? (params.id[0] ?? null) : null;
    const messageId = typeof params.messageId === 'string' ? params.messageId : Array.isArray(params.messageId) ? (params.messageId[0] ?? null) : null;
    const jumpChildId = typeof params.jumpChildId === 'string' ? params.jumpChildId : Array.isArray(params.jumpChildId) ? (params.jumpChildId[0] ?? null) : null;

    React.useEffect(() => {
        const sid = String(sessionId ?? '').trim();
        if (!sid) return;
        if (!isAuthenticatedRootDeepLinkRedirectAllowed()) return;

        const mid = String(messageId ?? '').trim();
        if (mid) {
            const child = String(jumpChildId ?? '').trim();
            const qs = child ? `?jumpChildId=${encodeURIComponent(child)}` : '';
            router.replace(`/session/${encodeURIComponent(sid)}/message/${encodeURIComponent(mid)}${qs}`);
            return;
        }

        router.replace(`/session/${encodeURIComponent(sid)}`);
    }, [jumpChildId, messageId, router, sessionId]);

    React.useEffect(() => {
        const sid = String(sessionId ?? '').trim();
        if (sid) return;
        if (!isAuthenticatedRootDeepLinkRedirectAllowed()) return;

        if (!shouldResumeSetupWizardAfterAuth()) {
            return;
        }
        router.replace('/setup');
    }, [router, sessionId]);

    return <MainView variant="phone" />;
}
