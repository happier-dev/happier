import * as React from 'react';
import { Linking, Platform } from 'react-native';

import { useRouter } from 'expo-router';

import { useAuth } from '@/auth/context/AuthContext';
import { authGetToken } from '@/auth/flows/getToken';
import { buildDataKeyCredentialsForToken } from '@/auth/flows/buildDataKeyCredentialsForToken';
import { getAuthProvider } from '@/auth/providers/registry';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { encodeBase64 } from '@/encryption/base64';
import { encodeHex } from '@/encryption/hex';
import sodium from '@/encryption/libsodium.lib';
import { digest } from '@/platform/digest';
import { getRandomBytesAsync } from '@/platform/cryptoRandom';
import { Modal } from '@/modal';
import { useAuthEntryOptions } from '@/components/account/auth/useAuthEntryOptions';
import { useIsLandscape } from '@/utils/platform/responsive';
import { isSafeExternalAuthUrl } from '@/auth/providers/externalAuthUrl';
import { formatOperationFailedDebugMessage } from '@/utils/errors/formatOperationFailedDebugMessage';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { resolveAppUrlScheme } from '@/utils/url/appScheme';
import { trackAccountCreated } from '@/track';
import { t } from '@/text';

import { getPendingSetupIntent, clearPendingSetupIntent } from '@/sync/domains/pending/pendingSetupIntent';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { readConfiguredServerUrlEnv } from '@/sync/domains/server/readConfiguredServerUrlEnv';
import { isTauriDesktop } from '@/utils/platform/tauri';

import { shouldAutoRedirectToSetupOnFirstLaunch } from '@/utils/platform/firstLaunchSetupRedirectPolicy';
import { OnboardingWizardSurfacePresentation } from '@/components/onboarding/surfaces/OnboardingWizardSurface';
import { useOnboardingWizardController } from '@/components/onboarding/surfaces/useOnboardingWizardController';
import { UnauthenticatedSplitShell, useApplyBrandHeroSeen } from '@/components/onboarding/unauthShell';
import { DesktopShellUpdateIndicatorHost } from '@/components/navigation/shell/desktopChrome/DesktopShellUpdateIndicatorHost';
import { DesktopShellWindowControlsHost } from '@/components/navigation/shell/desktopChrome/DesktopShellWindowControlsHost';
import { useResolvedDesktopWindowControls } from '@/components/navigation/shell/desktopChrome/useResolvedDesktopWindowControls';
import { AppUpdateStatusTag } from '@/components/ui/feedback/AppUpdateStatusTag';
import { runtimeFetch } from '@/utils/system/runtimeFetch';
import { resolveAppShellChromeHost } from '@/components/appShell/resolveAppShellChromeHost';
import { setOnboardingWizardPreAuthResumeIntent, resolveWizardAuthReturnToRoute } from '@/components/onboarding/state/wizardResume';
import { getWizardStepDefinition } from '@/components/onboarding/state/wizardStepRegistry';
import type { WizardStepId } from '@/components/onboarding/state/wizardTypes';

export type PreAuthOnboardingWizardEntryProps = Readonly<{
    testID?: string;
    clearPendingSetupIntentOnMount?: boolean;
    enableFirstLaunchSetupRedirect?: boolean;
    initialStepId?: WizardStepId;
}>;

function resolveAuthReturnToRoute(): string {
    return resolveWizardAuthReturnToRoute();
}

function resolveUnauthShellRouteTestId(stepId: WizardStepId): string {
    if (stepId === 'auth_restore') return 'unauth-shell-route-restore';
    if (stepId === 'relay_select') return 'unauth-shell-route-setup-pre-auth';
    return 'unauth-shell-route-welcome';
}

export const PreAuthOnboardingWizardEntry = React.memo(function PreAuthOnboardingWizardEntry(props: PreAuthOnboardingWizardEntryProps) {
    const auth = useAuth();
    const router = useRouter();
    const isLandscape = useIsLandscape();
    const isDesktopShell = React.useMemo(() => isTauriDesktop(), []);
    const authEntryOptions = useAuthEntryOptions();
    const applyBrandHeroSeen = useApplyBrandHeroSeen();
    const autoRedirectAttemptedRef = React.useRef(false);
    const firstLaunchSetupRedirectedRef = React.useRef(false);
    const shellChromeHost = resolveAppShellChromeHost({
        isAuthenticated: false,
        isWeb: Platform.OS === 'web',
        isTauriDesktop: isDesktopShell,
        isTablet: false,
        isTerminalConnectRoute: false,
    });
    const resolvedDesktopWindowControls = useResolvedDesktopWindowControls({
        variant: 'expanded',
    });

    React.useEffect(() => {
        if (!props.clearPendingSetupIntentOnMount) {
            return;
        }
        clearPendingSetupIntent();
    }, [props.clearPendingSetupIntentOnMount]);

    React.useEffect(() => {
        if (!props.enableFirstLaunchSetupRedirect) {
            return;
        }
        if (firstLaunchSetupRedirectedRef.current) {
            return;
        }
        if (!shouldAutoRedirectToSetupOnFirstLaunch({ platformOs: Platform.OS, isDesktopTauri: isTauriDesktop() })) {
            return;
        }
        const pendingSetupIntent = getPendingSetupIntent();
        if (pendingSetupIntent) {
            return;
        }

        firstLaunchSetupRedirectedRef.current = true;
        const snapshot = getActiveServerSnapshot();
        const relayUrl = snapshot.serverUrl ? String(snapshot.serverUrl).trim().replace(/\/+$/, '') : null;
        setOnboardingWizardPreAuthResumeIntent(relayUrl || null);
    }, [props.enableFirstLaunchSetupRedirect]);

    const createAccount = React.useCallback(async () => {
        try {
            const secret = await getRandomBytesAsync(32);
            const token = await authGetToken(secret);
            if (token && secret) {
                await auth.login(token, encodeBase64(secret, 'base64url'));
                trackAccountCreated();
            }
        } catch (error) {
            const message = process.env.EXPO_PUBLIC_DEBUG
                ? formatOperationFailedDebugMessage(t('errors.operationFailed'), error)
                : t('errors.operationFailed');
            await Modal.alert(t('common.error'), message);
        }
    }, [auth]);

    const createAccountViaProvider = React.useCallback(async (providerId: string) => {
        try {
            const proofBytes = await getRandomBytesAsync(32);
            const proof = encodeBase64(proofBytes, 'base64url');
            const proofHashBytes = await digest('SHA-256', new TextEncoder().encode(proof));
            const proofHash = encodeHex(proofHashBytes).toLowerCase();

            const secretBytes = await getRandomBytesAsync(32);
            const secret = encodeBase64(secretBytes, 'base64url');
            const signingKeyPair = sodium.crypto_sign_seed_keypair(secretBytes);
            const publicKey = encodeBase64(signingKeyPair.publicKey);

            const snapshot = getActiveServerSnapshot();
            const serverUrl = snapshot.serverUrl ? String(snapshot.serverUrl).trim() : '';
            await TokenStorage.setPendingExternalAuth({
                provider: providerId,
                proof,
                secret,
                returnTo: resolveAuthReturnToRoute(),
                ...(serverUrl ? { serverUrl } : {}),
            });

            const provider = getAuthProvider(providerId);
            if (!provider) {
                await TokenStorage.clearPendingExternalAuth();
                await Modal.alert(t('common.error'), t('errors.operationFailed'));
                return;
            }

            const url = await provider.getExternalAuthUrl({ mode: 'keyed', proofHash, publicKey });
            if (!isSafeExternalAuthUrl(url)) {
                await TokenStorage.clearPendingExternalAuth();
                await Modal.alert(t('common.error'), t('errors.operationFailed'));
                return;
            }
            if (Platform.OS === 'web') {
                const location = typeof window !== 'undefined' ? window.location : null;
                if (location && typeof location.assign === 'function') {
                    location.assign(url);
                    return;
                }
                if (location && typeof location.href === 'string') {
                    location.href = url;
                    return;
                }
            }
            await Linking.openURL(url);
        } catch (error) {
            await TokenStorage.clearPendingExternalAuth();
            await Modal.alert(t('common.error'), t('errors.operationFailed'));
        }
    }, []);

    const loginWithKeylessProvider = React.useCallback(async (providerId: string) => {
        try {
            const proofBytes = await getRandomBytesAsync(32);
            const proof = encodeBase64(proofBytes, 'base64url');
            const proofHashBytes = await digest('SHA-256', new TextEncoder().encode(proof));
            const proofHash = encodeHex(proofHashBytes).toLowerCase();

            const snapshot = getActiveServerSnapshot();
            const serverUrl = snapshot.serverUrl ? String(snapshot.serverUrl).trim() : '';
            await TokenStorage.setPendingExternalAuth({
                provider: providerId,
                proof,
                returnTo: resolveAuthReturnToRoute(),
                ...(serverUrl ? { serverUrl } : {}),
            });

            const provider = getAuthProvider(providerId);
            if (!provider) {
                await TokenStorage.clearPendingExternalAuth();
                await Modal.alert(t('common.error'), t('errors.operationFailed'));
                return;
            }

            const url = await provider.getExternalAuthUrl({ mode: 'keyless', proofHash });
            if (!isSafeExternalAuthUrl(url)) {
                await TokenStorage.clearPendingExternalAuth();
                await Modal.alert(t('common.error'), t('errors.operationFailed'));
                return;
            }
            if (Platform.OS === 'web') {
                const location = typeof window !== 'undefined' ? window.location : null;
                if (location && typeof location.assign === 'function') {
                    location.assign(url);
                    return;
                }
                if (location && typeof location.href === 'string') {
                    location.href = url;
                    return;
                }
            }
            await Linking.openURL(url);
        } catch {
            await TokenStorage.clearPendingExternalAuth();
            await Modal.alert(t('common.error'), t('errors.operationFailed'));
        }
    }, []);

    const loginWithMtls = React.useCallback(async () => {
        try {
            const snapshot = getActiveServerSnapshot();
            const rawServerUrl = snapshot.serverUrl ? String(snapshot.serverUrl).trim() : '';
            const serverUrl = rawServerUrl.replace(/\/+$/, '') || readConfiguredServerUrlEnv().replace(/\/+$/, '');
            if (!serverUrl) {
                await Modal.alert(t('common.error'), t('errors.operationFailed'));
                return;
            }

            if (Platform.OS !== 'web') {
                const returnTo = `${resolveAppUrlScheme()}:///mtls`;
                const startUrl = `${serverUrl}/v1/auth/mtls/start?returnTo=${encodeURIComponent(returnTo)}`;
                await Linking.openURL(startUrl);
                return;
            }

            const controller = new AbortController();
            const timeoutMs = 15000;
            const timer = setTimeout(() => controller.abort(), timeoutMs);
            try {
                const res = await runtimeFetch(`${serverUrl}/v1/auth/mtls`, { method: 'POST', signal: controller.signal });
                const json = await res.json().catch(() => null);
                if (!res.ok || !json || typeof json.token !== 'string') {
                    await Modal.alert(t('common.error'), t('errors.operationFailed'));
                    return;
                }
                const token = String(json.token);
                const credentials = await buildDataKeyCredentialsForToken(token);
                await auth.loginWithCredentials(credentials);
            } finally {
                clearTimeout(timer);
            }
        } catch (error) {
            const message = process.env.EXPO_PUBLIC_DEBUG
                ? formatOperationFailedDebugMessage(t('errors.operationFailed'), error)
                : t('errors.operationFailed');
            await Modal.alert(t('common.error'), message);
        }
    }, [auth]);

    const changeRelayViaServerConfig = React.useCallback(() => {
        router.replace('/?happier_wizard_step=relay_select');
    }, [router]);

    React.useEffect(() => {
        const autoRedirect = authEntryOptions.autoRedirect;
        const providerId = autoRedirect.providerId;
        const nonMtlsProviderId =
            typeof providerId === 'string' && providerId.trim().length > 0
                ? providerId
                : null;
        if (!autoRedirect.enabled) {
            return;
        }
        if (autoRedirectAttemptedRef.current) {
            return;
        }
        if (authEntryOptions.showAnonymousSignup) {
            return;
        }
        if (!autoRedirect.toMtls && !autoRedirect.toKeyedProvision && !autoRedirect.toKeylessLogin && !autoRedirect.toLegacySignupProvider) {
            return;
        }
        if (!autoRedirect.toMtls && nonMtlsProviderId == null) {
            return;
        }

        autoRedirectAttemptedRef.current = true;
        fireAndForget((async () => {
            const suppressedUntil = await TokenStorage.getAuthAutoRedirectSuppressedUntil();
            if (Date.now() < suppressedUntil) return;
            if (autoRedirect.toMtls) {
                await loginWithMtls();
                return;
            }
            if (nonMtlsProviderId == null) {
                return;
            }
            if (autoRedirect.toKeylessLogin) {
                await loginWithKeylessProvider(nonMtlsProviderId);
                return;
            }
            await createAccountViaProvider(nonMtlsProviderId);
        })(), { tag: 'PreAuthOnboardingWizardEntry.autoRedirect' });
    }, [authEntryOptions, createAccountViaProvider, loginWithKeylessProvider, loginWithMtls]);

    const resolvedInitialStepId = React.useMemo((): WizardStepId | undefined => {
        if (props.initialStepId) {
            return props.initialStepId;
        }
        if (Platform.OS !== 'web') {
            return undefined;
        }
        if (!process.env.EXPO_PUBLIC_DEBUG) {
            return undefined;
        }

        const location =
            typeof window !== 'undefined'
                ? window.location
                : (globalThis as unknown as { location?: { search?: unknown } }).location;
        const search = typeof location?.search === 'string' ? location.search : '';
        const href = typeof (location as { href?: unknown } | null)?.href === 'string'
            ? String((location as { href?: unknown }).href)
            : '';
        const fallbackSearch = !search && href.includes('?') ? href.slice(href.indexOf('?')) : '';
        const query = search || fallbackSearch;
        if (!query) {
            return undefined;
        }
        const value = new URLSearchParams(query).get('happier_wizard_step');
        const candidate = typeof value === 'string' ? value.trim() : '';
        if (!candidate) {
            return undefined;
        }

        try {
            getWizardStepDefinition(candidate as WizardStepId);
            return candidate as WizardStepId;
        } catch {
            return undefined;
        }
    }, [props.initialStepId]);

    const shellChrome = shellChromeHost === 'unauth-shell' ? (
        <>
            <DesktopShellWindowControlsHost>
                {resolvedDesktopWindowControls}
            </DesktopShellWindowControlsHost>
            <DesktopShellUpdateIndicatorHost>
                <AppUpdateStatusTag testID="preauth-app-update-status-tag" />
            </DesktopShellUpdateIndicatorHost>
        </>
    ) : null;

    const wizardSurfaceProps = {
        testID: props.testID ?? 'onboarding-wizard',
        layout: isLandscape ? 'landscape' as const : 'portrait' as const,
        isDesktopShell,
        wizardChromeMode: 'bare' as const,
        wizardLayoutPresentation: isDesktopShell ? 'fullscreen' as const : undefined,
        authEntryOptions,
        shellChrome,
        initialStepId: resolvedInitialStepId,
        onCreateAccount: createAccount,
        onCreateAccountViaProvider: createAccountViaProvider,
        onLoginWithKeylessProvider: loginWithKeylessProvider,
        onLoginWithMtls: loginWithMtls,
        onChangeRelayViaServerConfig: changeRelayViaServerConfig,
    };

    const controller = useOnboardingWizardController(wizardSurfaceProps);

    return (
        <UnauthenticatedSplitShell
            stepId={controller.stepId}
            isWelcomeStep={controller.stepId === 'welcome'}
            allowMobileBrandHero={controller.stepId === 'welcome'}
            onOpenRelayCustomFlow={() => {
                controller.goToStep('relay_select');
            }}
            onBrandHeroGetStarted={applyBrandHeroSeen}
            onBack={controller.onBack ?? undefined}
            transitionDirection={controller.contentTransitionDirection}
            workflowPresentation={controller.stepId === 'scan_code' ? 'fullBleed' : 'padded'}
            testID={props.testID ?? resolveUnauthShellRouteTestId(controller.stepId)}
        >
            <OnboardingWizardSurfacePresentation
                {...wizardSurfaceProps}
                controller={controller}
            />
        </UnauthenticatedSplitShell>
    );
});
