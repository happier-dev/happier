import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { NewSessionEngineOptionDetail } from '@/components/sessions/new/components/NewSessionEngineOptionDetail';
import { NewSessionFavoriteModelsDetail } from '@/components/sessions/new/components/NewSessionFavoriteModelsDetail';
import type { AgentInputChipPickerOption } from '@/components/sessions/agentInput/components/AgentInputChipPickerTypes';
import { getAgentCore, isAgentId, type AgentId } from '@/agents/catalog/catalog';
import { AgentIcon } from '@/agents/registry/AgentIcon';
import { getAgentPickerIconScale } from '@/agents/registry/registryUi';
import type { AIBackendProfile } from '@/sync/domains/profiles/profileCompatibility';
import { getBuiltInProfile } from '@/sync/domains/profiles/profileUtils';
import {
    buildAcpConfigOptionOverridesV1,
    type AccountProfile,
    type BackendTargetRefV1,
    type ConnectedServiceBindingsV1,
} from '@happier-dev/protocol';
import type { ModelMode } from '@/sync/domains/permissions/permissionTypes';
import type { ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { t } from '@/text';
import type { Settings } from '@/sync/domains/settings/settings';
import { resolveNewSessionCapabilityProbeContext } from '@/components/sessions/new/modules/newSessionCapabilityProbeContext';
import type { OptionPickerProbeState } from '@/components/sessions/pickers/OptionPickerOverlay';
import {
    readRememberedEngineSelection,
    type RememberedEngineSelectionsByScopeV1,
} from '@/sync/domains/sessionAuthoring/rememberedEngineSelections';
import {
    sortItemsByFavoriteTargetKey,
    toggleFavoriteBackendTargetKey,
} from '@/sync/domains/sessionAuthoring/favoriteBackendTargets';
import type { NewSessionAgentPickerViewV1 } from '@/sync/domains/settings/registry/account/accountSessionCreationSettingDefinitions';
import {
    favoriteModelSelectionMatchesBackend,
    toggleFavoriteModelSelection,
    type FavoriteModelBackendIdentity,
    type FavoriteModelSelectionV1,
} from '@/sync/domains/models/favoriteModelSelections';
import { resolveNewSessionConnectedServicesBindingsForAgent } from '@/components/sessions/new/modules/connectedServicesNewSessionBindings';
import { stableJsonStringify } from '@/utils/json/stableJsonStringify';
import { Icon } from '@/components/ui/icons/Icon';
import {
    readNonBlankSessionControlIdentifier,
    readSessionControlValueId,
} from '@/sync/domains/sessionControl/opaqueIdentifiers';

import { useStableValueBySignature } from '@/hooks/ui/useStableValueBySignature';

type EngineSelection = Readonly<{
    modelId: string;
    sessionModeId: string | null;
    configOverrides: Readonly<Record<string, string>>;
}>;

type EngineSelectionLike = Readonly<{
    modelId: string;
    sessionModeId: string | null;
    configOverrides?: Readonly<Record<string, string>> | null;
}>;

const FAVORITE_MODELS_AGENT_PICKER_OPTION_ID = 'favorite-models';

function areConfigOverridesEqual(
    left: Readonly<Record<string, string>> | null | undefined,
    right: Readonly<Record<string, string>> | null | undefined,
): boolean {
    const leftKeys = Object.keys(left ?? {});
    const rightKeys = Object.keys(right ?? {});
    if (leftKeys.length !== rightKeys.length) return false;
    for (const key of leftKeys) {
        if ((left ?? {})[key] !== (right ?? {})[key]) return false;
    }
    return true;
}

function normalizeConfigOverrides(overrides: Readonly<Record<string, string>> | null | undefined): Readonly<Record<string, string>> {
    return overrides ?? {};
}

function buildSessionConfigOptionOverrides(
    configOverrides: Readonly<Record<string, string>>,
    updatedAt: number,
) {
    if (Object.keys(configOverrides).length === 0) return null;
    return buildAcpConfigOptionOverridesV1({
        updatedAt,
        overrides: Object.fromEntries(
            Object.entries(configOverrides).map(([configId, value]) => [
                configId,
                { updatedAt, value },
            ]),
        ),
    });
}

function backendEntrySupportsSessionModeSelection(entry: ResolvedBackendCatalogEntry | null): boolean {
    if (!entry) return true;
    if (!isAgentId(entry.providerAgentId)) return true;
    return getAgentCore(entry.providerAgentId).sessionModes.kind !== 'none';
}

function normalizeSessionModeIdForEntry(
    entry: ResolvedBackendCatalogEntry | null,
    sessionModeId: string | null | undefined,
): string | null {
    if (!backendEntrySupportsSessionModeSelection(entry)) return null;
    return readNonBlankSessionControlIdentifier(sessionModeId) ?? 'default';
}

function areEngineSelectionsEqual(left: EngineSelectionLike, right: EngineSelectionLike): boolean {
    return left.modelId === right.modelId
        && left.sessionModeId === right.sessionModeId
        && areConfigOverridesEqual(left.configOverrides, right.configOverrides);
}

const ENGINE_FAVORITE_RAIL_ICON_SIZE = 14;

function FavoriteModelsPickerIcon(props: Readonly<{ size?: number }>) {
    const { theme } = useUnistyles();
    return (
        <Icon
            name="star"
            size={props.size ?? 12}
            color={theme.dark ? theme.colors.text.primary : theme.colors.button.primary.background}
            weight={theme.dark ? 'fill' : 'regular'}
        />
    );
}

function EngineFavoritePickerIcon(props: Readonly<{ favorite: boolean }>) {
    const { theme } = useUnistyles();
    const selectedColor = theme.dark ? theme.colors.text.primary : theme.colors.button.primary.background;
    return (
        <Icon
            name="star"
            size={ENGINE_FAVORITE_RAIL_ICON_SIZE}
            color={props.favorite ? selectedColor : theme.colors.text.secondary}
            weight={props.favorite ? 'fill' : 'regular'}
        />
    );
}

function buildFavoriteBackendIdentity(entry: ResolvedBackendCatalogEntry): FavoriteModelBackendIdentity {
    return {
        backendTargetKey: entry.targetKey,
        providerAgentId: entry.providerAgentId,
        builtInAgentId: entry.builtInAgentId,
        configuredBackendId: entry.target.kind === 'configuredAcpBackend' ? entry.target.backendId : null,
    };
}

function areShallowObjectsEqual<Value extends object>(left: Value, right: Value): boolean {
    if (left === right) return true;

    const leftKeys = Object.keys(left) as Array<keyof Value>;
    const rightKeys = Object.keys(right) as Array<keyof Value>;
    if (leftKeys.length !== rightKeys.length) return false;

    for (const key of leftKeys) {
        if (!Object.prototype.hasOwnProperty.call(right, key)) return false;
        if (!Object.is(left[key], right[key])) return false;
    }

    return true;
}

function useShallowStableObject<Value extends object>(value: Value): Value {
    const stableRef = React.useRef(value);
    if (!areShallowObjectsEqual(stableRef.current, value)) {
        stableRef.current = value;
    }
    return stableRef.current;
}

function useLatestRef<Value>(value: Value): React.MutableRefObject<Value> {
    const ref = React.useRef(value);
    ref.current = value;
    return ref;
}

function buildAgentPickerOptionsSignature(options: ReadonlyArray<AgentInputChipPickerOption> | undefined): string {
    if (!options) return 'undefined';
    try {
        return JSON.stringify(options.map((option) => ({
            id: option.id,
            label: option.label,
            subtitle: option.subtitle ?? null,
            disabled: option.disabled === true,
            muted: option.muted === true,
            closeOnSelectImmediate: option.closeOnSelectImmediate === true,
            deferRenderDetailContent: option.deferRenderDetailContent === true,
            deferredDetailContentCacheKey: option.deferredDetailContentCacheKey ?? null,
            preserveFocusOnExternalSelectionChange: option.preserveFocusOnExternalSelectionChange === true,
            railAction: option.railAction ? {
                testID: option.railAction.testID ?? null,
                selected: option.railAction.selected === true,
                disabled: option.railAction.disabled === true,
            } : null,
        }))) ?? 'null';
    } catch {
        return 'unserializable';
    }
}

function buildFavoriteBackendTargetKeysSignature(favoriteTargetKeys: ReadonlyArray<string>): string {
    try {
        return JSON.stringify(favoriteTargetKeys) ?? '[]';
    } catch {
        return 'unserializable';
    }
}

function buildCurrentConfigOverridesSignature(params: Readonly<{
    configOverrides: Readonly<Record<string, string>>;
}>): string {
    return stableJsonStringify(params);
}

function buildFavoriteModelSelectionsSignature(favorites: readonly FavoriteModelSelectionV1[]): string {
    try {
        return JSON.stringify(favorites.map((favorite) => ({
            backendTargetKey: favorite.backendTargetKey,
            providerAgentId: favorite.providerAgentId ?? null,
            builtInAgentId: favorite.builtInAgentId ?? null,
            configuredBackendId: favorite.configuredBackendId ?? null,
            modelId: favorite.modelId,
            backendLabel: favorite.backendLabel ?? null,
            modelLabel: favorite.modelLabel ?? null,
            addedAtMs: favorite.addedAtMs ?? null,
        }))) ?? '[]';
    } catch {
        return 'unserializable';
    }
}

function buildConnectedServicesPayloadCacheKeyPart(payload: ConnectedServiceBindingsV1 | null): string {
    return stableJsonStringify(payload);
}

function resolveProviderAgentIdForPickerEntry(entry: ResolvedBackendCatalogEntry): AgentId | null {
    if (isAgentId(entry.providerAgentId)) return entry.providerAgentId;
    if (isAgentId(entry.builtInAgentId)) return entry.builtInAgentId;
    if (entry.target.kind === 'builtInAgent' && isAgentId(entry.target.agentId)) return entry.target.agentId;
    return null;
}

export function useNewSessionAgentPickerControls(rawParams: Readonly<{
    useProfiles: boolean;
    selectedProfileId: string | null;
    profileMap: ReadonlyMap<string, AIBackendProfile>;
    resolvedBackendEntries: readonly ResolvedBackendCatalogEntry[];
    getCompatibleProfileBackendEntries: (profile: AIBackendProfile) => readonly ResolvedBackendCatalogEntry[];
    isBackendEntrySelectable: (entry: ResolvedBackendCatalogEntry) => boolean;
    selectedBackendEntry: ResolvedBackendCatalogEntry | null;
    selectedBackendTargetKey: string;
    setBackendTarget: React.Dispatch<React.SetStateAction<BackendTargetRefV1>>;
    modelMode: ModelMode;
    setModelMode: React.Dispatch<React.SetStateAction<ModelMode>>;
    acpSessionModeId: string | null;
    setAcpSessionModeId: React.Dispatch<React.SetStateAction<string | null>>;
    sessionConfigOptionOverrides: ReturnType<typeof buildAcpConfigOptionOverridesV1> | null;
    setSessionConfigOptionOverrides: React.Dispatch<React.SetStateAction<ReturnType<typeof buildAcpConfigOptionOverridesV1> | null>>;
    selectedMachineId: string | null;
    capabilityServerId: string;
    selectedPath: string | null;
    settings: Settings;
    accountProfileConnectedServicesV2?: AccountProfile['connectedServicesV2'];
    connectedServicesFeatureEnabled?: boolean;
    connectedServicesAccountGroupsFeatureEnabled?: boolean;
    agentNewSessionOptionStateByAgentId?: Readonly<Record<string, Record<string, unknown> | null | undefined>>;
    favoriteModelSelections?: readonly FavoriteModelSelectionV1[];
    setFavoriteModelSelections?: (favorites: FavoriteModelSelectionV1[]) => void;
    favoriteBackendTargetKeys?: ReadonlyArray<string>;
    setFavoriteBackendTargetKeys?: (favorites: string[]) => void;
    rememberedAgentPickerView?: NewSessionAgentPickerViewV1;
    onRememberAgentPickerView?: (view: NewSessionAgentPickerViewV1) => void;
    /**
     * Optional probe surface to merge into the engine detail pane's refresh affordance.
     * This is used to make the model refresh button also refresh CLI detection.
     */
    refreshProbe?: OptionPickerProbeState | null;
    rememberEngineSelectionsEnabled?: boolean;
    rememberedEngineSelectionsByScope?: RememberedEngineSelectionsByScopeV1 | null;
    rememberedEngineSelectionServerId?: string | null;
    onRememberEngineSelection?: (
        backendTarget: BackendTargetRefV1,
        selection: Readonly<{
            modelId: string;
            acpSessionModeId: string | null;
            sessionConfigOptionOverrides: ReturnType<typeof buildAcpConfigOptionOverridesV1> | null;
        }>,
    ) => void;
    onExplicitBackendTargetSelection?: (backendTarget: BackendTargetRefV1) => void;
}>): Readonly<{
    agentPickerOptions?: ReadonlyArray<AgentInputChipPickerOption>;
    agentPickerSelectedOptionId?: string | null;
    handleAgentPickerSelect: (selectedId: string) => void;
    handleAgentClick: () => void;
}> {
    const params = useShallowStableObject(rawParams);
    const resolveConnectedServicesForEntry = React.useCallback((entry: ResolvedBackendCatalogEntry): ConnectedServiceBindingsV1 | null => {
        const providerAgentId = resolveProviderAgentIdForPickerEntry(entry);
        if (!providerAgentId) return null;
        return resolveNewSessionConnectedServicesBindingsForAgent({
            agentId: providerAgentId,
            agentCore: getAgentCore(providerAgentId),
            agentOptionState: params.agentNewSessionOptionStateByAgentId?.[entry.targetKey] ?? null,
            accountProfileConnectedServicesV2: params.accountProfileConnectedServicesV2 ?? [],
            settings: {
                connectedServicesProfileLabelByKey: params.settings.connectedServicesProfileLabelByKey ?? {},
                connectedServicesDefaultProfileByServiceId: params.settings.connectedServicesDefaultProfileByServiceId ?? {},
                connectedServicesDefaultAuthByAgentIdV1: params.settings.connectedServicesDefaultAuthByAgentIdV1,
            },
            connectedServicesFeatureEnabled: params.connectedServicesFeatureEnabled === true,
            accountGroupsFeatureEnabled: params.connectedServicesAccountGroupsFeatureEnabled === true,
        }).connectedServicesBindingsPayload;
    }, [
        params.accountProfileConnectedServicesV2,
        params.agentNewSessionOptionStateByAgentId,
        params.connectedServicesAccountGroupsFeatureEnabled,
        params.connectedServicesFeatureEnabled,
        params.settings,
    ]);
    const profileForAgentSelection = React.useMemo(() => {
        if (!params.useProfiles || params.selectedProfileId === null) return null;
        return params.profileMap.get(params.selectedProfileId) || getBuiltInProfile(params.selectedProfileId);
    }, [params.profileMap, params.selectedProfileId, params.useProfiles]);

    const compatibleBackendEntries = React.useMemo(() => {
        return profileForAgentSelection
            ? params.getCompatibleProfileBackendEntries(profileForAgentSelection)
            : params.resolvedBackendEntries;
    }, [params.getCompatibleProfileBackendEntries, profileForAgentSelection, params.resolvedBackendEntries]);

    const compatibleBackendTargetKeys = React.useMemo(() => {
        return new Set(compatibleBackendEntries.map((entry) => entry.targetKey));
    }, [compatibleBackendEntries]);

    const selectableBackendEntries = React.useMemo(() => {
        return params.resolvedBackendEntries.filter((entry) => (
            params.isBackendEntrySelectable(entry)
            && (
                !profileForAgentSelection
                || compatibleBackendTargetKeys.has(entry.targetKey)
            )
        ));
    }, [
        compatibleBackendTargetKeys,
        params.isBackendEntrySelectable,
        params.resolvedBackendEntries,
        profileForAgentSelection,
    ]);

    const engineSelectionByTargetKeyRef = React.useRef(new Map<string, EngineSelection>());
    const pendingAppliedSelectionRef = React.useRef<Readonly<{
        targetKey: string;
        selection: EngineSelection;
    }> | null>(null);

    const buildInitialEngineSelection = React.useCallback((targetKey: string): EngineSelection => {
        const currentTargetKey = params.selectedBackendEntry?.targetKey ?? params.selectedBackendTargetKey;
        const entry = params.resolvedBackendEntries.find((candidate) => candidate.targetKey === targetKey)
            ?? params.selectedBackendEntry
            ?? null;
        if (targetKey === currentTargetKey) {
            return {
                modelId: String(params.modelMode),
                sessionModeId: normalizeSessionModeIdForEntry(entry, params.acpSessionModeId),
                configOverrides: Object.fromEntries(
                    Object.entries(params.sessionConfigOptionOverrides?.overrides ?? {})
                        .map(([configId, override]) => [
                            readNonBlankSessionControlIdentifier(configId) ?? '',
                            readSessionControlValueId(override?.value) ?? '',
                        ])
                        .filter(([configId, value]) => configId.length > 0 && value.length > 0),
                ),
            };
        }

        const remembered = entry
            ? readRememberedEngineSelection({
                enabled: params.rememberEngineSelectionsEnabled === true,
                selectionsByScope: params.rememberedEngineSelectionsByScope ?? null,
                serverId: params.rememberedEngineSelectionServerId ?? null,
                backendTarget: entry.target,
            })
            : null;

        return {
            modelId: remembered?.modelId ?? 'default',
            sessionModeId: normalizeSessionModeIdForEntry(entry, remembered?.acpSessionModeId),
            configOverrides: Object.fromEntries(
                Object.entries(remembered?.sessionConfigOptionOverrides?.overrides ?? {})
                    .map(([configId, override]) => [
                        readNonBlankSessionControlIdentifier(configId) ?? '',
                        readSessionControlValueId(override?.value) ?? '',
                    ])
                    .filter(([configId, value]) => configId.length > 0 && value.length > 0),
            ),
        };
    }, [
        params.acpSessionModeId,
        params.modelMode,
        params.rememberedEngineSelectionServerId,
        params.rememberedEngineSelectionsByScope,
        params.rememberEngineSelectionsEnabled,
        params.resolvedBackendEntries,
        params.selectedBackendEntry,
        params.selectedBackendTargetKey,
        params.sessionConfigOptionOverrides?.overrides,
    ]);

    React.useEffect(() => {
        const currentTargetKey = params.selectedBackendEntry?.targetKey ?? params.selectedBackendTargetKey;
        const nextSelection = buildInitialEngineSelection(currentTargetKey);
        const pendingAppliedSelection = pendingAppliedSelectionRef.current;
        if (pendingAppliedSelection?.targetKey === currentTargetKey) {
            if (!areEngineSelectionsEqual(nextSelection, pendingAppliedSelection.selection)) {
                engineSelectionByTargetKeyRef.current.set(currentTargetKey, pendingAppliedSelection.selection);
                return;
            }
            pendingAppliedSelectionRef.current = null;
        }
        engineSelectionByTargetKeyRef.current.set(currentTargetKey, nextSelection);
    }, [buildInitialEngineSelection, params.selectedBackendEntry?.targetKey, params.selectedBackendTargetKey]);

    const getEngineSelectionForTargetKey = React.useCallback((targetKey: string) => {
        const existing = engineSelectionByTargetKeyRef.current.get(targetKey);
        if (existing) return existing;
        const initialSelection = buildInitialEngineSelection(targetKey);
        engineSelectionByTargetKeyRef.current.set(targetKey, initialSelection);
        return initialSelection;
    }, [buildInitialEngineSelection]);

    const applyEngineSelection = React.useCallback((entry: ResolvedBackendCatalogEntry, selection: EngineSelectionLike) => {
        const nextConfigOverrides = normalizeConfigOverrides(selection.configOverrides);
        const nextSessionModeId = normalizeSessionModeIdForEntry(entry, selection.sessionModeId);
        const normalizedSelection: EngineSelection = {
            ...selection,
            sessionModeId: nextSessionModeId,
            configOverrides: nextConfigOverrides,
        };
        pendingAppliedSelectionRef.current = {
            targetKey: entry.targetKey,
            selection: normalizedSelection,
        };
        params.onExplicitBackendTargetSelection?.(entry.target);
        params.setBackendTarget(entry.target);
        params.setModelMode(selection.modelId as ModelMode);
        params.setAcpSessionModeId(nextSessionModeId);
        const updatedAt = Date.now();
        const sessionConfigOptionOverrides = buildSessionConfigOptionOverrides(nextConfigOverrides, updatedAt);
        params.onRememberEngineSelection?.(entry.target, {
            modelId: selection.modelId,
            acpSessionModeId: nextSessionModeId,
            sessionConfigOptionOverrides,
        });
        if (!sessionConfigOptionOverrides) {
            params.setSessionConfigOptionOverrides(null);
            return;
        }
        params.setSessionConfigOptionOverrides(sessionConfigOptionOverrides);
    }, [
        params.onRememberEngineSelection,
        params.onExplicitBackendTargetSelection,
        params.setAcpSessionModeId,
        params.setBackendTarget,
        params.setModelMode,
        params.setSessionConfigOptionOverrides,
    ]);

    const handleToggleFavoriteBackendTarget = React.useCallback((targetKey: string) => {
        if (!params.setFavoriteBackendTargetKeys) return;
        params.setFavoriteBackendTargetKeys(toggleFavoriteBackendTargetKey(
            params.favoriteBackendTargetKeys ?? [],
            targetKey,
        ));
    }, [
        params.favoriteBackendTargetKeys,
        params.setFavoriteBackendTargetKeys,
    ]);

    const handleToggleFavoriteModel = React.useCallback((
        entry: ResolvedBackendCatalogEntry,
        model: Readonly<{ modelId: string; modelLabel: string }>,
    ) => {
        if (!params.setFavoriteModelSelections) return;
        params.setFavoriteModelSelections(toggleFavoriteModelSelection({
            favorites: params.favoriteModelSelections ?? [],
            backend: buildFavoriteBackendIdentity(entry),
            modelId: model.modelId,
            modelLabel: model.modelLabel,
            backendLabel: entry.title,
            addedAtMs: Date.now(),
        }));
    }, [
        params.favoriteModelSelections,
        params.setFavoriteModelSelections,
    ]);

    const handleSelectFavoriteModel = React.useCallback((
        entry: ResolvedBackendCatalogEntry,
        modelId: string,
        configOverrides?: Readonly<Record<string, string>>,
    ) => {
        const nextSelection = {
            ...getEngineSelectionForTargetKey(entry.targetKey),
            modelId,
            ...(configOverrides ? { configOverrides } : {}),
        };
        engineSelectionByTargetKeyRef.current.set(entry.targetKey, nextSelection);
        applyEngineSelection(entry, nextSelection);
    }, [applyEngineSelection, getEngineSelectionForTargetKey]);

    const handleSelectFavoriteModelOptionValue = React.useCallback((
        entry: ResolvedBackendCatalogEntry,
        modelId: string,
        configId: string,
        valueId: string,
    ) => {
        const currentSelection = getEngineSelectionForTargetKey(entry.targetKey);
        const nextSelection = {
            ...currentSelection,
            modelId,
            configOverrides: {
                ...currentSelection.configOverrides,
                [configId]: valueId,
            },
        };
        engineSelectionByTargetKeyRef.current.set(entry.targetKey, nextSelection);
        applyEngineSelection(entry, nextSelection);
    }, [applyEngineSelection, getEngineSelectionForTargetKey]);

    const handleRemoveFavoriteModelSelection = React.useCallback((favorite: FavoriteModelSelectionV1) => {
        if (!params.setFavoriteModelSelections) return;
        params.setFavoriteModelSelections((params.favoriteModelSelections ?? []).filter((item) => item !== favorite));
    }, [
        params.favoriteModelSelections,
        params.setFavoriteModelSelections,
    ]);

    const favoriteModelsDetailSelectionRef = useLatestRef({
        selectedBackendTargetKey: params.selectedBackendEntry?.targetKey ?? params.selectedBackendTargetKey,
        selectedModelId: String(params.modelMode),
    });
    const effectiveProfileId = params.useProfiles ? params.selectedProfileId : null;

    const agentPickerOptions = React.useMemo<ReadonlyArray<AgentInputChipPickerOption> | undefined>(() => {
        if (params.resolvedBackendEntries.length <= 1) {
            return undefined;
        }
        const favoriteBackendTargetKeySet = new Set(params.favoriteBackendTargetKeys ?? []);
        const sortedBackendEntries = sortItemsByFavoriteTargetKey(
            params.resolvedBackendEntries,
            params.favoriteBackendTargetKeys ?? [],
            (entry) => entry.targetKey,
        );
        const resolved = sortedBackendEntries.map((entry) => {
            const isCompatibleWithSelectedProfile = !profileForAgentSelection || compatibleBackendTargetKeys.has(entry.targetKey);
            const selectable = params.isBackendEntrySelectable(entry);
            const isFavoriteBackend = favoriteBackendTargetKeySet.has(entry.targetKey);
            const disabled = !isCompatibleWithSelectedProfile;
            const connectedServices = resolveConnectedServicesForEntry(entry);
            const connectedServicesCacheKeyPart = buildConnectedServicesPayloadCacheKeyPart(connectedServices);
            const muted = !selectable && !disabled;
            const subtitle = !isCompatibleWithSelectedProfile
                ? t('newSession.aiBackendNotCompatibleWithSelectedProfile')
                : undefined;

            return {
                id: entry.targetKey,
                label: entry.title,
                icon: (
                    <AgentIcon
                        agentId={entry.iconAgentId}
                        size={12}
                        style={{ transform: [{ scale: getAgentPickerIconScale(entry.iconAgentId) }] }}
                    />
                ),
                subtitle,
                disabled,
                muted: muted || disabled,
                railAction: params.setFavoriteBackendTargetKeys ? {
                    testID: `new-session-engine-favorite-rail:${entry.targetKey}`,
                    accessibilityLabel: isFavoriteBackend ? t('profiles.actions.removeFromFavorites') : t('profiles.actions.addToFavorites'),
                    selected: isFavoriteBackend,
                    icon: <EngineFavoritePickerIcon favorite={isFavoriteBackend} />,
                    onPress: () => {
                        handleToggleFavoriteBackendTarget(entry.targetKey);
                    },
                } : undefined,
                closeOnSelectImmediate: false,
                deferRenderDetailContent: true,
                deferredDetailContentCacheKey: [
                    'new-session-engine',
                    params.capabilityServerId,
                    params.selectedMachineId ?? '',
                    entry.targetKey,
                    params.selectedPath ?? '',
                    effectiveProfileId ?? '',
                    connectedServicesCacheKeyPart,
                ].join(':'),
                onSelectImmediate: () => {
                    if (disabled) return;
                    params.onRememberAgentPickerView?.({
                        kind: 'backend',
                        backendTargetKey: entry.targetKey,
                    });
                    const nextSelection = getEngineSelectionForTargetKey(entry.targetKey);
                    applyEngineSelection(entry, nextSelection);
                },
                renderDetailContent: () => {
                    const selection = getEngineSelectionForTargetKey(entry.targetKey);
                    const capabilityProbeContext = resolveNewSessionCapabilityProbeContext({
                        backendTarget: entry.target,
                        settings: params.settings,
                    });
                    const detailConnectedServices = resolveConnectedServicesForEntry(entry);
                    return (
                        <NewSessionEngineOptionDetail
                            backendTarget={entry.target}
                            selectedMachineId={params.selectedMachineId}
                            capabilityServerId={params.capabilityServerId}
                            cwd={params.selectedPath}
                            profileId={effectiveProfileId}
                            capabilityProbeContext={capabilityProbeContext}
                            connectedServices={detailConnectedServices}
                            refreshProbe={params.refreshProbe}
                            selectedModelId={selection.modelId}
                            selectedSessionModeId={selection.sessionModeId}
                            selectedConfigOverrides={selection.configOverrides}
                            favoriteModelSelections={params.favoriteModelSelections ?? []}
                            onToggleFavoriteModel={params.setFavoriteModelSelections ? (model) => {
                                handleToggleFavoriteModel(entry, model);
                            } : undefined}
                            favoriteEngine={params.setFavoriteBackendTargetKeys ? {
                                favorite: isFavoriteBackend,
                                onToggle: () => {
                                    handleToggleFavoriteBackendTarget(entry.targetKey);
                                },
                            } : undefined}
                            onSelectionChange={(nextSelection) => {
                                engineSelectionByTargetKeyRef.current.set(entry.targetKey, nextSelection);
                                applyEngineSelection(entry, nextSelection);
                            }}
                        />
                    );
                },
            };
        });
        const available: AgentInputChipPickerOption[] = [];
        const muted: AgentInputChipPickerOption[] = [];
        const disabledOptions: AgentInputChipPickerOption[] = [];
        for (const option of resolved) {
            if (option.disabled) {
                disabledOptions.push(option);
            } else if (option.muted) {
                muted.push(option);
            } else {
                available.push(option);
            }
        }
        const favoriteModelSelections = params.favoriteModelSelections ?? [];
        const favoriteBackendEntries = params.resolvedBackendEntries.filter((entry) => (
            !profileForAgentSelection || compatibleBackendTargetKeys.has(entry.targetKey)
        ));
        const favoriteModelSelectionsForVisibleBackends = favoriteModelSelections.filter((favorite) => (
            favoriteBackendEntries.some((entry) => (
                favoriteModelSelectionMatchesBackend(favorite, buildFavoriteBackendIdentity(entry))
            ))
        ));
        const favoriteConnectedServicesByTargetKey = Object.fromEntries(
            favoriteBackendEntries.map((entry) => [
                entry.targetKey,
                resolveConnectedServicesForEntry(entry),
            ]),
        );
        const favoriteConnectedServicesCacheKeyPart = stableJsonStringify(favoriteConnectedServicesByTargetKey);
        const favoriteModelsOption: AgentInputChipPickerOption[] = favoriteModelSelectionsForVisibleBackends.length > 0
            ? [{
                id: FAVORITE_MODELS_AGENT_PICKER_OPTION_ID,
                label: t('profiles.groups.favorites'),
                icon: <FavoriteModelsPickerIcon />,
                closeOnSelectImmediate: false,
                deferRenderDetailContent: true,
                deferredDetailContentCacheKey: [
                    'new-session-favorite-models',
                    params.capabilityServerId,
                    params.selectedMachineId ?? '',
                    params.selectedPath ?? '',
                    effectiveProfileId ?? '',
                    favoriteConnectedServicesCacheKeyPart,
                ].join(':'),
                preserveFocusOnExternalSelectionChange: true,
                onSelectImmediate: () => {
                    params.onRememberAgentPickerView?.({ kind: 'favoriteModels' });
                },
                renderDetailContent: () => {
                    const selection = favoriteModelsDetailSelectionRef.current;
                    return (
                        <NewSessionFavoriteModelsDetail
                            favoriteModelSelections={favoriteModelSelectionsForVisibleBackends}
                            resolvedBackendEntries={favoriteBackendEntries}
                            selectedBackendTargetKey={selection.selectedBackendTargetKey}
                            selectedModelId={selection.selectedModelId}
                            selectedConfigOverrides={getEngineSelectionForTargetKey(selection.selectedBackendTargetKey).configOverrides}
                            selectedMachineId={params.selectedMachineId}
                            capabilityServerId={params.capabilityServerId}
                            cwd={params.selectedPath}
                            profileId={effectiveProfileId}
                            settings={params.settings}
                            connectedServicesByTargetKey={favoriteConnectedServicesByTargetKey}
                            refreshProbe={params.refreshProbe ?? null}
                            onSelectFavoriteModel={handleSelectFavoriteModel}
                            onSelectFavoriteModelOptionValue={handleSelectFavoriteModelOptionValue}
                            onToggleFavoriteModel={handleToggleFavoriteModel}
                            onRemoveFavoriteModelSelection={handleRemoveFavoriteModelSelection}
                        />
                    );
                },
            }]
            : [];
        return [...favoriteModelsOption, ...available, ...muted, ...disabledOptions];
    }, [
        applyEngineSelection,
        compatibleBackendTargetKeys,
        effectiveProfileId,
        handleSelectFavoriteModel,
        handleSelectFavoriteModelOptionValue,
        handleToggleFavoriteBackendTarget,
        handleToggleFavoriteModel,
        handleRemoveFavoriteModelSelection,
        favoriteModelsDetailSelectionRef,
        getEngineSelectionForTargetKey,
        params.capabilityServerId,
        params.favoriteBackendTargetKeys,
        params.favoriteModelSelections,
        params.isBackendEntrySelectable,
        params.modelMode,
        params.refreshProbe,
        params.resolvedBackendEntries,
        params.selectedBackendEntry?.targetKey,
        params.selectedMachineId,
        params.selectedPath,
        params.selectedBackendTargetKey,
        params.setFavoriteBackendTargetKeys,
        params.setFavoriteModelSelections,
        params.settings,
        params.onRememberAgentPickerView,
        profileForAgentSelection,
        resolveConnectedServicesForEntry,
    ]);
    const favoriteModelSelectionsSignature = React.useMemo(
        () => buildFavoriteModelSelectionsSignature(params.favoriteModelSelections ?? []),
        [params.favoriteModelSelections],
    );
    const favoriteBackendTargetKeysSignature = React.useMemo(
        () => buildFavoriteBackendTargetKeysSignature(params.favoriteBackendTargetKeys ?? []),
        [params.favoriteBackendTargetKeys],
    );
    const currentConfigOverridesSignature = React.useMemo(() => buildCurrentConfigOverridesSignature({
        configOverrides: Object.fromEntries(
            Object.entries(params.sessionConfigOptionOverrides?.overrides ?? {})
                .map(([configId, override]) => [
                    readNonBlankSessionControlIdentifier(configId) ?? '',
                    readSessionControlValueId(override?.value) ?? '',
                ])
                .filter(([configId, value]) => configId.length > 0 && value.length > 0),
        ),
    }), [
        params.sessionConfigOptionOverrides?.overrides,
    ]);
    const agentPickerOptionsSignature = React.useMemo(
        () => `${buildAgentPickerOptionsSignature(agentPickerOptions)}|favorite-models:${favoriteModelSelectionsSignature}|favorite-backends:${favoriteBackendTargetKeysSignature}|config-overrides:${currentConfigOverridesSignature}`,
        [agentPickerOptions, currentConfigOverridesSignature, favoriteBackendTargetKeysSignature, favoriteModelSelectionsSignature],
    );
    const stableAgentPickerOptions = useStableValueBySignature(
        agentPickerOptions,
        agentPickerOptionsSignature,
    );

    const agentPickerSelectedOptionId = React.useMemo(() => {
        const fallbackOptionId = params.selectedBackendEntry?.targetKey ?? params.selectedBackendTargetKey;
        const pickerOptions = stableAgentPickerOptions ?? [];
        if (params.rememberedAgentPickerView?.kind === 'favoriteModels') {
            const hasFavoriteModelsOption = pickerOptions.some((option) => option.id === FAVORITE_MODELS_AGENT_PICKER_OPTION_ID);
            if (hasFavoriteModelsOption) {
                return FAVORITE_MODELS_AGENT_PICKER_OPTION_ID;
            }
        }
        const rememberedView = params.rememberedAgentPickerView;
        if (rememberedView?.kind === 'backend') {
            const hasRememberedBackendOption = pickerOptions.some((option) => option.id === rememberedView.backendTargetKey);
            if (hasRememberedBackendOption) {
                return rememberedView.backendTargetKey;
            }
        }
        return fallbackOptionId;
    }, [
        params.rememberedAgentPickerView,
        params.selectedBackendEntry?.targetKey,
        params.selectedBackendTargetKey,
        stableAgentPickerOptions,
    ]);

    const agentPickerSelectStateRef = useLatestRef({
        applyEngineSelection,
        getEngineSelectionForTargetKey,
        onRememberAgentPickerView: params.onRememberAgentPickerView,
        resolvedBackendEntries: params.resolvedBackendEntries,
    });
    const handleAgentPickerSelect = React.useCallback((selectedId: string) => {
        if (selectedId === FAVORITE_MODELS_AGENT_PICKER_OPTION_ID) {
            agentPickerSelectStateRef.current.onRememberAgentPickerView?.({ kind: 'favoriteModels' });
            return;
        }
        const state = agentPickerSelectStateRef.current;
        const nextEntry = state.resolvedBackendEntries.find((entry) => entry.targetKey === selectedId) ?? null;
        if (nextEntry) {
            state.onRememberAgentPickerView?.({
                kind: 'backend',
                backendTargetKey: nextEntry.targetKey,
            });
            const nextSelection = state.getEngineSelectionForTargetKey(nextEntry.targetKey);
            state.applyEngineSelection(nextEntry, nextSelection);
        }
    }, [agentPickerSelectStateRef]);

    const agentClickStateRef = useLatestRef({
        selectableBackendEntries,
        selectedBackendEntryTargetKey: params.selectedBackendEntry?.targetKey ?? null,
        selectedBackendTargetKey: params.selectedBackendTargetKey,
        setBackendTarget: params.setBackendTarget,
    });
    const handleAgentClick = React.useCallback(() => {
        const state = agentClickStateRef.current;
        if (state.selectableBackendEntries.length === 0) {
            return;
        }

        if (state.selectableBackendEntries.length === 1) {
            const nextEntry = state.selectableBackendEntries[0] ?? null;
            if (nextEntry && nextEntry.targetKey !== (state.selectedBackendEntryTargetKey ?? state.selectedBackendTargetKey)) {
                state.setBackendTarget(nextEntry.target);
            }
        }
    }, [agentClickStateRef]);

    return {
        agentPickerOptions: stableAgentPickerOptions,
        agentPickerSelectedOptionId,
        handleAgentPickerSelect,
        handleAgentClick,
    };
}
