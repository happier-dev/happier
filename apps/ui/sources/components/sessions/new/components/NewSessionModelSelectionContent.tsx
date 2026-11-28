import type { FavoriteModelRef } from '@happier-dev/protocol/providers/modelFavoritesV1';
import type { TeamCredentialResourceStatusByKey } from '@/sync/domains/teams/teamCredentialResourceStatus';
import * as React from 'react';
import { useRouter } from 'expo-router';
import { View, type View as RNView } from 'react-native';
import type { ProviderErrorV1} from '@happier-dev/protocol/providers/errors';
import type { SessionModelSelection } from '@happier-dev/protocol/providers/selection/v2';
import type { ProviderPendingApproval } from '@/providers/actions/useProviderActionClient';
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
} from '@/components/sessions/modelPicker/SessionModelPicker';
import {
    sessionModelSelectionKey,
    sessionModelPickerValueFromRef,
    isTeamCredentialProviderModelPickerValue,
    type SessionModelPickerOptionValue,
} from '@/components/sessions/modelPicker/sessionModelSelectionKey';
import { Item } from '@/components/ui/lists/Item';
import { resolvePopoverSelectionListHeightBehavior } from '@/components/ui/selectionList/resolvePopoverSelectionListHeightBehavior';
import { buildFavoriteBackendIdentity } from '@/sync/domains/models/favoriteModelBackendIdentity';
import {
    resolveCanonicalModelOptionId,
    resolveCanonicalNativeModelSelectionRef,
} from '@/sync/domains/models/modelOptions';
import {
    toggleFavoriteModelSelection,
    type FavoriteModelSelectionV1,
} from '@/sync/domains/models/favoriteModelSelections';
import { favoriteModelPickerKey, projectFavoriteModelEntries } from '@/components/sessions/modelPicker/favoriteModelEntries';
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
    modelOptionsProbe?: React.ComponentProps<typeof SessionModelPicker>['probe'];
    modelOptions: readonly NewSessionModelOption[];
    selectedModelId: ModelMode | undefined;
    selectedModelSelection?: SessionModelSelection | null;
    selectedIndicatorColor: string;
    selectedBackendEntry?: ResolvedBackendCatalogEntry | null;
    popoverBoundaryRef?: React.RefObject<any> | null;
    favoriteModelSelections?: readonly FavoriteModelSelectionV1[];
    providerGroups?: readonly SessionModelProjectionGroup[];
    declarationContext?: React.ComponentProps<typeof SessionModelPicker>['declarationContext'];
    sourceBrowse?: React.ComponentProps<typeof SessionModelPicker>['sourceBrowse'];
    connectedServices?: React.ComponentProps<typeof SessionModelPicker>['connectedServices'];
    selectedProviderGroups?: readonly SessionModelProjectionGroup[];
    teamCredentialResources?: readonly TeamCredentialResourceCatalogEntryV1[];
    teamCredentialDisplayNames?: Readonly<Record<string, string | null>>;
    teamNameById?: Readonly<Record<string, string>>;
    homeNameByTeamId?: Readonly<Record<string, string>>;
    teamCredentialResourceStatusByKey?: TeamCredentialResourceStatusByKey;
    teamCredentialServerId?: string | null;
    selectedTeamCredentialModel?: TeamCredentialProviderModelSelectionV1 | null;
    providerProjectionAuthoritative: boolean;
    providerProjectionResolving?: boolean;
    providerProjectionError?: ProviderErrorV1 | null;
    providerProjectionFailures?: readonly DaemonProviderModelProjectionRefreshFailureV1[];
    retryProviderProjection?: (() => Promise<void> | void) | null;
    providerProjectionApproval?: ProviderPendingApproval | null;
    currentSelectionRecovery?: DaemonProviderCurrentSelectionRecoveryV1 | null;
    hiddenNativeModelKeys?: ReadonlySet<string>;
    experimentalConfirmation?: SessionModelPickerExperimentalConfirmationController;
    onSelectModel: (modelId: ModelMode) => void;
    onSelectSelection?: React.ComponentProps<typeof SessionModelPicker>['onSelect'];
    onSelectTeamCredentialModel?: (selection: TeamCredentialProviderModelSelectionV1) => void;
    onFavoriteModelSelectionsChange?: (favorites: FavoriteModelSelectionV1[]) => void;
}>;

function selectedModelRef(props: NewSessionModelSelectionContentProps): SessionModelPickerOptionValue {
    if (props.selectedModelSelection) {
        const ref = sessionModelPickerValueFromRef(props.selectedModelSelection.ref);
        return isTeamCredentialProviderModelPickerValue(ref)
            ? ref
            : resolveCanonicalNativeModelSelectionRef(props.modelOptions, ref);
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
    const selectedTeamCredentialModel = props.selectedTeamCredentialModel
        ?? (isTeamCredentialProviderModelPickerValue(selected) ? selected : null);
    const agentTargetKey = props.selectedBackendEntry?.backendTargetKey
        ?? props.selectedModelSelection?.ref.agentTargetKey
        ?? providerGroups[0]?.rows[0]?.ref.agentTargetKey
        ?? null;
    const favoritesEnabled = Boolean(
        props.selectedBackendEntry
        && props.onFavoriteModelSelectionsChange,
    );

    const favoriteEntries = React.useMemo(() => (
        props.selectedBackendEntry
            ? projectFavoriteModelEntries(props.favoriteModelSelections ?? [], buildFavoriteBackendIdentity(props.selectedBackendEntry))
            : []
    ), [props.favoriteModelSelections, props.selectedBackendEntry]);
    const favoriteKeys = React.useMemo(
        () => new Set(favoriteEntries.map((entry) => entry.key)),
        [favoriteEntries],
    );
    const modelFieldLabel = t('newSession.selectModelTitle');
    const selectedFallbackLabel = React.useMemo(() => {
        if (selected === null) {
            return props.modelOptions.find((option) => option.value === 'default')?.label
                ?? t('newSession.selectModelDescription');
        }
        return favoriteEntries.find((entry) => entry.key === favoriteModelPickerKey(selected))?.label
            || selected.modelId;
    }, [favoriteEntries, props.modelOptions, selected]);
    const selectedPresentation = React.useMemo(() => (
        selectedTeamCredentialModel
            ? (() => {
                const resource = props.teamCredentialResources?.find((entry) => (
                    entry.id === selectedTeamCredentialModel?.resourceId
                    && entry.teamId === selectedTeamCredentialModel.teamId
                ));
                const model = resource?.providerModels.find((entry) => (
                    entry.selection.modelId === selectedTeamCredentialModel?.modelId
                ));
                const teamName = resource ? props.teamNameById?.[resource.teamId] : null;
                const modelName = model?.descriptor.name || selectedTeamCredentialModel.modelId;
                return {
                    subtitle: modelName,
                    detail: [teamName, resource ? props.teamCredentialDisplayNames?.[resource.id] : null].filter(Boolean).join(' · ') || undefined,
                    accessibilityLabel: [modelFieldLabel, modelName, teamName, resource ? props.teamCredentialDisplayNames?.[resource.id] : null]
                        .filter(Boolean).join(', '),
                };
            })()
            : buildSessionModelSelectedTriggerPresentation({
            agentTargetKey: agentTargetKey ?? '',
            declarationContext: props.declarationContext ?? { kind: 'account' },
            nativeModels: agentTargetKey ? props.modelOptions : [],
            providerGroups: props.selectedProviderGroups ?? providerGroups,
            hiddenNativeModelKeys: props.hiddenNativeModelKeys ?? EMPTY_HIDDEN_NATIVE_MODEL_KEYS,
            providerProjectionAuthoritative: props.providerProjectionAuthoritative,
            selected: isTeamCredentialProviderModelPickerValue(selected) ? null : selected,
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
        props.selectedProviderGroups,
        providerGroups,
        selected,
        selectedFallbackLabel,
        modelFieldLabel,
        selectedTeamCredentialModel,
        props.teamCredentialResources,
        props.teamCredentialDisplayNames,
        props.teamNameById,
    ]);

    const commitSelection = React.useCallback<React.ComponentProps<typeof SessionModelPicker>['onSelect']>((ref, connectedAccountBinding) => {
        const canonicalRef = resolveCanonicalNativeModelSelectionRef(props.modelOptions, ref);
        if (props.onSelectSelection) {
            if (connectedAccountBinding) props.onSelectSelection(canonicalRef, connectedAccountBinding);
            else props.onSelectSelection(canonicalRef);
            return;
        }
        props.onSelectModel((canonicalRef?.modelId ?? 'default') as ModelMode);
    }, [props.modelOptions, props.onSelectModel, props.onSelectSelection]);
    const toggleFavorite = React.useCallback((ref: FavoriteModelRef, _reasoningEffort?: string, savedModelLabel?: string) => {
        if (!props.selectedBackendEntry || !props.onFavoriteModelSelectionsChange) return;
        const key = favoriteModelPickerKey(sessionModelPickerValueFromRef(ref));
        const providerGroup = providerGroups.find(group => group.rows.some(row => sessionModelSelectionKey(row.ref) === key));
        const providerRow = providerGroup?.rows.find((row) => (
            sessionModelSelectionKey(row.ref) === key
        ));
        const storedFavorite = favoriteEntries.find((entry) => (
            entry.key === key
        ));
        props.onFavoriteModelSelectionsChange(toggleFavoriteModelSelection({
            favorites: props.favoriteModelSelections ?? [],
            backend: buildFavoriteBackendIdentity(props.selectedBackendEntry),
            modelRef: ref,
            modelLabel: savedModelLabel || providerRow?.descriptor.name
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
            probe={props.modelOptionsProbe}
            agentTargetKey={agentTargetKey ?? ''}
            declarationContext={props.declarationContext}
            sourceBrowse={props.sourceBrowse}
            connectedServices={props.connectedServices}
            includeProviderConnectedAccounts={props.onSelectSelection !== undefined}
            nativeModels={agentTargetKey ? props.modelOptions : []}
            providerGroups={providerGroups}
            teamCredentialResources={props.teamCredentialResources}
            teamCredentialDisplayNames={props.teamCredentialDisplayNames}
            teamNameById={props.teamNameById}
            homeNameByTeamId={props.homeNameByTeamId}
            teamCredentialResourceStatusByKey={props.teamCredentialResourceStatusByKey}
            selectedTeamCredentialModel={selectedTeamCredentialModel}
            providerProjectionAuthoritative={props.providerProjectionAuthoritative}
            providerProjectionResolving={props.providerProjectionResolving}
            projectionError={props.providerProjectionError}
            projectionFailures={props.providerProjectionFailures}
            retryProjection={props.retryProviderProjection}
            projectionApproval={props.providerProjectionApproval}
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
            onSelect={(ref, connectedAccountBinding) => {
                commitSelection(ref, connectedAccountBinding);
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
