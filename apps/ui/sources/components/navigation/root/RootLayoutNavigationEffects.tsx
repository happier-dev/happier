import { router, useGlobalSearchParams, usePathname, useSegments } from 'expo-router';
import * as React from 'react';
import { Platform, View } from 'react-native';
import { useAuth } from '@/auth/context/AuthContext';
import { getActiveServerUrl, getTabActiveServerId } from '@/sync/domains/server/serverProfiles';
import { normalizeServerUrl, upsertActivateAndSwitchServer } from '@/sync/domains/server/activeServerSwitch';
import { getPendingTerminalConnect } from '@/sync/domains/pending/pendingTerminalConnect';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { Text } from '@/components/ui/text/Text';
import {
    bootstrapActiveServerFromWebLocation,
    commitWebServerUrlOverride,
    readWebServerUrlOverrideFromLocation,
} from '@/sync/domains/server/url/bootstrapActiveServerFromWebLocation';
import { buildTerminalConnectWebHref } from '@/utils/path/terminalConnectUrl';
import { useWebInitialRouteReconcile } from '@/hooks/ui/useWebInitialRouteReconcile';
import { useHappierVoiceSupport } from '@/hooks/server/useHappierVoiceSupport';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import { useNotificationResponseRouting } from '@/activity/notifications/runtime/useNotificationResponseRouting';
import { Modal } from '@/modal';
import { t } from '@/text';

const bootstrappedWebServerOverride = bootstrapActiveServerFromWebLocation({ scope: 'device' });

function pickFirstRouteParamString(value: string | string[] | undefined): string {
    if (Array.isArray(value)) return String(value[0] ?? '').trim();
    return String(value ?? '').trim();
}

function readLegacySessionIdFromWebLocation(): Readonly<{
    sessionId: string;
    serverId: string | null;
    messageId: string | null;
    jumpChildId: string | null;
    cleanedRelativeUrl: string;
}> | null {
    if (typeof window === 'undefined') return null;
    if (typeof window.location?.href !== 'string') return null;

    try {
        const current = new URL(window.location.href);
        // Legacy deep-link format: `/?id=<sessionId>` (no longer generated, but may be in old links or buggy flows).
        if (current.pathname !== '/') return null;

        const rawSessionId = (current.searchParams.get('id') ?? '').trim();
        if (!rawSessionId) return null;

        const rawServerId = (current.searchParams.get('serverId') ?? '').trim();
        const rawMessageId = (current.searchParams.get('messageId') ?? '').trim();
        const rawJumpChildId = (current.searchParams.get('jumpChildId') ?? '').trim();

        current.searchParams.delete('id');
        const search = current.searchParams.toString();
        const cleanedRelativeUrl = `${current.pathname}${search ? `?${search}` : ''}${current.hash ?? ''}`;
        return {
            sessionId: rawSessionId,
            serverId: rawServerId || null,
            messageId: rawMessageId || null,
            jumpChildId: rawJumpChildId || null,
            cleanedRelativeUrl,
        };
    } catch {
        return null;
    }
}

/**
 * Owns every navigation/auth-driven side effect from the app root layout.
 *
 * It subscribes to `usePathname()` / `useSegments()` / `useGlobalSearchParams()` and re-renders on
 * each navigation, but it renders nothing (or only the web-only, invisible debug pathname readout),
 * so its re-renders are cheap and never touch the Stack subtree. Mounted as a sibling of the shell.
 */
export function RootLayoutNavigationEffects(): React.ReactElement | null {
    const auth = useAuth();
    const segments = useSegments();
    const pathname = usePathname();
    const globalSearchParams = useGlobalSearchParams<{
        server?: string | string[];
        serverId?: string | string[];
        url?: string | string[];
        auto?: string | string[];
    }>();
    const debugRouterEnabled = process.env.EXPO_PUBLIC_DEBUG === '1';
    const happierVoiceSupported = useHappierVoiceSupport();

    useWebInitialRouteReconcile({ routerPathname: pathname });

    const bootstrappedWebServerOverrideHandledRef = React.useRef(false);
    const webServerOverrideCommitInFlightRef = React.useRef(false);
    const serverOverrideParamSignal = React.useMemo(() => [
        pickFirstRouteParamString(globalSearchParams.server),
        pickFirstRouteParamString(globalSearchParams.serverId),
        pickFirstRouteParamString(globalSearchParams.url),
        pickFirstRouteParamString(globalSearchParams.auto),
    ].join('\u0000'), [
        globalSearchParams.auto,
        globalSearchParams.server,
        globalSearchParams.serverId,
        globalSearchParams.url,
    ]);
    React.useEffect(() => {
        const liveOverride = readWebServerUrlOverrideFromLocation();
        const shouldUseBootstrappedOverride =
            !liveOverride
            && !bootstrappedWebServerOverrideHandledRef.current
            && bootstrappedWebServerOverride;
        const override = liveOverride ?? (shouldUseBootstrappedOverride ? bootstrappedWebServerOverride : null);
        if (!override) return;
        if (webServerOverrideCommitInFlightRef.current) return;
        webServerOverrideCommitInFlightRef.current = true;
        fireAndForget((async () => {
            try {
                while (true) {
                    try {
                        await commitWebServerUrlOverride({
                            override,
                            refreshAuth: auth.refreshFromActiveServer,
                        });
                        bootstrappedWebServerOverrideHandledRef.current = true;
                        return;
                    } catch (error) {
                        const shouldRetry = await Modal.confirm(
                            t('common.error'),
                            error instanceof Error ? error.message : t('common.requestFailed'),
                            {
                                cancelText: t('common.cancel'),
                                confirmText: t('common.retry'),
                            },
                        );
                        if (!shouldRetry) return;
                    }
                }
            } finally {
                webServerOverrideCommitInFlightRef.current = false;
            }
        })(), { tag: 'RootLayout.webServerOverride' });
    }, [auth, pathname, serverOverrideParamSignal]);

    const legacySessionDeepLinkHandledRef = React.useRef(false);
    React.useEffect(() => {
        if (legacySessionDeepLinkHandledRef.current) return;
        if (!auth.isAuthenticated) return;

        const legacy = readLegacySessionIdFromWebLocation();
        if (!legacy) return;
        legacySessionDeepLinkHandledRef.current = true;

        try {
            window.history.replaceState(null, '', legacy.cleanedRelativeUrl);
        } catch {
            // ignore
        }

        const suffix = legacy.messageId ? `/message/${encodeURIComponent(legacy.messageId)}` : '';
        router.replace(buildScopedSessionRouteHref({
            sessionId: legacy.sessionId,
            serverId: legacy.serverId,
            suffix,
            query: {
                jumpChildId: legacy.jumpChildId,
            },
        }));
    }, [auth.isAuthenticated]);

    const pendingTerminalHandledRef = React.useRef(false);
    useNotificationResponseRouting({
        enabled: auth.isAuthenticated,
        refreshAuth: auth.refreshFromActiveServer,
    });

    React.useEffect(() => {
        if (!auth.isAuthenticated) {
            pendingTerminalHandledRef.current = false;
            return;
        }

        const pendingTerminalConnect = getPendingTerminalConnect();
        if (pendingTerminalConnect) {
            if (pendingTerminalHandledRef.current) return;
            // Avoid leaking the terminal connect key via query params; use hash params on the dedicated
            // `/terminal/connect` route instead.
            const route = buildTerminalConnectWebHref({
                publicKeyB64Url: pendingTerminalConnect.publicKeyB64Url,
                serverUrl: pendingTerminalConnect.serverUrl,
                pairing: pendingTerminalConnect.pairing,
            });

            // If we are already on the terminal-connect page (which persists a pending connect while
            // clearing the URL hash for safety), do not navigate away.
            if (segments.includes('terminal') && segments.includes('connect')) return;

            const target = normalizeServerUrl(pendingTerminalConnect.serverUrl);
            const active = normalizeServerUrl(getActiveServerUrl());
            if (target && (target !== active || getTabActiveServerId())) {
                pendingTerminalHandledRef.current = true;
                fireAndForget((async () => {
                    try {
                        await upsertActivateAndSwitchServer({
                            serverUrl: pendingTerminalConnect.serverUrl,
                            source: 'url',
                            scope: 'device',
                            refreshAuth: auth.refreshFromActiveServer,
                        });
                    } catch {
                        // keep navigation best-effort; terminal flow can still recover with explicit server param
                    }
                    router.push(route);
                })(), { tag: 'RootLayout.pendingTerminalConnect' });
                return;
            }

            pendingTerminalHandledRef.current = true;
            router.push(route);
            return;
        }

        pendingTerminalHandledRef.current = false;
    }, [auth.isAuthenticated]);

    // Server capability gating: if the server doesn't support Happier Voice (misconfigured/disabled),
    // default the user's voice mode to off (they can still choose BYO ElevenLabs in settings).
    React.useEffect(() => {
        if (!auth.isAuthenticated) return;
        if (happierVoiceSupported !== false) return;
        let cancelled = false;
        fireAndForget((async () => {
            try {
                // Defer loading sync/storage modules until needed to keep module evaluation light.
                const [{ storage }, { applySystemSettings }] = await Promise.all([
                    import('@/sync/domains/state/storage'),
                    import('@/sync/store/settingsWriters'),
                ]);

                if (cancelled) return;
                const voice = (storage.getState().settings as any)?.voice ?? null;
                const providerId = voice?.providerId ?? 'off';
                const billingMode = voice?.adapters?.realtime_elevenlabs?.billingMode ?? 'happier';
                if (providerId !== 'realtime_elevenlabs') return;
                if (billingMode !== 'happier') return;
                applySystemSettings({ voice: { ...voice, providerId: 'off' } });
            } catch {
                // Non-fatal: feature gating should never crash the root layout.
            }
        })(), { tag: 'RootLayout.happierVoiceGate' });
        return () => {
            cancelled = true;
        };
    }, [auth.isAuthenticated, happierVoiceSupported]);

    if (debugRouterEnabled && Platform.OS === 'web') {
        return (
            <View
                testID="debug-router-pathname"
                style={{ position: 'absolute', top: 0, left: 0, opacity: 0, pointerEvents: 'none' }}
            >
                <Text>{pathname}</Text>
            </View>
        );
    }
    return null;
}
