import * as React from 'react';
import { AppState } from 'react-native';
import { useShallow } from 'zustand/react/shallow';
import { publishCommittedAppShellPluginUiProjection, readCurrentAppShellPluginUiExecutionOriginCandidates } from './committedPluginUiProjection';
import type { AppShellPluginUiProjectionRead } from './committedPluginUiProjection';
import {
    createAppShellPluginUiProjectionPublication,
    EMPTY_APP_SHELL_PLUGIN_UI_PROJECTION_SNAPSHOT,
    type AppShellPluginUiProjectionPublication,
    type AppShellPluginUiProjectionSnapshot,
} from './appShellPluginUiProjectionPublication';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { createPluginSkillSourceIdentityPublication, EMPTY_PLUGIN_SKILL_SOURCE_IDENTITY,
    type PluginSkillSourceIdentity } from '@/sync/domains/skills/pluginSkillSourceIdentity';

import type { PluginMachineExecutionOriginV1 } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import { parseQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contributionIdentity';
import { projectConnectedAccountDescriptorV1 } from '@happier-dev/protocol/connect/connectedAccountUiProjectionV1';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useServerProfilesGeneration } from '@/hooks/server/useServerProfilesGeneration';
import {
    createInstalledPluginUiReactNativeRuntimeProjectionSource,
    releaseRetainedInstalledPluginUiReactNativeArtifacts,
    retainInstalledPluginUiReactNativeArtifactsForEnabledPlugins,
    type PluginUiReactNativeRuntimeProjectionSource,
} from '@/components/plugins/reactNative/projectionInvalidation';
import { useIsActiveMachineListSettled, useSettingsSelector } from '@/sync/domains/state/storage';
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
    projectPluginUiProjectionAvailability,
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
    usePluginPages,
    selectPluginPagePlacements,
} from '@/components/plugins/pages/pluginPages';
import { usePluginPageDestinationHandler } from '@/components/plugins/pages/pluginPageNavigation';
import { usePluginSettingsPageDestinationHandler } from '@/components/settings/plugins/pluginSettingsPageNavigation';
import { useMachinePresenceMembership } from '@/sync/domains/machines/reachability/useMachinePresenceSummary';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
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
import type { PluginUiClientActionAdmissionSource } from '@/components/plugins/reactNative/clientActionAdmission';
import type { PluginUiClientExecutableReconciliationAttempt } from '@/components/plugins/reactNative/clientExecutableActivation';
import { readPluginUiClientExecutableProjectionFacts,
    type PluginUiClientExecutableProjectionSource } from '@/components/plugins/reactNative/clientExecutableProjection';
import { MountedClientActionDemandContext } from './mountedClientActionDemand';
import {
    getBundledConversationRuntimeGenerationRevision,
    subscribeBundledConversationRuntimeGeneration,
} from '@/voice/registry/bundledConversationRuntimeGeneration';
import { useVoiceExecutionMachineId } from '@/voice/credentials/useExecutionMachinePresentation';
import { useVoiceProviderRuntimeDemand } from '@/voice/session/useVoiceProviderRuntimeDemand';
import { bindVoiceProviderRuntimeDemandActivation, rejectVoiceProviderRuntimeDemands } from '@/voice/session/voiceProviderRuntimeDemand';
import { resolveStoredVoiceProviderId } from '@/voice/settings/resolveVoiceProviderId';

import { PluginPageLaunchInputScope } from '@/components/plugins/pages/pluginPageNavigation';
import {
    createPluginUiTranslationRuntime,
    PluginUiTranslationRuntimeProvider,
    usePluginLocalizedTextResolver,
    type PluginLocalizedTextResolver,
} from '@/sync/domains/plugins/ui/i18n';
import { createPluginUiTranslationResourceByteReader } from '@/sync/domains/plugins/availability/translationResourceBytes';
import { getActivePluginAccountPackageAssetSource } from '@/sync/api/plugins/availability/activePluginAccountPackageAssetRead';
import { usePreferredLanguage } from '@/text/usePreferredLanguage';

export type AppShellPluginUiProjectionValue = Readonly<{
    pluginUiProjection: PluginUiProjectionModel | null;
    mountedActionProjections?: readonly PluginUiClientExecutableProjectionSource[];
    pluginBrowserProjection: PluginBrowserProjectionModel | null;
    phase: PluginUiProjectionPhase;
    unavailableReasonCode?: string;
    /** Catalog completeness only; never a contribution's execution authority. */
    hasEstablishingMembers?: boolean;
    /** The Account's initial declaration census is still in flight. */
    accountCensusPending?: boolean;
    /** A registry source may still arrive (the publication's fact); absent means settled. */
    registrySourcesPending?: boolean;
    /** The Machines still owing registry sources, for the surface that waits on them to read. */
    registrySourcesPendingTargets?: readonly AppShellPluginProjectionTarget[];
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
    getVoiceProviderActivation?: (providerId: string) => Promise<void> | null;
}>;

export type AppShellClientExecutableActivationFailure = Readonly<{
    pluginId: string | null;
    target: PluginUiClientExecutableReconciliationAttempt['activation']['target'] | null;
    executionOrigin: PluginUiClientExecutableReconciliationAttempt['activation']['executionOrigin'] | null;
    occurrenceId: string | null;
    code: Extract<PluginUiClientExecutableReconciliationAttempt['result'], Readonly<{ ok: false }>>['code'];
    layer?: 'artifact' | 'registration';
    phase?: 'preparation' | 'activation';
    retryable?: boolean;
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
export function createAppShellClientActionAdmissionSource(
    subscription: AppShellPluginUiProjectionSubscription,
): PluginUiClientActionAdmissionSource {
    return {
        read: () => {
            const value = subscription.getSnapshot();
            return { projection: value.pluginUiProjection, platform: resolvePluginUiClientExecutablePlatform(),
                accountCensusPending: value.accountCensusPending, mountedActionProjections: value.mountedActionProjections,
                activation: value.clientExecutableActivation, accountLifetime: value.accountLifetime };
        },
        subscribe: subscription.subscribe,
    };
}

const noProjectionSubscription = () => () => {};
const AppShellPluginUiProjectionContext = React.createContext<AppShellPluginUiProjectionSubscription>({
    getSnapshot: () => EMPTY_APP_SHELL_PLUGIN_UI_PROJECTION_VALUE,
    subscribe: noProjectionSubscription,
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
} from './appShellPluginUiProjectionPublication';
export type {
    AppShellPluginProjectionTarget,
    AppShellAccountScopedPluginExecutionOriginReport,
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
                        ...('layer' in attempt.result ? { layer: attempt.result.layer, phase: attempt.result.phase,
                            retryable: attempt.result.retryable } : {}),
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
    publication?: Pick<AppShellPluginUiProjectionPublication, 'getSnapshot' | 'subscribe'>
        & Partial<Pick<AppShellPluginUiProjectionPublication, 'publishMountedActions' | 'acquireExecutionOriginDemand'
            | 'readExecutionOriginCandidates' | 'isAccountUiProjectionPending'>>;
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
    const translationProjection = currentDeclarations.projection ?? EMPTY_PLUGIN_UI_PROJECTION;
    const translationProjectionRef = React.useRef(translationProjection);
    translationProjectionRef.current = translationProjection;
    const translationAssetSource = getActivePluginAccountPackageAssetSource();
    // Construction is inert. Presentation reconnections retain this Account's
    // copy owner; source and locale changes are admitted by the runtime itself.
    const translationRuntime = React.useMemo(() => createPluginUiTranslationRuntime({
        projection: translationProjectionRef.current,
        readResourceBytes: async () => null,
        createResourceReader: (readCurrentProjection) => lifetime
            ? createPluginUiTranslationResourceByteReader({ accountLifetime: lifetime, readCurrentProjection,
                packageAssets: { reader: readPluginAccountAvailability(lifetime.scope),
                    source: translationAssetSource } })
            : async () => null,
    }), [lifetime, translationAssetSource]);
    React.useEffect(() => {
        const retirement = lifetime?.onRetire(() => translationRuntime.dispose());
        return () => { retirement?.dispose(); translationRuntime.dispose(); };
    }, [lifetime, translationRuntime]);
    React.useLayoutEffect(() => translationRuntime.setProjection(translationProjection), [translationProjection, translationRuntime]);
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
            standaloneCandidates.publish(standaloneProjection, [], []);
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
            if (!props.publication) return standaloneProjection?.installedPackagesById[pluginId]
                ? standaloneCandidates.read(pluginId) : null;
            const snapshot = props.publication.getSnapshot();
            return snapshot.accountLifetime === lifetime
                ? props.publication.readExecutionOriginCandidates?.(pluginId) ?? snapshot.candidateFactsByPluginId.get(pluginId) ?? null : null;
        };
        // Until the publication serves this Account, its registry sources are still owed.
        const readRegistrySourcesPending = (input?: AppShellPluginUiProjectionRead) => {
            if (!lifetime?.isCurrent() || (input && !areServerAccountScopesEqual(input.scope, lifetime.scope))) return false;
            if (!props.publication) return false;
            const snapshot = props.publication.getSnapshot();
            return snapshot.accountLifetime !== lifetime || snapshot.registrySourcesPending;
        };
        const readDeclarationsPending = (input: AppShellPluginUiProjectionRead, accountProjection?: PluginUiProjectionModel) => {
            if (!lifetime?.isCurrent() || !areServerAccountScopesEqual(input.scope, lifetime.scope)) return false;
            if (accountProjection) return props.publication?.isAccountUiProjectionPending?.(accountProjection) ?? false;
            if (!props.publication) return standaloneDeclarationReady === false;
            const snapshot = props.publication.getSnapshot();
            return snapshot.accountLifetime !== lifetime || snapshot.accountCensusPending
                || snapshot.projectionUnion.hasEstablishingMembers;
        };
        const readExecutionOriginSelectionPending = (pluginId: string, input: AppShellPluginUiProjectionRead) => {
            if (!lifetime?.isCurrent() || !areServerAccountScopesEqual(input.scope, lifetime.scope)) return false;
            const snapshot = props.publication?.getSnapshot();
            return snapshot?.accountLifetime === lifetime
                && snapshot.executionOriginReportsByPluginId.get(pluginId)?.loading === true;
        };
        // The publication owner replaces the incumbent binding atomically.
        // Withdrawing it before replacement would notify readers twice.
        const publication = props.publication;
        committedProjectionCleanup.current = publishCommittedAppShellPluginUiProjection(read, readCandidates,
            publication ? listener => publication.subscribe(listener, 'committed') : undefined, translationRuntime,
            providerId => valueRef.current.getVoiceProviderActivation?.(providerId) ?? null, readRegistrySourcesPending,
            publication?.acquireExecutionOriginDemand, readExecutionOriginSelectionPending, readDeclarationsPending,
            createAppShellClientActionAdmissionSource(valueSubscription));
    }, [lifetime, props.publication, standaloneProjection, standalonePhase, standaloneDeclarationReady, standaloneCandidates, standaloneSkills, translationRuntime, valueSubscription]);
    React.useLayoutEffect(() => () => {
        committedProjectionCleanup.current?.();
        committedProjectionCleanup.current = null;
    }, []);
    return (
        <MountedClientActionDemandContext.Provider value={props.publication?.publishMountedActions ?? null}>
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
                <PluginUiTranslationRuntimeProvider runtime={translationRuntime}>
                <PluginPageLaunchInputScope
                    target={{ kind: 'app' }}
                    pluginUiProjection={props.value.pluginUiProjection}
                >
                    {props.children}
                </PluginPageLaunchInputScope>
                </PluginUiTranslationRuntimeProvider>
            </AppShellPluginUiProjectionContext.Provider>
        </AppShellPluginUiDeclarationProjectionContext.Provider>
        </MountedClientActionDemandContext.Provider>
    );
}

function selectAppShellPluginUiPresentation(snapshot: AppShellPluginUiProjectionSnapshot, voiceMachineId: string | null) {
    const { currentnessForActiveAccountByMachineId, projectionUnion } = snapshot;
    return {
        published: snapshot !== EMPTY_APP_SHELL_PLUGIN_UI_PROJECTION_SNAPSHOT,
        accountLifetime: snapshot.accountLifetime,
        activeServerId: snapshot.activeServerId,
        accountUiProjection: snapshot.accountUiProjection,
        accountCensusPending: snapshot.accountCensusPending,
        projectionTargets: snapshot.projectionTargets,
        projectionUnion,
        pluginUiProjection: snapshot.pluginUiProjection,
        mountedActionProjections: snapshot.mountedActionProjections,
        candidateFactsByPluginId: snapshot.candidateFactsByPluginId,
        connectedAccountResolution: snapshot.connectedAccountResolution,
        destinationSurfacePlacements: snapshot.destinationSurfacePlacements,
        settingsPages: snapshot.settingsPages,
        registrySourcesPending: snapshot.registrySourcesPending,
        registrySourcesPendingTargets: snapshot.registrySourcesPendingTargets,
        // Browser targets belong to a single Machine and cannot be merged.
        pluginBrowserProjection: projectionUnion.machineId
            ? currentnessForActiveAccountByMachineId.get(projectionUnion.machineId)?.pluginBrowserProjection ?? null
            : null,
        voiceCurrentness: voiceMachineId ? currentnessForActiveAccountByMachineId.get(voiceMachineId) : undefined,
    };
}

const EMPTY_APP_SHELL_PLUGIN_UI_PRESENTATION = selectAppShellPluginUiPresentation(EMPTY_APP_SHELL_PLUGIN_UI_PROJECTION_SNAPSHOT, null);

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
    const voiceExecutionMachineId = useVoiceExecutionMachineId();
    const [projectionPublication] = React.useState(createAppShellPluginUiProjectionPublication);
    // Reports from other Machines only affect the shell when a derived fact changes.
    const selectPresentation = useShallow((snapshot: AppShellPluginUiProjectionSnapshot) =>
        selectAppShellPluginUiPresentation(snapshot, voiceExecutionMachineId));
    const getPresentation = () => selectPresentation(projectionPublication.getSnapshot());
    const publishedProjection = React.useSyncExternalStore(projectionPublication.subscribe, getPresentation, getPresentation);
    // Child layout effects run before their parent's. Do not mount a new
    // Home/Account reporter until its exact source basis has been published.
    const declarationReady = publishedProjection.published
        && publishedProjection.accountLifetime === accountLifetime
        && publishedProjection.activeServerId === activeServer.serverId;
    const derived = declarationReady ? publishedProjection : EMPTY_APP_SHELL_PLUGIN_UI_PRESENTATION;
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
        accountUiProjection, accountCensusPending, projectionTargets,
        projectionUnion, pluginUiProjection, mountedActionProjections, candidateFactsByPluginId,
        connectedAccountResolution, destinationSurfacePlacements, settingsPages,
        registrySourcesPending, registrySourcesPendingTargets, pluginBrowserProjection, voiceCurrentness,
    } = derived;
    const publishMachineProjectionCurrentness = projectionPublication.publishMachineCurrentness;
    const publishPluginExecutionOrigin = React.useCallback((
        pluginId: string, reportLifetime: ActiveServerAccountScopeLifetime | null,
        origin: PluginMachineExecutionOriginV1 | null, selectableOrigins: readonly PluginMachineExecutionOriginV1[],
        hasStoredTarget = false,
        loading = false,
    ) => {
        // The unscoped bootstrap has no Account lifetime to distinguish Homes.
        // An old child's effect must not publish into another Home's sources.
        if (projectionPublication.readActiveServerId() !== activeServer.serverId) return;
        projectionPublication.publishExecutionOrigin(pluginId, reportLifetime, origin, selectableOrigins, hasStoredTarget, loading);
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
    // Retained plugin Artifacts (bytes + compiled programs) are re-creatable; the platform's
    // memory-pressure signal (iOS) releases those no mounted scope declares.
    React.useEffect(() => {
        const subscription = AppState.addEventListener('memoryWarning', releaseRetainedInstalledPluginUiReactNativeArtifacts);
        // react-native-web accepts 'memoryWarning' but returns no subscription (only 'change' is wired on web).
        return () => (subscription as typeof subscription | undefined)?.remove();
    }, []);
    const hasEstablishingMembers = projectionUnion.hasEstablishingMembers;
    const hasCurrentAccountUi = accountUiProjection !== null && isCurrentAccountLifetime(accountLifetime);
    const { interactionEnabled, phase, unavailableReasonCode } = projectPluginUiProjectionAvailability(
        projectionUnion, hasCurrentAccountUi ? accountUiProjection : null,
    );
    // A plugin the Account no longer has enabled takes its retained idle values (a Home widget's
    // warm list, for one) and its retained Artifact bytes and compiled modules with it, instead of
    // keeping them until the Account changes.
    React.useEffect(() => {
        if (phase !== 'current' || !pluginUiProjection) return;
        const enabledPluginIds = new Set(Object.entries(pluginUiProjection.installedPackagesById)
            .filter(([, installed]) => installed.enabled)
            .map(([pluginId]) => pluginId));
        const lifetime = captureActiveServerAccountScopeLifetime();
        retireIdlePluginUiEphemeralSharedValuesExcept(lifetime, enabledPluginIds);
        retainInstalledPluginUiReactNativeArtifactsForEnabledPlugins(lifetime, enabledPluginIds);
    }, [phase, pluginUiProjection]);
    const platform = resolvePluginUiProjectionPlatform();
    const clientExecutablePlatform = resolvePluginUiClientExecutablePlatform();
    const voiceProviderIds = useVoiceProviderRuntimeDemand();
    const selectedVoiceProviderId = useSettingsSelector(settings => resolveStoredVoiceProviderId(settings.voiceSettingsV1.providerId), ['voiceSettingsV1']);
    // Selection needs declarations for discovery and Start admission, even while
    // no attempt demands the provider's executable adapter.
    const voiceProjectionDemand = (selectedVoiceProviderId !== null && parseQualifiedPluginContributionKey(selectedVoiceProviderId) !== null)
        || Array.from(voiceProviderIds).some((id) => parseQualifiedPluginContributionKey(id) !== null);
    // Voice execution stays bound to the USER-selected execution machine. When
    // that machine is already a union member its observer owns acquisition; a
    // voice machine outside the eligible set (active but past the presence
    // grace) uses dedicated currentness. A selected or active contributed
    // provider demands the declarations needed by generic executable activation.
    const voiceMachineIsUnionMember = Boolean(voiceExecutionMachineId) && projectionTargets.some(
        (projectionTarget) => projectionTarget.machineId === voiceExecutionMachineId,
    );
    const voiceUnionMember = voiceMachineIsUnionMember ? voiceCurrentness : undefined;
    // Target membership, not currentness settlement: a member whose observer has
    // not published yet does not need a second subscription. The
    // disabled dedicated hook is exactly the inert placeholder for that gap.
    // First publish the source's target set; an unpublished membership is not
    // evidence that this Voice machine needs another observer.
    const requiresDedicatedVoiceProjection = declarationReady && Boolean(voiceExecutionMachineId) && !voiceMachineIsUnionMember;
    const dedicatedVoiceProjectionCurrentness = usePluginUiProjectionCurrentness({
        machineId: voiceExecutionMachineId,
        serverId: activeServer.serverId,
        enabled: requiresDedicatedVoiceProjection,
        load: voiceProjectionDemand,
    });
    const voiceProjectionCurrentness = voiceUnionMember ?? dedicatedVoiceProjectionCurrentness;
    const voiceProjectionAcquiring = voiceProjectionDemand && Boolean(voiceExecutionMachineId) && (
        !declarationReady
        || (voiceMachineIsUnionMember && !voiceUnionMember)
        || voiceProjectionCurrentness.phase === 'establishing'
    );
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
    const [executeProjectionAction] = React.useState(() => createFrontDoorActionExecute());
    const reloadConnectedAccountProjection = React.useCallback(() => {
        if (!accountLifetime?.isCurrent()) return;
        void executeProjectionAction('connectedServices.catalog.list', { refresh: true }, {
            surface: 'ui', authority: 'present_user', serverId: accountLifetime.scope.serverId,
            expectedAccountId: accountLifetime.scope.accountId,
        }).catch(() => {});
    }, [accountLifetime, executeProjectionAction]);
    const [connectedAccountProjectionState, setConnectedAccountProjectionState] = React.useState<ConnectedAccountDescriptorProjectionState>(
        () => createConnectedAccountDescriptorProjectionLoadingState(connectedAccountScopeKey),
    );
    const connectedAccountProjectionStateRef = React.useRef(connectedAccountProjectionState);
    const installedConnectedAccountLifetimeRef = React.useRef<
        ActiveServerAccountScopeLifetime | null | undefined
    >(undefined);
    const accountConnectedAccountDescriptors = availabilityInputs?.accountUiProjection?.connectedAccountDescriptorsById;
    const accountConnectedAccountMetadata = React.useMemo(() => Object.freeze(
        Object.values(accountConnectedAccountDescriptors ?? {}).map(({ pluginId, definition, hostAccountOrigin, nativeLoginRequiredBy }) =>
            projectConnectedAccountDescriptorV1({ descriptor: definition, pluginId, serviceId: definition.id,
                nativeLoginRequiredBy,
                provenance: hostAccountOrigin.sourceCustody.kind === 'bundled_first_party' ? 'first_party' : 'external',
                sourceKind: hostAccountOrigin.sourceCustody.kind === 'bundled_first_party' ? 'bundled' : 'account_release',
                availability: { state: 'available', reason: 'account_declaration' }, diagnostics: [] })),
    ), [accountConnectedAccountDescriptors]);

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
        const registryChanged = installConnectedAccountDescriptorProjection(next, lifetime, accountConnectedAccountMetadata);
        if (next === previous) {
            if (registryChanged) setConnectedAccountProjectionRevision((revision) => revision + 1);
            return;
        }
        connectedAccountProjectionStateRef.current = next;
        setConnectedAccountProjectionState(next);
        setConnectedAccountProjectionRevision((revision) => revision + 1);
    }, [accountConnectedAccountMetadata]);

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
        installConnectedAccountDescriptorProjection(next, accountLifetime, accountConnectedAccountMetadata);
        setConnectedAccountProjectionState(next);
        setConnectedAccountProjectionRevision((revision) => revision + 1);
    }, [accountLifetime, connectedAccountScopeKey, accountConnectedAccountMetadata]);

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
    // Activation consumes live admission methods, not the diagnostic observer's
    // cursor/telemetry revision. Actual executable facts and explicit Retry
    // remain dependencies below; every operation still reads current authority.
    const clientExecutableAvailabilityReader = accountLifetime
        ? readPluginAccountAvailability(accountLifetime.scope) : null;
    const selectExecutableFacts = useShallow((projection: PluginUiProjectionModel | null) => projection
        ? readPluginUiClientExecutableProjectionFacts(projection) : null);
    const selectVoiceExecutableFacts = useShallow((projection: PluginUiProjectionModel | null) => projection
        ? readPluginUiClientExecutableProjectionFacts(projection) : null);
    const executableFacts = selectExecutableFacts(pluginUiProjection);
    const voiceExecutableFacts = selectVoiceExecutableFacts(voicePluginUiProjection);
    // A new admission samples the complete projection; presentation-only
    // changes do not withdraw an unchanged executable admission.
    const presentationRef = React.useRef({ pluginUiProjection, voicePluginUiProjection });
    presentationRef.current = { pluginUiProjection, voicePluginUiProjection };
    const clientExecutableActivationBasis = React.useMemo(() => Object.freeze({
        executableFacts,
        mountedActionProjections,
        platform: clientExecutablePlatform,
        voiceInteractionEnabled,
        voiceProjectionAcquiring,
        voiceMachineId,
        voiceExecutableFacts,
        voiceRuntimeGenerationRevision,
        voiceServerId,
        voiceProviderIds,
        availabilityReader: clientExecutableAvailabilityReader,
        accountLifetime,
    }), [
        accountLifetime,
        clientExecutableAvailabilityReader,
        clientExecutablePlatform,
        executableFacts,
        mountedActionProjections,
        voiceInteractionEnabled,
        voiceProjectionAcquiring,
        voiceMachineId,
        voiceExecutableFacts,
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
    const clientExecutableActivation = !voiceProjectionAcquiring
        && settledClientExecutableActivation?.request.basis === clientExecutableActivationBasis
        ? settledClientExecutableActivation.state
        : ESTABLISHING_CLIENT_EXECUTABLE_ACTIVATION;
    const prepareExecutionOrigin = React.useCallback(async (pluginId: string) => {
        if (!accountLifetime) return null;
        const prepared = await projectionPublication.prepareExecutionOriginSelection(pluginId, accountLifetime);
        if (!prepared) return null;
        return { placements: prepared.snapshot.destinationSurfacePlacements, settingsPages: prepared.snapshot.settingsPages,
            release: prepared.release };
    }, [accountLifetime, projectionPublication]);
    const appNavigationBinding = usePluginSurfaceDestinationNavigationBindingForScope({
        projection: pluginUiProjection,
        placements: destinationSurfacePlacements,
        settingsPages,
        prepareExecutionOrigin,
        targetKind: 'app',
        accountLifetime,
    });
    const appNavigationBindingRef = React.useRef(appNavigationBinding);
    appNavigationBindingRef.current = appNavigationBinding;
    const readAppNavigationBinding = React.useCallback(() => appNavigationBindingRef.current, []);

    const voiceActivation = React.useRef<{
        providerIds: ReadonlySet<string>;
        completion: Promise<void>;
        settle(): void;
        reject(error: unknown): void;
    } | null>(null);
    const getVoiceProviderActivation = React.useCallback((providerId: string) => {
        const activation = voiceActivation.current;
        return activation?.providerIds.has(providerId) ? activation.completion : null;
    }, []);
    React.useLayoutEffect(() => () => {
        rejectVoiceProviderRuntimeDemands(Object.assign(new Error('plugin_settings_action_cancelled'), {
            code: 'plugin_settings_action_cancelled',
        }));
        voiceActivation.current?.settle();
        voiceActivation.current = null;
    }, [accountLifetime, activeServer.serverId, voiceExecutionMachineId]);
    React.useLayoutEffect(() => {
        const request = clientExecutableActivationRequest;
        const basis = request.basis;
        // Start borrows one completion across declaration acquisition and the
        // executable reconciliation it enables, including a reconnect describe.
        if (!voiceActivation.current) {
            let settle!: () => void;
            let reject!: (error: unknown) => void;
            const completion = new Promise<void>((resolve, rejectCompletion) => {
                settle = resolve;
                reject = rejectCompletion;
            });
            // Borrowers still observe rejection; an idle shell need not borrow it.
            void completion.catch(() => {});
            voiceActivation.current = { providerIds: basis.voiceProviderIds, completion, settle, reject };
        }
        const activation = voiceActivation.current;
        activation.providerIds = basis.voiceProviderIds;
        bindVoiceProviderRuntimeDemandActivation(basis.voiceProviderIds, activation.completion);
        const next = presentationRef.current.pluginUiProjection ?? EMPTY_PLUGIN_UI_PROJECTION;
        let cancelled = false;
        const voiceProjection = presentationRef.current.voicePluginUiProjection;
        const voice = basis.voiceInteractionEnabled && basis.voiceMachineId && voiceProjection
            ? Object.freeze({ projection: voiceProjection, machineId: basis.voiceMachineId, serverId: basis.voiceServerId,
                providerIds: basis.voiceProviderIds })
            : null;
        // Withdrawal is synchronous inside the existing composition owner,
        // before this request waits on prior cleanup or successor Artifact bytes.
        const retention = retainAppShellProjectedClientExecutables({ projection: next, voice,
            mountedActionProjections: basis.mountedActionProjections,
            platform: basis.platform, accountLifetime: basis.accountLifetime });
        // Every request publishes its complete rights set immediately. Exact
        // target adoption is independent of a retired request's preparation.
        const update = (async () => {
            const settlement = await settleAppShellPluginRuntimeUpdate({
                isCancelled: () => cancelled,
                activate: async () => {
                    const activation = reconcileAppShellProjectedClientExecutables({
                        projection: next,
                        mountedActionProjections: basis.mountedActionProjections,
                        platform: basis.platform,
                        // Catalog authority is independent from executable
                        // interaction readiness. Keeping it here prevents a
                        // disabled/offline projected provider from reappearing
                        // through generated fallback metadata.
                        voiceProviderProjection: voiceProjection,
                        voice,
                        reader: basis.availabilityReader,
                        accountLifetime: basis.accountLifetime,
                        readNavigationBinding: readAppNavigationBinding,
                        isCurrent: () => !cancelled
                            && projectionPublication.getSnapshot().mountedActionProjections === basis.mountedActionProjections,
                    });
                    const [attempts] = await Promise.all([activation, retention]);
                    return attempts;
                },
            });
            if (!cancelled && settlement.status !== 'cancelled') {
                setSettledClientExecutableActivation({ request, state: settlement });
                if (!basis.voiceProjectionAcquiring) {
                    if (settlement.status === 'unavailable') {
                        for (const providerId of basis.voiceProviderIds) {
                            const pluginId = parseQualifiedPluginContributionKey(providerId)?.pluginId;
                            const failure = settlement.failures.find(candidate => candidate.pluginId === null || candidate.pluginId === pluginId);
                            if (failure) rejectVoiceProviderRuntimeDemands(Object.assign(new Error(failure.code), failure), new Set([providerId]));
                        }
                    }
                    if (voiceActivation.current === activation) voiceActivation.current = null;
                    activation.settle();
                }
            }
        })();
        void update.catch(activation.reject);
        return () => {
            cancelled = true;
        };
    }, [clientExecutableActivationRequest, projectionPublication, readAppNavigationBinding]);

    React.useEffect(() => () => {
        // The executable host is process-global. Fence every exact-authority leaf so a
        // pending Action or Voice activation cannot publish on remount.
        void unloadAppShellProjectedClientExecutables().catch(() => {
            // Authority is synchronously fenced before cleanup awaits plugin disposal.
        });
    }, []);

    const value = React.useMemo<AppShellPluginUiProjectionValue>(() => ({
        pluginUiProjection,
        mountedActionProjections,
        pluginBrowserProjection,
        phase,
        unavailableReasonCode,
        hasEstablishingMembers,
        accountCensusPending,
        registrySourcesPending,
        registrySourcesPendingTargets,
        interactionEnabled,
        machineId: projectionUnion.machineId,
        serverId: projectionUnion.serverId,
        platform,
        accountLifetime,
        connectedAccountProjectionRevision,
        connectedAccountProjectionState,
        clientExecutableActivation,
        getVoiceProviderActivation,
        reloadClientExecutables,
        reloadConnectedAccountProjection,
    }), [accountCensusPending, accountLifetime, getVoiceProviderActivation, clientExecutableActivation, connectedAccountProjectionRevision, connectedAccountProjectionState, hasEstablishingMembers, interactionEnabled, phase, platform, pluginBrowserProjection, pluginUiProjection, mountedActionProjections, projectionUnion.machineId, registrySourcesPending, registrySourcesPendingTargets, projectionUnion.serverId, reloadClientExecutables, reloadConnectedAccountProjection, unavailableReasonCode]);
    return (
        <AppShellPluginUiProjectionValueProvider value={value} declarationReady={declarationReady} publication={projectionPublication}>
            {projectionTargets.map((projectionTarget) => (
                <AppShellPluginUiMachineProjection
                    key={`${currentAccountLifetimeKey}:${projectionTarget.serverId ?? 'default'}:${projectionTarget.machineId}`}
                    machineId={projectionTarget.machineId}
                    serverId={projectionTarget.serverId}
                    load={voiceProjectionDemand && projectionTarget.machineId === voiceExecutionMachineId}
                    accountLifetime={accountLifetime}
                    onCurrentness={publishMachineProjectionCurrentness}
                />
            ))}
            {[...candidateFactsByPluginId].map(([pluginId, facts]) => (
                <AppShellPluginExecutionOriginSelection
                    key={`${currentAccountLifetimeKey}:${pluginId}`}
                    pluginId={pluginId}
                    accountLifetime={accountLifetime}
                    facts={facts}
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
    const projection = useAppShellPluginUiProjectionModel();
    const localize = useProjectedPluginLocalizedTextResolver();
    const binding = usePluginSurfaceDestinationNavigationBinding();
    const pages = usePluginPages({ target: { kind: 'app' },
        placements: selectPluginPagePlacements(projection, { container: 'appPage', targetKind: 'app' }),
        localize,
    });
    const openPage = usePluginPageDestinationHandler({ pages });
    const openSettingsPage = usePluginSettingsPageDestinationHandler({ projection });
    const openRightSidebarTab = useAppScopeRightSidebarDestinationHandler();
    const openRightSidebarWindow = useAppScopeRightSidebarDestinationHandler(true);
    const pageOwner = React.useMemo(() => ({
        container: 'appPage' as const,
        handler: openPage,
        openWindow: openPage,
    }), [openPage]);
    const settingsOwner = React.useMemo(() => ({
        container: 'settingsPage' as const,
        handler: openSettingsPage,
        openWindow: openSettingsPage,
    }), [openSettingsPage]);
    const rightSidebarOwner = React.useMemo(() => ({
        container: 'rightSidebarTab' as const,
        handler: openRightSidebarTab,
        openWindow: openRightSidebarWindow,
    }), [openRightSidebarTab, openRightSidebarWindow]);
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
    load: boolean;
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
        load: props.load,
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
        loading: boolean,
    ) => void;
}>): null {
    const classifyRelease = useActivePluginAccountAvailabilityReleaseClassifier(props.pluginId);
    const selection = usePluginMachineExecutionOriginSelection({
        pluginId: props.pluginId,
        includeMachineCandidates: false,
        observeOriginsOnly: true,
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
        props.onOrigin(props.pluginId, props.accountLifetime, origin, selectableOrigins, hasStoredTarget, selection.loading);
    }, [origin, selectableOrigins, hasStoredTarget, selection.loading, props.accountLifetime, props.onOrigin, props.pluginId]);
    return null;
});

/** Imperative dispatch reads the same current owner without subscribing presentation to its whole snapshot. */
export function useAppShellPluginUiProjectionReader(): () => AppShellPluginUiProjectionValue {
    return React.useContext(AppShellPluginUiProjectionContext).getSnapshot;
}

/** In-flight host admission observes this existing owner only while it is pending. */
export function useAppShellPluginUiProjectionSubscription(): AppShellPluginUiProjectionSubscription {
    return React.useContext(AppShellPluginUiProjectionContext);
}

export function useAppShellPluginUiProjection<T>(selector: (value: AppShellPluginUiProjectionValue) => T, enabled = true): T {
    const context = React.useContext(AppShellPluginUiProjectionContext);
    const select = useShallow(selector);
    const getSnapshot = React.useCallback(() => select(context.getSnapshot()), [context, select]);
    return React.useSyncExternalStore(enabled ? context.subscribe : noProjectionSubscription, getSnapshot, getSnapshot);
}

/**
 * The projection currentness a mounted surface host (a widget body, its frame) consumes. Executable
 * activation, mounted Actions and Connected Account descriptors are AppShell diagnostics this value also
 * carries; selecting the currentness fields keeps their transitions from redrawing every hosted body.
 */
function selectAppShellPluginUiProjectionCurrentness(value: AppShellPluginUiProjectionValue): PluginUiProjectionCurrentness {
    return {
        pluginUiProjection: value.pluginUiProjection,
        pluginBrowserProjection: value.pluginBrowserProjection,
        phase: value.phase,
        ...(value.unavailableReasonCode !== undefined ? { unavailableReasonCode: value.unavailableReasonCode } : {}),
        interactionEnabled: value.interactionEnabled,
        machineId: value.machineId,
        serverId: value.serverId,
        platform: value.platform,
        accountLifetime: value.accountLifetime,
    };
}

export function useAppShellPluginUiProjectionCurrentness(): PluginUiProjectionCurrentness {
    return useAppShellPluginUiProjection(selectAppShellPluginUiProjectionCurrentness);
}

export type AppShellPluginUiPageProjection =
    PluginUiProjectionCurrentness & Pick<AppShellPluginUiProjectionValue, 'hasEstablishingMembers'>;

export function useAppShellPluginUiPageProjection(): AppShellPluginUiPageProjection {
    return useAppShellPluginUiProjection(value => ({
        ...selectAppShellPluginUiProjectionCurrentness(value),
        ...(value.hasEstablishingMembers !== undefined ? { hasEstablishingMembers: value.hasEstablishingMembers } : {}),
    }));
}

const selectAppShellPluginUiProjectionModel = (value: AppShellPluginUiProjectionValue) => value.pluginUiProjection;

/**
 * The live projection model alone. Readers of placements, Actions or installed packages subscribe
 * here instead of to the whole value, so executable-activation and Connected Account diagnostics
 * (republished several times while plugins load) do not redraw them.
 */
export function useAppShellPluginUiProjectionModel(): PluginUiProjectionModel | null {
    return useAppShellPluginUiProjection(selectAppShellPluginUiProjectionModel);
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
    return usePluginLocalizedTextResolver({ projection, locale });
}
