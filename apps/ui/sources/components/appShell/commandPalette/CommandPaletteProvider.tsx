import { CommandPalettePluginActionProjectionDemand, useCommandPalettePluginActionPresentation } from './useCommandPalettePluginActionPresentation';
import { KeyboardCommandPaletteBridge } from './KeyboardCommandPaletteBridge';
import { sessionPanelKeyboardCommands } from '@/keyboard/commands';
import { buildSessionCommands, setSessionCommandPalettePresented, type SessionCommandDemand } from './sessionCommands';
import type { KeyboardCommandControls } from './buildCommandPaletteCommands';
export { useCommandPalettePluginActionPresentation, type CommandPalettePluginActionPresentation } from './useCommandPalettePluginActionPresentation';
import { useOpenExecutionRunLauncherDraft } from '@/components/sessions/runs/launcher/useOpenExecutionRunLauncherDraft';
import React, { useCallback, useMemo } from 'react';
import { loadSettingsPagePresentation, readSettingsPagePresentation } from '@/components/settings/catalog/loadSettingsPagePresentation';
import { useToggleThemeMode } from '@/components/settings/appearance/useApplyThemeSelection';
import { Platform } from 'react-native';
import { useCurrentRouteParamsSelector, useCurrentRouteSegments } from '@/components/appShell/workspace/currentRouteLocation';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useEventCallback } from '@/hooks/ui/useEventCallback';
import { Modal } from '@/modal';
import { COMMAND_SURFACE_WEB_PLACEMENT } from '@/modal/components/card/commandSurfaceCard';
import type { UniversalSearchModalProps } from '@/components/appShell/search/UniversalSearchModal';
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
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { createFrontDoorActionExecute, requireActionSuccess } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { readDocumentFocusReturnTarget } from '@/keyboard/focusReturn';
import { ESCAPE_LAYER_PRIORITIES, useEscapeLayer } from '@/keyboard/escape';
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
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { readMachineControlTargetForSession } from '@/sync/ops/sessionMachineTarget';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { getChangelogEntries } from '@/changelog';
import { getFeatureBuildPolicyDecision } from '@/sync/domains/features/featureBuildPolicy';
import { useApplyLocalSettings, useApplySettings } from '@/sync/store/settingsWriters';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { isDesktopHost } from '@/utils/platform/desktopHost';
import type { Session } from '@/sync/domains/state/storageTypes';
import { buildCommandPaletteCommands, selectCommandPaletteRecentSessions, type FileViewCommandControls, type PetCommandControls } from './buildCommandPaletteCommands';
import { useWorkflowsAvailability } from '@/components/workflows/gating/workflowsAvailability';
import { useWorkflowAgentAuthoring } from '@/components/workflows/authoring/useWorkflowAgentAuthoring';
import { buildWorkflowAgentAuthoringSeed } from '@/sync/domains/workflows/workflowAgentAuthoringSeed';
import { executeCommandPaletteKeyboardCommand, registerCommandPaletteActionCatalog } from './commandPaletteActionRuntime';
import { resolveKeyboardCommands } from '@/keyboard/commands';
import { KeyboardShortcutProvider, buildKeyboardShortcutLabels, resolveKeyboardPlatform, type KeyboardShortcutHandlers } from '@/keyboard';
import { useOptionalCurrentUiContextReader } from '@/components/appShell/currentUiContext/CurrentUiContextProvider';
import { useDesktopAppWindowCommands } from '@/desktop/window/useDesktopAppWindowCommands';
import { readCurrentUiContextActionReader } from '@/components/appShell/currentUiContext/currentUiContextActionRuntime';
import { normalizeSessionId } from '@/sync/domains/session/normalizeSessionId';
import { projectParameterFreeRoute } from '@/track/parameterFreeRouteProjection';
import { useOpenNewSession } from '@/components/sessions/new/navigation/newSessionEntry';
import { UNIVERSAL_SEARCH_ROUTE } from '@/components/appShell/search/universalSearchRoutePresentation';
import { parseSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';
import { TERMINAL_JUMP_ROUTE_PARAM } from '@/components/sessions/terminal/jump/terminalJumpTarget';
import { NextPendingNavigationHost } from '@/components/sessions/pendingNavigation/NextPendingNavigationHost';
import { t } from '@/text';
import { usePaneArrangement } from '@/components/appShell/panes/arrangement/usePaneArrangement';
import { readActiveFileViewActionOwner, readShellColumnActionOwner } from '@/sync/ops/actions/scopeActionFamily';
import { TRANSCRIPT_MESSAGE_CURSOR_ACTION_COMMANDS, readTranscriptMessageCursorActions } from '@/components/sessions/transcript/messageCursor/transcriptMessageCursorStore';
import { focusPaneRegion } from '@/components/appShell/panes/paneRegionFocus';
import { useAskHappierStarter } from '@/components/sessions/bots/useAskHappierOffer';
import { useWorkspaceFileOpener } from '@/components/workspaces/files/useWorkspaceFileOpener';
import { readSessionComposerActionChipOffer, readSessionComposerModelFavorites, requestRegisteredSessionComposerActionChip } from '@/components/sessions/presentation/sessionComposerPresentationTargets';
import { SESSION_MODEL_PICKER_CHIP_KEY } from '@/components/sessions/presentation/useSessionModelPickerEntry';

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

export function CommandPaletteProvider({ children }: { children: React.ReactNode }) {
    return <WebCommandPaletteProvider>{children}</WebCommandPaletteProvider>;
}

/** The route facts the palette's context reads; a pane's own params (`right=`, `q=`) do not render it. */
const selectPaletteRouteParams = (params: Readonly<Record<string, string | string[] | undefined>>) => ({
    id: params.id, sessionId: params.sessionId, serverId: params.serverId,
});

function WebCommandPaletteProvider({ children }: { children: React.ReactNode }) {
    const router = useRouter();
    const { open: openWorkspaceFile } = useWorkspaceFileOpener();
    const { toggle: togglePaneArrangement } = usePaneArrangement();
    const currentUiContextReader = useOptionalCurrentUiContextReader();
    const openNewSession = useOpenNewSession();
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
    })), { settings: ['commandPaletteEnabled', 'keyboardSingleKeyShortcutsEnabled',
        'keyboardShortcutDisabledCommandIdsV1', 'keyboardShortcutOverridesV1'] });
    const navigateToSession = useNavigateToSession();
    const segments = useCurrentRouteSegments();
    const routeParams = useCurrentRouteParamsSelector(selectPaletteRouteParams);
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
    const [paletteOpen, setPaletteOpen] = React.useState(false);
    const keyboardCommandsRef = React.useRef<KeyboardCommandControls | null>(null);
    const pluginActionPresentation = useCommandPalettePluginActionPresentation(commandContextSessionId, paletteOpen || universalSearchRouteActive);
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
    const derivedKeyboardCommands = useMemo(
        () => resolveKeyboardCommands(keyboardShortcutOverridesV1 ?? {})
            .filter(({ id }) => id.startsWith('action:') || id.startsWith('session.action:')),
        [keyboardShortcutOverridesV1],
    );
    const labelHandlers = useMemo<KeyboardShortcutHandlers>(
        () => ({
            ...Object.fromEntries(sessionPanelKeyboardCommands.map(command => [command.id, () => undefined])),
            'sessionList.source.toggle': () => undefined,
            'permission.open': () => undefined,
            'composer.attachFile': () => undefined,
            'mode.cycle': () => undefined,
            'permission.cycle': () => undefined,
            ...Object.fromEntries(derivedKeyboardCommands.map(command => [command.id, () => undefined])),
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
            ...Object.fromEntries(Object.values(TRANSCRIPT_MESSAGE_CURSOR_ACTION_COMMANDS).map(id => [id, () => undefined])),
            'search.files': () => undefined,
            'search.symbols': () => undefined,
            ...(commandPaletteEnabled ? { 'commandPalette.open': () => undefined } : {}),
        }),
        [commandPaletteEnabled, workflowsEnabled, derivedKeyboardCommands],
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
    const actionExecutor = useMemo(() => ({
        execute: createFrontDoorActionExecute(undefined, {
            resolveServerIdForSessionId: (sessionId) => resolvePreferredServerIdForSessionId(sessionId) ?? null,
            openSession: navigateToSession,
        }),
    }), [navigateToSession]);
    const loadThemeCommands = useCallback(async () => {
        const [{ buildThemeCommands }, { getSyncSingleton }, { readThemeProfileReferenceSelection },
            { readSystemTheme, resolveThemeRuntimeVisualTheme }] = await Promise.all([
            import('./themeCommands'), import('@/sync/runtime/getSyncSingleton'),
            import('@/theme/profiles/themeProfilePersistence'), import('@/theme/profiles/themeProfileRuntime'),
        ]);
        const state = storage.getState();
        return getSyncSingleton().withThemeProfileLibrary(async library => buildThemeCommands({
            entries: await library.list(), undoHandle: library.lastUndo(),
            mode: resolveThemeRuntimeVisualTheme(state.localSettings.themePreference, readSystemTheme()),
            selection: readThemeProfileReferenceSelection(state.localSettings.themeProfileSelection),
            execute: async (id: ActionId, input) => requireActionSuccess(await actionExecutor.execute(id, input, { surface: 'ui' })),
            push: path => router.push(path as never),
        }));
    }, [actionExecutor, router]);
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

    const openExecutionRunDraft = useOpenExecutionRunLauncherDraft();
    const textSearchOpener = React.useRef<(scope?: UniversalSearchScopeSeed, replace?: boolean) => void>(() => undefined);
    const fileSearchOpener = React.useRef<(source: 'files' | 'symbols', scope?: UniversalSearchScopeSeed, symbols?: UniversalSearchOpenOptions['symbols']) => void>(() => undefined);
    const isExactSessionContext = useCallback((requestedActiveSessionId: string | null, requestedScope?: UniversalSearchScopeSeed) => {
        if (requestedActiveSessionId !== commandContextSessionId) return false;
        const ambientSession = requestedActiveSessionId
            ? (storage.getState().sessions as Record<string, { serverId?: string; accountId?: string } | undefined>)[requestedActiveSessionId]
            : null;
        return !requestedScope || !requestedActiveSessionId || (
            resolveServerProfileScopeIdForIdentifier(ambientSession?.serverId ?? null)
                === resolveServerProfileScopeIdForIdentifier(requestedScope.serverId)
            && (requestedScope.accountId === null || ambientSession?.accountId === requestedScope.accountId)
        );
    }, [commandContextSessionId]);
    const buildCommands = useCallback((requestedActiveSessionId: string | null = commandContextSessionId, requestedScope?: UniversalSearchScopeSeed, symbols?: UniversalSearchOpenOptions['symbols']) => {
        // The contributed Action presentation is captured for the rendered
        // route's exact Session. An imperative opener may target another Home
        // or Session, so never attach the ambient Session's Actions to that
        // command inventory. The Search provider catalog still supplies
        // exact-target plugin entities for the requested scope.
        const exactSessionContext = isExactSessionContext(requestedActiveSessionId, requestedScope);
        const scopedPluginActionPresentation = exactSessionContext
            ? pluginActionPresentation
            : null;
        const askHappierLifetime = captureActiveServerAccountScopeLifetime();
        // The Session's composer decides whether its model picker is offered; read once as the palette opens.
        const modelPickerServerId = requestedScope?.serverId
            ?? (requestedActiveSessionId === commandContextSessionId ? commandContextServerId : null);
        const modelPickerAddress = requestedActiveSessionId && modelPickerServerId
            ? { serverId: modelPickerServerId, sessionId: requestedActiveSessionId } : null;
        const sessionModelPicker = modelPickerAddress
            && readSessionComposerActionChipOffer(modelPickerAddress, SESSION_MODEL_PICKER_CHIP_KEY) === 'offered'
            ? { open: () => { requestRegisteredSessionComposerActionChip(modelPickerAddress, SESSION_MODEL_PICKER_CHIP_KEY); } }
            : undefined;
        const sessionModelFavorites = modelPickerAddress ? readSessionComposerModelFavorites(modelPickerAddress) : [];
        const askHappierCurrentContext = readCurrentUiContextActionReader({ surface: 'ui' })?.readCurrentUiContext() ?? null;
        return buildCommandPaletteCommands({
            sessionsById: storage.getState().sessions,
            isDev: __DEV__ === true,
            activeSessionId: requestedActiveSessionId,
            activeSessionServerId: requestedScope?.serverId
                ?? (requestedActiveSessionId === commandContextSessionId ? commandContextServerId : null),
            features: { executionRunsEnabled, voiceEnabled, petsCompanionEnabled, workflowsEnabled },
            shortcutLabels,
            ...(keyboardCommandsRef.current ? { keyboardCommands: keyboardCommandsRef.current } : {}),
            sessionCommands: exactSessionContext ? buildSessionCommands({ reader: currentUiContextReader, shortcutLabels,
                execute: (actionId, input) => actionExecutor.execute(actionId, input, { surface: 'ui' }) }) : [],
            petControls,
            fileViewControls,
            focusedMessageActions: readTranscriptMessageCursorActions(),
            themeCommands: loadThemeCommands,
            ...(sessionModelPicker ? { sessionModelPicker } : {}),
            ...(sessionModelFavorites.length > 0 ? { sessionModelFavorites } : {}),
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
                openExecutionRunDraft,
            },
            actions: {
                execute: (actionId, parameters, ctx) => actionExecutor.execute(actionId as any, parameters, ctx),
            },
            alert: async (title, message) => {
                await Modal.alertAsync(title, message);
            },
        });
    }, [openExecutionRunDraft, isExactSessionContext, commandContextSessionId, commandContextServerId, currentUiContextReader, executionRunsEnabled, voiceEnabled, petsCompanionEnabled, workflowsEnabled, paletteDestinations, activateCompactAppDestination, shortcutLabels, petControls, pluginActionPresentation, router, openNewSession, openNewWorkflow, openWorkflowAgentAuthoring, navigateToSession, actionExecutor, desktopWindowCommands, fileViewControls, loadThemeCommands, startAskHappier, togglePaneArrangement]);

    const actionCommandBuilder = React.useRef(buildCommands);
    actionCommandBuilder.current = buildCommands;
    const prepareSessionCommands = useEventCallback((modalId?: string | null,
        requestedSessionId: string | null = commandContextSessionId, requestedScope?: UniversalSearchScopeSeed) => setSessionCommandPalettePresented({
        reader: isExactSessionContext(requestedSessionId, requestedScope) ? currentUiContextReader : null, presented: true, modalId,
        execute: (actionId, input) => actionExecutor.execute(actionId, input, { surface: 'ui' }),
    }));
    const prepareSettingsCommands = useCallback(() => voiceEnabled && !readSettingsPagePresentation()
        ? loadSettingsPagePresentation() : undefined, [voiceEnabled]);
    React.useEffect(() => registerCommandPaletteActionCatalog(
        () => actionCommandBuilder.current(), prepareSessionCommands, prepareSettingsCommands,
    ), [prepareSessionCommands, prepareSettingsCommands]);
    const sessionCommandDemandRelease = React.useRef<SessionCommandDemand | null>(null);
    React.useEffect(() => () => sessionCommandDemandRelease.current?.(), []);

    const openUniversalSearchModalRef = React.useRef<Readonly<{
        id: string;
        activeSessionId: string | null;
        scope: UniversalSearchScopeSeed;
        symbols?: UniversalSearchOpenOptions['symbols'];
    }> | null>(null);
    const pendingPaletteOpen = React.useRef<object | null>(null);
    const pendingPaletteFocus = React.useRef<ReturnType<typeof readDocumentFocusReturnTarget>>(null);
    // Only a pending open holds Escape; an idle palette must not sit above every page's own keys.
    const [palettePending, setPalettePending] = React.useState(false);
    React.useEffect(() => () => { pendingPaletteOpen.current = null; }, []);
    useEscapeLayer({
        enabled: Platform.OS === 'web' && palettePending,
        priority: ESCAPE_LAYER_PRIORITIES.commandPalette,
        allowEditableTarget: true,
        focusReturnRef: pendingPaletteFocus,
        onEscape: () => {
            if (!pendingPaletteOpen.current) return false;
            pendingPaletteOpen.current = null;
            setPalettePending(false);
            return true;
        },
    });
    // The Session facts the open palette's commands read: the listed recent Sessions, and the
    // requested Session's Home and metadata (its run drafts default to that Session's agent).
    // Other Session changes (streaming activity, Sessions outside the list) change no command,
    // so they publish nothing.
    const openPaletteSessionFacts = React.useRef<readonly unknown[] | null>(null);
    const readOpenPaletteSessionFacts = (activeSessionId: string | null): readonly unknown[] => {
        const sessions = storage.getState().sessions as Record<string, (Partial<Pick<Session, 'serverId' | 'metadata' | 'ownerMetadataView'>> & { accountId?: string }) | undefined>;
        const active = activeSessionId ? sessions[activeSessionId] : undefined;
        return [active?.serverId ?? null, active?.accountId ?? null, active?.metadata ?? null, active?.ownerMetadataView ?? null,
            ...selectCommandPaletteRecentSessions(sessions)
            .flatMap((row) => [row.sessionId, row.serverId, row.title, row.subtitle])];
    };
    const refreshOpenPaletteCommands = React.useCallback(() => {
        const openModal = openUniversalSearchModalRef.current;
        if (!openModal) return;
        openPaletteSessionFacts.current = readOpenPaletteSessionFacts(openModal.activeSessionId);
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
        const unsubscribeContext = currentUiContextReader?.subscribe(refreshOpenPaletteCommands);
        const unsubscribeSessions = storage.subscribe(() => {
            const openModal = openUniversalSearchModalRef.current;
            const previous = openPaletteSessionFacts.current;
            if (openModal && previous) {
                const next = readOpenPaletteSessionFacts(openModal.activeSessionId);
                if (next.length === previous.length && next.every((fact, index) => fact === previous[index])) return;
            }
            refreshOpenPaletteCommands();
        }, { sessions: true });
        return () => { unsubscribeContext?.(); unsubscribeSessions(); };
    }, [currentUiContextReader, paletteOpen, refreshOpenPaletteCommands]);

    // Opening reads the latest route and Account facts when invoked; its identity must not follow them,
    // because the Search runtime and the shortcut handlers are retained by always-mounted consumers.
    const showCommandPalette = useEventCallback((initialQuery?: string, requestedScope?: UniversalSearchScopeSeed, options?: UniversalSearchOpenOptions) => {
        const activeAccountScope = captureActiveServerAccountScopeLifetime()?.scope;
        // The presented pane owns file Search, even when focus is in shell chrome.
        // Explicit callers and terminal Jump keep their addressed scope.
        const presentedFile = !requestedScope && !options?.terminals ? readActiveFileViewActionOwner()?.search : undefined;
        const presentedProject = !requestedScope && !options?.terminals
            ? readShellColumnActionOwner('main')?.searchScope : undefined;
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
            requestedScope: requestedScope ?? presentedFile?.scope ?? presentedProject,
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
            const pushSearchRoute = (release: SessionCommandDemand) => {
                sessionCommandDemandRelease.current = release;
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
                    ...(invocationScope.workspace ? { workspace: JSON.stringify(invocationScope.workspace) } : {}),
                    ...(options?.terminals ? { [TERMINAL_JUMP_ROUTE_PARAM]: options.terminals.scopeId } : {}),
                },
                } as never);
            };
            const demand = prepareSessionCommands(null, invocationScope.sessionId, invocationScope);
            const settingsCommands = prepareSettingsCommands();
            if (typeof demand === 'function' && !settingsCommands) { pushSearchRoute(demand); return; }
            const opening = Promise.resolve(demand).then(async release => {
                try {
                    await settingsCommands;
                    pushSearchRoute(release);
                } catch (error) {
                    release();
                    universalSearchRouteOpenRequestedRef.current = false;
                    throw error;
                }
            });
            fireAndForget(opening, { tag: 'CommandPaletteProvider.openNative' });
            return opening;
        }
        if (openUniversalSearchModalRef.current || pendingPaletteOpen.current) return;
        const pending = {};
        pendingPaletteOpen.current = pending;
        setPalettePending(true);
        const lifetime = captureActiveServerAccountScopeLifetime();
        const focusReturnRef = { current: typeof document === 'undefined' ? null : readDocumentFocusReturnTarget(document) };
        pendingPaletteFocus.current = focusReturnRef.current;
        const opening = (async () => {
            const [{ UniversalSearchModal }] = await Promise.all([
                import('@/components/appShell/search/UniversalSearchModal'), prepareSettingsCommands(),
            ]);
            const releaseSessionCommands = await prepareSessionCommands(undefined, invocationScope.sessionId, invocationScope);
            sessionCommandDemandRelease.current = releaseSessionCommands;
            if (pendingPaletteOpen.current !== pending || (lifetime && !lifetime.isCurrent())) { releaseSessionCommands(); return; }
            let modalId = '';
            const clearOpenPalette = () => {
                if (openUniversalSearchModalRef.current?.id === modalId) {
                    openUniversalSearchModalRef.current = null;
                    setPaletteOpen(false);
                    releaseSessionCommands.setModalId(undefined);
                }
            };
            openPaletteSessionFacts.current = readOpenPaletteSessionFacts(invocationScope.sessionId);
            modalId = Modal.show({
                component: UniversalSearchModal,
                focusReturnRef,
                webPlacement: COMMAND_SURFACE_WEB_PLACEMENT,
                onRequestClose: clearOpenPalette,
                onHostUnmount: () => {
                    clearOpenPalette();
                    releaseSessionCommands();
                    if (sessionCommandDemandRelease.current === releaseSessionCommands) sessionCommandDemandRelease.current = null;
                },
                props: {
                    commands: actionCommandBuilder.current(invocationScope.sessionId, invocationScope, symbols),
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
            releaseSessionCommands.setModalId(modalId);
            openUniversalSearchModalRef.current = {
                id: modalId,
                activeSessionId: invocationScope.sessionId,
                scope: invocationScope,
                ...(symbols ? { symbols } : {}),
            };
            setPaletteOpen(true);
        })().finally(() => {
            if (pendingPaletteOpen.current === pending) {
                pendingPaletteOpen.current = null;
                setPalettePending(false);
            }
        });
        fireAndForget(opening, { tag: 'CommandPaletteProvider.open' });
        return opening;
    });

    const buildRuntimeCommands = useEventCallback(buildCommands);
    const universalSearchRuntime = useMemo<UniversalSearchRuntime>(() => ({
        open: showCommandPalette,
        buildCommands: buildRuntimeCommands,
        get routeSymbols() { return routeSymbolsRef.current; },
        releaseSessionCommands: () => { sessionCommandDemandRelease.current?.(); sessionCommandDemandRelease.current = null; },
    }), [buildRuntimeCommands, showCommandPalette]);
    textSearchOpener.current = (requestedScope, replace) => showCommandPalette(undefined, requestedScope, { source: 'fileContent', ...(replace ? { replace } : {}) });
    fileSearchOpener.current = (source, requestedScope, symbols) => showCommandPalette(undefined, requestedScope, { source, ...(symbols ? { symbols } : {}) });

    const toggleTheme = useToggleThemeMode();
    const keyboardHandlers = useMemo<KeyboardShortcutHandlers>(
        () => ({
            ...Object.fromEntries(derivedKeyboardCommands.map(command => [command.id, () => executeCommandPaletteKeyboardCommand(command.id)])),
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
        [commandPaletteEnabled, workflowsEnabled, derivedKeyboardCommands, fileViewControls, openNewSession, openNewWorkflow, openWorkflowAgentAuthoring, router, showCommandPalette, toggleTheme, togglePaneArrangement],
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
                <KeyboardCommandPaletteBridge target={keyboardCommandsRef} />
                <NextPendingNavigationHost />
                {!commandContextSessionId && (paletteOpen || universalSearchRouteActive)
                    ? <CommandPalettePluginActionProjectionDemand /> : null}
                {children}
            </KeyboardShortcutProvider>
        </UniversalSearchRuntimeProvider>
    );
}
