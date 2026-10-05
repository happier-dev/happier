import * as React from 'react';
import { openChatWithFindSeed } from '@/components/appShell/panes/fileFindSeedHandoff';
import { View } from 'react-native';
import {
    readExternalSessionsSettingsV1,
    removeExternalSessionsAutoLinkSourcePolicyV1,
    upsertExternalSessionsAutoLinkSourcePolicyV1,
    type ExternalSessionsAgentId,
    type ExternalSessionsSource,
} from '@happier-dev/protocol';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useOptionalAppPaneContext } from '@/components/appShell/panes/AppPaneProvider';
import { areServerAccountScopesEqual, type ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import { StyleSheet } from 'react-native-unistyles';

import {
    resolveAgentCatalogProjection,
    type ResolvedAgentCatalogEntry,
} from '@/agents/backendCatalog/agentCatalogProjection';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { AgentCatalogIdentityIcon } from '@/agents/presentation/AgentCatalogIdentityIcon';
import { useMachineAdministrationTargetFilter } from '@/components/settings/machines/MachineAdministrationTargetSelector';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import { resolveHomeDisplayNameForServerIdentity } from '@/components/settings/server/homeDisplayName';
import { AppHeaderCloseButton } from '@/components/navigation/AppHeaderCloseButton';
import type { SelectionListFilter } from '@/components/ui/selectionList';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { PageHeaderMenu, type PageHeaderMenuAction } from '@/components/ui/layout/PageHeaderEntityParts';
import { PopoverScope } from '@/components/ui/popover';
import { Modal } from '@/modal';
import { captureActiveServerAccountScopeCurrentness } from '@/sync/domains/scope/activeServerAccountScope';
import { useMachineListForServer, useSetting } from '@/sync/domains/state/storage';
import { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 } from '@/sync/domains/machines/administration/selectionPreferences';
import {
    machineAdministrationTargetsEqual,
    readMachineAdministrationCandidateName,
} from '@/sync/domains/machines/administration/targetSelection';
import { isMachineAdministrationExecutionTargetCurrent } from '@/sync/domains/machines/administration/operationCurrentness';
import { useMachineAdministrationTargetSelection } from '@/sync/domains/machines/administration/useTargetSelection';
import {
    machineExternalSessionCandidateDelete,
} from '@/sync/ops/machineExternalSessions';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { useActiveServerAccountScope, useProfile, useSettingsVersion } from '@/sync/store/hooks';
import { sync } from '@/sync/sync';
import { requireOneShotAccountSettingsMutationApplied } from '@/sync/engine/settings/syncSettings';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import type { Theme } from '@/theme';
import { t } from '@/text';

import { getPreferredExternalSessionBrowseProviderId } from './getPreferredExternalSessionBrowseProviderId';
import {
    listExternalSessionBrowseProviderIds,
    resolveExternalSessionBrowseSourceOption,
    resolveExternalSessionBrowseSourceOptions,
    resolveExternalSessionBrowseContentSearchCapability,
} from './resolveExternalSessionBrowseSourceOptions';
import {
    ExternalSessionBrowseCandidatesList,
    type ExternalSessionBrowseScope,
} from './ExternalSessionBrowseCandidatesList';
import { openExternalSessionCandidate, type ExternalSessionCandidateOpenState } from './openExternalSessionCandidate';
import {
    readExternalSessionBrowseCandidateKey,
    readExternalSessionBrowseCandidatePath,
    useExternalSessionBrowseCandidates,
    type ExternalSessionBrowseCandidate,
} from './useExternalSessionBrowseCandidates';
import {
    resolveExternalSessionBrowseRpcErrorMessage,
    resolveExternalSessionBrowseThrownErrorMessage,
} from './externalSessionBrowseErrorPresentation';
import { readMachineName } from '@/utils/sessions/machineDisplayNames';
import { useDeviceType } from '@/utils/platform/responsive';

type ExternalSessionBrowseProviderId = ExternalSessionsAgentId;
type AppTheme = Theme;

const EXTERNAL_SESSION_BROWSE_SEARCH_DEBOUNCE_MS = 250;

export type ExternalSessionsBrowseScopeLock = Readonly<{
    machineId: string;
    serverId?: string | null;
    providerId: ExternalSessionsAgentId;
    source: ExternalSessionsSource;
}>;

export type ExternalSessionsBrowseInteraction = 'openSession' | 'pickRemoteSessionId';

const stylesheet = StyleSheet.create((theme: AppTheme) => ({
    root: {
        flex: 1,
        minHeight: 0,
        backgroundColor: theme.colors.surface.base,
    },
    // The ⋯ menu and close trail the search band, as in Search / ⌘K: the band is the top of the card.
    bandTrailing: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
}));

export const ExternalSessionsBrowseScreen = React.memo((props: Readonly<{
    interaction?: ExternalSessionsBrowseInteraction;
    lockScope?: ExternalSessionsBrowseScopeLock | null;
    /** Ephemeral intent handed from Search; query text is never placed in the route. */
    initialSearchTarget?: 'metadata' | 'content';
    initialSearchQuery?: string;
    /** Explicit Search authority for the locked Show flow; otherwise use the active Account. */
    accountLifetime?: ServerAccountScopeLifetime;
    onPickRemoteSessionId?: (remoteSessionId: string) => void;
    onRequestClose?: () => void;
    /**
     * Put a close button in the search band, for a host with no chrome of its own (the web modal
     * route). Without it the host owns close (native header, card modal, Escape).
     */
    closeButton?: boolean;
}>) => {
    const interaction: ExternalSessionsBrowseInteraction = props.interaction ?? 'openSession';
    const lockScope = props.lockScope ?? null;
    const locked = Boolean(lockScope);
    const router = useRouter();
    const phone = useDeviceType() === 'phone';
    const paneContext = useOptionalAppPaneContext();
    const styles = stylesheet;
    const profile = useProfile();
    const profileScope = useActiveServerAccountScope();
    const settingsVersion = useSettingsVersion();
    const expectedSettingsScope = useAccountSettingsScope();
    const backendEnabledByTargetKey = useSetting('backendEnabledByTargetKey');
    const acpCatalogSettingsV1 = useSetting('acpCatalogSettingsV1');
    const connectedServicesProfileLabelByKey = useSetting('connectedServicesProfileLabelByKey');
    const settings = React.useMemo(() => ({
        backendEnabledByTargetKey,
        acpCatalogSettingsV1,
        connectedServicesProfileLabelByKey,
    }), [acpCatalogSettingsV1, backendEnabledByTargetKey, connectedServicesProfileLabelByKey]);
    const activeServerId = useActiveServerSnapshot().serverId;
    const externalSessionsSettings = readExternalSessionsSettingsV1(
        useSetting('externalSessionsSettingsV1'),
    );
    const autoLinkMutationPendingRef = React.useRef(false);
    const candidateOpenStateRef = React.useRef<ExternalSessionCandidateOpenState>({ requestToken: 0, linkingCandidateKey: null });
    const [autoLinkMutationPending, setAutoLinkMutationPending] = React.useState(false);
    const [daemonProjectionRefreshKey, setDaemonProjectionRefreshKey] = React.useState(0);
    const administrationTargetSelection = useMachineAdministrationTargetSelection(
        MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.externalSessions,
        { allowSoleCandidate: !lockScope },
    );
    const administrationExecutionTarget = React.useMemo(() => {
        if (lockScope) return null;
        const selectedTarget = administrationTargetSelection.selectedTarget;
        const resolvedTarget = administrationTargetSelection.resolveExecutionTarget();
        return selectedTarget !== null
            && resolvedTarget !== null
            && machineAdministrationTargetsEqual(selectedTarget, resolvedTarget.target)
            ? resolvedTarget
            : null;
    }, [administrationTargetSelection, lockScope]);
    const effectiveSelectedMachineId = lockScope?.machineId
        ?? administrationExecutionTarget?.machine.id
        ?? null;
    const effectiveSelectedServerId = lockScope?.serverId
        ?? administrationExecutionTarget?.serverId
        ?? null;
    const machines = useMachineListForServer(effectiveSelectedServerId ?? activeServerId);
    const lockedSettingsScopeMatches = props.accountLifetime
        ? areServerAccountScopesEqual(expectedSettingsScope, props.accountLifetime.scope)
        : !lockScope?.serverId || lockScope.serverId === expectedSettingsScope?.serverId;
    const lockedProfileScopeMatches = props.accountLifetime
        ? areServerAccountScopesEqual(profileScope, props.accountLifetime.scope)
        : !lockScope?.serverId || lockScope.serverId === activeServerId;
    const accountSettingsTargetAvailable = lockScope
        ? lockedSettingsScopeMatches
        : administrationTargetSelection.selectedTargetServerMatchesActiveAccount;
    const resolveCurrentOperationTarget = React.useCallback((): Readonly<{
        machineId: string;
        serverId: string | null;
    }> | null => {
        if (props.accountLifetime?.isCurrent() === false) return null;
        if (lockScope) {
            return { machineId: lockScope.machineId, serverId: lockScope.serverId ?? null };
        }
        if (!administrationExecutionTarget) return null;
        // The callback below is invoked by the currency check, so the resolved
        // target is held in a box the compiler cannot narrow to its initial null.
        const resolved: { target: ReturnType<typeof administrationTargetSelection.resolveExecutionTarget> } = { target: null };
        if (!isMachineAdministrationExecutionTargetCurrent({
            expectedTarget: administrationExecutionTarget,
            resolveCurrentTarget: () => {
                resolved.target = administrationTargetSelection.resolveExecutionTarget();
                return resolved.target;
            },
        }) || !resolved.target) return null;
        return { machineId: resolved.target.machine.id, serverId: resolved.target.serverId };
    }, [administrationExecutionTarget, administrationTargetSelection, lockScope, props.accountLifetime]);
    const daemonMergedProjection = useDaemonMergedProjectionInputs({
        machineId: effectiveSelectedMachineId,
        serverId: effectiveSelectedServerId,
        enabled: effectiveSelectedMachineId !== null,
        refreshKey: daemonProjectionRefreshKey,
        retainInputsAcrossScopeChange: true,
    });
    const daemonMergedProjectionInputs = daemonMergedProjection.inputs;
    const daemonMergedProjectionReady = daemonMergedProjection.phase === 'ready';
    const browseProviderIds = React.useMemo(
        () => listExternalSessionBrowseProviderIds({
            projection: daemonMergedProjectionInputs?.pluginProjectionV2,
            machineId: effectiveSelectedMachineId,
            interaction,
        }),
        [daemonMergedProjectionInputs?.pluginProjectionV2, effectiveSelectedMachineId, interaction],
    );
    const providers = React.useMemo<ReadonlyArray<Readonly<{
        id: ExternalSessionBrowseProviderId;
        label: string;
        entry: ResolvedAgentCatalogEntry;
    }>>>(
        () => browseProviderIds.map((providerId) => {
            const projection = resolveAgentCatalogProjection(providerId, {
                enabledAgentIds: browseProviderIds,
                backendEnabledByTargetKey: settings.backendEnabledByTargetKey,
                acpCatalogSettingsV1: settings.acpCatalogSettingsV1,
                mergedProviderProjectionById: daemonMergedProjectionInputs?.mergedProviderProjectionById ?? null,
                mergedBackendProjectionById: daemonMergedProjectionInputs?.mergedBackendProjectionById ?? null,
            });
            return {
                id: providerId,
                label: projection.title,
                entry: projection,
            };
        }),
        [
            browseProviderIds,
            daemonMergedProjectionInputs?.mergedBackendProjectionById,
            daemonMergedProjectionInputs?.mergedProviderProjectionById,
            settings.acpCatalogSettingsV1,
            settings.backendEnabledByTargetKey,
        ],
    );
    const providerIds = React.useMemo<readonly ExternalSessionBrowseProviderId[]>(() => providers.map((provider) => provider.id), [providers]);
    const [selectedProviderId, setSelectedProviderId] = React.useState<ExternalSessionBrowseProviderId | null>(() => (
        lockScope?.providerId ?? getPreferredExternalSessionBrowseProviderId(providerIds, null)
    ));
    const sourceOptions = React.useMemo(() => {
        if (lockScope) {
            const resolvedOption = resolveExternalSessionBrowseSourceOption({
                accountScope: props.accountLifetime?.scope,
                providerId: lockScope.providerId,
                machineId: effectiveSelectedMachineId,
                profile: lockedProfileScopeMatches ? profile : null,
                settings: lockedSettingsScopeMatches ? settings : { connectedServicesProfileLabelByKey: {} },
                projection: daemonMergedProjectionInputs?.pluginProjectionV2,
                source: lockScope.source,
                activeServerId: effectiveSelectedServerId ?? activeServerId,
                interaction,
            });
            return [{
                key: 'locked',
                label: resolvedOption?.label ?? t('externalSessions.browseSources'),
                ...(resolvedOption?.detail ? { detail: resolvedOption.detail } : {}),
                source: lockScope.source,
            }];
        }
        if (!selectedProviderId) return [];
        return resolveExternalSessionBrowseSourceOptions({
            providerId: selectedProviderId,
            machineId: effectiveSelectedMachineId,
            profile,
            settings,
            projection: daemonMergedProjectionInputs?.pluginProjectionV2,
            activeServerId: effectiveSelectedServerId ?? activeServerId,
            interaction,
        });
    }, [activeServerId, daemonMergedProjectionInputs?.pluginProjectionV2, effectiveSelectedMachineId, effectiveSelectedServerId, interaction, lockScope, lockedProfileScopeMatches, lockedSettingsScopeMatches, profile, props.accountLifetime, selectedProviderId, settings]);
    const [selectedSourceKey, setSelectedSourceKey] = React.useState<string | null>(() => (
        lockScope ? 'locked' : sourceOptions[0]?.key ?? null
    ));
    const [linkingSessionId, setLinkingSessionId] = React.useState<string | null>(null);
    const [deletingCandidateKey, setDeletingCandidateKey] = React.useState<string | null>(null);
    const [machinePickerOpen, setMachinePickerOpen] = React.useState(false);
    const [searchQuery, setSearchQuery] = React.useState(props.initialSearchQuery ?? '');
    const [candidateSearchTerm, setCandidateSearchTerm] = React.useState(
        props.initialSearchTarget === 'content' ? props.initialSearchQuery ?? '' : '',
    );
    const [searchTarget, setSearchTarget] = React.useState<'metadata' | 'content'>(props.initialSearchTarget ?? 'metadata');
    /** Internal threads (approval reviewers, spawned sub-agents) stay out of the listing unless asked for. */
    const [includeThreads, setIncludeThreads] = React.useState(false);
    const popoverBoundaryRef = React.useRef<View>(null);
    const selectedAgentProjection = React.useMemo(() => (
        selectedProviderId
            ? resolveAgentCatalogProjection(selectedProviderId, {
                enabledAgentIds: browseProviderIds,
                backendEnabledByTargetKey: settings.backendEnabledByTargetKey,
                acpCatalogSettingsV1: settings.acpCatalogSettingsV1,
                mergedProviderProjectionById: daemonMergedProjectionInputs?.mergedProviderProjectionById ?? null,
                mergedBackendProjectionById: daemonMergedProjectionInputs?.mergedBackendProjectionById ?? null,
            })
            : null
    ), [
        browseProviderIds,
        daemonMergedProjectionInputs?.mergedBackendProjectionById,
        daemonMergedProjectionInputs?.mergedProviderProjectionById,
        selectedProviderId,
        settings.acpCatalogSettingsV1,
        settings.backendEnabledByTargetKey,
    ]);
    const identityServerId = effectiveSelectedServerId ?? activeServerId;
    const selectedAgentIdentity = React.useMemo(() => selectedAgentProjection ? ({
        entry: selectedAgentProjection,
        machineId: effectiveSelectedMachineId,
        serverId: identityServerId,
        current: daemonMergedProjection.phase === 'ready',
    } as const) : null, [
        daemonMergedProjection.phase,
        effectiveSelectedMachineId,
        identityServerId,
        selectedAgentProjection,
    ]);

    React.useEffect(() => {
        if (lockScope) return;
        const preferredProviderId = getPreferredExternalSessionBrowseProviderId(providerIds, selectedProviderId);
        if (preferredProviderId !== selectedProviderId) {
            setSelectedProviderId(preferredProviderId);
        }
    }, [lockScope, providerIds, selectedProviderId]);

    React.useEffect(() => {
        if (lockScope) {
            if (selectedSourceKey !== 'locked') {
                setSelectedSourceKey('locked');
            }
            return;
        }
        const defaultKey = sourceOptions[0]?.key ?? null;
        if (!defaultKey) {
            setSelectedSourceKey(null);
            return;
        }
        const hasSelectedSource = sourceOptions.some((option) => option.key === selectedSourceKey);
        if (!hasSelectedSource) {
            setSelectedSourceKey(defaultKey);
        }
    }, [lockScope, selectedSourceKey, sourceOptions]);

    const selectedSource = React.useMemo(
        () => lockScope?.source ?? sourceOptions.find((option) => option.key === selectedSourceKey)?.source ?? sourceOptions[0]?.source ?? null,
        [lockScope, selectedSourceKey, sourceOptions],
    );
    const selectedSourceLabel = React.useMemo(() => {
        const option = sourceOptions.find((candidate) => candidate.key === selectedSourceKey)
            ?? sourceOptions[0];
        return option
            ? [option.label, option.detail].filter(Boolean).join(' · ')
            : null;
    }, [selectedSourceKey, sourceOptions]);
    const providerSelectItems = React.useMemo(() => providers.map((provider) => ({
        id: provider.id,
        title: provider.label,
        icon: (
            <AgentCatalogIdentityIcon
                entry={provider.entry}
                machineId={effectiveSelectedMachineId}
                serverId={identityServerId}
                current={daemonMergedProjection.phase === 'ready'}
                size={16}
            />
        ),
    })), [
        daemonMergedProjection.phase,
        effectiveSelectedMachineId,
        identityServerId,
        providers,
    ]);
    const sourceSelectItems = React.useMemo(() => sourceOptions.map((sourceOption) => ({
        id: sourceOption.key,
        title: sourceOption.label,
    })), [sourceOptions]);

    React.useEffect(() => {
        const trimmedSearchQuery = searchQuery.trim();
        if (searchTarget === 'content') {
            setCandidateSearchTerm((current) => current === searchQuery ? current : '');
            return;
        }
        if (!trimmedSearchQuery) {
            setCandidateSearchTerm('');
            return undefined;
        }

        const timeoutId = setTimeout(() => {
            setCandidateSearchTerm(trimmedSearchQuery);
        }, EXTERNAL_SESSION_BROWSE_SEARCH_DEBOUNCE_MS);

        return () => {
            clearTimeout(timeoutId);
        };
    }, [searchQuery, searchTarget]);

    const candidateActionAuthorityKey = React.useMemo(() => JSON.stringify({
        machineId: effectiveSelectedMachineId,
        serverId: effectiveSelectedServerId,
        providerId: selectedProviderId,
        source: selectedSource,
        interaction,
        searchTarget,
        ...(props.accountLifetime ? { accountScope: props.accountLifetime.scope } : {}),
    }), [effectiveSelectedMachineId, effectiveSelectedServerId, interaction, props.accountLifetime, selectedProviderId, selectedSource, searchTarget]);
    const [submittedContentScopeKey, setSubmittedContentScopeKey] = React.useState<string | null>(() => (
        props.initialSearchTarget === 'content' && props.initialSearchQuery?.trim() && lockScope
            ? candidateActionAuthorityKey
            : null
    ));
    const contentSearchCapability = resolveExternalSessionBrowseContentSearchCapability({
        providerId: selectedProviderId,
        source: selectedSource,
        projection: daemonMergedProjectionInputs?.pluginProjectionV2,
    });
    const contentSearchSupported = contentSearchCapability === true;
    const contentSearchSubmitted = searchTarget === 'content'
        && candidateSearchTerm.length > 0
        && candidateSearchTerm === searchQuery
        && submittedContentScopeKey === candidateActionAuthorityKey;

    const {
        candidates,
        candidatesAuthoritative,
        publishedSearchTerm,
        nextCursor,
        paginationRequestKey,
        loading,
        loadingMore,
        searchAugmenting,
        searchIncomplete,
        annotationsIncomplete,
        preparation,
        preparationStopped,
        cancelled,
        contentCoverage,
        autoLinkPolicyScope,
        error,
        candidateDeleteSupported,
        loadMore,
        cancelPreparation,
        reload,
        removeCandidate,
    } = useExternalSessionBrowseCandidates({
        machineId: effectiveSelectedMachineId,
        serverId: effectiveSelectedServerId,
        providerId: selectedProviderId,
        source: selectedSource,
        searchTerm: candidateSearchTerm,
        searchTarget,
        contentSearchSupported,
        accountLifetime: props.accountLifetime,
        includeThreads,
        enabled: daemonMergedProjectionReady && effectiveSelectedMachineId !== null
            && (searchTarget !== 'content' || contentSearchSubmitted),
    });
    /**
     * Whether a candidate on screen may be acted on. This is a capability fact about
     * the listing's authority, not a liveness fact about how much of it has arrived:
     * linking needs a machine, an Agent, a source and the candidate's own identity,
     * and a row the current scope's still-building index has already served carries
     * all four. Such a row opens while the rest of the index keeps building.
     *
     * `loading` must never gate this. It is also true for every progress round-trip
     * of an in-progress index — thousands of them on a large corpus — and the rows
     * that index serves are live throughout. Rows retained from a superseded request
     * keep their inert treatment through `candidatesAuthoritative`, which is false
     * until the request owning the current scope has published.
     *
     * The search field is debounced, so between a keystroke and the request there is
     * an interval in which the visible query has already moved on while the rows still
     * answer the previous one. `candidatesAuthoritative` cannot see that: no new
     * request has started yet. Comparing the visible query with the one the hook
     * actually published closes the interval.
     *
     * A reported error is deliberately not a second gate here. A root refresh that
     * failed never published, so it already leaves the retained rows unauthoritative;
     * the errors that survive a publication — a cancelled index build, a full search
     * whose continuation failed — describe how complete the listing is, not whether
     * the rows in it are real. Reading the error again would strand the user with a
     * visible, correct, inert list.
     */
    const candidateActionsAllowed = daemonMergedProjectionReady
        && candidatesAuthoritative
        && publishedSearchTerm === (searchTarget === 'content' ? searchQuery : searchQuery.trim());
    const handleContentSearchSubmit = React.useCallback((query: string) => {
        const term = query;
        if (searchTarget !== 'content' || !contentSearchSupported || !term.trim() || loading || loadingMore) return;
        setSubmittedContentScopeKey(candidateActionAuthorityKey);
        if (candidateSearchTerm === term && contentSearchSubmitted) void reload();
        else setCandidateSearchTerm(term);
    }, [candidateActionAuthorityKey, candidateSearchTerm, contentSearchSubmitted, contentSearchSupported, loading, loadingMore, reload, searchTarget]);
    const candidateActionAuthorityRef = React.useRef({
        key: candidateActionAuthorityKey,
        generation: 0,
    });
    if (candidateActionAuthorityRef.current.key !== candidateActionAuthorityKey) {
        candidateActionAuthorityRef.current = {
            key: candidateActionAuthorityKey,
            generation: candidateActionAuthorityRef.current.generation + 1,
        };
    }
    const candidateActionAuthorityGeneration = candidateActionAuthorityRef.current.generation;
    const deleteRequestTokenRef = React.useRef(0);
    const deletingCandidateKeyRef = React.useRef<string | null>(null);
    const autoLinkPolicyEnabled = React.useMemo(() => {
        if (!effectiveSelectedMachineId || !autoLinkPolicyScope) return false;
        return externalSessionsSettings?.autoLinkSourcePolicies.some((policy) => (
            policy.machineId === effectiveSelectedMachineId
            && policy.sourcePolicyId === autoLinkPolicyScope.sourcePolicyId
            && policy.qualifiedIdentity.agent.pluginId
                === autoLinkPolicyScope.qualifiedIdentity.agent.pluginId
            && policy.qualifiedIdentity.agent.localId
                === autoLinkPolicyScope.qualifiedIdentity.agent.localId
            && policy.qualifiedIdentity.source.kind
                === autoLinkPolicyScope.qualifiedIdentity.source.kind
            && policy.qualifiedIdentity.source.contractVersion
                === autoLinkPolicyScope.qualifiedIdentity.source.contractVersion
        )) === true;
    }, [autoLinkPolicyScope, effectiveSelectedMachineId, externalSessionsSettings]);
    const setAutoLinkPolicyEnabled = React.useCallback(async (enabled: boolean) => {
        const currentTarget = resolveCurrentOperationTarget();
        if (
            !currentTarget
            || !accountSettingsTargetAvailable
            || !autoLinkPolicyScope
            || autoLinkMutationPendingRef.current
        ) return;
        autoLinkMutationPendingRef.current = true;
        setAutoLinkMutationPending(true);
        try {
            if (settingsVersion === null) throw new Error('Account settings version is unavailable');
            const enabledAtMs = Date.now();
            requireOneShotAccountSettingsMutationApplied(
                await sync.mutateAccountSettingsOnce({
                    expectedSettingsScope,
                    expectedSettingsVersion: settingsVersion,
                    mutate: (raw) => ({
                        settings: {
                            ...raw,
                            externalSessionsSettingsV1: enabled
                                ? upsertExternalSessionsAutoLinkSourcePolicyV1(
                                    raw.externalSessionsSettingsV1,
                                    {
                                        machineId: currentTarget.machineId,
                                        qualifiedIdentity: autoLinkPolicyScope.qualifiedIdentity,
                                        sourcePolicyId: autoLinkPolicyScope.sourcePolicyId,
                                        enabledAtMs,
                                    },
                                )
                                : removeExternalSessionsAutoLinkSourcePolicyV1(
                                    raw.externalSessionsSettingsV1,
                                    {
                                        machineId: currentTarget.machineId,
                                        qualifiedIdentity: autoLinkPolicyScope.qualifiedIdentity,
                                        sourcePolicyId: autoLinkPolicyScope.sourcePolicyId,
                                    },
                                ),
                        },
                        value: undefined,
                    }),
                }),
            );
        } catch {
            await Modal.alert(
                t('common.error'),
                t('externalSessions.settingsAutoLinkUpdateFailed'),
            );
        } finally {
            autoLinkMutationPendingRef.current = false;
            setAutoLinkMutationPending(false);
        }
    }, [accountSettingsTargetAvailable, autoLinkPolicyScope, expectedSettingsScope, resolveCurrentOperationTarget, settingsVersion]);
    const selectedMachineIsOffline = React.useMemo(() => {
        if (!effectiveSelectedMachineId) return false;
        return machines?.find((machine) => machine.id === effectiveSelectedMachineId)?.active === false;
    }, [effectiveSelectedMachineId, machines]);
    const selectedMachineLabel = React.useMemo(() => {
        if (lockScope) {
            const machine = machines?.find((candidate) => candidate.id === effectiveSelectedMachineId);
            // Same rule as the administration branch below: no name reads "this machine" in the copy.
            return readMachineName(machine);
        }
        const selectedTarget = administrationTargetSelection.selectedTarget;
        const candidate = selectedTarget
            ? administrationTargetSelection.candidates.find((entry) => (
                machineAdministrationTargetsEqual(entry.target, selectedTarget)
            ))
            : undefined;
        // A machine with no name is "this machine" in the copy, never its id.
        return candidate ? readMachineAdministrationCandidateName(candidate) : null;
    }, [administrationTargetSelection, effectiveSelectedMachineId, lockScope, machines]);
    const selectedMachineHomeDir = React.useMemo(() => {
        const machine = lockScope
            ? machines?.find((candidate) => candidate.id === effectiveSelectedMachineId)
            : administrationExecutionTarget?.machine;
        return machine?.metadata?.homeDir ?? null;
    }, [administrationExecutionTarget?.machine, effectiveSelectedMachineId, lockScope, machines]);

    /**
     * Pending candidate work belongs to the scope that started it. When the
     * browse scope moves, both outstanding requests are disowned in one place:
     * their tokens are retired so a late completion can neither act nor clear
     * anything, and the listing that just arrived starts with no inherited
     * pending row.
     */
    React.useEffect(() => {
        candidateOpenStateRef.current.requestToken += 1;
        candidateOpenStateRef.current.linkingCandidateKey = null;
        setLinkingSessionId(null);
        deleteRequestTokenRef.current += 1;
        deletingCandidateKeyRef.current = null;
        setDeletingCandidateKey(null);
    }, [candidateActionAuthorityGeneration]);

    const handleOpenCandidate = React.useCallback(async (
        candidate: ExternalSessionBrowseCandidate,
        selectionAuthorityGeneration: number,
    ) => {
        await openExternalSessionCandidate({
            candidate, agentId: selectedProviderId, source: selectedSource, interaction,
            actionsAllowed: candidateActionsAllowed && effectiveSelectedMachineId !== null
                && (searchTarget !== 'content' || candidate.match !== undefined),
            offline: selectedMachineIsOffline,
            isSelectionCurrent: () => candidateActionAuthorityRef.current.generation === selectionAuthorityGeneration,
            accountCurrentness: props.accountLifetime,
            resolveCurrentTarget: resolveCurrentOperationTarget,
            state: candidateOpenStateRef.current,
            onLinkingChange: setLinkingSessionId,
            onPickRemoteSessionId: props.onPickRemoteSessionId,
            ...(searchTarget === 'content' && candidate.match ? {
                find: { query: candidateSearchTerm, sourceItemId: candidate.match.sourceItemId },
            } : {}),
            openSession: (sessionId, target, find) => {
                const authority = props.accountLifetime ?? (target.serverId
                    ? paneContext?.fileFindSeedAccountBindings.get(target.serverId) : null);
                return openChatWithFindSeed({
                    handoff: paneContext?.fileFindSeedHandoff,
                    destination: { sessionId, serverId: target.serverId ?? '' }, seed: find, authority,
                    open: () => router.push(buildScopedSessionRouteHref({ sessionId, serverId: target.serverId }) as never),
                });
            },
        });
    }, [candidateActionsAllowed, candidateSearchTerm, effectiveSelectedMachineId, interaction, paneContext, props, resolveCurrentOperationTarget, router, searchTarget, selectedMachineIsOffline, selectedProviderId, selectedSource]);

    /**
     * Delete one Agent-owned session behind the canonical destructive
     * confirmation. Nothing is removed optimistically: the row keeps its place
     * and its pending treatment until the Agent confirms the deletion, and a
     * failure leaves it exactly where it was so the user can retry.
     */
    const handleDeleteCandidate = React.useCallback(async (
        candidate: ExternalSessionBrowseCandidate,
        selectionAuthorityGeneration: number,
    ) => {
        /**
         * Admission is decided before the first await. Two presses dispatched
         * from one commit both observe the pre-press rendered state, so only a
         * ref written here can stop the second from opening its own
         * confirmation and sending its own irreversible deletion.
         */
        if (deletingCandidateKeyRef.current !== null) return;
        /**
         * The press carries the generation of the listing that rendered the
         * row. A confirmation opened on the previous scope's row must not be
         * answered against the machine, Agent and source the user moved to.
         */
        if (candidateActionAuthorityRef.current.generation !== selectionAuthorityGeneration) return;
        if (!selectedProviderId || !selectedSource) return;
        const currentTarget = resolveCurrentOperationTarget();
        if (!currentTarget) return;
        const candidateKey = readExternalSessionBrowseCandidateKey(candidate);
        const requestToken = deleteRequestTokenRef.current + 1;
        deleteRequestTokenRef.current = requestToken;
        deletingCandidateKeyRef.current = candidateKey;
        // Deletion is Account-scoped exactly like linking: a response that
        // resolves after an Account switch may neither alert nor mutate rows in
        // the Account the user moved to.
        const accountCurrentness = captureActiveServerAccountScopeCurrentness();
        const requestIsCurrent = () => (
            deleteRequestTokenRef.current === requestToken
            && candidateActionAuthorityRef.current.generation === selectionAuthorityGeneration
            && accountCurrentness.isCurrent()
        );
        try {
            const candidateTitle = candidate.title?.trim()
                || readExternalSessionBrowseCandidatePath(candidate.details)
                || candidate.remoteSessionId;
            const confirmed = await Modal.confirm(
                t('externalSessions.browseDeleteCandidateConfirmTitle'),
                t('externalSessions.browseDeleteCandidateConfirmMessage', {
                    title: candidateTitle,
                    agent: selectedAgentProjection?.title ?? selectedProviderId,
                }),
                {
                    cancelText: t('common.cancel'),
                    confirmText: t('common.delete'),
                    destructive: true,
                },
            );
            if (!confirmed) return;
            // The scope can move while the confirmation is on screen, and the
            // answer only authorizes the scope the user was looking at.
            if (!requestIsCurrent()) return;
            setDeletingCandidateKey(candidateKey);
            const request = {
                machineId: currentTarget.machineId,
                agentId: selectedProviderId,
                source: selectedSource,
                // The listing handed out the Agent's opaque bytes; deletion
                // addresses the same record without reinterpreting them.
                remoteSessionId: candidate.remoteSessionId,
            };
            const result = currentTarget.serverId
                ? await machineExternalSessionCandidateDelete(request, { serverId: currentTarget.serverId })
                : await machineExternalSessionCandidateDelete(request);
            if (!requestIsCurrent()) return;
            if (!result.ok) {
                Modal.alert(
                    t('common.error'),
                    resolveExternalSessionBrowseRpcErrorMessage(result.errorCode, 'delete'),
                );
                return;
            }
            // The Agent's key is unique only inside the scope that served it, so
            // this removal is reachable only while that scope still owns the
            // listing; a same-keyed row in a newer one is a different session.
            removeCandidate(candidateKey);
        } catch (deleteError) {
            if (!requestIsCurrent()) return;
            Modal.alert(
                t('common.error'),
                resolveExternalSessionBrowseThrownErrorMessage(deleteError, 'delete'),
            );
        } finally {
            if (deleteRequestTokenRef.current === requestToken) {
                deletingCandidateKeyRef.current = null;
                setDeletingCandidateKey(null);
            }
        }
    }, [
        removeCandidate,
        resolveCurrentOperationTarget,
        selectedAgentProjection?.title,
        selectedProviderId,
        selectedSource,
    ]);

    const openMachinePicker = React.useCallback(() => setMachinePickerOpen(true), []);
    const targetState = administrationTargetSelection.state;
    /**
     * Which machine problem the list states first. The target owner already knows the saved machine
     * is gone, away or locked; the list must say that rather than what its (unreachable) agents
     * would report.
     */
    const browseScope = React.useMemo<ExternalSessionBrowseScope>(() => {
        if (lockScope) return { kind: 'ready' };
        switch (targetState.kind) {
            case 'unselected':
                return { kind: 'unselected', onChooseMachine: openMachinePicker };
            case 'missing':
                if (targetState.inventoryKnown === false) {
                    return {
                        kind: 'unreachable',
                        homeName: resolveHomeDisplayNameForServerIdentity(targetState.target.serverIdentityId),
                        onChooseMachine: openMachinePicker,
                    };
                }
                return {
                    kind: 'gone',
                    homeName: resolveHomeDisplayNameForServerIdentity(targetState.target.serverIdentityId),
                    onChooseMachine: openMachinePicker,
                };
            case 'replaced':
            case 'revoked':
                return {
                    kind: 'gone',
                    homeName: resolveHomeDisplayNameForServerIdentity(targetState.target.serverIdentityId),
                    onChooseMachine: openMachinePicker,
                };
            case 'offline':
                return { kind: 'offline', onChooseMachine: openMachinePicker };
            case 'locked':
                return { kind: 'locked', onChooseMachine: openMachinePicker };
            case 'online':
                return { kind: 'ready' };
        }
    }, [lockScope, openMachinePicker, targetState]);
    const alternativeAgent = React.useMemo(() => {
        if (locked) return null;
        const other = providers.find((provider) => provider.id !== selectedProviderId);
        return other ? { label: other.label, onSelect: () => setSelectedProviderId(other.id) } : null;
    }, [locked, providers, selectedProviderId]);
    const menuActions = React.useMemo((): PageHeaderMenuAction[] => [
        ...(accountSettingsTargetAvailable && autoLinkPolicyScope ? [{
            id: 'auto-link',
            testID: 'external-sessions-browse-auto-link',
            title: t('externalSessions.browseAutoLinkTitle'),
            checked: autoLinkPolicyEnabled,
            loading: autoLinkMutationPending,
            onSelect: () => setAutoLinkPolicyEnabled(!autoLinkPolicyEnabled),
        }] : []),
        // Auto-link is a policy: its page holds every source's switch. The picker variant stays put.
        ...(interaction === 'openSession' ? [{
            id: 'settings',
            testID: 'external-sessions-browse-settings',
            title: t('externalSessions.browseSettingsLink'),
            onSelect: () => { router.push(SETTINGS_ROUTES.externalSessions as never); },
        }] : []),
    ], [
        accountSettingsTargetAvailable,
        autoLinkMutationPending,
        autoLinkPolicyEnabled,
        autoLinkPolicyScope,
        interaction,
        router,
        setAutoLinkPolicyEnabled,
    ]);
    const menu = menuActions.length > 0 ? (
        <PageHeaderMenu testID="external-sessions-browse-menu" actions={menuActions} />
    ) : null;
    const machineFilter = useMachineAdministrationTargetFilter({
        selection: administrationTargetSelection,
        testIDPrefix: 'external-sessions.browse.administration.target',
        groupTitle: t('externalSessions.browseMachines'),
        chipOpen: machinePickerOpen,
        onChipOpenChange: setMachinePickerOpen,
    });
    /**
     * The browser's scope as SelectionList filters: machine (its canonical owner's chooser), Agent,
     * and source only when the Agent has more than one. A locked scope (resume by id) shows the same
     * chips as fixed values.
     */
    const filters = React.useMemo<ReadonlyArray<SelectionListFilter>>(() => {
        if (locked) {
            return [
                {
                    id: 'machine',
                    label: t('externalSessions.browseMachines'),
                    valueLabel: selectedMachineLabel ?? t('externalSessions.browseThisMachine'),
                    testID: 'external-sessions.browse.locked.machine',
                },
                {
                    id: 'agent',
                    label: t('externalSessions.browseAgents'),
                    valueLabel: [
                        selectedAgentProjection?.title ?? lockScope?.providerId,
                        selectedSourceLabel,
                    ].filter(Boolean).join(' · '),
                    testID: 'external-sessions.browse.locked.agent',
                },
            ];
        }
        const next: SelectionListFilter[] = [machineFilter];
        if (effectiveSelectedMachineId && providerSelectItems.length > 0) {
            next.push({
                id: 'agent',
                label: t('externalSessions.browseAgents'),
                options: providerSelectItems.map((item) => ({ id: item.id, label: item.title, icon: item.icon })),
                selectedId: selectedProviderId,
                onChange: (itemId) => setSelectedProviderId(itemId as ExternalSessionBrowseProviderId),
                testID: 'direct-session-provider-picker',
            });
        }
        if (effectiveSelectedMachineId && sourceSelectItems.length > 1) {
            next.push({
                id: 'source',
                label: t('externalSessions.browseSources'),
                options: sourceSelectItems.map((item) => ({ id: item.id, label: item.title })),
                selectedId: selectedSourceKey,
                onChange: setSelectedSourceKey,
                testID: 'direct-session-source-picker',
            });
        }
        if (effectiveSelectedMachineId) {
            next.push({
                id: 'threads',
                label: t('externalSessions.browseThreadsFilter'),
                options: [
                    { id: 'hidden', label: t('externalSessions.browseThreadsHidden') },
                    { id: 'shown', label: t('externalSessions.browseThreadsShown') },
                ],
                selectedId: includeThreads ? 'shown' : 'hidden',
                onChange: (optionId) => setIncludeThreads(optionId === 'shown'),
                testID: 'external-sessions.browse.threads',
            });
        }
        return next;
    }, [
        effectiveSelectedMachineId,
        includeThreads,
        lockScope?.providerId,
        locked,
        machineFilter,
        providerSelectItems,
        selectedAgentProjection?.title,
        selectedMachineLabel,
        selectedProviderId,
        selectedSourceKey,
        selectedSourceLabel,
        sourceSelectItems,
    ]);
    const onRequestClose = props.onRequestClose ?? (() => router.back());
    // Titles | Conversations is part of asking (Find lab H2): beside the field on wide layouts, its own row
    // on a phone where the field needs the width.
    const searchTargetControl = (
        <SegmentedTabBar
            role="radiogroup"
            testIDPrefix="external-sessions-search-target"
            accessibilityLabel={t('externalSessions.browseSearchTarget')}
            tabs={[
                { id: 'metadata', label: t('externalSessions.browseTitles') },
                { id: 'content', label: t('externalSessions.browseConversations') },
            ]}
            activeTabId={searchTarget}
            onSelectTab={(target) => {
                setCandidateSearchTerm('');
                setSubmittedContentScopeKey(null);
                setSearchTarget(target);
            }}
            compact
            targetSize="platform"
        />
    );
    const bandTrailing = menu || props.closeButton || !phone ? (
        <View style={styles.bandTrailing}>
            {phone ? null : searchTargetControl}
            {menu}
            {props.closeButton ? (
                <AppHeaderCloseButton
                    testID="external-sessions-browse-close"
                    accessibilityLabel={t('common.close')}
                    onPress={onRequestClose}
                />
            ) : null}
        </View>
    ) : null;
    const agentName = selectedAgentProjection?.title ?? null;
    const searchPlaceholder = searchTarget === 'content'
        ? t('externalSessions.browseContentPlaceholder')
        : agentName
        ? t('externalSessions.browseSearchAgentPlaceholder', { agent: agentName })
        : t('externalSessions.browseSearchPlaceholder');

    return (
        <PopoverScope boundaryRef={popoverBoundaryRef}>
            <View
                ref={popoverBoundaryRef}
                style={styles.root}
                testID="direct-sessions-browse-modal"
                // The band has no title; the dialog keeps its name.
                accessibilityLabel={t('externalSessions.browseHeaderTitle')}
            >
                {phone ? searchTargetControl : null}
                <ExternalSessionBrowseCandidatesList
                    candidates={candidates}
                    loading={loading}
                    error={error}
                    offline={selectedMachineIsOffline}
                    nextCursor={nextCursor}
                    paginationRequestKey={paginationRequestKey}
                    loadingMore={loadingMore}
                    searchAugmenting={searchAugmenting}
                    searchIncomplete={searchIncomplete}
                    annotationsIncomplete={annotationsIncomplete}
                    preparation={preparation}
                    preparationStopped={preparationStopped}
                    cancelled={cancelled}
                    linkingSessionId={linkingSessionId}
                    deletingCandidateKey={deletingCandidateKey}
                    candidateDeleteSupported={candidateDeleteSupported}
                    candidateActionsDisabled={!candidateActionsAllowed}
                    interaction={interaction}
                    agentIdentity={selectedAgentIdentity}
                    agentLabel={selectedAgentProjection?.title ?? null}
                    machineLabel={selectedMachineLabel}
                    machineHomeDir={selectedMachineHomeDir}
                    sourceLabel={selectedSourceLabel}
                    projectionPhase={daemonMergedProjection.phase === 'idle'
                        ? 'ready'
                        : daemonMergedProjection.phase}
                    browseCapabilityAvailable={browseProviderIds.length > 0}
                    scope={browseScope}
                    filters={filters}
                    bandTrailing={bandTrailing}
                    searchPlaceholder={searchPlaceholder}
                    alternativeAgent={alternativeAgent}
                    searchQuery={searchQuery}
                    searchTarget={searchTarget}
                    contentSearchSupported={contentSearchSupported}
                    contentSearchExplicitlyUnsupported={contentSearchCapability === false}
                    contentSearchSubmitted={contentSearchSubmitted}
                    contentCoverage={contentCoverage}
                    onSearchSubmit={handleContentSearchSubmit}
                    onSearchQueryChange={setSearchQuery}
                    selectionAuthorityGeneration={candidateActionAuthorityGeneration}
                    onSelectCandidate={(candidate, selectionAuthorityGeneration) => {
                        void handleOpenCandidate(candidate, selectionAuthorityGeneration);
                    }}
                    {...(candidateDeleteSupported
                        ? {
                            onDeleteCandidate: (
                                candidate: ExternalSessionBrowseCandidate,
                                selectionAuthorityGeneration: number,
                            ) => {
                                void handleDeleteCandidate(candidate, selectionAuthorityGeneration);
                            },
                        }
                        : {})}
                    onLoadMore={() => { void loadMore(); }}
                    onCancelPreparation={cancelPreparation}
                    onRetry={() => {
                        if (daemonMergedProjection.phase !== 'ready' && effectiveSelectedMachineId) {
                            setDaemonProjectionRefreshKey((current) => current + 1);
                            return;
                        }
                        void (nextCursor ? loadMore() : reload());
                    }}
                    onRequestClose={onRequestClose}
                />
            </View>
        </PopoverScope>
    );
});
