import React, { useCallback, useMemo } from 'react';
import { useToggleThemeMode } from '@/components/settings/appearance/useApplyThemeSelection';
import { Platform } from 'react-native';
import { useGlobalSearchParams, useSegments } from 'expo-router';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { getPluginMachineExecutionOriginRef } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
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
import { PETS_SETTINGS } from '@/components/settings/pets/petsSettings';
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
} from '@/sync/domains/plugins/ui/projection';
import { readPluginUiContributionOrigin } from '@/sync/domains/plugins/ui/projectionUnion';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import {
    createPluginContributedActionController,
    type PluginContributedActionController,
    type PluginContributedActionCurrentSnapshot,
} from '@/components/plugins/actions/pluginContributedActionController';
import {
    usePluginUiClientExecutableRegistrationRevision,
} from '@/components/plugins/reactNative/clientExecutableContributions';
import { useSessionMachineControlTarget } from '@/components/sessions/model/useSessionMachineTarget';
import { readMachineControlTargetForSession } from '@/sync/ops/sessionMachineTarget';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { useServerCredentialAccountScopeBindings } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { getChangelogEntries } from '@/changelog';
import { getFeatureBuildPolicyDecision } from '@/sync/domains/features/featureBuildPolicy';
import { useApplyLocalSettings, useApplySettings } from '@/sync/store/settingsWriters';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { isDesktopHost } from '@/utils/platform/desktopHost';
import { buildCommandPaletteCommands, type FileViewCommandControls, type PetCommandControls } from './buildCommandPaletteCommands';
import { useWorkflowsAvailability } from '@/components/workflows/gating/workflowsAvailability';
import { useWorkflowAgentAuthoring } from '@/components/workflows/authoring/useWorkflowAgentAuthoring';
import { buildWorkflowAgentAuthoringSeed } from '@/sync/domains/workflows/workflowAgentAuthoringSeed';
import { registerCommandPaletteActionCatalog } from './commandPaletteActionRuntime';
import { KeyboardShortcutProvider, buildKeyboardShortcutLabels, resolveKeyboardPlatform, type KeyboardShortcutHandlers } from '@/keyboard';
import { useOptionalCurrentUiContextReader } from '@/components/appShell/currentUiContext/CurrentUiContextProvider';
import { useDesktopAppWindowCommands } from '@/desktop/window/useDesktopAppWindowCommands';
import { readCurrentUiContextActionReader } from '@/components/appShell/currentUiContext/currentUiContextActionRuntime';
import { usePluginSurfaceDestinationNavigationBinding } from '@/components/plugins/surfaces/pluginSurfaceDestinationNavigation';
import { normalizeSessionId } from '@/sync/domains/session/normalizeSessionId';
import { projectParameterFreeRoute } from '@/track/parameterFreeRouteProjection';
import { useResolveNewSessionOrdinaryEntryRoute } from '@/components/sessions/new/navigation/newSessionOrdinaryEntryRoute';
import { UNIVERSAL_SEARCH_ROUTE } from '@/components/appShell/search/universalSearchRoutePresentation';
import { parseSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';
import { TERMINAL_JUMP_ROUTE_PARAM } from '@/components/sessions/terminal/jump/terminalJumpTarget';
import { NextPendingNavigationHost } from '@/components/sessions/pendingNavigation/NextPendingNavigationHost';
import { t } from '@/text';
import { usePaneArrangement } from '@/components/appShell/panes/arrangement/usePaneArrangement';
import { readActiveFileViewActionOwner, readShellColumnActionOwner } from '@/sync/ops/actions/scopeActionFamily';
import { focusPaneRegion } from '@/components/appShell/panes/paneRegionFocus';
import { useAskHappierStarter } from '@/components/sessions/bots/useAskHappierOffer';
import { useWorkspaceFileOpener } from '@/components/workspaces/files/useWorkspaceFileOpener';

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
export type CommandPalettePluginActionPresentation = Readonly<{
    controller: PluginContributedActionController;
    scope: 'global' | 'session';
    signal: AbortSignal;
}>;

export function useCommandPalettePluginActionPresentation(activeSessionId: string | null): CommandPalettePluginActionPresentation | undefined {
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
    const routedBindings = useServerCredentialAccountScopeBindings(serverId ? [serverId] : []);
    const accountLifetime = serverId
        ? routedBindings.values().next().value ?? null
        : captureActiveServerAccountScopeLifetime();
    const projection = useDaemonMergedProjectionInputs({
        accountLifetime,
        machineId,
        serverId,
        enabled: machineId !== null,
        staleMs: 60_000,
    });
    const appShellProjectionRef = React.useRef(appShellProjection);
    appShellProjectionRef.current = appShellProjection;
    const snapshotRef = React.useRef<PluginContributedActionCurrentSnapshot | null>(null);
    // This scope follows authority identity, not catalog metadata. The shared
    // controller re-resolves metadata/availability at open time, while a
    // target or Account transition retires any live form/action.
    const actionScope = React.useMemo(() => new AbortController(), [
        activeSessionId,
        accountLifetime,
        machineId,
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
        const resolveContributedAction = createPluginUiProjectedActionResolver(inputs.pluginUiProjection?.actionsById);
        const current: PluginContributedActionCurrentSnapshot = {
            pluginProjectionById: inputs.pluginProjectionById,
            pluginUiProjection: inputs.pluginUiProjection,
            resolveContributedAction,
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
                    snapshotRef.current?.host.signal === actionScope.signal
                    && actionScope.signal.aborted === false
                    && accountLifetime?.isCurrent() !== false
                ),
                // The app palette consumes an Action only from its selected
                // app-scope origin. A Session palette already has its exact
                // Session machine/currentness owner and must not acquire a
                // second app-scope selection gate.
                isActionCurrent: (identity: Readonly<{ pluginId: string; localId: string }>) => {
                    const action = resolveContributedAction(identity);
                    if (!action || snapshotRef.current?.resolveContributedAction?.(identity) !== action) return false;
                    if (activeSessionId) return true;
                    const projectedAction = appShellProjectionRef.current.pluginUiProjection?.actionsById[
                        buildQualifiedPluginContributionKey(identity)
                    ];
                    const origin = readPluginUiContributionOrigin(projectedAction);
                    const exactRef = origin?.executionOrigin ? getPluginMachineExecutionOriginRef(origin.executionOrigin) : null;
                    return origin?.machineId === machineId && origin.serverId === serverId
                        && origin.interactionEnabled === true && origin.phase === 'current'
                        && exactRef?.pluginId === identity.pluginId && exactRef.machineId === machineId;
                },
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
    const { open: openWorkspaceFile } = useWorkspaceFileOpener();
    const { toggle: togglePaneArrangement } = usePaneArrangement();
    const currentUiContextReader = useOptionalCurrentUiContextReader();
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
    const routeSymbolsRef = React.useRef<UniversalSearchOpenOptions['symbols']>(undefined);
    React.useEffect(() => {
        if (!universalSearchRouteActive) {
            universalSearchRouteOpenRequestedRef.current = false;
            routeSymbolsRef.current = undefined;
        }
    }, [universalSearchRouteActive]);
    const pluginActionPresentation = useCommandPalettePluginActionPresentation(commandContextSessionId);
    const executionRunsEnabled = useFeatureEnabled('execution.runs');
    const voiceEnabled = useFeatureEnabled('voice');
    const petsCompanionEnabled = useFeatureEnabled('pets.companion');
    const { available: workflowsEnabled } = useWorkflowsAvailability();
    const openWorkflowAgentDraft = useWorkflowAgentAuthoring();
    const { start: startAskHappier } = useAskHappierStarter();
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
            'shell.column.toggle': () => undefined,
            'panes.main.toggle': () => undefined,
            'panes.side.toggle': () => undefined,
            'panes.arrangement.toggle': () => undefined,
            'panes.region.next': () => undefined,
            'panes.region.previous': () => undefined,
            'session.new': () => undefined,
            ...(workflowsEnabled ? { 'workflow.new': () => undefined, 'workflow.createWithAgent': () => undefined } : {}),
            'settings.open': () => undefined,
            'search.textInFiles': () => undefined,
            'search.replaceInFiles': () => undefined,
            'file.blame.toggle': () => undefined,
            'search.files': () => undefined,
            'search.symbols': () => undefined,
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
    const openDesktopWindow = React.useCallback(async (input: import('@happier-dev/protocol/actions/actionSpecs').DesktopWindowsOpenInput) => {
        const result = await actionExecutor.execute('desktop.windows.open', input, { surface: 'ui' });
        return result.ok;
    }, [actionExecutor]);
    const desktopWindowCommands = useDesktopAppWindowCommands(openDesktopWindow);
    // One path for the palette row and a user-bound shortcut: the active File page's `file.view.set`.
    const fileViewControls = useMemo<FileViewCommandControls>(() => ({
        readActive: readActiveFileViewActionOwner,
        toggleBlame: () => {
            const owner = readActiveFileViewActionOwner();
            if (owner?.blameAvailable) void actionExecutor.execute('file.view.set', { blame: !owner.blame }, { surface: 'ui' });
        },
    }), [actionExecutor]);
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
                    const operation = actionExecutor.execute('settings.invoke', { anchor: PETS_SETTINGS.settings.desktopOverlayResetPosition.anchor }, { surface: 'ui' }).then(() => {});
                    fireAndForget(operation, {
                        tag: 'CommandPaletteProvider.resetDesktopPetOverlayPosition',
                    });
                    return operation;
                }
                : undefined,
            refreshCodexPets: () => {
                router.push('/settings/pets' as any);
                requestCodexPetRefresh();
            },
        };
    }, [actionExecutor, applyLocalSettings, applySettings, router]);

    const openNewSession = useCallback(() => {
        const { draftId, draftOrigin } = resolveNewSessionOrdinaryEntryRoute();
        router.push({ pathname: '/new', params: { draftId, draftOrigin } });
    }, [resolveNewSessionOrdinaryEntryRoute, router]);

    const textSearchOpener = React.useRef<(scope?: UniversalSearchScopeSeed, replace?: boolean) => void>(() => undefined);
    const fileSearchOpener = React.useRef<(source: 'files' | 'symbols', scope?: UniversalSearchScopeSeed, symbols?: UniversalSearchOpenOptions['symbols']) => void>(() => undefined);
    const buildCommands = useCallback((requestedActiveSessionId: string | null = commandContextSessionId, requestedScope?: UniversalSearchScopeSeed, symbols?: UniversalSearchOpenOptions['symbols']) => {
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
        const askHappierLifetime = captureActiveServerAccountScopeLifetime();
        const askHappierCurrentContext = readCurrentUiContextActionReader({ surface: 'ui' })?.readCurrentUiContext() ?? null;
        return buildCommandPaletteCommands({
            sessionsById: storage.getState().sessions,
            isDev: __DEV__ === true,
            activeSessionId: requestedActiveSessionId,
            activeSessionServerId: requestedScope?.serverId
                ?? (requestedActiveSessionId === commandContextSessionId ? commandContextServerId : null),
            features: { executionRunsEnabled, voiceEnabled, petsCompanionEnabled, workflowsEnabled },
            shortcutLabels,
            petControls,
            fileViewControls,
            paneControls: {
                readColumn: readShellColumnActionOwner,
                focusRegion: direction => { focusPaneRegion(direction); },
                ...(readShellColumnActionOwner('main')?.arrangementAvailable ? { toggleArrangement: () => {
                    if (readShellColumnActionOwner('main')?.arrangementAvailable) togglePaneArrangement();
                } } : {}),
            },
            ...(scopedPluginActionPresentation ? { pluginActionPresentation: scopedPluginActionPresentation } : {}),
            compactAppDestinations: paletteDestinations,
            onActivateCompactAppDestination: activateCompactAppDestination,
            // "About this update" asks about the newest release the changelog owner lists.
            ...(getFeatureBuildPolicyDecision('app.ui.changelog') !== 'deny' && getChangelogEntries()[0]
                ? { askHappierRelease: getChangelogEntries()[0] } : {}),
            nav: {
                push: (path) => router.push(path as any),
                openNewSession,
                ...(desktopWindowCommands.available ? { openNewWindow: desktopWindowCommands.open } : {}),
                openNewWorkflow,
                openWorkflowAgentAuthoring,
                openAskHappier: async (context) => {
                    await startAskHappier({ lifetime: askHappierLifetime, context, currentUiContext: askHappierCurrentContext });
                },
                openTextInFiles: () => textSearchOpener.current(requestedScope),
                openReplaceInFiles: () => textSearchOpener.current(requestedScope, true),
                openFiles: () => fileSearchOpener.current('files', requestedScope, symbols),
                openSymbols: () => fileSearchOpener.current('symbols', requestedScope, symbols),
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
    }, [commandContextSessionId, commandContextServerId, currentUiContextReader, executionRunsEnabled, voiceEnabled, petsCompanionEnabled, workflowsEnabled, paletteDestinations, activateCompactAppDestination, shortcutLabels, petControls, pluginActionPresentation, router, openNewSession, openNewWorkflow, openWorkflowAgentAuthoring, navigateToSession, actionExecutor, desktopWindowCommands, fileViewControls, startAskHappier, togglePaneArrangement]);

    const actionCommandBuilder = React.useRef(buildCommands);
    actionCommandBuilder.current = buildCommands;
    React.useEffect(() => registerCommandPaletteActionCatalog(() => actionCommandBuilder.current()), []);

    const openUniversalSearchModalRef = React.useRef<Readonly<{
        id: string;
        activeSessionId: string | null;
        scope: UniversalSearchScopeSeed;
        symbols?: UniversalSearchOpenOptions['symbols'];
    }> | null>(null);
    const [paletteOpen, setPaletteOpen] = React.useState(false);
    const refreshOpenPaletteCommands = React.useCallback(() => {
        const openModal = openUniversalSearchModalRef.current;
        if (!openModal) return;
        Modal.update<UniversalSearchModalProps>(openModal.id, {
            commands: buildCommands(openModal.activeSessionId, openModal.scope, openModal.symbols),
            openWorkspaceFile,
        });
    }, [buildCommands, openWorkspaceFile]);
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
        // The presented pane owns file Search, even when focus is in shell chrome.
        // Explicit callers and terminal Jump keep their addressed scope.
        const presentedFile = !requestedScope && !options?.terminals ? readActiveFileViewActionOwner()?.search : undefined;
        const symbols = options?.symbols ?? presentedFile?.symbols;
        // A Jump is about the session it was opened from, which need not be the route's session (a
        // split workspace shows several); its pane scope names that session exactly.
        const terminalSession = options?.terminals ? parseSessionPaneScopeId(options.terminals.scopeId) : null;
        const ambientSessionId = terminalSession?.sessionId ?? activeSessionId;
        const activeSession = ambientSessionId
            ? (storage.getState().sessions as Record<string, { serverId?: string } | undefined>)[ambientSessionId]
            : null;
        const activeMachineTarget = ambientSessionId ? readMachineControlTargetForSession(ambientSessionId) : null;
        const invocationScope = resolveUniversalSearchInvocationScope({
            requestedScope: requestedScope ?? presentedFile?.scope,
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
            routeSymbolsRef.current = symbols;
            router.push({
                pathname: UNIVERSAL_SEARCH_ROUTE,
                params: {
                    ...(initialQuery ? { q: initialQuery } : {}),
                    ...(options?.source ? { source: options.source } : {}),
                    ...(options?.replace ? { replace: '1' } : {}),
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
        const clearOpenPalette = () => {
            if (openUniversalSearchModalRef.current?.id === modalId) {
                openUniversalSearchModalRef.current = null;
                setPaletteOpen(false);
            }
        };
        modalId = Modal.show({
            component: UniversalSearchModal,
            webPlacement: COMMAND_SURFACE_WEB_PLACEMENT,
            onRequestClose: clearOpenPalette,
            onHostUnmount: clearOpenPalette,
            props: {
                commands: buildCommands(invocationScope.sessionId, invocationScope, symbols),
                openWorkspaceFile,
                ...(symbols ? { symbols } : {}),
                ...(initialQuery ? { initialQuery } : {}),
                ...(options?.source ? { initialSource: options.source } : {}),
                ...(options?.replace ? { initialReplace: true } : {}),
                ...(invocationScope.sessionId ? { activeSessionId: invocationScope.sessionId } : {}),
                initialScope: invocationScope,
                ...(options?.terminals ? { terminalJump: options.terminals } : {}),
            },
        });
        openUniversalSearchModalRef.current = {
            id: modalId,
            activeSessionId: invocationScope.sessionId,
            scope: invocationScope,
            ...(symbols ? { symbols } : {}),
        };
        setPaletteOpen(true);
    }, [activeSessionId, buildCommands, openWorkspaceFile, router, universalSearchRouteActive]);

    const universalSearchRuntime = useMemo<UniversalSearchRuntime>(() => ({
        open: showCommandPalette,
        buildCommands,
        get routeSymbols() { return routeSymbolsRef.current; },
    }), [buildCommands, showCommandPalette]);
    textSearchOpener.current = (requestedScope, replace) => showCommandPalette(undefined, requestedScope, { source: 'fileContent', ...(replace ? { replace } : {}) });
    fileSearchOpener.current = (source, requestedScope, symbols) => showCommandPalette(undefined, requestedScope, { source, ...(symbols ? { symbols } : {}) });

    const toggleTheme = useToggleThemeMode();
    const keyboardHandlers = useMemo<KeyboardShortcutHandlers>(
        () => ({
            ...(commandPaletteEnabled ? { 'commandPalette.open': showCommandPalette } : {}),
            'appearance.theme.toggle': toggleTheme,
            'panes.arrangement.toggle': () => {
                if (!readShellColumnActionOwner('main')?.arrangementAvailable) return 'pass';
                togglePaneArrangement();
                return 'handled';
            },
            'session.new': openNewSession,
            ...(workflowsEnabled ? { 'workflow.new': openNewWorkflow, 'workflow.createWithAgent': openWorkflowAgentAuthoring } : {}),
            'search.textInFiles': () => showCommandPalette(undefined, undefined, { source: 'fileContent' }),
            'search.replaceInFiles': () => showCommandPalette(undefined, undefined, { source: 'fileContent', replace: true }),
            'search.files': () => showCommandPalette(undefined, undefined, { source: 'files' }),
            'search.symbols': () => showCommandPalette(undefined, undefined, { source: 'symbols' }),
            'file.blame.toggle': () => {
                if (!readActiveFileViewActionOwner()?.blameAvailable) return 'pass';
                fileViewControls.toggleBlame();
                return 'handled';
            },
            'settings.open': () => {
                router.push('/settings' as any);
            },
        }),
        [commandPaletteEnabled, workflowsEnabled, fileViewControls, openNewSession, openNewWorkflow, openWorkflowAgentAuthoring, router, showCommandPalette, toggleTheme, togglePaneArrangement],
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
