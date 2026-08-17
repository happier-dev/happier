import React, { useCallback, useMemo } from 'react';
import { Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { Modal } from '@/modal';
import {
    presentFirstKeyCredentialLifecycle,
} from '@/components/account/presentFirstKeyCredentialLifecycle';
import { CommandPalette } from './CommandPalette';
import { useAuth } from '@/auth/context/AuthContext';
import { storage } from '@/sync/domains/state/storage';
import { useShallow } from 'zustand/react/shallow';
import { useNavigateToSession } from '@/hooks/session/useNavigateToSession';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import { useSegments } from 'expo-router';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { resolvePreferredServerIdForSessionId } from '@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId';
import { resetDesktopActivityOverlayPosition } from '@/activity/adapters/desktop/runtime/desktopActivityOverlayBridge';
import { requestCodexPetRefresh } from '@/components/settings/pets/petSettingsCommandEvents';
import {
    type CompactAppDestination,
    useCompactAppDestinations,
} from '@/components/appShell/destinations/compactAppDestinationCatalog';
import { usePluginAppPageCatalogActivationHandler } from '@/components/appShell/plugins/pluginAppPageNavigation';
import { useApplyLocalSettings, useApplySettings } from '@/sync/store/settingsWriters';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { isTauriDesktop } from '@/utils/platform/tauri';
import { buildCommandPaletteCommands, type PetCommandControls } from './buildCommandPaletteCommands';
import { KeyboardShortcutProvider, buildKeyboardShortcutLabels, resolveKeyboardPlatform, type KeyboardShortcutHandlers } from '@/keyboard';

function readActiveSessionIdFromSegments(segments: readonly string[]): string | null {
    // expo-router segments look like: ['(app)', 'session', '<id>', ...]
    const idx = segments.indexOf('session');
    if (idx < 0) return null;
    const candidate = String(segments[idx + 1] ?? '').trim();
    return candidate.length > 0 ? candidate : null;
}

const EMPTY_KEYBOARD_HANDLERS: KeyboardShortcutHandlers = {};
const EMPTY_ENABLED_WHEN_DISABLED_COMMAND_IDS: readonly [] = [];

export function CommandPaletteProvider({ children }: { children: React.ReactNode }) {
    if (Platform.OS !== 'web') {
        return (
            <KeyboardShortcutProvider
                handlers={EMPTY_KEYBOARD_HANDLERS}
                enabledWhenDisabledCommandIds={EMPTY_ENABLED_WHEN_DISABLED_COMMAND_IDS}
            >
                {children}
            </KeyboardShortcutProvider>
        );
    }

    return <WebCommandPaletteProvider>{children}</WebCommandPaletteProvider>;
}

function WebCommandPaletteProvider({ children }: { children: React.ReactNode }) {
    const router = useRouter();
    const { logout } = useAuth();
    const {
        commandPaletteEnabled,
        keyboardSingleKeyShortcutsEnabled,
        keyboardShortcutDisabledCommandIdsV1,
        keyboardShortcutOverridesV1,
    } = storage(useShallow((state) => ({
        commandPaletteEnabled: state.settings.commandPaletteEnabled,
        keyboardSingleKeyShortcutsEnabled: state.settings.keyboardSingleKeyShortcutsEnabled,
        keyboardShortcutDisabledCommandIdsV1: state.settings.keyboardShortcutDisabledCommandIdsV1,
        keyboardShortcutOverridesV1: state.settings.keyboardShortcutOverridesV1,
    })));
    const navigateToSession = useNavigateToSession();
    const segments = useSegments();
    const executionRunsEnabled = useFeatureEnabled('execution.runs');
    const voiceEnabled = useFeatureEnabled('voice');
    const memorySearchEnabled = useFeatureEnabled('memory.search');
    const petsCompanionEnabled = useFeatureEnabled('pets.companion');
    const browseExistingSessionsEnabled = useFeatureEnabled('sessions.direct');
    const compactAppDestinations = useCompactAppDestinations({ browseExistingSessionsEnabled });
    const activatePluginAppPage = usePluginAppPageCatalogActivationHandler();
    const activateCompactAppDestination = useCallback((destination: CompactAppDestination) => {
        if (
            destination.kind === 'plugin'
            && destination.container === 'appPage'
            && destination.availability === 'available'
        ) {
            activatePluginAppPage(destination);
            return;
        }
        // Unavailable pages retain the existing route-owned tombstone; all
        // other compact entries have no launch-input lifecycle to stage.
        router.push(destination.routePath as Parameters<typeof router.push>[0]);
    }, [activatePluginAppPage, router]);
    const applySettings = useApplySettings();
    const applyLocalSettings = useApplyLocalSettings();
    const keyboardPlatform = useMemo(resolveKeyboardPlatform, []);
    const labelHandlers = useMemo<KeyboardShortcutHandlers>(
        () => ({
            'session.new': () => undefined,
            'settings.open': () => undefined,
            ...(commandPaletteEnabled ? { 'commandPalette.open': () => undefined } : {}),
        }),
        [commandPaletteEnabled],
    );
    const shortcutLabels = useMemo(
        () => buildKeyboardShortcutLabels(keyboardPlatform, Platform.OS === 'web' ? 'web' : 'native', {
            disabledCommandIds: keyboardShortcutDisabledCommandIdsV1 ?? [],
            overrides: keyboardShortcutOverridesV1 ?? {},
            singleKeyShortcutsEnabled: keyboardSingleKeyShortcutsEnabled === true,
            handlers: labelHandlers,
            context: {
                isEditableTarget: false,
                isComposing: false,
            },
        }),
        [
            keyboardPlatform,
            keyboardShortcutDisabledCommandIdsV1,
            keyboardShortcutOverridesV1,
            keyboardSingleKeyShortcutsEnabled,
            labelHandlers,
        ],
    );
    const actionExecutor = useMemo(
        () => createDefaultActionExecutor({
            resolveServerIdForSessionId: (sessionId) => resolvePreferredServerIdForSessionId(sessionId) ?? null,
            openSession: (sessionId, options) => {
                router.push(buildScopedSessionRouteHref({
                    sessionId,
                    serverId: options?.serverId,
                }) as any);
            },
        }),
        [router],
    );
    const petControls = useMemo<PetCommandControls>(() => {
        const desktop = isTauriDesktop();
        const surface = desktop ? 'desktopOverlay' : Platform.OS === 'web' ? 'appShell' : 'none';
        return {
            surface,
            wake: () => {
                applySettings({ petsEnabled: true });
                applyLocalSettings(desktop
                    ? {
                        petsEnabledOverride: 'enabled',
                        desktopPetOverlayEnabledOverride: 'enabled',
                        desktopOverlayEnabled: true,
                        desktopOverlayVisibilityMode: 'always_when_enabled',
                    }
                    : { petsEnabledOverride: 'enabled' });
            },
            tuck: () => {
                applyLocalSettings(desktop
                    ? {
                        desktopPetOverlayEnabledOverride: 'disabled',
                        desktopOverlayEnabled: false,
                    }
                    : { petsEnabledOverride: 'disabled' });
            },
            resetPosition: desktop
                ? () => {
                    applyLocalSettings({
                        desktopOverlayPlacementMode: 'anchored',
                        desktopOverlayAnchor: 'top_center',
                        desktopOverlayOffsetX: 0,
                        desktopOverlayOffsetY: 0,
                    });
                    fireAndForget(resetDesktopActivityOverlayPosition(), {
                        tag: 'CommandPaletteProvider.resetDesktopActivityOverlayPosition',
                    });
                }
                : undefined,
            refreshCodexPets: () => {
                router.push('/settings/pets' as any);
                requestCodexPetRefresh();
            },
        };
    }, [applyLocalSettings, applySettings, router]);

    const buildCommands = useCallback(() => {
        const activeSessionId = readActiveSessionIdFromSegments(segments);

        return buildCommandPaletteCommands({
            sessionsById: storage.getState().sessions,
            isDev: __DEV__ === true,
            activeSessionId,
            features: { executionRunsEnabled, voiceEnabled, memorySearchEnabled, petsCompanionEnabled },
            shortcutLabels,
            petControls,
            compactAppDestinations,
            onActivateCompactAppDestination: activateCompactAppDestination,
            nav: {
                push: (path) => router.push(path as any),
                navigateToSession,
            },
            auth: {
                logout: async () => {
                    await presentFirstKeyCredentialLifecycle({
                        run: logout,
                    });
                },
            },
            actions: {
                execute: (actionId, parameters, ctx) => actionExecutor.execute(actionId as any, parameters, ctx),
            },
            alert: async (title, message) => {
                await Modal.alertAsync(title, message);
            },
        });
    }, [segments, executionRunsEnabled, voiceEnabled, memorySearchEnabled, petsCompanionEnabled, compactAppDestinations, activateCompactAppDestination, shortcutLabels, petControls, router, navigateToSession, logout, actionExecutor]);

    const showCommandPalette = useCallback(() => {
        if (Platform.OS !== 'web' || !commandPaletteEnabled) return;

        Modal.show({
            component: CommandPalette,
            props: {
                commands: buildCommands(),
            }
        });
    }, [buildCommands, commandPaletteEnabled]);

    const keyboardHandlers = useMemo<KeyboardShortcutHandlers>(
        () => ({
            ...(commandPaletteEnabled ? { 'commandPalette.open': showCommandPalette } : {}),
            'session.new': () => {
                router.push('/new' as any);
            },
            'settings.open': () => {
                router.push('/settings' as any);
            },
        }),
        [commandPaletteEnabled, router, showCommandPalette],
    );
    const keyboardEnabledWhenDisabledCommandIds = useMemo(
        () => commandPaletteEnabled ? ['commandPalette.open'] as const : [],
        [commandPaletteEnabled],
    );
    return (
        <KeyboardShortcutProvider
            handlers={keyboardHandlers}
            enabledWhenDisabledCommandIds={keyboardEnabledWhenDisabledCommandIds}
        >
            {children}
        </KeyboardShortcutProvider>
    );
}
