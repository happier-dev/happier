import React, { useCallback, useMemo } from 'react';
import { useToggleThemeMode } from '@/components/settings/appearance/useApplyThemeSelection';
import { Platform } from 'react-native';
import { useGlobalSearchParams, useSegments } from 'expo-router';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { Modal } from '@/modal';
import { COMMAND_SURFACE_WEB_PLACEMENT } from '@/modal/components/card/commandSurfaceCard';
import { UniversalSearchModal, type UniversalSearchModalProps } from '@/components/appShell/search/UniversalSearchModal';
import {
    UniversalSearchRuntimeProvider,
    resolveUniversalSearchInvocationScope,
    type UniversalSearchRuntime,
    type UniversalSearchOpenOptions,
    type UniversalSearchScopeSeed,
} from '@/components/appShell/search/UniversalSearchRuntimeContext';
import { storage } from '@/sync/domains/state/storage';
import { useShallow } from 'zustand/react/shallow';
import { useNavigateToSession } from '@/hooks/session/useNavigateToSession';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { resolvePreferredServerIdForSessionId } from '@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId';
import { resetDesktopActivityOverlayPosition } from '@/activity/adapters/desktop/runtime/desktopActivityOverlayBridge';
import { requestCodexPetRefresh } from '@/components/settings/pets/petSettingsCommandEvents';
import {
    SEARCH_DESTINATION_ID,
    useActivateAppDestination,
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
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import {
    createPluginContributedActionController,
    type PluginContributedActionCurrentSnapshot,
} from '@/components/plugins/actions/pluginContributedActionController';
import {
    usePluginUiClientExecutableRegistrationRevision,
} from '@/components/plugins/reactNative/clientExecutableContributions';
import { useSessionMachineControlTarget } from '@/components/sessions/model/useSessionMachineTarget';
import { readMachineControlTargetForSession } from '@/sync/ops/sessionMachineTarget';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { useApplyLocalSettings, useApplySettings } from '@/sync/store/settingsWriters';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { isDesktopHost } from '@/utils/platform/desktopHost';
import { buildCommandPaletteCommands, type PetCommandControls } from './buildCommandPaletteCommands';
import { useWorkflowsAvailability } from '@/components/workflows/gating/workflowsAvailability';
import { useWorkflowAgentAuthoring } from '@/components/workflows/authoring/useWorkflowAgentAuthoring';
import { buildWorkflowAgentAuthoringSeed } from '@/sync/domains/workflows/workflowAgentAuthoringSeed';
import { registerCommandPaletteActionCatalog } from './commandPaletteActionRuntime';
import { KeyboardShortcutProvider, buildKeyboardShortcutLabels, resolveKeyboardPlatform, type KeyboardShortcutHandlers } from '@/keyboard';
import { useOptionalCurrentUiContextReader } from '@/components/appShell/currentUiContext/CurrentUiContextProvider';
import { usePluginSurfaceDestinationNavigationBinding } from '@/components/plugins/surfaces/pluginSurfaceDestinationNavigation';
import { normalizeSessionId } from '@/sync/domains/session/normalizeSessionId';
import { projectParameterFreeRoute } from '@/track/parameterFreeRouteProjection';
import { useResolveNewSessionOrdinaryEntryRoute } from '@/components/sessions/new/navigation/newSessionOrdinaryEntryRoute';
import { UNIVERSAL_SEARCH_ROUTE } from '@/components/appShell/search/universalSearchRoutePresentation';
import { parseSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';
import { TERMINAL_JUMP_ROUTE_PARAM } from '@/components/sessions/terminal/jump/terminalJumpTarget';
import { NextPendingNavigationHost } from '@/components/sessions/pendingNavigation/NextPendingNavigationHost';

export function readActiveSessionIdFromRoute(
    segments: readonly string[],
    routeId: string | readonly string[] | undefined,
): string | null {
    const route = projectParameterFreeRoute(segments);
    if (route.segments[0] !== 'session' || route.segments[1] !== ':id') return null;
    const sessionId = normalizeSessionId(routeId);
    if (!sessionId || projectParameterFreeRoute([sessionId]).segments[0] === ':id') return null;
    return sessionId;
}

/**
 * The root palette has an exact machine only when either the current Session
 * supplies one or the app scope has a single eligible machine. A Session route
 * never falls back to an unrelated app-scoped machine; doing so would turn a
 * contextual Action into a second execution target selector.
 */
function useCommandPalettePluginActionPresentation(activeSessionId: string | null) {
    const appShellProjection = useAppShellPluginUiProjection();
    const currentUiContextReader = useOptionalCurrentUiContextReader();
    const destinationNavigation = usePluginSurfaceDestinationNavigationBinding();
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
                ...(activeSessionId ? { sessionId: activeSessionId } : {}),
                signal: actionScope.signal,
                accountLifetime,
                ...(destinationNavigation ? { openSurface: destinationNavigation.openSurface } : {}),
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
        destinationNavigation,
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
    return <WebCommandPaletteProvider>{children}</WebCommandPaletteProvider>;
}

function WebCommandPaletteProvider({ children }: { children: React.ReactNode }) {
    const router = useRouter();
    const resolveNewSessionOrdinaryEntryRoute = useResolveNewSessionOrdinaryEntryRoute();
    // Sessions are read when commands are built (`buildCommands`) and followed only while the palette
    // is open (below). This provider is always mounted around the whole app shell: subscribing it to
    // every session update re-created its runtime context on each one and re-rendered every consumer.
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
    const routeParams = useGlobalSearchParams<{
        id?: string | string[];
        sessionId?: string | string[];
        serverId?: string | string[];
    }>();
    const activeSessionId = useMemo(
        () => readActiveSessionIdFromRoute(segments, routeParams.id),
        [routeParams.id, segments],
    );
    const universalSearchRouteActive = useMemo(
        () => projectParameterFreeRoute(segments).segments[0] === 'search',
        [segments],
    );
    const commandContextSessionId = universalSearchRouteActive
        ? normalizeSessionId(routeParams.sessionId)
        : activeSessionId;
    const commandContextServerId = normalizeSessionId(routeParams.serverId);
    const universalSearchRouteOpenRequestedRef = React.useRef(universalSearchRouteActive);
    React.useEffect(() => {
        if (!universalSearchRouteActive) {
            universalSearchRouteOpenRequestedRef.current = false;
        }
    }, [universalSearchRouteActive]);
    const pluginActionPresentation = useCommandPalettePluginActionPresentation(commandContextSessionId);
    const executionRunsEnabled = useFeatureEnabled('execution.runs');
    const voiceEnabled = useFeatureEnabled('voice');
    const petsCompanionEnabled = useFeatureEnabled('pets.companion');
    const { available: workflowsEnabled } = useWorkflowsAvailability();
    const openWorkflowAgentDraft = useWorkflowAgentAuthoring();
    const openNewWorkflow = useCallback(() => { router.push('/workflows/new' as never); }, [router]);
    const openWorkflowAgentAuthoring = useCallback(() => {
        openWorkflowAgentDraft(buildWorkflowAgentAuthoringSeed({ kind: 'create' }));
    }, [openWorkflowAgentDraft]);
    const compactAppDestinations = useCompactAppDestinations();
    // Search is this palette's own runtime, so it is not listed as a command inside it.
    const paletteDestinations = useMemo(
        () => compactAppDestinations.filter((destination) => destination.id !== SEARCH_DESTINATION_ID),
        [compactAppDestinations],
    );
    const activateCompactAppDestination = useActivateAppDestination();
    const applySettings = useApplySettings();
    const applyLocalSettings = useApplyLocalSettings();
    const keyboardPlatform = useMemo(resolveKeyboardPlatform, []);
    const labelHandlers = useMemo<KeyboardShortcutHandlers>(
        () => ({
            'session.new': () => undefined,
            ...(workflowsEnabled ? { 'workflow.new': () => undefined, 'workflow.createWithAgent': () => undefined } : {}),
            'settings.open': () => undefined,
            'search.textInFiles': () => undefined,
            ...(commandPaletteEnabled ? { 'commandPalette.open': () => undefined } : {}),
        }),
        [commandPaletteEnabled, workflowsEnabled],
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

    const openNewSession = useCallback(() => {
        const { draftId, draftOrigin } = resolveNewSessionOrdinaryEntryRoute();
        router.push({ pathname: '/new', params: { draftId, draftOrigin } });
    }, [resolveNewSessionOrdinaryEntryRoute, router]);

    const textSearchOpener = React.useRef<(scope?: UniversalSearchScopeSeed) => void>(() => undefined);
    const buildCommands = useCallback((requestedActiveSessionId: string | null = commandContextSessionId, requestedScope?: UniversalSearchScopeSeed) => {
        // The contributed Action presentation is captured for the rendered
        // route's exact Session. An imperative opener may target another Home
        // or Session, so never attach the ambient Session's Actions to that
        // command inventory. The Search provider catalog still supplies
        // exact-target plugin entities for the requested scope.
        const ambientSession = requestedActiveSessionId
            ? (storage.getState().sessions as Record<string, { serverId?: string; accountId?: string } | undefined>)[requestedActiveSessionId]
            : null;
        const exactSessionContext = requestedScope && requestedActiveSessionId
            ? resolveServerProfileScopeIdForIdentifier(ambientSession?.serverId ?? null)
                === resolveServerProfileScopeIdForIdentifier(requestedScope.serverId)
                && (requestedScope.accountId === null || ambientSession?.accountId === requestedScope.accountId)
            : requestedActiveSessionId === commandContextSessionId;
        const scopedPluginActionPresentation = exactSessionContext
            ? pluginActionPresentation
            : null;
        return buildCommandPaletteCommands({
            sessionsById: storage.getState().sessions,
            isDev: __DEV__ === true,
            activeSessionId: requestedActiveSessionId,
            activeSessionServerId: requestedScope?.serverId
                ?? (requestedActiveSessionId === commandContextSessionId ? commandContextServerId : null),
            features: { executionRunsEnabled, voiceEnabled, petsCompanionEnabled, workflowsEnabled },
            shortcutLabels,
            petControls,
            ...(scopedPluginActionPresentation ? { pluginActionPresentation: scopedPluginActionPresentation } : {}),
            compactAppDestinations: paletteDestinations,
            onActivateCompactAppDestination: activateCompactAppDestination,
            nav: {
                push: (path) => router.push(path as any),
                openNewSession,
                openNewWorkflow,
                openWorkflowAgentAuthoring,
                openTextInFiles: () => textSearchOpener.current(requestedScope),
                openHomePairingModal: async () => {
                    const { showHomePairingModal } = await import('@/components/auth/pairing/HomePairingModal');
                    showHomePairingModal('phone');
                },
                navigateToSession,
            },
            actions: {
                execute: (actionId, parameters, ctx) => actionExecutor.execute(actionId as any, parameters, ctx),
            },
            alert: async (title, message) => {
                await Modal.alertAsync(title, message);
            },
        });
    }, [commandContextSessionId, commandContextServerId, executionRunsEnabled, voiceEnabled, petsCompanionEnabled, workflowsEnabled, paletteDestinations, activateCompactAppDestination, shortcutLabels, petControls, pluginActionPresentation, router, openNewSession, openNewWorkflow, openWorkflowAgentAuthoring, navigateToSession, actionExecutor]);

    const actionCommandBuilder = React.useRef(buildCommands);
    actionCommandBuilder.current = buildCommands;
    React.useEffect(() => registerCommandPaletteActionCatalog(() => actionCommandBuilder.current()), []);

    const openUniversalSearchModalRef = React.useRef<Readonly<{
        id: string;
        activeSessionId: string | null;
        scope: UniversalSearchScopeSeed;
    }> | null>(null);
    const [paletteOpen, setPaletteOpen] = React.useState(false);
    const refreshOpenPaletteCommands = React.useCallback(() => {
        const openModal = openUniversalSearchModalRef.current;
        if (!openModal) return;
        Modal.update<UniversalSearchModalProps>(openModal.id, {
            commands: buildCommands(openModal.activeSessionId, openModal.scope),
        });
    }, [buildCommands]);
    React.useEffect(() => {
        refreshOpenPaletteCommands();
    }, [refreshOpenPaletteCommands]);
    // The open palette lists sessions, so it follows them while open, and only while open.
    React.useEffect(() => {
        if (!paletteOpen) return;
        let sessions = storage.getState().sessions;
        return storage.subscribe((state) => {
            if (state.sessions === sessions) return;
            sessions = state.sessions;
            refreshOpenPaletteCommands();
        });
    }, [paletteOpen, refreshOpenPaletteCommands]);

    const showCommandPalette = useCallback((initialQuery?: string, requestedScope?: UniversalSearchScopeSeed, options?: UniversalSearchOpenOptions) => {
        const activeAccountScope = captureActiveServerAccountScopeLifetime()?.scope;
        // A Jump is about the session it was opened from, which need not be the route's session (a
        // split workspace shows several); its pane scope names that session exactly.
        const terminalSession = options?.terminals ? parseSessionPaneScopeId(options.terminals.scopeId) : null;
        const ambientSessionId = terminalSession?.sessionId ?? activeSessionId;
        const activeSession = ambientSessionId
            ? (storage.getState().sessions as Record<string, { serverId?: string } | undefined>)[ambientSessionId]
            : null;
        const activeMachineTarget = ambientSessionId ? readMachineControlTargetForSession(ambientSessionId) : null;
        const invocationScope = resolveUniversalSearchInvocationScope({
            requestedScope,
            ambientScope: {
                accountId: activeAccountScope?.accountId ?? null,
                serverId: terminalSession?.address?.serverId ?? activeSession?.serverId ?? activeAccountScope?.serverId ?? null,
                sessionId: ambientSessionId,
                machineId: activeMachineTarget?.machineId ?? null,
                rootPath: activeMachineTarget?.basePath ?? null,
            },
        });
        if (Platform.OS !== 'web') {
            if (universalSearchRouteActive || universalSearchRouteOpenRequestedRef.current) return;
            universalSearchRouteOpenRequestedRef.current = true;
            router.push({
                pathname: UNIVERSAL_SEARCH_ROUTE,
                params: {
                    ...(initialQuery ? { q: initialQuery } : {}),
                    ...(options?.source ? { source: options.source } : {}),
                    ...(invocationScope.sessionId ? { sessionId: invocationScope.sessionId } : {}),
                    ...(invocationScope.accountId ? { accountId: invocationScope.accountId } : {}),
                    ...(invocationScope.serverId ? { serverId: invocationScope.serverId } : {}),
                    ...(invocationScope.machineId ? { machineId: invocationScope.machineId } : {}),
                    ...(invocationScope.rootPath ? { rootPath: invocationScope.rootPath } : {}),
                    ...(options?.terminals ? { [TERMINAL_JUMP_ROUTE_PARAM]: options.terminals.scopeId } : {}),
                },
            } as never);
            return;
        }
        if (openUniversalSearchModalRef.current) return;
        let modalId = '';
        modalId = Modal.show({
            component: UniversalSearchModal,
            webPlacement: COMMAND_SURFACE_WEB_PLACEMENT,
            onRequestClose: () => {
                if (openUniversalSearchModalRef.current?.id === modalId) {
                    openUniversalSearchModalRef.current = null;
                    setPaletteOpen(false);
                }
            },
            props: {
                commands: buildCommands(invocationScope.sessionId, invocationScope),
                ...(initialQuery ? { initialQuery } : {}),
                ...(options?.source ? { initialSource: options.source } : {}),
                ...(invocationScope.sessionId ? { activeSessionId: invocationScope.sessionId } : {}),
                initialScope: invocationScope,
                ...(options?.terminals ? { terminalJump: options.terminals } : {}),
            },
        });
        openUniversalSearchModalRef.current = {
            id: modalId,
            activeSessionId: invocationScope.sessionId,
            scope: invocationScope,
        };
        setPaletteOpen(true);
    }, [activeSessionId, buildCommands, router, universalSearchRouteActive]);

    const universalSearchRuntime = useMemo<UniversalSearchRuntime>(() => ({
        open: showCommandPalette,
        buildCommands,
    }), [buildCommands, showCommandPalette]);
    textSearchOpener.current = (requestedScope) => showCommandPalette(undefined, requestedScope, { source: 'fileContent' });

    const toggleTheme = useToggleThemeMode();
    const keyboardHandlers = useMemo<KeyboardShortcutHandlers>(
        () => ({
            ...(commandPaletteEnabled ? { 'commandPalette.open': showCommandPalette } : {}),
            'appearance.theme.toggle': toggleTheme,
            'session.new': openNewSession,
            ...(workflowsEnabled ? { 'workflow.new': openNewWorkflow, 'workflow.createWithAgent': openWorkflowAgentAuthoring } : {}),
            'search.textInFiles': () => showCommandPalette(undefined, undefined, { source: 'fileContent' }),
            'settings.open': () => {
                router.push('/settings' as any);
            },
        }),
        [commandPaletteEnabled, workflowsEnabled, openNewSession, openNewWorkflow, openWorkflowAgentAuthoring, router, showCommandPalette, toggleTheme],
    );
    const keyboardEnabledWhenDisabledCommandIds = useMemo(
        () => commandPaletteEnabled ? ['commandPalette.open'] as const : [],
        [commandPaletteEnabled],
    );
    return (
        <UniversalSearchRuntimeProvider value={universalSearchRuntime}>
            <KeyboardShortcutProvider
                handlers={keyboardHandlers}
                enabledWhenDisabledCommandIds={keyboardEnabledWhenDisabledCommandIds}
            >
                <NextPendingNavigationHost />
                {children}
            </KeyboardShortcutProvider>
        </UniversalSearchRuntimeProvider>
    );
}
