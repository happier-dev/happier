import * as React from 'react';
import { useShallow } from 'zustand/react/shallow';
import { publishCommittedAppShellPluginUiProjection, readCurrentAppShellPluginUiExecutionOriginCandidates } from './committedPluginUiProjection';
import type { AppShellPluginUiProjectionRead } from './committedPluginUiProjection';
import {
    createAppShellPluginUiProjectionPublication,
    EMPTY_APP_SHELL_PLUGIN_UI_PROJECTION_SNAPSHOT,
    type AppShellPluginUiProjectionPublication,
} from './appShellPluginUiProjectionPublication';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { createPluginSkillSourceIdentityPublication, EMPTY_PLUGIN_SKILL_SOURCE_IDENTITY,
    type PluginSkillSourceIdentity } from '@/sync/domains/skills/pluginSkillSourceIdentity';

import type { PluginMachineExecutionOriginV1 } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useServerProfilesGeneration } from '@/hooks/server/useServerProfilesGeneration';
import {
    createInstalledPluginUiReactNativeRuntimeProjectionSource,
    type PluginUiReactNativeRuntimeProjectionSource,
} from '@/components/plugins/reactNative/projectionInvalidation';
import { useIsActiveMachineListSettled } from '@/sync/domains/state/storage';
import type { LocalServicePreviewPlatform } from '@/sync/domains/local/services/preview/url';
import {
    EMPTY_PLUGIN_UI_PROJECTION,
    type PluginUiProjectionModel,
} from '@/sync/domains/plugins/ui/projection';
import type { PluginBrowserProjectionModel } from '@/sync/domains/plugins/browser/targets';
import {
    resolvePluginUiClientExecutablePlatform,
    resolvePluginUiProjectionPlatform,
    usePluginUiProjectionCurrentness,
    type PluginUiProjectionCurrentness,
    type PluginUiProjectionPhase,
} from '@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness';
import {
    createPluginUiExecutionOriginCandidatePublication,
    type PluginUiExecutionOriginCandidateFacts,
} from '@/sync/domains/plugins/ui/projectionUnion';
import {
    readPluginAccountAvailability,
    useActivePluginAccountUiProjectionInputs,
    useActivePluginAccountAvailabilityReleaseClassifier,
} from '@/sync/domains/plugins/availability/projection';
import { usePluginMachineExecutionOriginSelection } from '@/sync/domains/machines/administration/usePluginExecutionOriginSelection';
import { getPluginExecutionOriginCandidateOrigin, isPluginMachineExecutionOriginCandidateSelectable } from '@/sync/domains/machines/administration/pluginExecutionOrigin';
import {
    captureActiveServerAccountScopeLifetime,
    type ActiveServerAccountScopeLifetime,
} from '@/sync/domains/scope/activeServerAccountScope';
import { retireIdlePluginUiEphemeralSharedValuesExcept } from '@/components/plugins/surfaces/pluginUiEphemeralSharedScope';
import {
    PluginSurfaceDestinationNavigationBindingProvider,
    PluginSurfacePaneLaunchScope,
    usePluginSurfaceDestinationNavigationBinding,
    usePluginSurfaceDestinationNavigationBindingForScope,
    useRegisterPluginSurfaceDestinationNavigationOwner,
} from '@/components/plugins/surfaces/pluginSurfaceDestinationNavigation';
import { useAppScopeRightSidebarDestinationHandler } from '@/components/appShell/rightSidebar/appScopeRightSidebarNavigation';
import {
    resolvePluginAppPages,
    selectPluginAppPagePlacements,
} from './pluginAppPages';
import { usePluginAppPageDestinationHandler } from './pluginAppPageNavigation';
import { usePluginSettingsPageDestinationHandler } from '@/components/settings/plugins/pluginSettingsPageNavigation';
import { useMachinePresenceMembership } from '@/sync/domains/machines/reachability/useMachinePresenceSummary';
import {
    advanceConnectedAccountDescriptorProjectionState,
    createConnectedAccountDescriptorProjectionLoadingState,
    type ConnectedAccountDescriptorProjectionResolution,
    type ConnectedAccountDescriptorProjectionState,
} from '@/sync/domains/connectedServices/connectedAccountDescriptorProjection';
import {
    getConnectedServiceRegistrySnapshot,
    installConnectedAccountDescriptorProjection,
    retireConnectedAccountDescriptorProjection,
    type ConnectedServiceRegistrySnapshot,
} from '@/sync/domains/connectedServices/connectedServiceRegistry';
import {
    reconcileAppShellProjectedClientExecutables,
    retainAppShellProjectedClientExecutables,
    unloadAppShellProjectedClientExecutables,
} from './appShellClientExecutableActivation';
import type { PluginUiClientExecutableReconciliationAttempt } from '@/components/plugins/reactNative/clientExecutableActivation';
import type { PluginUiExecutableModuleActivationResult } from '@/components/plugins/reactNative/executableModuleHost';
import {
    getBundledConversationRuntimeGenerationRevision,
    subscribeBundledConversationRuntimeGeneration,
} from '@/voice/registry/bundledConversationRuntimeGeneration';
import { useVoiceExecutionMachineId } from '@/voice/credentials/useExecutionMachinePresentation';
import { useVoiceProviderRuntimeDemand } from '@/voice/session/useVoiceProviderRuntimeDemand';

import { PluginAppPageLaunchInputScope } from './pluginAppPageNavigation';
import {
    createPluginLocalizedTextResolver,
    type PluginLocalizedTextResolver,
} from '@/sync/domains/plugins/ui/i18n';
import { usePreferredLanguage } from '@/text/usePreferredLanguage';

export type AppShellPluginUiProjectionValue = Readonly<{
    pluginUiProjection: PluginUiProjectionModel | null;
    pluginBrowserProjection: PluginBrowserProjectionModel | null;
    phase: PluginUiProjectionPhase;
    unavailableReasonCode?: string;
    /** Catalog completeness only; never a contribution's execution authority. */
    hasEstablishingMembers?: boolean;
    interactionEnabled: boolean;
    machineId: string | null;
    serverId: string | null;
    platform: LocalServicePreviewPlatform;
    /** The incumbent Account lifetime fencing this app-scope union. */
    accountLifetime: ActiveServerAccountScopeLifetime | null;
    connectedAccountProjectionRevision?: number;
    connectedAccountProjectionState?: ConnectedAccountDescriptorProjectionState;
    /** Re-read Connected Account descriptors for the active Account scope. */
    reloadConnectedAccountProjection(): void;
    clientExecutableActivation: AppShellClientExecutableActivationState;
    reloadClientExecutables(): void;
}>;

export type AppShellClientExecutableActivationFailure = Readonly<{
    pluginId: string | null;
    target: PluginUiClientExecutableReconciliationAttempt['activation']['target'] | null;
    executionOrigin: PluginUiClientExecutableReconciliationAttempt['activation']['executionOrigin'] | null;
    occurrenceId: string | null;
    code: Extract<PluginUiExecutableModuleActivationResult, Readonly<{ ok: false }>>['code'];
}>;

export type AppShellClientExecutableActivationState =
    | Readonly<{ status: 'establishing' }>
    | Readonly<{ status: 'ready' }>
    | Readonly<{
        status: 'unavailable';
        failures: readonly AppShellClientExecutableActivationFailure[];
    }>;

/**
 * The complete-set settlement is diagnostic state, not a global interaction
 * gate. Exact failures narrow only the plugin whose target failed; an
 * un-attributed owner failure remains conservatively unavailable to all.
 */
export function isAppShellPluginClientExecutableAvailable(
    state: AppShellClientExecutableActivationState | null | undefined,
    pluginId: string,
): boolean {
    if (!state) return true;
    if (state.status !== 'unavailable') return state.status === 'ready';
    return state.failures.length > 0
        && state.failures.every((failure) => failure.pluginId !== null && failure.pluginId !== pluginId);
}

type AppShellPluginRuntimeUpdateSettlement =
    | Readonly<{ status: 'cancelled' }>
    | AppShellClientExecutableActivationState;

const ESTABLISHING_CLIENT_EXECUTABLE_ACTIVATION = Object.freeze({
    status: 'establishing' as const,
});

const READY_CLIENT_EXECUTABLE_ACTIVATION = Object.freeze({
    status: 'ready' as const,
});

const UNAVAILABLE_CLIENT_EXECUTABLE_ACTIVATION = Object.freeze({
    status: 'unavailable' as const,
    failures: Object.freeze([]),
});

const EMPTY_APP_SHELL_PLUGIN_UI_PROJECTION_VALUE: AppShellPluginUiProjectionValue = Object.freeze({
    pluginUiProjection: null,
    pluginBrowserProjection: null,
    phase: 'unavailable',
    interactionEnabled: false,
    machineId: null,
    serverId: null,
    platform: 'web',
    accountLifetime: null,
    connectedAccountProjectionRevision: 0,
    connectedAccountProjectionState: createConnectedAccountDescriptorProjectionLoadingState('unmounted'),
    reloadConnectedAccountProjection: () => {},
    clientExecutableActivation: ESTABLISHING_CLIENT_EXECUTABLE_ACTIVATION,
    reloadClientExecutables: () => {},
});

type AppShellPluginUiProjectionSubscription = Readonly<{
    getSnapshot(): AppShellPluginUiProjectionValue;
    subscribe(listener: () => void): () => void;
}>;
const AppShellPluginUiProjectionContext = React.createContext<AppShellPluginUiProjectionSubscription>({
    getSnapshot: () => EMPTY_APP_SHELL_PLUGIN_UI_PROJECTION_VALUE,
    subscribe: () => () => {},
});
export type AppShellPluginUiDeclarationSources = Readonly<{
    projection: PluginUiProjectionModel | null;
    skillSourceIdentity: PluginSkillSourceIdentity;
    accountLifetime: ActiveServerAccountScopeLifetime | null;
    /** This exact source scope has completed its first descriptive publication. */
    ready: boolean;
}>;
const EMPTY_DECLARATION_SOURCES: AppShellPluginUiDeclarationSources = Object.freeze({ projection: null,
    skillSourceIdentity: EMPTY_PLUGIN_SKILL_SOURCE_IDENTITY, accountLifetime: null, ready: true });
const AppShellPluginUiDeclarationProjectionContext = React.createContext<Readonly<{
    current: AppShellPluginUiDeclarationSources;
    retired: AppShellPluginUiDeclarationSources;
}>>(Object.freeze({ current: EMPTY_DECLARATION_SOURCES, retired: EMPTY_DECLARATION_SOURCES }));

export {
    resolveAppShellPluginProjectionTargets,
    selectCurrentAppShellPluginUiCurrentness,
} from './appShellPluginUiProjectionPublication';
export type {
    AppShellPluginProjectionTarget,
    AppShellAccountScopedPluginExecutionOriginReport,
    AppShellAccountScopedPluginUiCurrentnessReport,
} from './appShellPluginUiProjectionPublication';

function isCurrentAccountLifetime(lifetime: ActiveServerAccountScopeLifetime | null): boolean {
    return lifetime?.isCurrent() ?? true;
}

function accountLifetimeScopeKey(lifetime: ActiveServerAccountScopeLifetime | null): string {
    return lifetime ? JSON.stringify([lifetime.scope.serverId, lifetime.scope.accountId]) : 'no-active-account';
}

export async function settleAppShellPluginRuntimeUpdate(input: Readonly<{
    activate: () => Promise<readonly PluginUiClientExecutableReconciliationAttempt[] | void>;
    isCancelled: () => boolean;
}>): Promise<AppShellPluginRuntimeUpdateSettlement> {
    try {
        if (input.isCancelled()) return { status: 'cancelled' };
        const attempts = await input.activate();
        if (input.isCancelled()) return { status: 'cancelled' };
        const failures = attempts
            ? attempts.flatMap((attempt): readonly AppShellClientExecutableActivationFailure[] => (
                attempt.result.ok
                    ? []
                    : [Object.freeze({
                        pluginId: attempt.activation.pluginId,
                        target: attempt.activation.target,
                        executionOrigin: attempt.activation.executionOrigin,
                        occurrenceId: attempt.activation.occurrenceId,
                        code: attempt.result.code,
                    })]
            ))
            : [];
        return failures.length > 0
            ? Object.freeze({ status: 'unavailable', failures: Object.freeze(failures) })
            : READY_CLIENT_EXECUTABLE_ACTIVATION;
    } catch {
        // Fail closed through the AppShell's incumbent availability seam while
        // still containing the failure at the React-effect boundary.
        return UNAVAILABLE_CLIENT_EXECUTABLE_ACTIVATION;
    }
}

export function AppShellPluginUiProjectionValueProvider(props: Readonly<{
    value: AppShellPluginUiProjectionValue;
    declarationReady?: boolean;
    publication?: Pick<AppShellPluginUiProjectionPublication, 'getSnapshot' | 'subscribe'>;
    children: React.ReactNode;
}>): React.ReactElement {
    // Subscribe to the fields a consumer uses. Machine/source reports must not
    // broadcast unrelated executable and catalog changes through the tree.
    const valueRef = React.useRef(props.value);
    valueRef.current = props.value;
    const [valueListeners] = React.useState(() => new Set<() => void>());
    const [valueSubscription] = React.useState<AppShellPluginUiProjectionSubscription>(() => ({
        getSnapshot: () => valueRef.current,
        subscribe(listener) { valueListeners.add(listener); return () => { valueListeners.delete(listener); }; },
    }));
    React.useLayoutEffect(() => { for (const listener of valueListeners) listener(); }, [props.value, valueListeners]);
    // A retained value still belongs to its original Account, even if a
    // render after withdrawal can already capture another active lifetime.
    const lifetime = props.value.accountLifetime;
    // Standalone composition/specimens use the same descriptive candidate
    // publisher. The real AppShell supplies its already-published fact map.
    const [standaloneCandidates] = React.useState(createPluginUiExecutionOriginCandidatePublication);
    const [standaloneSkills] = React.useState(createPluginSkillSourceIdentityPublication);
    const [standaloneDeclarations, setStandaloneDeclarations] = React.useState<AppShellPluginUiDeclarationSources>(() => Object.freeze({
        projection: null, skillSourceIdentity: EMPTY_PLUGIN_SKILL_SOURCE_IDENTITY, accountLifetime: lifetime, ready: false,
    }));
    const standaloneBasis = React.useRef<PluginUiProjectionModel | null | undefined>(undefined);
    const committedProjectionCleanup = React.useRef<(() => void) | null>(null);
    // The live publication supplies fresh facts through its subscription;
    // executable diagnostics do not change the committed reader's identity.
    const standaloneProjection = props.publication ? null : props.value.pluginUiProjection;
    const standalonePhase = props.publication ? null : props.value.phase;
    const standaloneDeclarationReady = props.publication ? undefined : props.declarationReady;
    const published = props.publication?.getSnapshot();
    const currentDeclarations = React.useMemo<AppShellPluginUiDeclarationSources>(() => {
        if (!props.publication) return standaloneDeclarations;
        const ready = props.declarationReady !== false && published?.accountLifetime === lifetime;
        return Object.freeze({ projection: ready ? published!.pluginUiProjection : null,
            skillSourceIdentity: ready ? published!.skillSourceIdentity : EMPTY_PLUGIN_SKILL_SOURCE_IDENTITY,
            accountLifetime: lifetime, ready });
    }, [props.publication, props.declarationReady, published?.accountLifetime, published?.pluginUiProjection,
        published?.skillSourceIdentity, lifetime, standaloneDeclarations]);
    const declarationSources = React.useMemo(() => Object.freeze({
        current: currentDeclarations,
        // Preserve the retired identity: null must not relabel an in-progress
        // Account transition as an admitted, unscoped builtin-only catalog.
        retired: Object.freeze({ projection: null, skillSourceIdentity: EMPTY_PLUGIN_SKILL_SOURCE_IDENTITY,
            accountLifetime: currentDeclarations.accountLifetime, ready: false }),
    }), [currentDeclarations]);
    React.useLayoutEffect(() => {
        if (!props.publication) {
            const ready = standaloneDeclarationReady !== false && isCurrentAccountLifetime(lifetime);
            const projection = ready ? standaloneProjection : null;
            const skillSourceIdentity = standaloneSkills.publish(projection);
            // Publish projection, identity and original lifetime together. A
            // generation-only preparation never withdraws an in-flight read.
            setStandaloneDeclarations(previous => previous.projection === projection && previous.skillSourceIdentity === skillSourceIdentity
                && previous.accountLifetime === lifetime && previous.ready === ready ? previous
                : Object.freeze({ projection, skillSourceIdentity, accountLifetime: lifetime, ready }));
        }
        if (!props.publication && standaloneBasis.current !== standaloneProjection) {
            standaloneBasis.current = standaloneProjection;
            standaloneCandidates.publish(standaloneProjection, [],
                Object.keys(standaloneProjection?.installedPackagesById ?? {}));
        }
        const read = (input?: AppShellPluginUiProjectionRead) => {
            if (!lifetime?.isCurrent() || (input && !areServerAccountScopesEqual(input.scope, lifetime.scope))) return null;
            if (!props.publication) return input?.declarationsOnly || standalonePhase === 'current'
                ? standaloneProjection : null;
            const snapshot = props.publication.getSnapshot();
            if (snapshot.accountLifetime !== lifetime) return null;
            return input?.declarationsOnly || snapshot.accountUiProjection !== null || snapshot.projectionUnion.phase === 'current'
                ? snapshot.pluginUiProjection : null;
        };
        const readCandidates = (pluginId: string, input?: AppShellPluginUiProjectionRead) => {
            if (!lifetime?.isCurrent() || (input && !areServerAccountScopesEqual(input.scope, lifetime.scope))) return null;
            if (!props.publication) return standaloneCandidates.getSnapshot().get(pluginId) ?? null;
            const snapshot = props.publication.getSnapshot();
            return snapshot.accountLifetime === lifetime
                ? snapshot.candidateFactsByPluginId.get(pluginId) ?? null : null;
        };
        // The publication owner replaces the incumbent binding atomically.
        // Withdrawing it before replacement would notify readers twice.
        const publication = props.publication;
        committedProjectionCleanup.current = publishCommittedAppShellPluginUiProjection(read, readCandidates,
            publication ? listener => publication.subscribe(listener, 'committed') : undefined);
    }, [lifetime, props.publication, standaloneProjection, standalonePhase, standaloneDeclarationReady, standaloneCandidates, standaloneSkills]);
    React.useLayoutEffect(() => () => {
        committedProjectionCleanup.current?.();
        committedProjectionCleanup.current = null;
    }, []);
    return (
        <AppShellPluginUiDeclarationProjectionContext.Provider value={declarationSources}>
            <AppShellPluginUiProjectionContext.Provider value={valueSubscription}>
                {/*
                  * The launch input a plugin page is opened with is scoped HERE, by
                  * that page's stamped union contribution: a bounded argument is
                  * addressed to one page, produced by its own generation and
                  * machine, for one server/account. The app-wide union has no
                  * authority of its own; binding to the contribution owner retires
                  * the input when any of those facts changes.
                  */}
                <PluginAppPageLaunchInputScope
                    pluginUiProjection={props.value.pluginUiProjection}
                >
                    {props.children}
                </PluginAppPageLaunchInputScope>
            </AppShellPluginUiProjectionContext.Provider>
        </AppShellPluginUiDeclarationProjectionContext.Provider>
    );
}

export function AppShellPluginUiProjectionProvider(props: Readonly<{
    children: React.ReactNode;
}>): React.ReactElement {
    const activeInventoryLoaded = useIsActiveMachineListSettled();
    const activeServer = useActiveServerSnapshot();
    // The union is an Account-scoped consumer even when its server id does not
    // change. Capturing the incumbent lifetime gives every report a synchronous
    // fence before Account B renders under the same server/machine coordinates.
    const accountLifetime = captureActiveServerAccountScopeLifetime();
    const { onlineMachineIds, selectableMachineIds } = useMachinePresenceMembership(activeServer.serverId, accountLifetime);
    const serverProfilesGeneration = useServerProfilesGeneration();
    const currentAccountLifetimeKey = accountLifetimeScopeKey(accountLifetime);
    const availabilityInputs = useActivePluginAccountUiProjectionInputs();
    const hostBundledUiEnabled = useFeatureEnabled('plugins.ui.reactNativeBundles', {
        scopeKind: 'spawn', serverId: accountLifetime?.scope.serverId ?? activeServer.serverId,
    });
    const [projectionPublication] = React.useState(createAppShellPluginUiProjectionPublication);
    const publishedProjection = React.useSyncExternalStore(
        projectionPublication.subscribe, projectionPublication.getSnapshot, projectionPublication.getSnapshot,
    );
    // Child layout effects run before their parent's. Do not mount a new
    // Home/Account reporter until its exact source basis has been published.
    const declarationReady = publishedProjection !== EMPTY_APP_SHELL_PLUGIN_UI_PROJECTION_SNAPSHOT
        && publishedProjection.accountLifetime === accountLifetime
        && publishedProjection.activeServerId === activeServer.serverId;
    const derived = declarationReady ? publishedProjection : EMPTY_APP_SHELL_PLUGIN_UI_PROJECTION_SNAPSHOT;
    React.useLayoutEffect(() => {
        projectionPublication.publishSources({
            accountLifetime, availabilityInputs, hostBundledUiEnabled,
            activeServerId: activeServer.serverId, serverProfilesGeneration,
            activeInventoryLoaded, onlineMachineIds, selectableMachineIds,
        });
    }, [accountLifetime, activeInventoryLoaded, activeServer.serverId, availabilityInputs, hostBundledUiEnabled,
        onlineMachineIds, projectionPublication, selectableMachineIds, serverProfilesGeneration]);
    React.useEffect(() => () => projectionPublication.dispose(), [projectionPublication]);
    const {
        accountUiProjection, executionOriginPluginIds, projectionTargets,
        currentnessForActiveAccountByMachineId, projectionUnion, pluginUiProjection,
        candidateFactsByPluginId, connectedAccountResolution, destinationSurfacePlacements, settingsPages,
    } = derived;
    const publishMachineProjectionCurrentness = projectionPublication.publishMachineCurrentness;
    const publishPluginExecutionOrigin = React.useCallback((
        pluginId: string, reportLifetime: ActiveServerAccountScopeLifetime | null,
        origin: PluginMachineExecutionOriginV1 | null, selectableOrigins: readonly PluginMachineExecutionOriginV1[],
        hasStoredTarget = false,
    ) => {
        // The unscoped bootstrap has no Account lifetime to distinguish Homes.
        // An old child's effect must not publish into another Home's sources.
        if (projectionPublication.getSnapshot().activeServerId !== activeServer.serverId) return;
        projectionPublication.publishExecutionOrigin(pluginId, reportLifetime, origin, selectableOrigins, hasStoredTarget);
    }, [activeServer.serverId, projectionPublication]);
    const accountArtifactProjectionSource = React.useRef<PluginUiReactNativeRuntimeProjectionSource | null>(null);
    React.useLayoutEffect(() => {
        const source = accountArtifactProjectionSource.current ?? createInstalledPluginUiReactNativeRuntimeProjectionSource();
        accountArtifactProjectionSource.current = source;
        source.update({ projection: accountUiProjection, accountLifetime,
            isCurrent: () => accountLifetime?.isCurrent() === true });
    }, [accountLifetime, accountUiProjection]);
    React.useEffect(() => () => {
        accountArtifactProjectionSource.current?.dispose();
        accountArtifactProjectionSource.current = null;
    }, []);
    const hasEstablishingMembers = projectionUnion.hasEstablishingMembers;
    const hasCurrentAccountUi = accountUiProjection !== null && isCurrentAccountLifetime(accountLifetime);
    const interactionEnabled = hasCurrentAccountUi || projectionUnion.interactionEnabled;
    const phase = hasCurrentAccountUi ? 'current' : projectionUnion.phase;
    const unavailableReasonCode = hasCurrentAccountUi ? undefined : projectionUnion.unavailableReasonCode;
    // A plugin the Account no longer has enabled takes its retained idle values (a Home widget's
    // warm list, for one) with it, instead of keeping them until the Account changes.
    React.useEffect(() => {
        if (phase !== 'current' || !pluginUiProjection) return;
        const enabledPluginIds = new Set(Object.entries(pluginUiProjection.installedPackagesById)
            .filter(([, installed]) => installed.enabled)
            .map(([pluginId]) => pluginId));
        retireIdlePluginUiEphemeralSharedValuesExcept(captureActiveServerAccountScopeLifetime(), enabledPluginIds);
    }, [phase, pluginUiProjection]);
    const platform = resolvePluginUiProjectionPlatform();
    const clientExecutablePlatform = resolvePluginUiClientExecutablePlatform();
    // §3.2 keeps the browser projection machine-scoped: it describes ONE
    // machine's browser targets, so it is published only when the union has a
    // single member — never merged into a machine-less bag.
    const pluginBrowserProjection = projectionUnion.machineId
        ? currentnessForActiveAccountByMachineId.get(projectionUnion.machineId)?.pluginBrowserProjection ?? null
        : null;
    const voiceExecutionMachineId = useVoiceExecutionMachineId();
    const voiceProviderIds = useVoiceProviderRuntimeDemand();
    // Voice execution stays bound to the USER-selected execution machine. When
    // that machine is already a union member its probe owns the description; a
    // voice machine outside the eligible set (active but past the presence
    // grace) still gets its own dedicated currentness.
    const voiceMachineIsUnionMember = Boolean(voiceExecutionMachineId) && projectionTargets.some(
        (projectionTarget) => projectionTarget.machineId === voiceExecutionMachineId,
    );
    const voiceUnionMember = voiceMachineIsUnionMember && voiceExecutionMachineId
        ? currentnessForActiveAccountByMachineId.get(voiceExecutionMachineId)
        : undefined;
    // Target membership, not currentness settlement: a member whose probe has
    // not published yet must not be double-described by a second subscription. The
    // disabled dedicated hook is exactly the inert placeholder for that gap.
    // First publish the source's target set; an unpublished membership is not
    // evidence that this Voice machine needs a separate reader.
    const requiresDedicatedVoiceProjection = declarationReady && Boolean(voiceExecutionMachineId) && !voiceMachineIsUnionMember;
    const dedicatedVoiceProjectionCurrentness = usePluginUiProjectionCurrentness({
        machineId: voiceExecutionMachineId,
        serverId: activeServer.serverId,
        enabled: requiresDedicatedVoiceProjection,
    });
    const voiceProjectionCurrentness = voiceUnionMember ?? dedicatedVoiceProjectionCurrentness;
    const {
        interactionEnabled: voiceInteractionEnabled,
        machineId: voiceMachineId,
        pluginUiProjection: voicePluginUiProjection,
        serverId: voiceServerId,
    } = voiceProjectionCurrentness;
    const connectedAccountScopeKey = activeServer.serverId?.trim() || 'default';
    const voiceRuntimeGenerationRevision = React.useSyncExternalStore(
        subscribeBundledConversationRuntimeGeneration,
        getBundledConversationRuntimeGenerationRevision,
        getBundledConversationRuntimeGenerationRevision,
    );
    const [clientExecutableReloadRevision, setClientExecutableReloadRevision] = React.useState(0);
    const reloadClientExecutables = React.useCallback(() => {
        setClientExecutableReloadRevision((revision) => revision + 1);
    }, []);
    const [connectedAccountProjectionRevision, setConnectedAccountProjectionRevision] = React.useState(0);
    const [connectedAccountProjectionReloadRevision, setConnectedAccountProjectionReloadRevision] = React.useState(0);
    const reloadConnectedAccountProjection = React.useCallback(() => {
        setConnectedAccountProjectionReloadRevision((revision) => revision + 1);
    }, []);
    const [connectedAccountProjectionState, setConnectedAccountProjectionState] = React.useState<ConnectedAccountDescriptorProjectionState>(
        () => createConnectedAccountDescriptorProjectionLoadingState(connectedAccountScopeKey),
    );
    const connectedAccountProjectionStateRef = React.useRef(connectedAccountProjectionState);
    const installedConnectedAccountLifetimeRef = React.useRef<
        ActiveServerAccountScopeLifetime | null | undefined
    >(undefined);

    const commitConnectedAccountProjection = React.useCallback((
        lifetime: ActiveServerAccountScopeLifetime | null,
        resolution: ConnectedAccountDescriptorProjectionResolution,
    ) => {
        if (
            installedConnectedAccountLifetimeRef.current !== lifetime
            || !isCurrentAccountLifetime(lifetime)
        ) return;
        const previous = connectedAccountProjectionStateRef.current;
        const next = advanceConnectedAccountDescriptorProjectionState(previous, resolution);
        if (next === previous) return;
        connectedAccountProjectionStateRef.current = next;
        installConnectedAccountDescriptorProjection(next, lifetime);
        setConnectedAccountProjectionState(next);
        setConnectedAccountProjectionRevision((revision) => revision + 1);
    }, []);

    React.useEffect(() => {
        const previous = connectedAccountProjectionStateRef.current;
        // An Account lifetime is the authoritative fence when it exists. A
        // pre-profile AppShell has no Account scope to capture, so retain the
        // incumbent server-scope comparison for that explicitly unscoped
        // lifecycle; otherwise a server switch from `null` to `null` would
        // leave its old descriptor projection installed.
        if (
            installedConnectedAccountLifetimeRef.current === accountLifetime
            && (accountLifetime !== null || previous.scopeKey === connectedAccountScopeKey)
        ) return;
        const next = previous.scopeKey === connectedAccountScopeKey
            ? previous
            : createConnectedAccountDescriptorProjectionLoadingState(connectedAccountScopeKey);
        installedConnectedAccountLifetimeRef.current = accountLifetime;
        connectedAccountProjectionStateRef.current = next;
        installConnectedAccountDescriptorProjection(next, accountLifetime);
        setConnectedAccountProjectionState(next);
        setConnectedAccountProjectionRevision((revision) => revision + 1);
    }, [accountLifetime, connectedAccountScopeKey]);

    React.useEffect(() => {
        if (!accountLifetime) return;
        return accountLifetime.onRetire(() => {
            if (installedConnectedAccountLifetimeRef.current !== accountLifetime) return;
            // Retirement can run synchronously while Account B is rendering.
            // Mutate only owner-local refs and the module projection here; the
            // next effect publishes React state for Account B without a
            // render-phase update.
            installedConnectedAccountLifetimeRef.current = undefined;
            connectedAccountProjectionStateRef.current =
                createConnectedAccountDescriptorProjectionLoadingState(connectedAccountScopeKey);
            retireConnectedAccountDescriptorProjection(accountLifetime);
        }).dispose;
    }, [accountLifetime, connectedAccountScopeKey]);

    React.useEffect(() => () => {
        const unmounted = createConnectedAccountDescriptorProjectionLoadingState('unmounted');
        installedConnectedAccountLifetimeRef.current = undefined;
        connectedAccountProjectionStateRef.current = unmounted;
        installConnectedAccountDescriptorProjection(unmounted);
    }, []);

    React.useEffect(() => {
        commitConnectedAccountProjection(accountLifetime, connectedAccountResolution);
    }, [accountLifetime, commitConnectedAccountProjection, connectedAccountResolution]);
    const pluginRuntimeUpdateTailRef = React.useRef<Promise<void>>(Promise.resolve());
    // Activation consumes live admission methods, not the diagnostic observer's
    // cursor/telemetry revision. Actual executable facts and explicit Retry
    // remain dependencies below; every operation still reads current authority.
    const clientExecutableAvailabilityReader = accountLifetime
        ? readPluginAccountAvailability(accountLifetime.scope) : null;
    const clientExecutableActivationBasis = React.useMemo(() => Object.freeze({
        projection: pluginUiProjection,
        platform: clientExecutablePlatform,
        voiceInteractionEnabled,
        voiceMachineId,
        voicePluginUiProjection,
        voiceRuntimeGenerationRevision,
        voiceServerId,
        voiceProviderIds,
        availabilityReader: clientExecutableAvailabilityReader,
        accountLifetime,
    }), [
        accountLifetime,
        clientExecutableAvailabilityReader,
        clientExecutablePlatform,
        pluginUiProjection,
        voiceInteractionEnabled,
        voiceMachineId,
        voicePluginUiProjection,
        voiceRuntimeGenerationRevision,
        voiceServerId,
        voiceProviderIds,
    ]);
    const clientExecutableActivationRequest = React.useMemo(() => Object.freeze({
        basis: clientExecutableActivationBasis,
        reloadRevision: clientExecutableReloadRevision,
    }), [clientExecutableActivationBasis, clientExecutableReloadRevision]);
    const [settledClientExecutableActivation, setSettledClientExecutableActivation] = React.useState<Readonly<{
        request: typeof clientExecutableActivationRequest;
        state: AppShellClientExecutableActivationState;
    }> | null>(null);
    const clientExecutableActivation = settledClientExecutableActivation?.request.basis === clientExecutableActivationBasis
        ? settledClientExecutableActivation.state
        : ESTABLISHING_CLIENT_EXECUTABLE_ACTIVATION;
    const appNavigationBinding = usePluginSurfaceDestinationNavigationBindingForScope({
        placements: destinationSurfacePlacements,
        settingsPages,
        targetKind: 'app',
        accountLifetime,
    });
    const appNavigationBindingRef = React.useRef(appNavigationBinding);
    appNavigationBindingRef.current = appNavigationBinding;
    const readAppNavigationBinding = React.useCallback(() => appNavigationBindingRef.current, []);

    React.useEffect(() => {
        const request = clientExecutableActivationRequest;
        const basis = request.basis;
        const next = basis.projection ?? EMPTY_PLUGIN_UI_PROJECTION;
        let cancelled = false;
        const voice = basis.voiceInteractionEnabled && basis.voiceMachineId && basis.voicePluginUiProjection
            ? Object.freeze({ projection: basis.voicePluginUiProjection, machineId: basis.voiceMachineId, serverId: basis.voiceServerId, providerIds: basis.voiceProviderIds })
            : null;
        // Withdrawal is synchronous inside the existing composition owner,
        // before this request waits on prior cleanup or successor Artifact bytes.
        const retention = retainAppShellProjectedClientExecutables({ projection: next, voice,
            platform: basis.platform, accountLifetime: basis.accountLifetime });
        // This is the one production serial caller. It always reconciles the
        // complete app Action set, and layers the optional Voice family into
        // that same transaction rather than allowing Voice currentness to gate
        // unrelated Action activation.
        const update = pluginRuntimeUpdateTailRef.current.then(async () => {
            await retention;
            const settlement = await settleAppShellPluginRuntimeUpdate({
                isCancelled: () => cancelled,
                activate: async () => {
                    return await reconcileAppShellProjectedClientExecutables({
                        projection: next,
                        platform: basis.platform,
                        // Catalog authority is independent from executable
                        // interaction readiness. Keeping it here prevents a
                        // disabled/offline projected provider from reappearing
                        // through generated fallback metadata.
                        voiceProviderProjection: basis.voicePluginUiProjection,
                        voice,
                        reader: basis.availabilityReader,
                        accountLifetime: basis.accountLifetime,
                        readNavigationBinding: readAppNavigationBinding,
                        isCurrent: () => !cancelled,
                    });
                },
            });
            if (!cancelled && settlement.status !== 'cancelled') {
                setSettledClientExecutableActivation({ request, state: settlement });
            }
        });
        pluginRuntimeUpdateTailRef.current = update;
        return () => { cancelled = true; };
    }, [clientExecutableActivationRequest, readAppNavigationBinding]);

    React.useEffect(() => () => {
        // The executable host is process-global while this update tail belongs
        // to one component instance. Fence every exact-authority leaf so a
        // pending Action or Voice activation cannot publish on remount.
        void unloadAppShellProjectedClientExecutables().catch(() => {
            // Authority is synchronously fenced before cleanup awaits plugin disposal.
        });
    }, []);

    const value = React.useMemo<AppShellPluginUiProjectionValue>(() => ({
        pluginUiProjection,
        pluginBrowserProjection,
        phase,
        unavailableReasonCode,
        hasEstablishingMembers,
        interactionEnabled,
        machineId: projectionUnion.machineId,
        serverId: projectionUnion.serverId,
        platform,
        accountLifetime,
        connectedAccountProjectionRevision,
        connectedAccountProjectionState,
        clientExecutableActivation,
        reloadClientExecutables,
        reloadConnectedAccountProjection,
    }), [accountLifetime, clientExecutableActivation, connectedAccountProjectionRevision, connectedAccountProjectionState, hasEstablishingMembers, interactionEnabled, phase, platform, pluginBrowserProjection, pluginUiProjection, projectionUnion.machineId, projectionUnion.serverId, reloadClientExecutables, reloadConnectedAccountProjection, unavailableReasonCode]);
    return (
        <AppShellPluginUiProjectionValueProvider value={value} declarationReady={declarationReady} publication={projectionPublication}>
            {projectionTargets.map((projectionTarget) => (
                <AppShellPluginUiMachineProjection
                    key={`${currentAccountLifetimeKey}:${projectionTarget.serverId ?? 'default'}:${projectionTarget.machineId}`}
                    machineId={projectionTarget.machineId}
                    serverId={projectionTarget.serverId}
                    reloadRevision={connectedAccountProjectionReloadRevision}
                    accountLifetime={accountLifetime}
                    onCurrentness={publishMachineProjectionCurrentness}
                />
            ))}
            {executionOriginPluginIds.map((pluginId) => (
                <AppShellPluginExecutionOriginSelection
                    key={`${currentAccountLifetimeKey}:${pluginId}`}
                    pluginId={pluginId}
                    accountLifetime={accountLifetime}
                    facts={candidateFactsByPluginId.get(pluginId)!}
                    onOrigin={publishPluginExecutionOrigin}
                />
            ))}
            <PluginSurfaceDestinationNavigationBindingProvider binding={appNavigationBinding}>
                {/*
                  * The app-scope pane handoff scope is app-lifetime because its
                  * producer is: a plugin can open an app right-sidebar tab before
                  * that route exists, and the bounded launch input has to survive
                  * the navigation that mounts it. Cockpit routes still establish
                  * their own narrower scope inside this one.
                  */}
                <PluginSurfacePaneLaunchScope>
                    <AppShellPluginSurfaceNavigationOwners />
                    {props.children}
                </PluginSurfacePaneLaunchScope>
            </PluginSurfaceDestinationNavigationBindingProvider>
        </AppShellPluginUiProjectionValueProvider>
    );
}

/**
 * The app route, Settings route and app right sidebar remain their own
 * incumbent navigation owners. This renderless bridge only registers those
 * existing adapters with the one app-target binding; it owns no router state or
 * destination choice.
 *
 * Every app-target container registers here, at app lifetime, because that is
 * what makes a plugin's FIRST `openSurface` reach a destination whose screen is
 * not mounted yet. A container registered from its own leaf could only ever be
 * opened once that leaf was already on screen.
 */
function AppShellPluginSurfaceNavigationOwners(): null {
    const projection = useAppShellPluginUiProjection();
    const localize = useProjectedPluginLocalizedTextResolver();
    const binding = usePluginSurfaceDestinationNavigationBinding();
    const pages = React.useMemo(() => resolvePluginAppPages({
        placements: selectPluginAppPagePlacements(projection.pluginUiProjection),
        localize,
    }), [localize, projection.pluginUiProjection]);
    const openPage = usePluginAppPageDestinationHandler({ pages });
    const openSettingsPage = usePluginSettingsPageDestinationHandler({
        projection: projection.pluginUiProjection,
    });
    const openRightSidebarTab = useAppScopeRightSidebarDestinationHandler();
    const pageOwner = React.useMemo(() => ({
        container: 'appPage' as const,
        handler: openPage,
    }), [openPage]);
    const settingsOwner = React.useMemo(() => ({
        container: 'settingsPage' as const,
        handler: openSettingsPage,
    }), [openSettingsPage]);
    const rightSidebarOwner = React.useMemo(() => ({
        container: 'rightSidebarTab' as const,
        handler: openRightSidebarTab,
    }), [openRightSidebarTab]);
    useRegisterPluginSurfaceDestinationNavigationOwner(pageOwner, binding);
    useRegisterPluginSurfaceDestinationNavigationOwner(settingsOwner, binding);
    useRegisterPluginSurfaceDestinationNavigationOwner(rightSidebarOwner, binding);
    return null;
}

/**
 * One eligible machine's plugin-UI projection, published into the app-scope
 * union.
 *
 * Per-machine currentness — reconnect epochs, daemon state versions, projection
 * invalidation revisions and executable authority — stays owned by
 * `usePluginUiProjectionCurrentness`. A union across N machines needs N of those
 * subscriptions and React has no way to call a hook per member, so each member
 * is one renderless child. This adds no second currentness owner, no polling and
 * no parallel registry: it is the hook, once per machine.
 */
const AppShellPluginUiMachineProjection = React.memo(function AppShellPluginUiMachineProjection(props: Readonly<{
    machineId: string;
    serverId: string | null;
    reloadRevision: number;
    accountLifetime: ActiveServerAccountScopeLifetime | null;
    onCurrentness: (
        machineId: string,
        accountLifetime: ActiveServerAccountScopeLifetime | null,
        currentness: PluginUiProjectionCurrentness,
    ) => void;
}>): null {
    const currentness = usePluginUiProjectionCurrentness({
        machineId: props.machineId,
        serverId: props.serverId,
        reloadRevision: props.reloadRevision,
    });
    const { accountLifetime, machineId, onCurrentness } = props;
    // Publish retained presentation before paint, so the first rail fit uses
    // the same catalog as its mounted currentness readers.
    React.useLayoutEffect(() => {
        onCurrentness(machineId, accountLifetime, currentness);
    }, [accountLifetime, currentness, machineId, onCurrentness]);
    return null;
});

/**
 * One renderless consumer of Administration's exact-origin owner. Dynamic
 * plugin materializations need dynamic hook instances, so each admitted plugin
 * gets a child; this component has no local classifier, election, persistence,
 * or fallback path. It publishes the selected origin and selectable candidate
 * origins from that same owner; the union never reclassifies candidate facts.
 */
const AppShellPluginExecutionOriginSelection = React.memo(function AppShellPluginExecutionOriginSelection(props: Readonly<{
    pluginId: string;
    accountLifetime: ActiveServerAccountScopeLifetime | null;
    facts: PluginUiExecutionOriginCandidateFacts;
    onOrigin: (
        pluginId: string,
        accountLifetime: ActiveServerAccountScopeLifetime | null,
        origin: PluginMachineExecutionOriginV1 | null,
        selectableOrigins: readonly PluginMachineExecutionOriginV1[],
        hasStoredTarget: boolean,
    ) => void;
}>): null {
    const classifyRelease = useActivePluginAccountAvailabilityReleaseClassifier(props.pluginId);
    const selection = usePluginMachineExecutionOriginSelection({
        pluginId: props.pluginId,
        includeMachineCandidates: false,
        classifyRelease,
        ...props.facts,
        readSourceCandidates: React.useCallback(() => readCurrentAppShellPluginUiExecutionOriginCandidates(props.pluginId).sourceCandidates, [props.pluginId]),
        readMachineRejections: React.useCallback(() => readCurrentAppShellPluginUiExecutionOriginCandidates(props.pluginId).machineRejections, [props.pluginId]),
        readDeclaredDefaultOrigins: React.useCallback(() => readCurrentAppShellPluginUiExecutionOriginCandidates(props.pluginId).declaredDefaultOrigins, [props.pluginId]),
    });
    // Retain exact user intent while its machine/source is unavailable. Losing
    // that preference here would let the union bind a different sole supplier.
    // Administration and each supply's currentness still own executable admission.
    const origin = selection.selectedOrigin;
    const hasStoredTarget = Boolean(selection.storedTarget);
    const selectableOrigins = React.useMemo(() => Object.freeze(selection.candidates
        .filter(isPluginMachineExecutionOriginCandidateSelectable)
        .map(getPluginExecutionOriginCandidateOrigin)), [selection.candidates]);
    React.useEffect(() => {
        props.onOrigin(props.pluginId, props.accountLifetime, origin, selectableOrigins, hasStoredTarget);
    }, [origin, selectableOrigins, hasStoredTarget, props.accountLifetime, props.onOrigin, props.pluginId]);
    return null;
});

const readAppShellPluginUiProjection = (value: AppShellPluginUiProjectionValue) => value;

export function useAppShellPluginUiProjection<T>(selector: (value: AppShellPluginUiProjectionValue) => T): T;
export function useAppShellPluginUiProjection(): AppShellPluginUiProjectionValue;
export function useAppShellPluginUiProjection<T>(selector?: (value: AppShellPluginUiProjectionValue) => T): AppShellPluginUiProjectionValue | T {
    const context = React.useContext(AppShellPluginUiProjectionContext);
    const select = useShallow<AppShellPluginUiProjectionValue, AppShellPluginUiProjectionValue | T>(selector ?? readAppShellPluginUiProjection);
    const getSnapshot = React.useCallback(() => select(context.getSnapshot()), [context, select]);
    return React.useSyncExternalStore(context.subscribe, getSnapshot, getSnapshot);
}

/** Descriptive declaration consumers do not need executable diagnostics. */
export function useAppShellPluginUiDeclarationProjection(): PluginUiProjectionModel | null {
    return useAppShellPluginUiDeclarationSources().projection;
}

/** The declaration and the lifetime that admitted it must never be recaptured separately. */
export function useAppShellPluginUiDeclarationSources(): AppShellPluginUiDeclarationSources {
    const sources = React.useContext(AppShellPluginUiDeclarationProjectionContext);
    return sources.current.accountLifetime && !sources.current.accountLifetime.isCurrent() ? sources.retired : sources.current;
}

export function useProjectedConnectedServicesRegistry(): ConnectedServiceRegistrySnapshot {
    useAppShellPluginUiProjection(value => value.connectedAccountProjectionRevision);
    return getConnectedServiceRegistrySnapshot();
}

/** Binds plugin-authored text to the exact current app-scope projection and locale. */
export function useProjectedPluginLocalizedTextResolver(): PluginLocalizedTextResolver {
    const projection = useAppShellPluginUiDeclarationProjection();
    const locale = usePreferredLanguage();
    return React.useMemo(
        () => createPluginLocalizedTextResolver({ projection, locale }),
        [locale, projection],
    );
}
