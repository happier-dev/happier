import React, { useCallback, useMemo } from 'react';
import { Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol';
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
import {
    useAppShellPluginUiProjection,
} from '@/components/appShell/plugins/AppShellPluginUiProjection';
import {
    createPluginUiProjectedActionResolver,
    normalizePluginUiProjection,
} from '@/sync/domains/plugins/ui/projection';
import { readPluginUiContributionOrigin } from '@/sync/domains/plugins/ui/projectionUnion';
import {
    createPluginContributedActionController,
    type PluginContributedActionCurrentSnapshot,
} from '@/components/plugins/actions/pluginContributedActionController';
import {
    usePluginUiClientExecutableRegistrationRevision,
} from '@/components/plugins/reactNative/clientExecutableContributions';
import { usePluginAppPageCatalogActivationHandler } from '@/components/appShell/plugins/pluginAppPageNavigation';
import { useSessionMachineControlTarget } from '@/components/sessions/model/useSessionMachineTarget';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { useApplyLocalSettings, useApplySettings } from '@/sync/store/settingsWriters';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { isDesktopHost } from '@/utils/platform/desktopHost';
import { buildCommandPaletteCommands, type PetCommandControls } from './buildCommandPaletteCommands';
import { KeyboardShortcutProvider, buildKeyboardShortcutLabels, resolveKeyboardPlatform, type KeyboardShortcutHandlers } from '@/keyboard';
import { useOptionalCurrentUiContextReader } from '@/components/appShell/currentUiContext/CurrentUiContextProvider';

function readActiveSessionIdFromSegments(segments: readonly string[]): string | null {
    // expo-router segments look like: ['(app)', 'session', '<id>', ...]
    const idx = segments.indexOf('session');
    if (idx < 0) return null;
    const candidate = String(segments[idx + 1] ?? '').trim();
    return candidate.length > 0 ? candidate : null;
}

const EMPTY_KEYBOARD_HANDLERS: KeyboardShortcutHandlers = {};
const EMPTY_ENABLED_WHEN_DISABLED_COMMAND_IDS: readonly [] = [];

/**
 * The root palette has an exact machine only when either the current Session
 * supplies one or the app scope has a single eligible machine. A Session route
 * never falls back to an unrelated app-scoped machine; doing so would turn a
 * contextual Action into a second execution target selector.
 */
function useCommandPalettePluginActionPresentation(activeSessionId: string | null) {
    const appShellProjection = useAppShellPluginUiProjection();
    const currentUiContextReader = useOptionalCurrentUiContextReader();
    const clientExecutableRegistrationRevision = usePluginUiClientExecutableRegistrationRevision();
    const sessionMachineTarget = useSessionMachineControlTarget(activeSessionId ?? '');
    const scope = activeSessionId ? 'session' as const : 'global' as const;
    const machineId = activeSessionId
        ? sessionMachineTarget?.machineId ?? null
        : appShellProjection.machineId;
    const serverId = activeSessionId
        ? resolvePreferredServerIdForSessionId(activeSessionId) ?? null
        : appShellProjection.serverId;
    const projection = useDaemonMergedProjectionInputs({
        machineId,
        serverId,
        enabled: machineId !== null,
        staleMs: 60_000,
    });
    const accountLifetime = captureActiveServerAccountScopeLifetime();
    const appShellProjectionRef = React.useRef(appShellProjection);
    appShellProjectionRef.current = appShellProjection;
    const snapshotRef = React.useRef<PluginContributedActionCurrentSnapshot | null>(null);
    // This scope follows authority identity, not catalog metadata. The shared
    // controller re-resolves metadata/availability at open time, while a
    // target, Account, or generation transition retires any live form/action.
    const actionScope = React.useMemo(() => new AbortController(), [
        activeSessionId,
        accountLifetime,
        machineId,
        projection.inputs?.pluginProjectionV2?.generation,
        projection.phase,
        serverId,
    ]);
    React.useEffect(() => () => actionScope.abort(), [actionScope]);
    const snapshot = React.useMemo<PluginContributedActionCurrentSnapshot | null>(() => {
        const inputs = projection.inputs;
        const generation = inputs?.pluginProjectionV2?.generation;
        if (
            machineId === null
            || projection.phase !== 'ready'
            || !inputs
            || generation === null
            || generation === undefined
        ) {
            return null;
        }
        let current!: PluginContributedActionCurrentSnapshot;
        current = {
            pluginProjectionById: inputs.pluginProjectionById,
            pluginUiProjection: normalizePluginUiProjection(inputs.pluginProjectionV2 ?? null),
            resolveContributedAction: createPluginUiProjectedActionResolver(
                inputs.pluginProjectionV2?.actionsById,
            ),
            host: {
                machineId,
                serverId,
                expectedGeneration: generation,
                ...(activeSessionId ? { sessionId: activeSessionId } : {}),
                signal: actionScope.signal,
                accountLifetime,
                ...(currentUiContextReader
                    ? { readCurrentUiContext: currentUiContextReader.readCurrentUiContext }
                    : {}),
                isCurrent: () => (
                    snapshotRef.current === current
                    && actionScope.signal.aborted === false
                    && accountLifetime?.isCurrent() !== false
                ),
                // The app palette consumes an Action only from its selected
                // app-scope origin. A Session palette already has its exact
                // Session machine/currentness owner and must not acquire a
                // second app-scope selection gate.
                ...(activeSessionId ? {} : {
                    isActionCurrent: (identity: Readonly<{ pluginId: string; localId: string }>) => {
                        const projectedAction = appShellProjectionRef.current.pluginUiProjection?.actionsById[
                            buildQualifiedPluginContributionKey(identity)
                        ];
                        const origin = readPluginUiContributionOrigin(projectedAction);
                        return origin?.machineId === machineId
                            && origin.serverId === serverId
                            && origin.generation !== null
                            && String(origin.generation) === String(generation)
                            && origin.interactionEnabled === true
                            && origin.phase === 'current'
                            && origin.executionOrigin?.materializationRef.pluginId === identity.pluginId
                            && origin.executionOrigin.materializationRef.machineId === machineId;
                    },
                }),
            },
        };
        return current;
    }, [
        accountLifetime,
        actionScope,
        activeSessionId,
        currentUiContextReader,
        machineId,
        projection.inputs,
        projection.phase,
        serverId,
    ]);
    snapshotRef.current = snapshot;
    const controller = React.useMemo(() => createPluginContributedActionController({
        resolveCurrent: () => snapshotRef.current,
    }), [clientExecutableRegistrationRevision]);

    return React.useMemo(() => (
        snapshot
            ? { controller, scope, signal: actionScope.signal }
            : undefined
    ), [actionScope.signal, controller, scope, snapshot]);
}

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
    const activeSessionId = useMemo(() => readActiveSessionIdFromSegments(segments), [segments]);
    const pluginActionPresentation = useCommandPalettePluginActionPresentation(activeSessionId);
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
        const desktop = isDesktopHost();
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
        return buildCommandPaletteCommands({
            sessionsById: storage.getState().sessions,
            isDev: __DEV__ === true,
            activeSessionId,
            features: { executionRunsEnabled, voiceEnabled, memorySearchEnabled, petsCompanionEnabled },
            shortcutLabels,
            petControls,
            ...(pluginActionPresentation ? { pluginActionPresentation } : {}),
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
    }, [activeSessionId, executionRunsEnabled, voiceEnabled, memorySearchEnabled, petsCompanionEnabled, compactAppDestinations, activateCompactAppDestination, shortcutLabels, petControls, pluginActionPresentation, router, navigateToSession, logout, actionExecutor]);

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
