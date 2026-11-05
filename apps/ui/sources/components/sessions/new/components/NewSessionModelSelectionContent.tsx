import * as React from 'react';
import { useRouter } from 'expo-router';
import { View, type View as RNView } from 'react-native';
import type { ProviderErrorV1, SessionModelSelectionV1 } from '@happier-dev/protocol';
import type {
    DaemonProviderCurrentSelectionRecoveryV1,
    DaemonProviderModelProjectionRefreshFailureV1,
} from '@happier-dev/protocol/rpc';
import type {
    TeamCredentialProviderModelSelectionV1,
    TeamCredentialResourceCatalogEntryV1,
} from '@happier-dev/protocol/teams';

import type { ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { AgentInputContentPopover } from '@/components/sessions/agentInput/components/AgentInputContentPopover';
import { deferAgentInputPopoverClose } from '@/components/sessions/agentInput/selection/deferAgentInputPopoverClose';
import {
    buildSessionModelSelectedTriggerPresentation,
    type SessionModelProjectionGroup,
} from '@/components/sessions/modelPicker/buildSessionModelPickerSections';
import {
    SessionModelPicker,
    type SessionModelPickerExperimentalConfirmationController,
    type SessionModelPickerFavoriteEntry,
} from '@/components/sessions/modelPicker/SessionModelPicker';
import {
    sessionModelSelectionKey,
    type SessionModelPickerValue,
} from '@/components/sessions/modelPicker/sessionModelSelectionKey';
import { Item } from '@/components/ui/lists/Item';
import { resolvePopoverSelectionListHeightBehavior } from '@/components/ui/selectionList';
import { buildFavoriteBackendIdentity } from '@/sync/domains/models/favoriteModelBackendIdentity';
import {
    resolveCanonicalModelOptionId,
    resolveCanonicalNativeModelSelectionRef,
} from '@/sync/domains/models/modelOptions';
import {
    favoriteModelSelectionMatchesBackend,
    getFavoriteModelRef,
    isFavoriteModelRefSelectable,
    toggleFavoriteModelSelection,
    type FavoriteModelSelectionV1,
} from '@/sync/domains/models/favoriteModelSelections';
import type { ModelMode } from '@/sync/domains/permissions/permissionTypes';
import { t } from '@/text';
import { teamCredentialDetailPath } from '@/components/settings/teams/teamsRoutes';

export type NewSessionModelOption = Readonly<{
    value: ModelMode;
    label: string;
    description: string;
    extendedContextModelId?: string;
}>;

const EMPTY_HIDDEN_NATIVE_MODEL_KEYS: ReadonlySet<string> = new Set();

export type NewSessionModelSelectionContentProps = Readonly<{
    presentation?: 'expanded' | 'compact';
    modelDiscoveryFailed?: boolean;
    modelOptions: readonly NewSessionModelOption[];
    selectedModelId: ModelMode | undefined;
    selectedModelSelection?: SessionModelSelectionV1 | null;
    selectedIndicatorColor: string;
    selectedBackendEntry?: ResolvedBackendCatalogEntry | null;
    popoverBoundaryRef?: React.RefObject<any> | null;
    favoriteModelSelections?: readonly FavoriteModelSelectionV1[];
    providerGroups?: readonly SessionModelProjectionGroup[];
    declarationContext?: React.ComponentProps<typeof SessionModelPicker>['declarationContext'];
    teamCredentialResources?: readonly TeamCredentialResourceCatalogEntryV1[];
    teamNameById?: Readonly<Record<string, string>>;
    homeNameByTeamId?: Readonly<Record<string, string>>;
    currentTeamCredentialResourceKeys?: ReadonlySet<string>;
    teamCredentialServerId?: string | null;
    selectedTeamCredentialModel?: TeamCredentialProviderModelSelectionV1 | null;
    providerProjectionAuthoritative: boolean;
    providerProjectionError?: ProviderErrorV1 | null;
    providerProjectionFailures?: readonly DaemonProviderModelProjectionRefreshFailureV1[];
    retryProviderProjection?: (() => Promise<void> | void) | null;
    currentSelectionRecovery?: DaemonProviderCurrentSelectionRecoveryV1 | null;
    hiddenNativeModelKeys?: ReadonlySet<string>;
    experimentalConfirmation?: SessionModelPickerExperimentalConfirmationController;
    onSelectModel: (modelId: ModelMode) => void;
    onSelectSelection?: (selection: SessionModelPickerValue) => void;
    onSelectTeamCredentialModel?: (selection: TeamCredentialProviderModelSelectionV1) => void;
    onFavoriteModelSelectionsChange?: (favorites: FavoriteModelSelectionV1[]) => void;
}>;

function selectedModelRef(props: NewSessionModelSelectionContentProps): SessionModelPickerValue {
    if (props.selectedModelSelection) {
        return resolveCanonicalNativeModelSelectionRef(props.modelOptions, props.selectedModelSelection.ref);
    }
    const modelId = String(props.selectedModelId ?? '').trim();
    if (!modelId || modelId === 'default') return null;
    if (!props.selectedBackendEntry) return null;
    return {
        agentTargetKey: props.selectedBackendEntry.backendTargetKey,
        providerConnectionId: null,
        modelId: resolveCanonicalModelOptionId(props.modelOptions, modelId),
    };
}

export function NewSessionModelSelectionContent(props: NewSessionModelSelectionContentProps) {
    const router = useRouter();
    const [popoverOpen, setPopoverOpen] = React.useState(false);
    const anchorRef = React.useRef<RNView>(null);
    const providerGroups = props.providerGroups ?? [];
    const selected = selectedModelRef(props);
    const agentTargetKey = props.selectedBackendEntry?.backendTargetKey
        ?? props.selectedModelSelection?.ref.agentTargetKey
        ?? providerGroups[0]?.rows[0]?.ref.agentTargetKey
        ?? null;
    const favoritesEnabled = Boolean(
        props.selectedBackendEntry
        && props.onFavoriteModelSelectionsChange,
    );

    const favoriteEntries = React.useMemo<readonly SessionModelPickerFavoriteEntry[]>(() => {
        if (!props.selectedBackendEntry) return [];
        const backend = buildFavoriteBackendIdentity(props.selectedBackendEntry);
        const seen = new Set<string>();
        return (props.favoriteModelSelections ?? []).flatMap((favorite) => {
            if (!favoriteModelSelectionMatchesBackend(favorite, backend)) return [];
            const ref = getFavoriteModelRef(favorite);
            const key = sessionModelSelectionKey(ref);
            if (!isFavoriteModelRefSelectable(ref) || seen.has(key)) return [];
            seen.add(key);
            const providerSnapshot = favorite.providerDisplaySnapshot;
            return [{
                ref,
                label: favorite.modelLabel || ref.modelId,
                description: favorite.backendLabel || t('agentInput.model.configureInCli'),
                accessibilityLabel: [
                    providerSnapshot?.providerName,
                    providerSnapshot?.connectionName,
                    favorite.modelLabel || ref.modelId,
                ].filter(Boolean).join(', ') || favorite.modelLabel || ref.modelId,
            }];
        });
    }, [props.favoriteModelSelections, props.selectedBackendEntry]);
    const favoriteKeys = React.useMemo(
        () => new Set(favoriteEntries.map((entry) => sessionModelSelectionKey(entry.ref))),
        [favoriteEntries],
    );
    const modelFieldLabel = t('newSession.selectModelTitle');
    const selectedFallbackLabel = React.useMemo(() => {
        if (selected === null) {
            return props.modelOptions.find((option) => option.value === 'default')?.label
                ?? t('newSession.selectModelDescription');
        }
        return favoriteEntries.find((entry) => sessionModelSelectionKey(entry.ref) === sessionModelSelectionKey(selected))?.label
            || selected.modelId;
    }, [favoriteEntries, props.modelOptions, selected]);
    const selectedPresentation = React.useMemo(() => (
        props.selectedTeamCredentialModel
            ? (() => {
                const resource = props.teamCredentialResources?.find((entry) => (
                    entry.id === props.selectedTeamCredentialModel?.resourceId
                    && entry.teamId === props.selectedTeamCredentialModel.teamId
                ));
                const model = resource?.providerModels.find((entry) => (
                    entry.selection.modelId === props.selectedTeamCredentialModel?.modelId
                ));
                const teamName = resource ? props.teamNameById?.[resource.teamId] : null;
                const modelName = model?.descriptor.name || props.selectedTeamCredentialModel.modelId;
                return {
                    subtitle: modelName,
                    detail: [teamName, resource?.displayName].filter(Boolean).join(' · ') || undefined,
                    accessibilityLabel: [modelFieldLabel, modelName, teamName, resource?.displayName]
                        .filter(Boolean).join(', '),
                };
            })()
            : buildSessionModelSelectedTriggerPresentation({
            agentTargetKey: agentTargetKey ?? '',
            declarationContext: props.declarationContext ?? { kind: 'account' },
            nativeModels: agentTargetKey ? props.modelOptions : [],
            providerGroups,
            hiddenNativeModelKeys: props.hiddenNativeModelKeys ?? EMPTY_HIDDEN_NATIVE_MODEL_KEYS,
            providerProjectionAuthoritative: props.providerProjectionAuthoritative,
            selected,
            currentSelectionRecovery: props.currentSelectionRecovery,
            fallbackLabel: selectedFallbackLabel,
            fieldLabel: modelFieldLabel,
        })
    ), [
        agentTargetKey,
        props.currentSelectionRecovery,
        props.declarationContext,
        props.hiddenNativeModelKeys,
        props.modelOptions,
        props.providerProjectionAuthoritative,
        providerGroups,
        selected,
        selectedFallbackLabel,
        modelFieldLabel,
        props.selectedTeamCredentialModel,
        props.teamCredentialResources,
        props.teamNameById,
    ]);

    const commitSelection = React.useCallback((ref: SessionModelPickerValue) => {
        const canonicalRef = resolveCanonicalNativeModelSelectionRef(props.modelOptions, ref);
        if (props.onSelectSelection) {
            props.onSelectSelection(canonicalRef);
            return;
        }
        props.onSelectModel((canonicalRef?.modelId ?? 'default') as ModelMode);
    }, [props.modelOptions, props.onSelectModel, props.onSelectSelection]);
    const toggleFavorite = React.useCallback((ref: NonNullable<SessionModelPickerValue>) => {
        if (!props.selectedBackendEntry || !props.onFavoriteModelSelectionsChange) return;
        const providerGroup = ref.providerConnectionId
            ? providerGroups.find((group) => group.connectionId === ref.providerConnectionId)
            : null;
        const providerRow = providerGroup?.rows.find((row) => (
            sessionModelSelectionKey(row.ref) === sessionModelSelectionKey(ref)
        ));
        const storedFavorite = favoriteEntries.find((entry) => (
            sessionModelSelectionKey(entry.ref) === sessionModelSelectionKey(ref)
        ));
        props.onFavoriteModelSelectionsChange(toggleFavoriteModelSelection({
            favorites: props.favoriteModelSelections ?? [],
            backend: buildFavoriteBackendIdentity(props.selectedBackendEntry),
            modelRef: ref,
            modelLabel: providerRow?.descriptor.name
                || props.modelOptions.find((option) => option.value === ref.modelId)?.label
                || storedFavorite?.label
                || ref.modelId,
            backendLabel: props.selectedBackendEntry.title,
            providerDisplaySnapshot: providerGroup ? {
                providerName: providerGroup.providerName,
                connectionName: providerGroup.connectionName,
                connectionRole: providerGroup.connectionRole,
                connectionDisplayNameMode: providerGroup.connectionDisplayNameMode,
            } : null,
            addedAtMs: Date.now(),
        }));
    }, [
        favoriteEntries,
        props.favoriteModelSelections,
        props.modelOptions,
        props.onFavoriteModelSelectionsChange,
        props.selectedBackendEntry,
        providerGroups,
    ]);

    const picker = (options: Readonly<{
        maxHeight?: number;
        onRequestClose?: () => void;
        closeAfterSelect?: boolean;
    }>) => (
        // The wizard section header owns refresh and activity; the shared picker owns failure copy.
        <SessionModelPicker
            probe={props.modelDiscoveryFailed ? { phase: 'idle', failed: true } : undefined}
            agentTargetKey={agentTargetKey ?? ''}
            declarationContext={props.declarationContext}
            nativeModels={agentTargetKey ? props.modelOptions : []}
            providerGroups={providerGroups}
            teamCredentialResources={props.teamCredentialResources}
            teamNameById={props.teamNameById}
            homeNameByTeamId={props.homeNameByTeamId}
            currentTeamCredentialResourceKeys={props.currentTeamCredentialResourceKeys}
            selectedTeamCredentialModel={props.selectedTeamCredentialModel}
            providerProjectionAuthoritative={props.providerProjectionAuthoritative}
            projectionError={props.providerProjectionError}
            projectionFailures={props.providerProjectionFailures}
            retryProjection={props.retryProviderProjection}
            currentSelectionRecovery={props.currentSelectionRecovery}
            hiddenNativeModelKeys={props.hiddenNativeModelKeys}
            selected={selected}
            favoriteEntries={favoriteEntries}
            favoriteKeys={favoriteKeys}
            onToggleFavorite={favoritesEnabled ? toggleFavorite : undefined}
            favoriteActionVisibility={favoritesEnabled ? 'all' : undefined}
            experimentalConfirmation={props.experimentalConfirmation}
            showTitle={false}
            maxHeight={options.maxHeight}
            heightBehavior={options.maxHeight !== undefined
                ? resolvePopoverSelectionListHeightBehavior()
                : undefined}
            autoFocusInputOnWeb={options.maxHeight !== undefined}
            onRequestClose={options.onRequestClose}
            onSelect={(ref) => {
                commitSelection(ref);
                if (options.closeAfterSelect && options.onRequestClose) {
                    deferAgentInputPopoverClose(options.onRequestClose);
                }
            }}
            onSelectTeamCredentialModel={(selection) => {
                props.onSelectTeamCredentialModel?.(selection);
                if (options.closeAfterSelect && options.onRequestClose) {
                    deferAgentInputPopoverClose(options.onRequestClose);
                }
            }}
            onRecoverTeamCredentialResource={(resource) => {
                if (!props.teamCredentialServerId) return;
                router.push(teamCredentialDetailPath({
                    serverId: props.teamCredentialServerId,
                    teamId: resource.teamId,
                }, resource.id));
            }}
        />
    );

    if (props.presentation !== 'compact') return picker({});

    // A bare value row: the wizard's Model section owns the sheet around it.
    return (
        <View ref={anchorRef} collapsable={false}>
            <Item
                testID="new-session-model-dropdown-trigger"
                title={selectedPresentation.subtitle ?? modelFieldLabel}
                detail={selectedPresentation.detail}
                accessibilityLabel={selectedPresentation.accessibilityLabel}
                showChevron
                accessibilityExpanded={popoverOpen}
                onPress={() => setPopoverOpen(true)}
            />
            <AgentInputContentPopover
                open={popoverOpen}
                anchorRef={anchorRef}
                boundaryRef={props.popoverBoundaryRef}
                scrollEnabled={false}
                onRequestClose={() => setPopoverOpen(false)}
                content={({ maxHeight, requestClose }) => picker({
                    maxHeight,
                    onRequestClose: requestClose,
                    closeAfterSelect: true,
                })}
            />
        </View>
    );
}
