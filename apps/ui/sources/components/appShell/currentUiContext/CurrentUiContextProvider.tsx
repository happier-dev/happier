import * as React from 'react';
import { useGlobalSearchParams, useSegments } from 'expo-router';
import { Platform } from 'react-native';

import { useVisibleModalKind } from '@/modal';
import { useAppPaneContext } from '@/components/appShell/panes/AppPaneProvider';
import { useAppShellPluginUiProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import {
    readPluginAppPageRouteIdentity,
} from '@/components/appShell/plugins/pluginAppPageRoute';
import {
    resolvePluginAppPageForRoute,
    resolvePluginAppPages,
    selectPluginAppPagePlacements,
} from '@/components/appShell/plugins/pluginAppPages';
import { useResolvedSettingsPageCatalog } from '@/components/settings/catalog/runtime/useResolvedSettingsPageCatalog';
import { useMainAppTabState } from '@/components/navigation/mobile/chrome/MainAppTabStateProvider';
import { usePluginSurfaceCurrentUiContextEligibility } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { normalizeSessionId } from '@/sync/domains/session/normalizeSessionId';
import { useFocusedSessionId } from '@/sync/domains/session/sessionSurfaceVisibility';
import { readVoicePrivacySettings } from '@/sync/domains/settings/readVoicePrivacySettings';
import { useMachine, useSessionDisplayNameSource, useSetting } from '@/sync/store/hooks';
import { projectParameterFreeRoute } from '@/track/parameterFreeRouteProjection';
import { readHostActivelyViewed, useHostActivelyViewed } from '@/utils/runtime/useHostActivelyViewed';
import { isDesktopHost } from '@/utils/platform/desktopHost';
import {
    CURRENT_UI_CONTEXT_BOUNDED_INCOMPLETENESS_V1,
} from '@happier-dev/protocol/plugins/ui';
import type {
    CurrentUiContextSnapshotV1,
    PluginUiResolvedSemanticCommandV1,
} from '@happier-dev/protocol/plugins/ui';

import {
    composeCurrentUiContextSnapshot,
    composeCurrentUiContextSnapshotFromNavigation,
    hasActiveDetailsWorkspace,
    hasCurrentSessionRoute,
    readCurrentUiContextSettingsPage,
    type CurrentUiContextMountedEnrichment,
    type CurrentUiContextMountProjection,
} from './currentUiContextModel';

type CurrentUiContextMountOwner = object;

/**
 * The semantic command records remain private to the sole current mount
 * record. The snapshot receives `projection` only; EU06 resolves an opaque
 * descriptor through this same owner without exposing a callback or command
 * payload here.
 */
type CurrentUiContextMountRecord = Readonly<{
    owner: CurrentUiContextMountOwner;
    projection: CurrentUiContextMountProjection;
    retirement: AbortController;
    semanticCommands: readonly Readonly<{
        id: string;
        command: PluginUiResolvedSemanticCommandV1;
    }>[];
}>;

type CurrentUiContextMountAction =
    | Readonly<{ kind: 'replace'; record: CurrentUiContextMountRecord }>
    | Readonly<{ kind: 'clear'; owner: CurrentUiContextMountOwner }>;

function reduceCurrentUiContextMount(
    current: CurrentUiContextMountRecord | null,
    action: CurrentUiContextMountAction,
): CurrentUiContextMountRecord | null {
    if (action.kind === 'clear') {
        return current?.owner === action.owner ? null : current;
    }
    // The ref below decides the slot synchronously. Keep the reducer fenced as
    // well so a queued retired mount update cannot replace a newer record.
    if (current !== null && current.owner !== action.record.owner) return current;
    return action.record;
}

export type CurrentUiContextMountPublication = Readonly<{
    publish: (enrichment: CurrentUiContextMountedEnrichment | null) => boolean;
    /** Temporarily removes this mount; the presentation owner republishes on restoration. */
    clear: () => void;
    /** Permanently retires this exact mount. */
    dispose: () => void;
}>;

/**
 * Provider-local factory for exact mounted controllers. It is neither a
 * registry nor a dispatcher: the composer has one guarded current-record slot
 * and never exposes semantic command payloads to consumers.
 */
export type CurrentUiContextMountPublisher = Readonly<{
    createMount: () => CurrentUiContextMountPublication;
}>;

/**
 * The one private semantic record paired with a public opaque command
 * descriptor. Callers must re-resolve it immediately before an effect; it is
 * never serialized with the current UI snapshot.
 */
export type CurrentUiContextResolvedCommand = Readonly<{
    id: string;
    command: PluginUiResolvedSemanticCommandV1;
    /** Aborts synchronously when this exact private command record retires. */
    retirementSignal: AbortSignal;
}>;

/**
 * Provider-local read port for current UI context consumers such as voice.
 * It owns no cache or registration: reads and command qualification always
 * target the provider's one current committed snapshot/record.
 */
export type CurrentUiContextReader = Readonly<{
    readCurrentUiContext: () => CurrentUiContextSnapshotV1 | null;
    resolveCurrentUiCommand: (commandId: string) => CurrentUiContextResolvedCommand | null;
    subscribe: (listener: () => void) => () => void;
}>;

const CurrentUiContextMountPublisherContext = React.createContext<CurrentUiContextMountPublisher | null>(null);
const CurrentUiContextReaderContext = React.createContext<CurrentUiContextReader | null>(null);

function retiresCurrentUiContextMountWhenNotViewed(): boolean {
    return Platform.OS !== 'web' && !isDesktopHost();
}

function readCurrentUiContextMountLifecycleActive(): boolean {
    return !retiresCurrentUiContextMountWhenNotViewed() || readHostActivelyViewed();
}

function retireCurrentUiContextMountRecord(record: CurrentUiContextMountRecord | null): void {
    if (record !== null && !record.retirement.signal.aborted) {
        record.retirement.abort();
    }
}

/**
 * Native background retires mounted semantic context; web and Tauri only
 * withdraw reader authority while their still-mounted record remains live.
 * Surface publishers consume this one lifecycle fact to restore retained
 * enrichment through their incumbent publication path on native foreground.
 */
export function useCurrentUiContextMountLifecycleActive(): boolean {
    const hostActivelyViewed = useHostActivelyViewed();
    return !retiresCurrentUiContextMountWhenNotViewed() || hostActivelyViewed;
}

function createMountRecord(input: Readonly<{
    owner: CurrentUiContextMountOwner;
    enrichment: CurrentUiContextMountedEnrichment;
    nextCommandId: () => string;
}>): CurrentUiContextMountRecord {
    const retirement = new AbortController();
    const semanticCommands = Object.freeze((input.enrichment.commands ?? []).map((entry) => Object.freeze({
        id: input.nextCommandId(),
        command: entry.command,
    })));
    const projection: CurrentUiContextMountProjection = Object.freeze({
        ...(input.enrichment.entity === undefined ? {} : { entity: input.enrichment.entity }),
        ...(input.enrichment.detail === undefined ? {} : { detail: input.enrichment.detail }),
        commands: Object.freeze((input.enrichment.commands ?? []).map((entry, index) => Object.freeze({
            id: semanticCommands[index]!.id,
            title: entry.title,
            ...(entry.description === undefined ? {} : { description: entry.description }),
        }))),
    });
    return Object.freeze({
        owner: input.owner,
        projection,
        retirement,
        semanticCommands,
    });
}

/**
 * Composes and publishes client-local presentational context from incumbent
 * providers. The provider is the one current snapshot composer; exact mounted
 * surfaces contribute only after their controller commits through the private
 * one-record publication capability below.
 */
export function CurrentUiContextProvider(props: Readonly<{ children: React.ReactNode }>): React.ReactElement {
    const hostActivelyViewed = useHostActivelyViewed();
    const routeSegments = useSegments();
    const route = React.useMemo(
        () => projectParameterFreeRoute(routeSegments),
        [routeSegments],
    );
    const visibleModalKind = useVisibleModalKind();
    const { state: appPaneState } = useAppPaneContext();
    const { activeTab } = useMainAppTabState();
    const focusedSessionId = useFocusedSessionId();
    const isSessionRoute = route.segments[0] === 'session' && route.segments[1] === ':id';
    const isMachineRoute = route.segments[0] === 'machine' && route.segments[1] === ':id';
    // `[id]` is the incumbent scalar machine route parameter. It is consumed
    // only by the canonical machine selector and never copied into the DTO.
    const machineRouteParams = useGlobalSearchParams<{ id?: string }>();
    const sessionRouteId = isSessionRoute ? normalizeSessionId(machineRouteParams.id) : '';
    // Both sources are keyed to the one foreground route entity. Do not
    // subscribe to the Session or machine collections merely to enrich its
    // already-current framework snapshot.
    const session = useSessionDisplayNameSource(sessionRouteId);
    const machine = useMachine(machineRouteParams.id ?? '', isMachineRoute);
    const sessionActive = hasCurrentSessionRoute(focusedSessionId, sessionRouteId);
    const machineActive = isMachineRoute && machine !== null;
    const voiceSettings = useSetting('voice');
    const voicePrivacy = React.useMemo(
        () => readVoicePrivacySettings({ voice: voiceSettings }),
        [voiceSettings],
    );
    const settingsCatalog = useResolvedSettingsPageCatalog();
    const settingsPage = React.useMemo(
        () => readCurrentUiContextSettingsPage({
            tree: settingsCatalog.tree,
            activePageId: settingsCatalog.activePageId,
        }),
        [settingsCatalog.activePageId, settingsCatalog.tree],
    );
    const settingsTitle = settingsPage?.title?.trim() || null;
    const pluginSettingsPage = settingsPage?.pluginSettingsPage !== undefined;

    const pluginProjection = useAppShellPluginUiProjection();
    const pluginRouteParams = useGlobalSearchParams();
    const pluginRouteIdentity = React.useMemo(
        () => readPluginAppPageRouteIdentity(pluginRouteParams),
        [pluginRouteParams],
    );
    const pluginPages = React.useMemo(() => {
        const placements = selectPluginAppPagePlacements(pluginProjection.pluginUiProjection);
        return resolvePluginAppPages({ placements });
    }, [pluginProjection.pluginUiProjection]);
    const pluginPageLabel = React.useMemo(() => {
        if (route.segments[0] !== 'plugins') return null;
        return resolvePluginAppPageForRoute({
            pages: pluginPages,
            pluginId: pluginRouteIdentity.pluginId,
            localId: pluginRouteIdentity.localId,
        })?.label ?? null;
    }, [pluginPages, pluginRouteIdentity.localId, pluginRouteIdentity.pluginId, route.segments]);

    const [mountRecord, dispatchMountRecord] = React.useReducer(reduceCurrentUiContextMount, null);
    const currentMountRecordRef = React.useRef<CurrentUiContextMountRecord | null>(null);
    const committedSnapshotRef = React.useRef<CurrentUiContextSnapshotV1 | null>(null);
    const readerListenersRef = React.useRef(new Set<() => void>());
    const providerCurrentRef = React.useRef(true);
    const nextCommandIdRef = React.useRef(0);
    const notifyReaderListeners = React.useCallback(() => {
        for (const listener of readerListenersRef.current) {
            listener();
        }
    }, []);
    React.useInsertionEffect(() => {
        // StrictMode replays descendant layout publishers without recreating
        // this provider. Keep the provider gate in the insertion lifetime so
        // only a real replacement/unmount fences its prior mount closures.
        providerCurrentRef.current = true;
        return () => {
            providerCurrentRef.current = false;
            retireCurrentUiContextMountRecord(currentMountRecordRef.current);
            currentMountRecordRef.current = null;
            committedSnapshotRef.current = null;
            readerListenersRef.current.clear();
        };
    }, []);

    React.useLayoutEffect(() => {
        if (!retiresCurrentUiContextMountWhenNotViewed() || hostActivelyViewed) return;
        const record = currentMountRecordRef.current;
        if (record === null) return;
        retireCurrentUiContextMountRecord(record);
        currentMountRecordRef.current = null;
        dispatchMountRecord({ kind: 'clear', owner: record.owner });
    }, [hostActivelyViewed]);

    const readCurrentUiContext = React.useCallback((): CurrentUiContextSnapshotV1 | null => {
        if (!readHostActivelyViewed()) return null;
        const committedSnapshot = committedSnapshotRef.current;
        if (committedSnapshot === null) return null;
        // A bounded fallback intentionally omits every optional surface
        // projection. Reconstructing it from the navigation shell below would
        // let a still-private mount record resurrect withheld descriptors.
        if (committedSnapshot.detail === CURRENT_UI_CONTEXT_BOUNDED_INCOMPLETENESS_V1) {
            return committedSnapshot;
        }
        const mountEnrichment = committedSnapshot.navigation.area === 'modal'
            || committedSnapshot.navigation.area === 'workspace'
            ? null
            : currentMountRecordRef.current?.projection ?? null;
        return composeCurrentUiContextSnapshotFromNavigation(
            committedSnapshot.navigation,
            mountEnrichment,
        );
    }, []);

    const reader = React.useMemo<CurrentUiContextReader>(() => Object.freeze({
        readCurrentUiContext,
        resolveCurrentUiCommand: (rawCommandId: string) => {
            if (!readHostActivelyViewed()) return null;
            const commandId = rawCommandId.trim();
            if (!commandId) return null;
            const currentSnapshot = readCurrentUiContext();
            const descriptor = currentSnapshot?.commands.find((entry) => entry.id === commandId);
            // A private record is never enough for effect authority: modal /
            // workspace precedence and the bounded fallback may withhold its
            // descriptors from the one current provider-facing snapshot.
            if (descriptor === undefined) return null;
            const record = currentMountRecordRef.current;
            if (record === null) return null;
            // The public descriptor and private semantic payload must still
            // be paired in this one current record. This is what fences IDs
            // presented by an earlier publication, clear, or disposal.
            const semantic = record.semanticCommands.find((entry) => entry.id === commandId);
            if (!semantic || descriptor.id !== semantic.id) return null;
            return Object.freeze({
                id: semantic.id,
                command: semantic.command,
                retirementSignal: record.retirement.signal,
            });
        },
        subscribe: (listener: () => void) => {
            readerListenersRef.current.add(listener);
            return () => {
                readerListenersRef.current.delete(listener);
            };
        },
    }), [readCurrentUiContext]);

    const createMount = React.useCallback<CurrentUiContextMountPublisher['createMount']>(() => {
        const owner = Object.freeze({});
        let disposed = false;
        const canUseProvider = (): boolean => !disposed && providerCurrentRef.current;
        const acquire = (): boolean => {
            const record = currentMountRecordRef.current;
            return record === null || record.owner === owner;
        };
        const clearCurrent = (): void => {
            const record = currentMountRecordRef.current;
            if (record?.owner !== owner) return;
            retireCurrentUiContextMountRecord(record);
            currentMountRecordRef.current = null;
            if (providerCurrentRef.current) {
                dispatchMountRecord({ kind: 'clear', owner });
            }
        };

        return Object.freeze({
            publish(enrichment): boolean {
                if (!canUseProvider()) return false;
                if (enrichment === null) {
                    clearCurrent();
                    return true;
                }
                if (!readCurrentUiContextMountLifecycleActive()) return false;
                if (!acquire()) return false;
                const record = createMountRecord({
                    owner,
                    enrichment,
                    nextCommandId: () => {
                        nextCommandIdRef.current += 1;
                        return `current-ui-command:${nextCommandIdRef.current}`;
                    },
                });
                retireCurrentUiContextMountRecord(currentMountRecordRef.current);
                currentMountRecordRef.current = record;
                dispatchMountRecord({ kind: 'replace', record });
                return true;
            },
            clear(): void {
                if (!canUseProvider()) return;
                clearCurrent();
            },
            dispose(): void {
                if (disposed) return;
                disposed = true;
                clearCurrent();
            },
        });
    }, []);
    const mountPublisher = React.useMemo<CurrentUiContextMountPublisher>(() => Object.freeze({
        createMount,
    }), [createMount]);

    const focusedDetailsWorkspace = hasActiveDetailsWorkspace(appPaneState);
    const snapshot = React.useMemo(() => composeCurrentUiContextSnapshot({
        route,
        visibleModalKind,
        focusedDetailsWorkspace,
        ...(settingsTitle ? {
            settings: {
                title: settingsTitle,
                ...(pluginSettingsPage ? { pluginSettingsPage: true } : {}),
            },
        } : {}),
        ...(pluginPageLabel ? { pluginPage: { label: pluginPageLabel } } : {}),
        sessionActive,
        session,
        machineActive,
        machine,
        privacy: voicePrivacy,
        mobileTab: activeTab,
        ...(mountRecord === null ? {} : { mountEnrichment: mountRecord.projection }),
    }), [
        activeTab,
        focusedDetailsWorkspace,
        machineActive,
        machine,
        mountRecord,
        pluginSettingsPage,
        pluginPageLabel,
        route,
        session,
        sessionActive,
        settingsTitle,
        visibleModalKind,
        voicePrivacy,
    ]);

    React.useLayoutEffect(() => {
        committedSnapshotRef.current = snapshot;
        notifyReaderListeners();
    }, [hostActivelyViewed, notifyReaderListeners, snapshot]);

    return (
        <CurrentUiContextMountPublisherContext.Provider value={mountPublisher}>
            <CurrentUiContextReaderContext.Provider value={reader}>
                {props.children}
            </CurrentUiContextReaderContext.Provider>
        </CurrentUiContextMountPublisherContext.Provider>
    );
}

/** Optional outside AppShell so legacy previews omit the unavailable host method. */
export function useCurrentUiContextMountPublisher(): CurrentUiContextMountPublisher | null {
    return React.useContext(CurrentUiContextMountPublisherContext);
}

/**
 * Lifecycle-safe app-private adapter for a product screen's current-context
 * enrichment. It shares the provider's one composer; it neither stores a
 * screen-local snapshot nor elects a successor among simultaneous panes.
 */
export function usePublishCurrentUiContext(
    enrichment: CurrentUiContextMountedEnrichment | null,
): void {
    const mountPublisher = useCurrentUiContextMountPublisher();
    const currentUiContextEligible = usePluginSurfaceCurrentUiContextEligibility();
    const mountLifecycleActive = useCurrentUiContextMountLifecycleActive();
    const publicationRef = React.useRef<CurrentUiContextMountPublication | null>(null);

    React.useLayoutEffect(() => {
        if (mountPublisher === null) return;
        const publication = mountPublisher.createMount();
        publicationRef.current = publication;
        return () => {
            if (publicationRef.current === publication) {
                publicationRef.current = null;
            }
            publication.dispose();
        };
    }, [mountPublisher]);

    React.useLayoutEffect(() => {
        const publication = publicationRef.current;
        if (publication === null) return;
        // The provider owns native background retirement. A simultaneous
        // focus withdrawal must not let this consumer clear the same record.
        if (!mountLifecycleActive) return;
        if (!currentUiContextEligible) {
            publication.clear();
            return;
        }
        // Native background retirement belongs to the provider's one current
        // record. Retain this screen's latest enrichment here so foreground
        // can republish through the incumbent publication capability.
        publication.publish(enrichment);
    }, [currentUiContextEligible, enrichment, mountLifecycleActive, mountPublisher]);
}

/** Optional outside AppShell so unavailable consumers omit the capability. */
export function useOptionalCurrentUiContextReader(): CurrentUiContextReader | null {
    return React.useContext(CurrentUiContextReaderContext);
}
