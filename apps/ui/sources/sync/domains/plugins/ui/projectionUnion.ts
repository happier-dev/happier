import {
    EMPTY_PLUGIN_UI_PROJECTION,
    samePluginUiMaterializationFacts,
    arePluginUiMaterializationsEquivalent,
    resolvePluginUiClientExecutablePlatform,
    type PluginUiActionProjection,
    type PluginUiHostedWebProjection,
    type PluginUiProjectionModel,
    type PluginUiReactNativeBundleProjection,
    type PluginUiSettingsGroupProjection,
    type PluginUiSettingsPageProjection,
    type PluginUiSessionHeaderActionProjection,
    type PluginUiSearchProviderProjection,
    type PluginUiPhysicalSurfacePlacementProjection,
    type PluginUiTranslationsProjection,
    type PluginVoiceProviderProjection,
    type PluginUiDragSourceProjection,
    type PluginUiWorkItemsProjection,
    type PluginUiDropTargetProjection,
    type PluginUiResourceProjection,
    type PluginUiInputTypeProjection,
    type PluginUiAtmospherePictureProjection,
    type PluginUiRegistrySourceProjection,
    type PluginUiStoreKindProjection,
    type PluginUiSkillProjection,
} from './projection';
import { arePluginMachineExecutionOriginsEqual, getPluginMachineExecutionOriginRef, type PluginMachineExecutionOriginV1 } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import type { PluginProjectionInstalledPackageV2 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import type { PluginMachineMaterializationV1 } from '@happier-dev/protocol/plugins/availability/v1';
import type { MachineAdministrationTargetV1 } from '@happier-dev/protocol/account/settings/machineAdministrationSelectionsV1';
import { PluginUiArtifactsManifestEntryV2Schema } from '@happier-dev/protocol/plugins/ui';
import { projectPluginDeclarativeModelComparisonV1, type PluginDeclarativeProjectedModelV1 } from '@happier-dev/protocol/plugins/contributions/ui/declarativeProjectedModelV1';
import type { PluginUiProjectionPhase } from './usePluginUiProjectionCurrentness';
import { composePluginMachineExecutionOriginV1, type PluginMachineSourceExecutionOriginCandidateV1, type PluginMachineExecutionOriginRejectionV1 } from '@/sync/domains/machines/administration/pluginExecutionOrigin';
import { resolveFleetSupplyAgreement } from '@/sync/domains/machines/administration/fleetUnion';
import { readSelectedPluginUiResourceCapability } from './resourceCapability';
import { normalizeStrictJsonValue, projectNativeJsonValueForTransport, sameStrictJsonValue, type JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import {
    hasCurrentPluginUiProjectionOccurrence as entryHasCurrentOccurrence,
    readPluginUiProjectionEntryOrPackageExecutionOrigin,
    publishPluginUiContributionSupplies,
    readPluginUiAccountExecutableOrigin,
    readPluginUiContributionOrigin,
    readPluginUiContributionSupplies,
    readPluginUiProjectionEntryExecutionOrigin,
    retainPluginUiProjectionValue,
    type PluginUiContributionOriginV1,
    type PluginUiContributionSupplyV1,
} from './projectionOrigins';

export {
    PLUGIN_UI_CONTRIBUTION_ORIGIN_KEY,
    preparePluginUiProjectionOrigins,
    readPluginUiContributionOrigin,
    readPluginUiContributionSupplies,
    readPluginUiProjectionEntryExecutionOrigin,
    type PluginUiContributionOriginV1,
    type PluginUiContributionSupplyV1,
} from './projectionOrigins';

type UnknownRecord = Readonly<Record<string, unknown>>;
type UnionSupplyFacts = Readonly<{
    facts: Map<UnknownRecord, PluginUiContributionSupplyV1>;
    /** Previous carriers are available only during this synchronous publication. */
    previousFacts?: ReadonlyMap<UnknownRecord, PluginUiContributionSupplyV1>;
}>;

/**
 * Capture execution from an already-selected publication, not its descriptive
 * representative. Account custody and a renderer's optional Machine supply are
 * independent; this conversion never selects a candidate or changes the catalog.
 */
export function resolvePluginUiExecutionDeclaration<T extends UnknownRecord & Readonly<{ id: string; pluginId: string }>>(
    declaration: T,
    input: Readonly<{ current?: T | null; machineResource?: PluginUiResourceProjection | null }> = {},
): T | null {
    const current = input.current === undefined ? declaration : input.current;
    if (!current || current.pluginId !== declaration.pluginId || current.id !== declaration.id) return null;
    if (input.machineResource) {
        const resource = input.machineResource;
        if (resource.pluginId !== declaration.pluginId || resource.execution?.target === 'account') return null;
        const supplies = readPluginUiContributionSupplies(current);
        // Direct Session/Project projections retain their incumbent scoped
        // admission. Union rows instead require the exact selected Resource.
        if (supplies.length === 0) return Object.hasOwn(current, 'hostSupplies') ? null : current;
        const origin = readPluginUiProjectionEntryExecutionOrigin(resource);
        const bound = readPluginUiContributionOrigin(current);
        // A selected placement already owns authority; a Resource cannot
        // replace it with a sibling supplier. Scoped Resource rows can
        // omit their redundant stamps, but any stamps present must agree.
        if (bound) return bound.executionOrigin && bound.phase === 'current' && bound.interactionEnabled
            && typeof current.occurrenceId === 'string'
            && (resource.occurrenceId === undefined || current.occurrenceId === resource.occurrenceId)
            && (!origin || arePluginMachineExecutionOriginsEqual(bound.executionOrigin, origin)) ? current : null;
        if (!origin || !resource.occurrenceId) return null;
        const selected = supplies.find(supply => supply.executionOrigin
            && arePluginMachineExecutionOriginsEqual(supply.executionOrigin, origin)
            && supply.occurrenceId === resource.occurrenceId);
        if (!selected || selected.phase !== 'current' || !selected.interactionEnabled) return null;
        return Object.freeze({ ...current, occurrenceId: selected.occurrenceId,
            executionOrigin: selected.executionOrigin, hostOrigin: selected,
            runtime: Object.freeze({ ...asRecord(current.runtime), resourceCapability: selected.resourceCapability }) });
    }
    const execution = asRecord(declaration.execution);
    const currentExecution = asRecord(current.execution);
    if (execution?.target !== currentExecution?.target) return null;
    const executable = asRecord(execution?.target === 'account' ? execution.account : execution?.target === 'client' ? execution.client : null);
    const currentExecutable = asRecord(currentExecution?.target === 'account' ? currentExecution.account
        : currentExecution?.target === 'client' ? currentExecution.client : null);
    if (executable?.artifactId !== currentExecutable?.artifactId || executable?.exportName !== currentExecutable?.exportName) return null;
    if (execution?.target === 'account') {
        const captured = readPluginUiAccountExecutableOrigin(declaration);
        const selected = readPluginUiAccountExecutableOrigin(current);
        if (!selected || captured && (captured.serverId !== selected.serverId || captured.accountId !== selected.accountId
            || captured.custodyId !== selected.custodyId)) return null;
        return current;
    }
    // An occurrence-less union row has not captured an executable yet. Once
    // bound, replacement is a retirement, including source changes in place.
    if (declaration.occurrenceId !== undefined && declaration.occurrenceId !== current.occurrenceId) return null;
    const captured = readPluginUiProjectionEntryExecutionOrigin(declaration);
    const selected = readPluginUiProjectionEntryExecutionOrigin(current);
    if (captured && (!selected || !arePluginMachineExecutionOriginsEqual(captured, selected))) return null;
    return current;
}

export type PluginUiProjectionUnionMember = Readonly<{
    machineId: string;
    serverId: string | null;
    serverIdentityId?: string;
    projection: PluginUiProjectionModel | null;
    phase: PluginUiProjectionPhase;
    unavailableReasonCode?: string;
    interactionEnabled: boolean;
    /** Exact reported content correspondence, separate from runtime authority. */
    materializationsByPluginId?: Readonly<Record<string, PluginMachineMaterializationV1>>;
    /** Exact choices admitted by Administration; omitted means not reported yet. */
    selectableExecutionOrigins?: readonly PluginMachineExecutionOriginV1[];
}>;

/** Installed release slots bind the graph omitted by portable manifest-only declarations. */
function matchesInstalledArtifactSlot(
    entry: unknown,
    materializations: Readonly<Record<string, PluginMachineMaterializationV1>> | undefined,
): boolean {
    const record = asRecord(entry);
    const pluginId = readString(record?.pluginId);
    const materialization = pluginId ? materializations?.[pluginId] : null;
    if (!record || !materialization?.portableRelease || record.pluginVersion !== materialization.version
        || !readString(record.occurrenceId)) return false;
    const origin = readPluginUiProjectionEntryExecutionOrigin(record);
    if (!origin || !arePluginMachineExecutionOriginsEqual(origin, composePluginMachineExecutionOriginV1(materialization))) return false;
    const graph = PluginUiArtifactsManifestEntryV2Schema.safeParse(record.artifactGraph);
    const tier = record.contributionKind === 'reactNativeBundle' ? 'reactNative'
        : record.contributionKind === 'hostedWeb' ? 'hostedWeb' : null;
    if (!graph.success || graph.data.tier !== tier) return false;
    const platform = resolvePluginUiClientExecutablePlatform();
    return materialization.uiArtifacts.some(slot => slot.contributionId === record.contributionId
        && slot.artifactId === graph.data.artifactId && slot.tier === tier && slot.platform === platform
        && slot.artifactDigest === graph.data.digest && slot.hostUiApiRange === graph.data.hostUiApiRange);
}

export function mergeInstalledPluginUiProjections(
    installed: readonly PluginUiProjectionModel[],
    runtime: PluginUiProjectionModel | null,
    materializations?: Readonly<Record<string, PluginMachineMaterializationV1>>,
    explicitOrigins?: PluginUiProjectionUnionOriginSelections,
    /** Only a proven complete census can withdraw runtime rows omitted by an installation. */
    completeUiPluginIds?: ReadonlySet<string>,
): PluginUiProjectionModel | null {
    return deriveInstalledPluginUiProjection(installed, runtime, materializations, explicitOrigins, createDeclarationComparisons(), completeUiPluginIds);
}

function deriveInstalledPluginUiProjection(
    installed: readonly PluginUiProjectionModel[],
    runtime: PluginUiProjectionModel | null,
    materializations: Readonly<Record<string, PluginMachineMaterializationV1>> | undefined,
    explicitOrigins: PluginUiProjectionUnionOriginSelections | undefined,
    comparisons: DeclarationComparisons,
    completeUiPluginIds?: ReadonlySet<string>,
): PluginUiProjectionModel | null {
    if (installed.length === 0) return runtime;
    // A renderer descriptor selects that renderer, not the plugin's entire
    // declaration census. Partial installation metadata retains known rows,
    // but cannot turn an unobserved UI declaration into a withdrawal.
    // Complete installations still retire omitted entries,
    // including renderer-only Machine installations with exact artifact slots.
    const installedPluginIds = new Set(installed.flatMap(model => [
        ...Object.keys(model.installedPackagesById),
        ...declarationMaps(model).flatMap(map => Object.values(map).flatMap(entry => {
            const record = asRecord(entry);
            const id = readString(record?.pluginId);
            return id && record?.contributionKind !== 'uiRenderer' ? [id] : [];
        })),
    ]).filter(id => completeUiPluginIds === undefined || completeUiPluginIds.has(id)));
    const hostBundledPluginIds = new Set(installed.flatMap(model => Object.values(model.installedPackagesById)
        .filter(plugin => plugin.source.kind === 'bundled' && !plugin.occurrenceId).map(plugin => plugin.id)));
    const merge = <T>(read: (model: PluginUiProjectionModel) => Readonly<Record<string, T>>, options: Readonly<{
        artifactFacts?: boolean;
        hostDeclarations?: boolean;
        uiCensus?: boolean;
    }> = {}) => {
        const { artifactFacts, hostDeclarations, uiCensus } = options;
        const declared: Record<string, T> = Object.assign({}, ...installed.map(read));
        for (const [key, entry] of Object.entries(runtime ? read(runtime) : {})) {
            const declaration = asRecord(declared[key]);
            // Account Actions and their per-Action executable graphs share
            // Availability custody, independently of an optional Machine supplier.
            if (artifactFacts && declaration?.generatedOwnerKind === 'clientContribution'
                && readPluginUiAccountExecutableOrigin(declaration)) continue;
            const pluginId = readString(asRecord(entry)?.pluginId);
            const selectedOrigin = pluginId ? explicitOrigins?.get(pluginId) : undefined;
            if (pluginId && hostBundledPluginIds.has(pluginId) && selectedOrigin && 'sourceRef' in selectedOrigin
                && !(hostDeclarations && readPluginUiAccountExecutableOrigin(declaration))
                && selectedOrigin.sourceRef.sourceCustody.kind === 'development'
                && readPluginUiContributionSupplies(entry).some(supply => supply.phase === 'current' && supply.interactionEnabled
                    && supply.executionOrigin && arePluginMachineExecutionOriginsEqual(supply.executionOrigin, selectedOrigin))) {
                // Development renderer bytes are selected independently from
                // an existing Account destination's requester custody. Only
                // Machine-owned/new destinations take the runtime declaration.
                declared[key] = entry;
                continue;
            }
            const executableOwner = asRecord(entry)?.generatedOwnerKind;
            if (artifactFacts && (executableOwner === 'clientContribution' || executableOwner === 'voiceProvider')
                && declaration?.generatedOwnerKind !== 'renderer') {
                // Installed declarations retain renderer bytes. Executable graphs
                // instead accompany the runtime Actions/Voice declarations whose
                // exact occurrence and origin the executable resolver admits.
                declared[key] = entry;
                continue;
            }
            if (declaration && Array.isArray(declaration.hostSupplies)
                && (!declaration.occurrenceId || declaration.hostAccountOrigin)) {
                declared[key] = Object.freeze(Object.assign({}, declared[key], {
                    hostSupplies: readPluginUiContributionSupplies(entry),
                    // Account surfaces retain their own custody; these supplies
                    // are only optional scoped Machine transport. Other bundled
                    // surfaces retain the selected producer's launch identity.
                    ...(!declaration.hostAccountOrigin && (declaration.contributionKind === 'surfacePlacement' || declaration.contributionKind === 'settingsPage')
                        ? {
                            runtime: asRecord(entry)?.runtime ?? declaration.runtime,
                            occurrenceId: asRecord(entry)?.occurrenceId,
                            executionOrigin: asRecord(entry)?.executionOrigin,
                            hostOrigin: asRecord(entry)?.hostOrigin,
                        } : {}),
                }));
                continue;
            }
            if (!pluginId || ((!uiCensus || !installedPluginIds.has(pluginId)) && !declared[key])
                || (artifactFacts && matchesInstalledArtifactSlot(entry, materializations))
                || (declared[key] && sameDeclarationContent(declared[key], entry, comparisons))) {
                declared[key] = entry;
            }
        }
        return Object.freeze(declared);
    };
    const projection = Object.freeze({
        ...(runtime ?? EMPTY_PLUGIN_UI_PROJECTION),
        generation: runtime?.generation ?? null,
        installedPackagesById: Object.freeze(Object.assign({}, ...installed.map(model => model.installedPackagesById), runtime?.installedPackagesById)),
        // Availability owns portable Account execution; Machine projections
        // continue to own every other executable Action family.
        actionsById: Object.freeze(Object.assign({}, runtime?.actionsById,
            ...installed.map(model => Object.fromEntries(Object.entries(model.actionsById)
                .filter(([, action]) => action.execution.target === 'account'))))),
        connectedAccountDescriptorsById: Object.freeze(Object.assign({}, runtime?.connectedAccountDescriptorsById,
            ...installed.map(model => model.connectedAccountDescriptorsById))),
        translationsByPluginId: merge(model => model.translationsByPluginId, { uiCensus: true }),
        sessionHeaderActionsById: merge(model => model.sessionHeaderActionsById, { uiCensus: true }),
        // Search binds the runtime Action's occurrence and origin, like
        // Machine Actions above. Portable renderer declarations omit this family
        // and cannot withdraw an admitted runtime provider from Home.
        searchProvidersById: runtime?.searchProvidersById ?? EMPTY_PLUGIN_UI_PROJECTION.searchProvidersById,
        hostedWebById: merge(model => model.hostedWebById, { artifactFacts: true, uiCensus: true }),
        reactNativeBundlesById: merge(model => model.reactNativeBundlesById, { artifactFacts: true, uiCensus: true }),
        surfacePlacementsById: merge(model => model.surfacePlacementsById, { hostDeclarations: true, uiCensus: true }),
        settingsGroupsById: merge(model => model.settingsGroupsById, { uiCensus: true }),
        settingsPagesById: merge(model => model.settingsPagesById, { hostDeclarations: true, uiCensus: true }),
        // The installed pluginUi census cannot withdraw independent contribution
        // families. Their current daemon projection owns declaration removal.
        composerControlsById: merge(model => model.composerControlsById),
        composerRegionsById: merge(model => model.composerRegionsById),
        composerReferencesById: merge(model => model.composerReferencesById),
        voiceProvidersById: merge(model => model.voiceProvidersById),
        atmospherePicturesById: merge(model => model.atmospherePicturesById),
        registrySourcesById: merge(model => model.registrySourcesById),
        storeKindsById: merge(model => model.storeKindsById),
        skillsById: merge(model => model.skillsById),
        unknownEntriesById: merge(model => model.unknownEntriesById, { uiCensus: true }),
    });
    return projection;
}

/**
 * The canonical Administration decision for each plugin that may contribute to
 * the app scope. Selection binds effects only; its absence cannot remove
 * an installed declaration from the Account catalog.
 */
export type PluginUiProjectionUnionOriginSelections = ReadonlyMap<
    string,
    PluginMachineExecutionOriginV1
>;

/** Selection meaning, not a reporter's map wrapper, invalidates composition. */
export function arePluginExecutionOriginSelectionsEquivalent(
    left: PluginUiProjectionUnionOriginSelections | undefined,
    right: PluginUiProjectionUnionOriginSelections | undefined,
): boolean {
    if (left === right) return true;
    if ((left?.size ?? 0) !== (right?.size ?? 0)) return false;
    for (const [pluginId, origin] of left ?? []) {
        const other = right?.get(pluginId);
        if (!other || !arePluginMachineExecutionOriginsEqual(origin, other)) return false;
    }
    return true;
}

export type PluginUiProjectionUnion = Readonly<{
    pluginUiProjection: PluginUiProjectionModel | null;
    /** Canonical state for app consumers without a contribution-specific origin. */
    phase: PluginUiProjectionPhase;
    unavailableReasonCode?: string;
    /** Missing destinations remain unresolved while an eligible origin is pending. */
    hasEstablishingMembers: boolean;
    /**
     * Coarse roll-up across current contributors. The per-contribution
     * origin is still the authority for an actual mount; this value reaches
     * only consumers that have no contribution in hand.
     */
    interactionEnabled: boolean;
    /**
     * The union's machine, and only when the union HAS one: a single eligible
     * member. With zero or several members there is no single app machine and
     * this is `null` — the honest answer. It is never inferred from `activeAt`.
     */
    machineId: string | null;
    serverId: string | null;
}>;

export const EMPTY_PLUGIN_UI_PROJECTION_UNION: PluginUiProjectionUnion = Object.freeze({
    pluginUiProjection: null,
    phase: 'unavailable',
    hasEstablishingMembers: false,
    interactionEnabled: false,
    machineId: null,
    serverId: null,
});

/** One Account/target publisher owns only its current immutable source inputs. */
export function createPluginUiProjectionUnionPublication() {
    let members: readonly PluginUiProjectionUnionMember[] | null = null;
    let publishedMembers: readonly PluginUiProjectionUnionMember[] | null = null;
    let publishedSelections: PluginUiProjectionUnionOriginSelections | undefined;
    let selections: PluginUiProjectionUnionOriginSelections | undefined;
    let comparisons = createDeclarationComparisons();
    let source: UnionPublicationSource | null = null;
    let snapshot = EMPTY_PLUGIN_UI_PROJECTION_UNION;
    return {
        getSnapshot: (): PluginUiProjectionUnion => snapshot,
        // Inputs are immutable producer publications; changed selections publish a new Map.
        publish(nextMembers: readonly PluginUiProjectionUnionMember[], nextSelections?: PluginUiProjectionUnionOriginSelections): PluginUiProjectionUnion {
            if (publishedMembers === nextMembers && publishedSelections === nextSelections) return snapshot;
            if (members && source) {
                const currentSource = source;
                const sameMembers = arePluginUiProjectionUnionMembersEquivalentForPlugins(members, nextMembers, true);
                const sameMaterializationInputs = members.length === nextMembers.length && members.every((member, index) => {
                    const next = nextMembers[index]!;
                    return member.machineId === next.machineId && member.serverId === next.serverId
                        && member.serverIdentityId === next.serverIdentityId
                        && member.materializationsByPluginId === next.materializationsByPluginId;
                });
                if ((!sameMembers && (members.some(member => member.projection && !nextMembers.some(next => next.projection === member.projection))
                    || nextMembers.some(member => member.projection && !members!.some(previous => previous.projection === member.projection))))
                    || (!sameMaterializationInputs && [...comparisons.materializations.keys()]
                        .some(value => !nextMembers.some(member => member.materializationsByPluginId?.[value.pluginId] === value)))) {
                    comparisons = retainDeclarationComparisons(nextMembers.flatMap(member => member.projection ? [member.projection] : []), comparisons,
                        nextMembers.flatMap(member => member.materializationsByPluginId ? Object.values(member.materializationsByPluginId) : []));
                }
                const nextSource = sameMembers ? source
                    : prepareUnionPublicationSource(nextMembers, snapshot.pluginUiProjection, comparisons, source, members);
                const changed = new Set<string>();
                for (const id of new Set([...source.pluginIds, ...nextSource.pluginIds])) {
                    const before = selections?.get(id);
                    const after = nextSelections?.get(id);
                    if (!sameMembers && !samePluginUnionInputs(members, nextMembers, source, nextSource, id)) changed.add(id);
                    else if (before !== after && (!before || !after || !arePluginMachineExecutionOriginsEqual(before, after))) changed.add(id);
                    else if (nextSource.conflictSensitivePluginIds.has(id)
                        && !(after && nextSource.declaredOrigins.get(id)?.some(origin => arePluginMachineExecutionOriginsEqual(origin, after)))
                        && !members.every((member, index) => {
                            const next = nextMembers[index];
                            if (!next) return false;
                            if (member.selectableExecutionOrigins === next.selectableExecutionOrigins) return true;
                            return memberHasSelectableDeclaration(member, id, member.projection ? currentSource.slices.get(member.projection)?.get(id) ?? null : null)
                                === memberHasSelectableDeclaration(next, id, next.projection ? nextSource.slices.get(next.projection)?.get(id) ?? null : null);
                        })) changed.add(id);
                }
                if (changed.size > 0 || !sameMembers) snapshot = publishPluginUnionChanges(snapshot, nextMembers,
                    nextSelections ?? new Map(), nextSource, changed, comparisons, source);
                source = refreshUnionDeclaredOrigins(nextSource, snapshot.pluginUiProjection, changed);
                members = [...nextMembers];
                selections = nextSelections ? new Map(nextSelections) : undefined;
                publishedMembers = nextMembers;
                publishedSelections = nextSelections;
                return snapshot;
            }
            comparisons = retainDeclarationComparisons(nextMembers.flatMap(member => member.projection ? [member.projection] : []), comparisons);
            const previousIndex = readPublishedProjectionPluginIndex(snapshot.pluginUiProjection);
            source = prepareUnionPublicationSource(nextMembers, snapshot.pluginUiProjection, comparisons, source);
            snapshot = retainPluginUiProjectionValue(snapshot, derivePluginUiProjectionUnion(nextMembers, nextSelections ?? new Map(), comparisons,
                new Map(source.supplyFacts.map(({ member, facts }) => [member, { facts }])))) as PluginUiProjectionUnion;
            if (snapshot.pluginUiProjection) {
                const model = publishProjectionPluginIndex(snapshot.pluginUiProjection,
                    prepareProjectionPluginIndex(snapshot.pluginUiProjection, previousIndex));
                if (model !== snapshot.pluginUiProjection) snapshot = Object.freeze({ ...snapshot, pluginUiProjection: model });
            }
            source = refreshUnionDeclaredOrigins(source, snapshot.pluginUiProjection, source.pluginIds);
            members = [...nextMembers];
            selections = nextSelections ? new Map(nextSelections) : undefined;
            publishedMembers = nextMembers;
            publishedSelections = nextSelections;
            return snapshot;
        },
    };
}

/** The exact fleet-agreement input, not the report's origin-list representation. */
function memberHasSelectableDeclaration(
    member: PluginUiProjectionUnionMember,
    pluginId: string,
    projection = member.projection,
): boolean {
    if (!projection || member.phase !== 'current' || !member.interactionEnabled || !member.selectableExecutionOrigins?.length) return false;
    const currentMember = { ...member, projection };
    return declarationMaps(projection).some(map => Object.values(map).some(entry => {
        const record = asRecord(entry);
        if (record?.pluginId !== pluginId) return false;
        const origin = resolveMemberEntryExecutionOrigin(currentMember, record);
        return origin !== null && member.selectableExecutionOrigins?.some(selectable => arePluginMachineExecutionOriginsEqual(selectable, origin));
    }));
}

/** Mounted and AppShell compositions have separate, explicitly scoped lifetimes. */
export function createInstalledPluginUiProjectionPublication() {
    let inputs: Readonly<{
        installed: readonly PluginUiProjectionModel[];
        runtime: PluginUiProjectionModel | null;
        materializations: Readonly<Record<string, PluginMachineMaterializationV1>> | undefined;
        selections: PluginUiProjectionUnionOriginSelections | undefined;
        completeUiPluginIds: ReadonlySet<string> | undefined;
    }> | null = null;
    let publishedInputs: Readonly<{
        installed: readonly PluginUiProjectionModel[];
        runtime: PluginUiProjectionModel | null;
        materializations: Readonly<Record<string, PluginMachineMaterializationV1>> | undefined;
        selections: PluginUiProjectionUnionOriginSelections | undefined;
        completeUiPluginIds: ReadonlySet<string> | undefined;
    }> | null = null;
    let comparisons = createDeclarationComparisons();
    let snapshot: PluginUiProjectionModel | null = null;
    let runtimeIndex: PublishedProjectionPluginIndex | null = null;
    let installedIndexes = new Map<PluginUiProjectionModel, PublishedProjectionPluginIndex>();
    return {
        getSnapshot: (): PluginUiProjectionModel | null => snapshot,
        publish(installed: readonly PluginUiProjectionModel[], runtime: PluginUiProjectionModel | null,
            materializations?: Readonly<Record<string, PluginMachineMaterializationV1>>,
            selections?: PluginUiProjectionUnionOriginSelections,
            completeUiPluginIds?: ReadonlySet<string>): PluginUiProjectionModel | null {
            if (publishedInputs && publishedInputs.installed === installed && publishedInputs.runtime === runtime
                && publishedInputs.materializations === materializations && publishedInputs.selections === selections
                && publishedInputs.completeUiPluginIds === completeUiPluginIds) return snapshot;
            if (inputs && inputs.runtime === runtime && arePluginUiMaterializationsEquivalent(inputs.materializations, materializations)
                && installed.length === inputs.installed.length && installed.every((model, index) => model === inputs!.installed[index])
                && arePluginExecutionOriginSelectionsEquivalent(inputs.selections, selections)
                && sameCompleteUiPluginIds(inputs.completeUiPluginIds, completeUiPluginIds)) {
                publishedInputs = { installed, runtime, materializations, selections, completeUiPluginIds };
                return snapshot;
            }
            if (installed.length === 0) {
                snapshot = runtime;
                runtimeIndex = readPublishedProjectionPluginIndex(runtime);
                installedIndexes = new Map();
                comparisons = createDeclarationComparisons();
                inputs = { installed: [], runtime, materializations, selections: selections ? new Map(selections) : undefined,
                    completeUiPluginIds: completeUiPluginIds ? new Set(completeUiPluginIds) : undefined };
                publishedInputs = { installed, runtime, materializations, selections, completeUiPluginIds };
                return snapshot;
            }
            const nextRuntimeIndex = readPublishedProjectionPluginIndex(runtime);
            const previousIndex = readPublishedProjectionPluginIndex(snapshot);
            // The existing comparison owner retains only current inputs.
            // Stable owned plugin slices reuse their prepared record sets;
            // replacing one runtime slice cannot retain its retired rows.
            comparisons = retainDeclarationComparisons([...installed,
                ...(nextRuntimeIndex ? Object.values(nextRuntimeIndex.slices).map(slice => slice.model) : runtime ? [runtime] : [])], comparisons);
            if (inputs && runtime && runtimeIndex && nextRuntimeIndex && previousIndex
                && installed.length === inputs.installed.length && installed.every((model, index) => model === inputs!.installed[index])) {
                const ids = new Set([...Object.keys(runtimeIndex.slices), ...Object.keys(nextRuntimeIndex.slices),
                    ...[...installedIndexes.values()].flatMap(index => Object.keys(index.slices))]);
                const changed = new Set([...ids].filter(id => runtimeIndex!.slices[id] !== nextRuntimeIndex.slices[id]
                    || !samePluginUiMaterializationFacts(inputs!.materializations?.[id], materializations?.[id])
                    || !sameOptionalOrigin(inputs!.selections?.get(id), selections?.get(id))
                    || (inputs!.completeUiPluginIds === undefined || inputs!.completeUiPluginIds.has(id))
                        !== (completeUiPluginIds === undefined || completeUiPluginIds.has(id))));
                snapshot = publishInstalledPluginChanges(snapshot, installed, installedIndexes, runtime, nextRuntimeIndex,
                    previousIndex, materializations, selections, changed, comparisons, completeUiPluginIds);
            } else {
                snapshot = retainPluginUiProjectionValue(snapshot,
                    deriveInstalledPluginUiProjection(installed, runtime, materializations, selections, comparisons, completeUiPluginIds)) as PluginUiProjectionModel | null;
                if (snapshot) snapshot = publishProjectionPluginIndex(snapshot, prepareProjectionPluginIndex(snapshot, previousIndex));
                const nextInstalled = new Map<PluginUiProjectionModel, PublishedProjectionPluginIndex>();
                for (const model of installed) nextInstalled.set(model, installedIndexes.get(model)
                    ?? readPublishedProjectionPluginIndex(model) ?? prepareProjectionPluginIndex(model));
                installedIndexes = nextInstalled;
            }
            runtimeIndex = nextRuntimeIndex;
            inputs = { installed: [...installed], runtime, materializations, selections: selections ? new Map(selections) : undefined,
                completeUiPluginIds: completeUiPluginIds ? new Set(completeUiPluginIds) : undefined };
            publishedInputs = { installed, runtime, materializations, selections, completeUiPluginIds };
            return snapshot;
        },
    };
}

function sameCompleteUiPluginIds(left: ReadonlySet<string> | undefined, right: ReadonlySet<string> | undefined): boolean {
    return left === right || Boolean(left && right && left.size === right.size && [...left].every(id => right.has(id)));
}

function readString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function sameOptionalOrigin(left: PluginMachineExecutionOriginV1 | undefined, right: PluginMachineExecutionOriginV1 | undefined): boolean {
    return left === right || Boolean(left && right && arePluginMachineExecutionOriginsEqual(left, right));
}

function resolveUnionProjectionPhase(
    members: readonly PluginUiProjectionUnionMember[],
): PluginUiProjectionPhase {
    // Current presentation is not withheld by an unrelated pending origin.
    // Catalog completeness is published separately for missing destinations;
    // executable authority remains stamped on each exact contribution below.
    if (members.some((member) => member.phase === 'current')) return 'current';
    if (members.some((member) => member.phase === 'establishing')) return 'establishing';
    if (members.some((member) => member.phase === 'retainedOffline')) return 'retainedOffline';
    return 'unavailable';
}

function asRecord(value: unknown): UnknownRecord | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as UnknownRecord
        : null;
}

function resolveUnionGeneration(members: readonly (PluginUiProjectionUnionMember & { projection: PluginUiProjectionModel })[]): number | null {
    // Keep an observed source's readiness; the UI has no aggregate registry revision.
    for (const member of members) if (member.projection.generation !== null) return member.projection.generation;
    return null;
}

function selectedOriginOwnsEntry(input: Readonly<{
    selectedOriginsByPluginId: PluginUiProjectionUnionOriginSelections;
    entry: unknown;
    machineId: string;
}>): boolean {
    const pluginId = readString(asRecord(input.entry)?.pluginId);
    if (!pluginId) return false;
    const producerOrigin = readPluginUiProjectionEntryExecutionOrigin(input.entry);
    return selectedOriginOwnsProducer({ ...input, pluginId, producerOrigin });
}

function selectedOriginOwnsProducer(input: Readonly<{
    selectedOriginsByPluginId: PluginUiProjectionUnionOriginSelections;
    pluginId: string;
    producerOrigin: PluginMachineExecutionOriginV1 | null;
    machineId: string;
}>): boolean {
    const { pluginId, producerOrigin } = input;
    const selectedOrigin = input.selectedOriginsByPluginId.get(pluginId);
    return selectedOrigin !== undefined
        && producerOrigin !== null
        && getPluginMachineExecutionOriginRef(selectedOrigin).pluginId === pluginId
        && getPluginMachineExecutionOriginRef(selectedOrigin).machineId === input.machineId
        && getPluginMachineExecutionOriginRef(producerOrigin).machineId === input.machineId
        && arePluginMachineExecutionOriginsEqual(selectedOrigin, producerOrigin);
}

function memberHasAdmittedContribution(
    member: PluginUiProjectionUnionMember,
    selectedOriginsByPluginId: PluginUiProjectionUnionOriginSelections,
    inspectDeclarations = true,
    resourceOrigins?: readonly PluginMachineExecutionOriginV1[],
): boolean {
    const projection = member.projection;
    return projection !== null && ((inspectDeclarations && declarationMaps(projection).some(map => Object.values(map).some(entry => readString(asRecord(entry)?.pluginId) !== null)))
        || (resourceOrigins ? resourceOrigins.some(producerOrigin => selectedOriginOwnsProducer({
            selectedOriginsByPluginId, producerOrigin, machineId: member.machineId,
            pluginId: getPluginMachineExecutionOriginRef(producerOrigin).pluginId,
        })) : Object.values(projection.resourcesById).some(entry => resourceHasCurrentProducerOrigin(projection, entry)
            && selectedOriginOwnsEntry({ entry, machineId: member.machineId, selectedOriginsByPluginId }))));
}

function declarationMaps(model: PluginUiProjectionModel): readonly Readonly<Record<string, unknown>>[] {
    return DECLARATION_MAP_KEYS.map(key => model[key]);
}

const DECLARATION_MAP_KEYS = ['translationsByPluginId', 'sessionHeaderActionsById', 'searchProvidersById',
    'hostedWebById', 'reactNativeBundlesById', 'surfacePlacementsById', 'settingsGroupsById', 'settingsPagesById',
    'actionsById', 'voiceProvidersById', 'dragSourcesById', 'workItemsById', 'dropTargetsById',
    'atmospherePicturesById', 'registrySourcesById', 'storeKindsById', 'skillsById', 'unknownEntriesById', 'inputTypesById',
    'composerControlsById', 'composerRegionsById', 'composerReferencesById'] as const;
const UNION_MAP_KEYS = [...DECLARATION_MAP_KEYS, 'resourcesById', 'connectedAccountDescriptorsById', 'installedPackagesById'] as const;
type UnionMapKey = typeof UNION_MAP_KEYS[number];

type PublishedPluginSlice = Readonly<{ model: PluginUiProjectionModel; entries: readonly unknown[] }>;
type PublishedProjectionPluginIndex = Readonly<{ slices: Readonly<Record<string, PublishedPluginSlice>> }>;
const publishedProjectionPluginIndex = Symbol('pluginUiPublishedPluginIndex');

function readPublishedProjectionPluginIndex(model: PluginUiProjectionModel | null): PublishedProjectionPluginIndex | null {
    const proof = model ? asRecord(Object.getOwnPropertyDescriptor(model, publishedProjectionPluginIndex)?.value) : null;
    // Only this publication owner creates the private immutable index. Copying
    // its descriptor to another snapshot must not turn that snapshot into proof.
    return proof && proof.owner === model ? proof.index as PublishedProjectionPluginIndex : null;
}

function publishProjectionPluginIndex(model: PluginUiProjectionModel, index: PublishedProjectionPluginIndex): PluginUiProjectionModel {
    if (readPublishedProjectionPluginIndex(model) === index) return model;
    const owned = { ...model };
    Object.defineProperty(owned, publishedProjectionPluginIndex, { value: Object.freeze({ owner: owned, index }) });
    return Object.freeze(owned);
}

/** Index new raw inputs once; owned publications hand their current slices on. */
function prepareProjectionPluginIndex(model: PluginUiProjectionModel, previous?: PublishedProjectionPluginIndex | null): PublishedProjectionPluginIndex {
    const groups = new Map<string, Partial<Record<UnionMapKey, Record<string, unknown>>>>();
    for (const key of UNION_MAP_KEYS) for (const [entryId, entry] of Object.entries(model[key] ?? {})) {
        const id = key === 'installedPackagesById' ? entryId : readString(asRecord(entry)?.pluginId);
        if (!id) continue;
        const group = groups.get(id) ?? {};
        const map = group[key] ??= {};
        Object.defineProperty(map, entryId, { value: entry, enumerable: true, configurable: true, writable: true });
        groups.set(id, group);
    }
    const slices = Object.fromEntries([...groups].map(([id, group]) => {
        const old = previous?.slices[id];
        const maps = Object.fromEntries(UNION_MAP_KEYS.map(key => {
            const map = group[key] ?? {};
            const keys = Object.keys(map);
            const previousMap = old?.model[key];
            const oldKeys = previousMap ? Object.keys(previousMap) : [];
            const same = previousMap && keys.length === oldKeys.length
                && keys.every((entryId, index) => Object.hasOwn(previousMap, entryId) && previousMap[entryId] === map[entryId]
                    && (key !== 'atmospherePicturesById' || oldKeys[index] === entryId));
            return [key, same ? previousMap : Object.freeze(map)];
        }));
        if (old && UNION_MAP_KEYS.every(key => maps[key] === old.model[key])) return [id, old] as const;
        // Only plugin-owned dictionaries cross this handoff. Global generation,
        // diagnostics and pending-target facts come from the actual next root,
        // never from a retained dictionary slice.
        const sliceModel = Object.freeze({ ...EMPTY_PLUGIN_UI_PROJECTION, ...maps }) as PluginUiProjectionModel;
        const entries = DECLARATION_MAP_KEYS.flatMap(key => Object.values(sliceModel[key]));
        const retainedEntries = old && old.entries.length === entries.length && entries.every((entry, index) => entry === old.entries[index])
            ? old.entries : Object.freeze(entries);
        return [id, Object.freeze({ model: sliceModel, entries: retainedEntries })] as const;
    }));
    const ids = Object.keys(slices);
    if (previous && ids.length === Object.keys(previous.slices).length && ids.every(id => slices[id] === previous.slices[id])) return previous;
    Object.setPrototypeOf(slices, null);
    return Object.freeze({ slices: Object.freeze(slices) });
}

function pluginSliceKeys(models: readonly (PluginUiProjectionModel | undefined | null)[]): ReadonlyMap<UnionMapKey, ReadonlySet<string>> {
    return new Map(UNION_MAP_KEYS.map(key => [key, new Set(models.flatMap(model => Object.keys(model?.[key] ?? {})))]));
}

function replacePublishedPluginSlices(previous: PublishedProjectionPluginIndex,
    changed: ReadonlyMap<string, PluginUiProjectionModel | null>): PublishedProjectionPluginIndex {
    if (changed.size === 0) return previous;
    const slices = { ...previous.slices };
    for (const [id, sliceModel] of changed) {
        const slice = sliceModel ? prepareProjectionPluginIndex(sliceModel, previous).slices[id] : undefined;
        if (slice) Object.defineProperty(slices, id, { value: slice, enumerable: true, configurable: true, writable: true });
        else delete slices[id];
    }
    Object.setPrototypeOf(slices, null);
    return Object.freeze({ slices: Object.freeze(slices) });
}

/** The existing merge policy runs on changed plugin inputs, never sibling rows. */
function publishInstalledPluginChanges(previous: PluginUiProjectionModel | null,
    installed: readonly PluginUiProjectionModel[], installedIndexes: ReadonlyMap<PluginUiProjectionModel, PublishedProjectionPluginIndex>,
    runtime: PluginUiProjectionModel, runtimeIndex: PublishedProjectionPluginIndex, previousIndex: PublishedProjectionPluginIndex,
    materializations: Readonly<Record<string, PluginMachineMaterializationV1>> | undefined,
    selections: PluginUiProjectionUnionOriginSelections | undefined, changed: ReadonlySet<string>, comparisons: DeclarationComparisons,
    completeUiPluginIds?: ReadonlySet<string>): PluginUiProjectionModel {
    const replacements = new Map<UnionMapKey, Map<string, unknown>>();
    const removed = new Map<UnionMapKey, Set<string>>();
    const changedModels = new Map<string, PluginUiProjectionModel | null>();
    for (const id of changed) {
        const installedSlices = installed.flatMap(model => {
            const slice = installedIndexes.get(model)?.slices[id];
            return slice ? [slice.model] : [];
        });
        const runtimeSlice = runtimeIndex.slices[id]?.model ?? null;
        const derived = deriveInstalledPluginUiProjection(installedSlices, runtimeSlice,
            materializations?.[id] ? { [id]: materializations[id]! } : undefined, selections, comparisons, completeUiPluginIds);
        const keys = pluginSliceKeys([previousIndex.slices[id]?.model, runtimeSlice, ...installedSlices]);
        const retained = retainPluginUnionSlice(previous, derived, keys);
        changedModels.set(id, derived ? Object.freeze({ ...derived, ...Object.fromEntries(retained) }) as PluginUiProjectionModel : null);
        for (const key of UNION_MAP_KEYS) {
            const updates = replacements.get(key) ?? new Map<string, unknown>();
            const removals = removed.get(key) ?? new Set<string>();
            for (const entryId of keys.get(key) ?? []) {
                removals.add(entryId);
                const map = retained.get(key)!;
                if (Object.hasOwn(map, entryId)) updates.set(entryId, map[entryId]);
            }
            replacements.set(key, updates);
            removed.set(key, removals);
        }
    }
    const maps = Object.fromEntries(UNION_MAP_KEYS.map(key => {
        const old = previous?.[key] ?? EMPTY_PLUGIN_UI_PROJECTION[key]!;
        const updates = replacements.get(key);
        const removals = removed.get(key);
        if (!updates || !removals || [...removals].every(id => Object.hasOwn(old, id) === updates.has(id)
            && (!updates.has(id) || old[id] === updates.get(id)))) return [key, old];
        const map: Record<string, unknown> = { ...old };
        for (const id of removals) delete map[id];
        for (const [id, value] of updates) Object.defineProperty(map, id, { value, enumerable: true, configurable: true, writable: true });
        if (key === 'atmospherePicturesById') {
            // Installed declarations establish insertion slots; runtime overrides
            // retain those slots, exactly as the canonical merge does. This one
            // family feeds an unsorted, visible picture picker.
            const order = new Set([...installed.flatMap(model => Object.keys(model.atmospherePicturesById)), ...Object.keys(runtime.atmospherePicturesById)]);
            return [key, Object.freeze(Object.fromEntries([...order].flatMap(id => Object.hasOwn(map, id) ? [[id, map[id]]] : [])))];
        }
        return [key, Object.freeze(map)];
    }));
    const model = Object.freeze({ ...runtime, ...maps, generation: runtime.generation }) as PluginUiProjectionModel;
    if (previous) {
        const old = asRecord(previous)!;
        const next = asRecord(model)!;
        const keys = Object.keys(model);
        if (keys.length === Object.keys(previous).length && keys.every(key => Object.hasOwn(old, key)
            && (key === 'generation' ? (previous.generation === null) === (model.generation === null) : old[key] === next[key]))) return previous;
    }
    return publishProjectionPluginIndex(model, replacePublishedPluginSlices(previousIndex, changedModels));
}

type UnionSourceModelIndex = Readonly<{
    publicationIndex: PublishedProjectionPluginIndex;
    declarationComparison: ProjectionDeclarationComparison;
    slices: ReadonlyMap<string, PluginUiProjectionModel>;
    keysByPlugin: ReadonlyMap<string, ReadonlyMap<UnionMapKey, ReadonlySet<string>>>;
    hasDeclarations: boolean;
    pictureOrdinals: ReadonlyMap<string, number>;
    resourceOrigins: readonly PluginMachineExecutionOriginV1[];
}>;
type UnionPublicationSource = Readonly<{
    /** Validated descriptive carriers live only with these exact current inputs. */
    supplyFacts: readonly Readonly<{ member: PluginUiProjectionUnionMember; facts: Map<UnknownRecord, PluginUiContributionSupplyV1> }>[];
    modelIndexes: ReadonlyMap<PluginUiProjectionModel, UnionSourceModelIndex>;
    slices: ReadonlyMap<PluginUiProjectionModel, ReadonlyMap<string, PluginUiProjectionModel>>;
    pluginIds: ReadonlySet<string>;
    conflictSensitivePluginIds: ReadonlySet<string>;
    hasDeclarations: ReadonlyMap<PluginUiProjectionModel, boolean>;
    keysByPlugin: ReadonlyMap<string, ReadonlyMap<UnionMapKey, ReadonlySet<string>>>;
    declaredOrigins: ReadonlyMap<string, readonly PluginMachineExecutionOriginV1[]>;
    pictureSources: readonly Readonly<{ machineId: string; serverKey: string; ordinals: ReadonlyMap<string, number> }>[];
}>;

function samePluginUnionInputs(leftMembers: readonly PluginUiProjectionUnionMember[], rightMembers: readonly PluginUiProjectionUnionMember[],
    leftSource: Pick<UnionPublicationSource, 'modelIndexes' | 'slices'>,
    rightSource: Pick<UnionPublicationSource, 'modelIndexes' | 'slices'>, id: string, declarationsOnly = false): boolean {
    const contributing = (members: readonly PluginUiProjectionUnionMember[], source: typeof leftSource) => members.filter(member => {
        if (!readString(member.machineId) || !member.projection) return false;
        const keys = source.modelIndexes.get(member.projection)?.keysByPlugin.get(id);
        return keys && [...keys].some(([key, ids]) => key !== 'installedPackagesById' && ids.size > 0);
    }).sort((left, right) => left.machineId.localeCompare(right.machineId)
        || (left.serverIdentityId ?? left.serverId ?? '').localeCompare(right.serverIdentityId ?? right.serverId ?? ''));
    const left = contributing(leftMembers, leftSource);
    const right = contributing(rightMembers, rightSource);
    return left.length === right.length && left.every((member, index) => {
        const other = right[index]!;
        const model = member.projection!;
        const next = other.projection!;
        const beforeIndex = leftSource.modelIndexes.get(model)!;
        const afterIndex = rightSource.modelIndexes.get(next)!;
        if (member.machineId !== other.machineId || member.serverId !== other.serverId
            || member.serverIdentityId !== other.serverIdentityId
            || beforeIndex.publicationIndex.slices[id] !== afterIndex.publicationIndex.slices[id]
            || !samePluginUiMaterializationFacts(member.materializationsByPluginId?.[id], other.materializationsByPluginId?.[id])) return false;
        // Declaration correspondence consumes no live readiness or phase.
        // Readiness, phase and relevant refusals still invalidate availability.
        return declarationsOnly || (member.phase === other.phase
            && member.interactionEnabled === other.interactionEnabled && member.unavailableReasonCode === other.unavailableReasonCode
            && (model.generation === null) === (next.generation === null)
            && (model.diagnostics === next.diagnostics || memberHasActivationRefusal(member, id) === memberHasActivationRefusal(other, id))
            && [...beforeIndex.keysByPlugin.get(id)?.get('atmospherePicturesById') ?? []].every(key =>
                beforeIndex.pictureOrdinals.get(key) === afterIndex.pictureOrdinals.get(key)));
    });
}

function refreshUnionDeclaredOrigins(source: UnionPublicationSource, published: PluginUiProjectionModel | null,
    changed: ReadonlySet<string>): UnionPublicationSource {
    if (changed.size === 0) return source;
    const declaredOrigins = new Map(source.declaredOrigins);
    for (const id of changed) declaredOrigins.set(id, readPublishedPluginOrigins(source.keysByPlugin.get(id), published));
    return { ...source, declaredOrigins };
}

function readPublishedPluginOrigins(keys: ReadonlyMap<UnionMapKey, ReadonlySet<string>> | undefined,
    published: PluginUiProjectionModel | null): readonly PluginMachineExecutionOriginV1[] {
    const origins: PluginMachineExecutionOriginV1[] = [];
    for (const key of DECLARATION_MAP_KEYS) for (const entryId of keys?.get(key) ?? []) {
        for (const supply of readPluginUiContributionSupplies(published?.[key][entryId])) {
            const origin = supply.executionOrigin;
            if (origin && getPluginMachineExecutionOriginRef(origin).machineId === supply.machineId
                && !origins.some(previous => arePluginMachineExecutionOriginsEqual(previous, origin))) origins.push(origin);
        }
    }
    return origins;
}

/** Prepare only current source rows, before any controller selection feedback. */
function prepareUnionPublicationSource(members: readonly PluginUiProjectionUnionMember[], published: PluginUiProjectionModel | null,
    comparisons: DeclarationComparisons, previous: UnionPublicationSource | null,
    previousMembers: readonly PluginUiProjectionUnionMember[] = []): UnionPublicationSource {
    const supplyFacts = members.map((member, index) => {
        const preceding = previous?.supplyFacts[index];
        const sameTarget = (other: PluginUiProjectionUnionMember) => member.machineId === other.machineId
            && member.serverId === other.serverId && member.serverIdentityId === other.serverIdentityId;
        const old = preceding && sameTarget(preceding.member) ? preceding : previous?.supplyFacts.find(value => sameTarget(value.member));
        return old && samePluginUiProjectionUnionMemberInputs(old.member, member, true) ? old
            : { member, facts: new Map<UnknownRecord, PluginUiContributionSupplyV1>() };
    });
    const modelIndexes = new Map<PluginUiProjectionModel, UnionSourceModelIndex>();
    const slices = new Map<PluginUiProjectionModel, ReadonlyMap<string, PluginUiProjectionModel>>();
    const pluginIds = new Set<string>();
    const hasDeclarations = new Map<PluginUiProjectionModel, boolean>();
    const keysByPlugin = new Map<string, Map<UnionMapKey, Set<string>>>();
    const sortedMembers = [...members].sort((left, right) => left.machineId.localeCompare(right.machineId)
        || (left.serverIdentityId ?? left.serverId ?? '').localeCompare(right.serverIdentityId ?? right.serverId ?? ''));
    const pictureOrdinals = new Map<PluginUiProjectionModel, ReadonlyMap<string, number>>();
    // Make every reusable current dictionary visible before normalizing any
    // new one. A new source may converge on a later member's existing content.
    for (const member of sortedMembers) {
        const model = member.projection;
        if (!model) continue;
        const before = previousMembers.find(old => old.machineId === member.machineId
            && old.serverId === member.serverId && old.serverIdentityId === member.serverIdentityId);
        const index = previous?.modelIndexes.get(model)
            ?? (before?.projection ? previous?.modelIndexes.get(before.projection) : undefined);
        if (index && (previous?.modelIndexes.has(model)
            || (before?.projection && UNION_MAP_KEYS.every(key => before.projection![key] === model[key])))) {
            comparisons.projections.set(model, index.declarationComparison);
        }
    }
    for (const member of sortedMembers) {
        const model = member.projection;
        if (!model || slices.has(model)) continue;
        const previousMember = previousMembers.find(old => old.machineId === member.machineId
            && old.serverId === member.serverId && old.serverIdentityId === member.serverIdentityId);
        const preceding = previous?.modelIndexes.get(model)
            ?? (previousMember?.projection ? previous?.modelIndexes.get(previousMember.projection) : undefined);
        if (preceding && previous?.modelIndexes.has(model)) {
            comparisons.projections.set(model, preceding.declarationComparison);
            for (const slice of preceding.slices.values()) comparisons.projections.set(slice, preceding.declarationComparison);
            modelIndexes.set(model, preceding);
            slices.set(model, preceding.slices);
            hasDeclarations.set(model, preceding.hasDeclarations);
            pictureOrdinals.set(model, preceding.pictureOrdinals);
            continue;
        }
        const sameDictionaries = previousMember?.projection && UNION_MAP_KEYS.every(key => previousMember.projection![key] === model[key]);
        const publicationIndex = readPublishedProjectionPluginIndex(model)
            ?? (sameDictionaries && preceding ? preceding.publicationIndex : prepareProjectionPluginIndex(model, preceding?.publicationIndex));
        const modelSlices = new Map(Object.entries(publicationIndex.slices).map(([id, slice]) => {
            const old = preceding?.slices.get(id);
            return [id, old && preceding?.publicationIndex.slices[id] === slice && (old.generation === null) === (model.generation === null)
                && old.diagnostics === model.diagnostics ? old
                : Object.freeze({ ...slice.model, generation: model.generation, diagnostics: model.diagnostics })] as const;
        }));
        // Currentness roots and their plugin slices are wrappers around the
        // same immutable declaration dictionaries. Rebind this owner's existing
        // comparison facts instead of reconstructing portable JSON families.
        const declarationComparison = sameDictionaries && preceding ? preceding.declarationComparison
            : readProjectionDeclarationComparison(model, comparisons);
        comparisons.projections.set(model, declarationComparison);
        for (const slice of modelSlices.values()) comparisons.projections.set(slice, declarationComparison);
        const modelPluginKeys = publicationIndex === preceding?.publicationIndex ? preceding.keysByPlugin
            : new Map([...modelSlices].map(([id, slice]) => [id, pluginSliceKeys([slice])]));
        const declarations = [...modelPluginKeys.values()].some(keys => DECLARATION_MAP_KEYS.some(key => (keys.get(key)?.size ?? 0) > 0));
        slices.set(model, modelSlices);
        hasDeclarations.set(model, declarations);
        const ordinals = sameDictionaries && preceding ? preceding.pictureOrdinals
            : new Map(Object.keys(model.atmospherePicturesById).map((key, index) => [key, index]));
        const resourceOrigins: PluginMachineExecutionOriginV1[] = [];
        if (!sameDictionaries || !preceding) for (const entry of Object.values(model.resourcesById)) {
            const origin = readCurrentResourceProducerOrigin(model, entry);
            if (origin && !resourceOrigins.some(previous => arePluginMachineExecutionOriginsEqual(previous, origin))) resourceOrigins.push(origin);
        }
        pictureOrdinals.set(model, ordinals);
        modelIndexes.set(model, { publicationIndex, declarationComparison, slices: modelSlices, keysByPlugin: modelPluginKeys, hasDeclarations: declarations,
            pictureOrdinals: ordinals, resourceOrigins: sameDictionaries && preceding ? preceding.resourceOrigins : Object.freeze(resourceOrigins) });
    }
    for (const index of modelIndexes.values()) for (const [id, maps] of index.keysByPlugin) {
        const combined = keysByPlugin.get(id) ?? new Map<UnionMapKey, Set<string>>();
        for (const [key, ids] of maps) {
            if (key !== 'installedPackagesById' && ids.size > 0) pluginIds.add(id);
            const keys = combined.get(key) ?? new Set<string>();
            for (const entryId of ids) keys.add(entryId);
            combined.set(key, keys);
        }
        keysByPlugin.set(id, combined);
    }
    const conflictSensitivePluginIds = new Set<string>();
    const declaredOrigins = new Map<string, readonly PluginMachineExecutionOriginV1[]>();
    const prepared = { modelIndexes, slices };
    for (const id of pluginIds) {
        if (previous && samePluginUnionInputs(previousMembers, members, previous, prepared, id, true)) {
            if (previous.conflictSensitivePluginIds.has(id)) conflictSensitivePluginIds.add(id);
            declaredOrigins.set(id, previous.declaredOrigins.get(id) ?? []);
            continue;
        }
        const supplying = members.filter((member): member is PluginUiProjectionUnionMember & { projection: PluginUiProjectionModel } => (
            member.projection !== null && slices.get(member.projection)?.has(id) === true
        ));
        const first = supplying[0];
        if (first && DECLARATION_MAP_KEYS.some(key => (keysByPlugin.get(id)?.get(key)?.size ?? 0) > 0)
            && supplying.slice(1).some(member => !samePluginDeclarationContent(first, member, id, comparisons))) conflictSensitivePluginIds.add(id);
        declaredOrigins.set(id, readPublishedPluginOrigins(keysByPlugin.get(id), published));
    }
    const pictureSources = sortedMembers.flatMap(member => member.projection ? [{ machineId: member.machineId,
        serverKey: member.serverIdentityId ?? member.serverId ?? '', ordinals: pictureOrdinals.get(member.projection)! }] : []);
    return { supplyFacts, modelIndexes, slices, pluginIds, conflictSensitivePluginIds, hasDeclarations, keysByPlugin, declaredOrigins, pictureSources };
}

function pluginUnionMembers(members: readonly PluginUiProjectionUnionMember[], source: UnionPublicationSource, pluginId: string,
    previousSource: UnionPublicationSource) {
    const supplyFacts = new Map<PluginUiProjectionUnionMember, UnionSupplyFacts>();
    const scopedMembers = members.map((member, index) => {
        const scoped = { ...member,
            // The source slice, unlike an output-index dictionary slice, carries
            // this source's readiness and activation diagnostics.
            projection: member.projection ? source.slices.get(member.projection)?.get(pluginId) ?? null : null,
            materializationsByPluginId: member.materializationsByPluginId?.[pluginId]
                ? { [pluginId]: member.materializationsByPluginId[pluginId]! } : undefined,
            selectableExecutionOrigins: member.selectableExecutionOrigins?.filter(origin => getPluginMachineExecutionOriginRef(origin).pluginId === pluginId),
        };
        const facts = source.supplyFacts[index];
        const before = previousSource.supplyFacts[index];
        const sameTarget = (other: PluginUiProjectionUnionMember) => member.machineId === other.machineId
            && member.serverId === other.serverId && member.serverIdentityId === other.serverIdentityId;
        const previous = before && sameTarget(before.member) ? before : previousSource.supplyFacts.find(value => sameTarget(value.member));
        if (facts) supplyFacts.set(scoped, { facts: facts.facts, previousFacts: previous?.facts });
        return scoped;
    });
    return { members: scopedMembers, supplyFacts };
}

function retainPluginUnionSlice(previous: PluginUiProjectionModel | null, next: PluginUiProjectionModel | null,
    keys: ReadonlyMap<UnionMapKey, ReadonlySet<string>> | undefined): ReadonlyMap<UnionMapKey, Readonly<Record<string, unknown>>> {
    const maps = new Map<UnionMapKey, Readonly<Record<string, unknown>>>();
    for (const key of UNION_MAP_KEYS) {
        const old = previous?.[key];
        const map = next?.[key] ?? {};
        maps.set(key, Object.freeze(Object.fromEntries([...(keys?.get(key) ?? [])].flatMap(id => Object.hasOwn(map, id)
            ? [[id, retainPluginUiProjectionValue(old?.[id], map[id])]] : []))));
    }
    return maps;
}

/** Report changes reuse every other published row; only dictionary shells change. */
function publishPluginUnionChanges(snapshot: PluginUiProjectionUnion, members: readonly PluginUiProjectionUnionMember[],
    selections: PluginUiProjectionUnionOriginSelections, source: UnionPublicationSource, changed: ReadonlySet<string>, comparisons: DeclarationComparisons,
    previousSource: UnionPublicationSource): PluginUiProjectionUnion {
    const replacements = new Map<UnionMapKey, Map<string, unknown>>();
    const removed = new Map<UnionMapKey, Set<string>>();
    const changedModels = new Map<string, PluginUiProjectionModel | null>();
    for (const id of changed) {
        const scoped = pluginUnionMembers(members, source, id, previousSource);
        const derived = derivePluginUiProjectionUnion(scoped.members, selections, comparisons, scoped.supplyFacts);
        const pluginKeys = new Map(UNION_MAP_KEYS.map(key => [key, new Set([
            ...previousSource.keysByPlugin.get(id)?.get(key) ?? [], ...source.keysByPlugin.get(id)?.get(key) ?? [],
        ])]));
        const maps = retainPluginUnionSlice(snapshot.pluginUiProjection, derived.pluginUiProjection, pluginKeys);
        changedModels.set(id, derived.pluginUiProjection ? Object.freeze({ ...derived.pluginUiProjection, ...Object.fromEntries(maps) }) as PluginUiProjectionModel : null);
        for (const key of UNION_MAP_KEYS) {
            const updates = replacements.get(key) ?? new Map<string, unknown>();
            const keys = removed.get(key) ?? new Set<string>();
            for (const entryId of pluginKeys.get(key) ?? []) {
                keys.add(entryId);
                const map = maps.get(key)!;
                if (Object.hasOwn(map, entryId)) updates.set(entryId, map[entryId]);
            }
            replacements.set(key, updates);
            removed.set(key, keys);
        }
    }
    const { phase, hasEstablishingMembers, soleMember, admittedContributing: admitted, establishingFacts, emptyProjection }
        = readUnionPublicationFacts(members, selections, source);
    const maps: Partial<Record<UnionMapKey, Readonly<Record<string, unknown>>>> = {};
    for (const key of UNION_MAP_KEYS) {
        const old = snapshot.pluginUiProjection?.[key] ?? EMPTY_PLUGIN_UI_PROJECTION[key]!;
        const updates = replacements.get(key) ?? new Map<string, unknown>();
        const removals = removed.get(key) ?? new Set<string>();
        const pictureOrderChanged = key === 'atmospherePicturesById' && (source.pictureSources.length !== previousSource.pictureSources.length
            || source.pictureSources.some((member, index) => member.machineId !== previousSource.pictureSources[index]?.machineId
                || member.serverKey !== previousSource.pictureSources[index]?.serverKey || member.ordinals !== previousSource.pictureSources[index]?.ordinals));
        if (!pictureOrderChanged && [...removals].every(id => Object.hasOwn(old, id) === updates.has(id) && (!updates.has(id) || old[id] === updates.get(id)))) {
            maps[key] = old;
            continue;
        }
        const map: Record<string, unknown> = { ...old };
        for (const id of removals) delete map[id];
        for (const [id, value] of updates) Object.defineProperty(map, id, { value, enumerable: true, configurable: true, writable: true });
        if (key === 'atmospherePicturesById') {
            // The picture picker consumes this family's insertion order. The
            // canonical first supply identifies its actual first emitter, even
            // when another picture source was individually rejected.
            const coordinate = (id: string): readonly [number, number] => {
                const supply = readPluginUiContributionSupplies(map[id])[0];
                const index = source.pictureSources.findIndex(member => member.machineId === supply?.machineId
                    && member.serverKey === (supply.serverIdentityId ?? supply.serverId ?? ''));
                return [index, source.pictureSources[index]?.ordinals.get(id) ?? 0];
            };
            const ordered = Object.keys(map).map(id => ({ id, coordinate: coordinate(id) }))
                .sort((left, right) => left.coordinate[0] - right.coordinate[0] || left.coordinate[1] - right.coordinate[1]);
            const oldKeys = Object.keys(old);
            maps[key] = ordered.length === oldKeys.length && ordered.every(({ id }, index) => id === oldKeys[index] && old[id] === map[id])
                ? old : Object.freeze(Object.fromEntries(ordered.map(({ id }) => [id, map[id]])));
        } else maps[key] = Object.freeze(map);
    }
    const modelChanged = UNION_MAP_KEYS.some(key => maps[key] !== (snapshot.pluginUiProjection?.[key] ?? EMPTY_PLUGIN_UI_PROJECTION[key]));
    const generation = resolveUnionGeneration(admitted);
    const interactionEnabled = phase === 'current' && admitted.some(member => member.phase === 'current' && member.interactionEnabled);
    let pluginUiProjection = snapshot.pluginUiProjection;
    if (admitted.length === 0) {
        pluginUiProjection = emptyProjection;
    } else {
        const pending = retainPluginUiProjectionValue(pluginUiProjection?.establishingExecutionTargetsByPluginId,
            establishingFacts.establishingExecutionTargetsByPluginId);
        if (modelChanged || (pluginUiProjection?.generation == null) !== (generation === null)
            || pending !== pluginUiProjection?.establishingExecutionTargetsByPluginId) {
            const base = pluginUiProjection ?? [...changedModels.values()].find(model => model !== null) ?? EMPTY_PLUGIN_UI_PROJECTION;
            const { establishingExecutionTargetsByPluginId: _previousPending, ...withoutPending } = base;
            pluginUiProjection = Object.freeze({ ...withoutPending, ...maps, generation,
                ...(pending ? { establishingExecutionTargetsByPluginId: pending } : {}),
            }) as PluginUiProjectionModel;
        }
        if (generation === null && UNION_MAP_KEYS.filter(key => key !== 'installedPackagesById')
            .every(key => Object.keys(pluginUiProjection?.[key] ?? {}).length === 0)) pluginUiProjection = emptyProjection ?? EMPTY_PLUGIN_UI_PROJECTION;
    }
    if (pluginUiProjection && snapshot.pluginUiProjection && admitted.length === 0) pluginUiProjection =
        retainPluginUiProjectionValue(snapshot.pluginUiProjection, pluginUiProjection) as PluginUiProjectionModel;
    if (pluginUiProjection && pluginUiProjection !== snapshot.pluginUiProjection) {
        const previousIndex = readPublishedProjectionPluginIndex(snapshot.pluginUiProjection);
        pluginUiProjection = publishProjectionPluginIndex(pluginUiProjection, previousIndex
            ? replacePublishedPluginSlices(previousIndex, changedModels) : prepareProjectionPluginIndex(pluginUiProjection));
    }
    return pluginUiProjection === snapshot.pluginUiProjection && interactionEnabled === snapshot.interactionEnabled
        && phase === snapshot.phase && hasEstablishingMembers === snapshot.hasEstablishingMembers
        && soleMember?.unavailableReasonCode === snapshot.unavailableReasonCode
        && (soleMember?.machineId ?? null) === snapshot.machineId && (soleMember?.serverId ?? null) === snapshot.serverId
        ? snapshot : Object.freeze({ pluginUiProjection, phase, hasEstablishingMembers, interactionEnabled,
            unavailableReasonCode: soleMember?.unavailableReasonCode, machineId: soleMember?.machineId ?? null, serverId: soleMember?.serverId ?? null });
}

/** Runtime identity and health are not portable declaration content. */
function declarationContent(entry: unknown): unknown {
    const record = asRecord(entry);
    if (!record) return entry;
    const { occurrenceId, executionOrigin, sourceCustody, immutableGenerationId, generation,
        enabled, availability, available, runtimeMode, runtimeDiagnostics, diagnostics, ...content } = record;
    const renderer = asRecord(content.renderer);
    if (renderer?.kind !== 'declarative' || renderer.model === undefined) return content;
    // Registry projection already owns model admission. Fleet agreement compares
    // authored semantics, excluding generated occurrence/availability facts.
    return { ...content, renderer: { ...renderer,
        model: projectPluginDeclarativeModelComparisonV1(renderer.model as PluginDeclarativeProjectedModelV1),
    } };
}

type DeclarationComparisons = {
    entries: WeakMap<UnknownRecord, JsonValue>;
    projections: Map<PluginUiProjectionModel, ProjectionDeclarationComparison>;
    materializations: Map<PluginMachineMaterializationV1, MaterializationDeclarationComparison>;
};

function createDeclarationComparisons(): DeclarationComparisons {
    return { entries: new WeakMap(), projections: new Map(), materializations: new Map() };
}

/** Current inputs bound retention; unchanged source rows keep their prepared facts. */
function retainDeclarationComparisons(models: readonly PluginUiProjectionModel[], previous: DeclarationComparisons,
    materializations: readonly PluginMachineMaterializationV1[] = []): DeclarationComparisons {
    const next = createDeclarationComparisons();
    // Declaration rows are immutable publications. Weak keys follow their
    // lifetime without enumerating/copying every surviving authored dictionary
    // when just a currentness carrier changes. Selection and currentness stay
    // in the freshly bounded projection/materialization indexes below.
    next.entries = previous.entries;
    // Register every surviving descriptive fact before preparing new inputs.
    // A replaced report may keep the same owned manifest/artifact roots; no
    // phase, trust, selection or execution admission decision is retained here.
    for (const materialization of materializations) {
        const previousInput = previous.materializations.has(materialization) ? materialization
            : [...previous.materializations.keys()].find(value => value.portableRelease === materialization.portableRelease
                && value.sourceClass === materialization.sourceClass
                && value.archiveDigestSha256 === materialization.archiveDigestSha256
                && value.declaredManifest === materialization.declaredManifest && value.uiArtifacts === materialization.uiArtifacts);
        const facts = previousInput && previous.materializations.get(previousInput);
        if (facts) next.materializations.set(materialization, facts);
    }
    for (const model of models) {
        if (next.projections.has(model)) continue;
        const comparison = previous.projections.get(model);
        if (comparison) next.projections.set(model, comparison);
    }
    return next;
}

function readDeclarationComparisonSnapshot(entry: unknown, comparisons: DeclarationComparisons): JsonValue {
    const record = asRecord(entry);
    if (!record) return projectNativeJsonValueForTransport(entry);
    const previous = comparisons.entries.get(record);
    if (previous !== undefined) return previous;
    const snapshot = projectNativeJsonValueForTransport(declarationContent(record));
    comparisons.entries.set(record, snapshot);
    return snapshot;
}

function sameDeclarationContent(left: unknown, right: unknown, comparisons: DeclarationComparisons): boolean {
    return left === right || sameStrictJsonValue(readDeclarationComparisonSnapshot(left, comparisons), readDeclarationComparisonSnapshot(right, comparisons));
}

type DeclarationComparisonEntry = readonly [string, JsonValue];
type DeclarationComparisonFamilies = readonly (readonly DeclarationComparisonEntry[])[];
type ProjectionDeclarationComparison = Readonly<{
    familiesByPluginId: ReadonlyMap<string, DeclarationComparisonFamilies>;
    stampedPluginIds: ReadonlySet<string>;
}>;
type MaterializationDeclarationComparison = Readonly<{
    manifest: JsonValue;
    artifacts: readonly JsonValue[];
}>;

function readMaterializationDeclarationComparison(materialization: PluginMachineMaterializationV1,
    comparisons: DeclarationComparisons): MaterializationDeclarationComparison {
    const previous = comparisons.materializations.get(materialization);
    if (previous) return previous;
    let manifest = materialization.portableRelease ? null : projectNativeJsonValueForTransport(materialization.declaredManifest ?? null);
    for (const facts of comparisons.materializations.values()) {
        if (sameStrictJsonValue(manifest, facts.manifest)) { manifest = facts.manifest; break; }
    }
    const artifacts: JsonValue[] = [];
    for (const artifact of materialization.uiArtifacts) {
        let snapshot = normalizeStrictJsonValue(artifact);
        const candidates = [...artifacts, ...[...comparisons.materializations.values()].flatMap(facts => facts.artifacts)];
        for (const candidate of candidates) {
            if (sameStrictJsonValue(snapshot, candidate)) { snapshot = candidate; break; }
        }
        artifacts.push(snapshot);
    }
    const facts = Object.freeze({ manifest, artifacts: Object.freeze(artifacts) });
    comparisons.materializations.set(materialization, facts);
    return facts;
}

/** Index one comparison pass, not one full-family scan for every plugin. */
function readProjectionDeclarationComparison(model: PluginUiProjectionModel, comparisons: DeclarationComparisons): ProjectionDeclarationComparison {
    const previous = comparisons.projections.get(model);
    if (previous) return previous;
    const declarationFamilies = declarationMaps(model);
    const families = [...declarationFamilies, model.resourcesById];
    const groupedFamiliesByPluginId = new Map<string, DeclarationComparisonEntry[][]>();
    const stampedPluginIds = new Set<string>();
    for (const [index, family] of families.entries()) {
        for (const [key, entry] of Object.entries(family)) {
            const pluginId = asRecord(entry)?.pluginId;
            if (typeof pluginId !== 'string') continue;
            let grouped = groupedFamiliesByPluginId.get(pluginId);
            if (!grouped) {
                grouped = Array.from({ length: families.length }, (): DeclarationComparisonEntry[] => []);
                groupedFamiliesByPluginId.set(pluginId, grouped);
            }
            grouped[index]!.push([key, readDeclarationComparisonSnapshot(entry, comparisons)]);
            if (index < declarationFamilies.length && !stampedPluginIds.has(pluginId)
                && readPluginUiProjectionEntryExecutionOrigin(entry) !== null) stampedPluginIds.add(pluginId);
        }
    }
    const familiesByPluginId = new Map<string, DeclarationComparisonFamilies>();
    for (const [pluginId, grouped] of groupedFamiliesByPluginId) {
        for (const family of grouped) {
            family.sort(([left], [right]) => left.localeCompare(right));
            for (const entry of family) Object.freeze(entry);
            Object.freeze(family);
        }
        Object.freeze(grouped);
        let canonical: DeclarationComparisonFamilies = grouped;
        const compared = new Set<DeclarationComparisonFamilies>();
        for (const other of comparisons.projections.values()) {
            const candidate = other.familiesByPluginId.get(pluginId);
            if (!candidate || compared.has(candidate)) continue;
            compared.add(candidate);
            if (sameStrictJsonValue(candidate, grouped)) { canonical = candidate; break; }
        }
        // Only this owner prepares these source-neutral cloned JSON facts.
        // Both raw one-shot inputs and live dictionaries pass this strict
        // comparison before reference inequality can mean disagreement.
        familiesByPluginId.set(pluginId, canonical);
    }
    const comparison = { familiesByPluginId, stampedPluginIds };
    comparisons.projections.set(model, comparison);
    return comparison;
}

function samePluginDeclarationContent(
    left: PluginUiProjectionUnionMember & Readonly<{ projection: PluginUiProjectionModel }>,
    right: PluginUiProjectionUnionMember & Readonly<{ projection: PluginUiProjectionModel }>,
    pluginId: string,
    comparisons: DeclarationComparisons,
): boolean {
    const leftComparison = readProjectionDeclarationComparison(left.projection, comparisons);
    const rightComparison = readProjectionDeclarationComparison(right.projection, comparisons);
    const leftFamilies = leftComparison.familiesByPluginId.get(pluginId);
    const rightFamilies = rightComparison.familiesByPluginId.get(pluginId);
    if (leftFamilies !== rightFamilies) return false;
    const installedContent = (member: typeof left) => {
        const installed = member.projection.installedPackagesById[pluginId];
        return installed ? [installed.id, installed.displayName, installed.version, installed.executionTarget ?? null] : null;
    };
    if (!sameStrictJsonValue(installedContent(left), installedContent(right))) return false;
    const leftMaterialization = left.materializationsByPluginId?.[pluginId];
    const rightMaterialization = right.materializationsByPluginId?.[pluginId];
    const correspondence = (member: typeof left, materialization: typeof leftMaterialization, comparison: ProjectionDeclarationComparison) => (
        materialization?.portableRelease && materialization.archiveDigestSha256 ? materialization.archiveDigestSha256
            : materialization && !materialization.portableRelease ? readMaterializationDeclarationComparison(materialization, comparisons).manifest
                : comparison.stampedPluginIds.has(pluginId) ? ['unprovenPortableContent', member.serverId, member.machineId] : null
    );
    const leftCorrespondence = correspondence(left, leftMaterialization, leftComparison);
    const rightCorrespondence = correspondence(right, rightMaterialization, rightComparison);
    if (leftMaterialization && !leftMaterialization.portableRelease && rightMaterialization && !rightMaterialization.portableRelease) {
        // Both native manifests were strictly normalized and canonicalized in
        // this current comparison owner; inequality is already known content
        // disagreement, not a reason to walk the same payload again.
        if (leftCorrespondence !== rightCorrespondence) return false;
    } else if (!sameStrictJsonValue(leftCorrespondence, rightCorrespondence)) return false;
    const artifacts = (materialization: typeof leftMaterialization) => materialization && (!materialization.portableRelease || materialization.archiveDigestSha256)
        ? readMaterializationDeclarationComparison(materialization, comparisons).artifacts : [];
    const leftArtifacts = artifacts(leftMaterialization);
    const rightArtifacts = artifacts(rightMaterialization);
    if (leftArtifacts === rightArtifacts) return true;
    if (leftArtifacts.length !== rightArtifacts.length) return false;
    // Artifact order is not correspondence. Compare the same multiset without
    // creating sorted, serialized copies of already admitted artifact facts.
    const matched = new Set<number>();
    return leftArtifacts.every(artifact => {
        const index = rightArtifacts.findIndex((other, index) => !matched.has(index) && artifact === other);
        if (index < 0) return false;
        matched.add(index);
        return true;
    });
}

export type PluginUiExecutionOriginCandidateFacts = Readonly<{
    establishingTargets: readonly MachineAdministrationTargetV1[];
    sourceCandidates: readonly PluginMachineSourceExecutionOriginCandidateV1[];
    declaredDefaultOrigins: readonly PluginMachineExecutionOriginV1[];
    machineRejections: readonly PluginMachineExecutionOriginRejectionV1[];
    autoPick: boolean;
    renderedVersion?: string;
}>;

/** Project exact reported supplies into Administration; never elect an origin here. */
export function readPluginUiExecutionOriginCandidates(params: Readonly<{
    projection: PluginUiProjectionModel | null;
    pluginId: string;
    entry?: unknown;
    /** Package occurrences also supply native-only contributions, with no UI declaration. */
    members?: readonly PluginUiProjectionUnionMember[];
    /** This consumer's last projection, retained only when every selection fact is unchanged. */
    previous?: PluginUiExecutionOriginCandidateFacts;
}>): PluginUiExecutionOriginCandidateFacts {
    const entries = params.entry ? [params.entry] : params.projection
        ? declarationMaps(params.projection).flatMap(map => Object.values(map).filter(entry => asRecord(entry)?.pluginId === params.pluginId)) : [];
    return derivePluginUiExecutionOriginCandidates(params, entries);
}

function derivePluginUiExecutionOriginCandidates(
    params: Parameters<typeof readPluginUiExecutionOriginCandidates>[0],
    entries: readonly unknown[],
): PluginUiExecutionOriginCandidateFacts {
    const sourceCandidates: PluginMachineSourceExecutionOriginCandidateV1[] = [];
    const declaredDefaultOrigins: PluginMachineExecutionOriginV1[] = [];
    const machineRejections: PluginMachineExecutionOriginRejectionV1[] = [];
    const establishingTargets: MachineAdministrationTargetV1[] = [...(params.projection?.establishingExecutionTargetsByPluginId?.[params.pluginId] ?? [])];
    const packageSupplies: PluginUiContributionSupplyV1[] = [];
    for (const member of params.members ?? []) {
        if (!member.projection) continue;
        const installed = member.projection.installedPackagesById[params.pluginId];
        if (!installed) continue;
        // Availability already supplies portable installations and owns their immutable-content
        // admission. A package occurrence must never introduce an alternate source for one.
        if (member.materializationsByPluginId?.[params.pluginId]?.portableRelease) continue;
        const origin = resolveMemberContributionOrigin({ ...member, projection: member.projection }, {
            pluginId: params.pluginId, occurrenceId: installed.occurrenceId, executionOrigin: installed.executionOrigin,
        });
        if (!origin || (!origin.executionOrigin && !origin.unavailableReasonCode)) continue;
        packageSupplies.push({ ...origin, occurrenceId: installed.occurrenceId ?? null, pluginVersion: installed.version ?? null,
            sourceCustody: installed.sourceCustody ?? null,
            executionTargetDefault: installed.executionTarget?.default === 'installation',
            executionTargetAutoPick: installed.executionTarget?.autoPick });
    }
    const supplyGroups = [
        ...entries.map(entry => ({ conflict: asRecord(entry)?.hostCompatibility === 'conflict', supplies: readPluginUiContributionSupplies(entry) })),
        { conflict: entries.some(entry => asRecord(entry)?.hostCompatibility === 'conflict'), supplies: packageSupplies },
    ];
    for (const { conflict, supplies } of supplyGroups) {
        for (const supply of supplies) {
            if (supply.phase === 'establishing' && supply.serverIdentityId
                && !establishingTargets.some(target => target.serverIdentityId === supply.serverIdentityId && target.machineId === supply.machineId)) {
                establishingTargets.push({ serverIdentityId: supply.serverIdentityId, machineId: supply.machineId });
            }
            const origin = supply.executionOrigin;
            const reason = readPluginUiSupplyRejection(supply);
            const serverIdentityId = origin?.serverIdentityId ?? supply.serverIdentityId;
            if (reason && serverIdentityId && !machineRejections.some(entry => entry.serverIdentityId === serverIdentityId
                && entry.machineId === supply.machineId)) {
                machineRejections.push({ serverIdentityId, machineId: supply.machineId, reason });
            }
            if (!origin || getPluginMachineExecutionOriginRef(origin).pluginId !== params.pluginId) continue;
            if (supply.executionTargetDefault && !conflict
                && !declaredDefaultOrigins.some(candidate => arePluginMachineExecutionOriginsEqual(candidate, origin))) declaredDefaultOrigins.push(origin);
            if (!('sourceRef' in origin) || !supply.occurrenceId || !supply.pluginVersion
                || !supply.serverId
                || sourceCandidates.some(candidate => arePluginMachineExecutionOriginsEqual(candidate.source.origin, origin))) continue;
            sourceCandidates.push(Object.freeze({
                source: Object.freeze({ origin, version: supply.pluginVersion, occurrenceId: supply.occurrenceId,
                    serverId: supply.serverId }),
                // A machine-local source is selected by exact custody, not by
                // correspondence with another Machine's portable release.
                releaseContent: 'matched',
                validation: reason ? { kind: 'rejected' as const, reason }
                    : supply.phase === 'current' && supply.interactionEnabled ? { kind: 'admitted' as const }
                        : { kind: 'rejected' as const, reason: 'stale' as const },
            }));
        }
    }
    const installed = params.projection?.installedPackagesById[params.pluginId];
    const autoPick = installed ? installed.executionTarget?.autoPick !== false
        : !supplyGroups.some(({ supplies }) => supplies.some(supply => supply.executionTargetAutoPick === false));
    const renderedVersion = installed?.version;
    const previous = params.previous;
    if (previous && previous.autoPick === autoPick && previous.renderedVersion === renderedVersion
        && previous.establishingTargets.length === establishingTargets.length
        && establishingTargets.every((target, index) => target.serverIdentityId === previous.establishingTargets[index]!.serverIdentityId
            && target.machineId === previous.establishingTargets[index]!.machineId)
        && previous.sourceCandidates.length === sourceCandidates.length
        && sourceCandidates.every((candidate, index) => {
            const other = previous.sourceCandidates[index]!;
            return candidate.source.serverId === other.source.serverId
                && candidate.source.version === other.source.version
                && candidate.source.occurrenceId === other.source.occurrenceId
                && arePluginMachineExecutionOriginsEqual(candidate.source.origin, other.source.origin)
                && candidate.releaseContent === other.releaseContent
                && candidate.validation.kind === other.validation.kind
                && (candidate.validation.kind !== 'rejected'
                    || (other.validation.kind === 'rejected' && candidate.validation.reason === other.validation.reason));
        })
        && previous.declaredDefaultOrigins.length === declaredDefaultOrigins.length
        && declaredDefaultOrigins.every((origin, index) => arePluginMachineExecutionOriginsEqual(origin, previous.declaredDefaultOrigins[index]!))
        && previous.machineRejections.length === machineRejections.length
        && machineRejections.every((rejection, index) => {
            const other = previous.machineRejections[index]!;
            return rejection.serverIdentityId === other.serverIdentityId && rejection.machineId === other.machineId
                && rejection.reason === other.reason;
        })) return previous;
    return Object.freeze({ establishingTargets: Object.freeze(establishingTargets), sourceCandidates: Object.freeze(sourceCandidates), declaredDefaultOrigins: Object.freeze(declaredDefaultOrigins),
        // The rendered declaration owns policy. An older replica's opt-out
        // cannot change the current rendered release's automatic placement.
        autoPick,
        ...(renderedVersion ? { renderedVersion } : {}),
        machineRejections: Object.freeze(machineRejections) });
}

type CandidatePublicationInput = Readonly<{
    entries: readonly unknown[];
    installed: PluginUiProjectionModel['installedPackagesById'][string] | undefined;
    establishing: readonly MachineAdministrationTargetV1[] | undefined;
    members: readonly PluginUiProjectionUnionMember[];
}>;

function sameCandidateMembers(left: readonly PluginUiProjectionUnionMember[], right: readonly PluginUiProjectionUnionMember[], pluginId: string): boolean {
    return left.length === right.length && left.every((member, index) => {
        const other = right[index]!;
        if (member === other) return true;
        return member.machineId === other.machineId && member.serverId === other.serverId
            && member.serverIdentityId === other.serverIdentityId && member.phase === other.phase
            && member.unavailableReasonCode === other.unavailableReasonCode && member.interactionEnabled === other.interactionEnabled
            && (member.projection?.generation == null) === (other.projection?.generation == null)
            && member.projection?.installedPackagesById[pluginId] === other.projection?.installedPackagesById[pluginId]
            && samePluginUiMaterializationFacts(member.materializationsByPluginId?.[pluginId], other.materializationsByPluginId?.[pluginId])
            && memberHasActivationRefusal(member, pluginId) === memberHasActivationRefusal(other, pluginId);
    });
}

/** Group declaration families once for all demanded plugins at source publication. */
export function createPluginUiExecutionOriginCandidatePublication() {
    let projection: PluginUiProjectionModel | null = null;
    let members: readonly PluginUiProjectionUnionMember[] = [];
    let pluginIds: readonly string[] = [];
    let publishedMembers: readonly PluginUiProjectionUnionMember[] | null = null;
    let publishedPluginIds: readonly string[] | null = null;
    let projectionIndex: PublishedProjectionPluginIndex | null = null;
    let membersByPluginId = new Map<string, PluginUiProjectionUnionMember[]>();
    let inputs = new Map<string, CandidatePublicationInput>();
    let snapshot: ReadonlyMap<string, PluginUiExecutionOriginCandidateFacts> = new Map();
    const noEntries: readonly unknown[] = Object.freeze([]);
    return {
        getSnapshot: (): ReadonlyMap<string, PluginUiExecutionOriginCandidateFacts> => snapshot,
        publish(nextProjection: PluginUiProjectionModel | null, nextMembers: readonly PluginUiProjectionUnionMember[],
            nextPluginIds: readonly string[]): ReadonlyMap<string, PluginUiExecutionOriginCandidateFacts> {
            if (projection === nextProjection && publishedMembers === nextMembers && publishedPluginIds === nextPluginIds) return snapshot;
            const requested = [...new Set(nextPluginIds)];
            if (projection === nextProjection && arePluginUiProjectionUnionMembersEquivalentForPlugins(members, nextMembers, true)
                && pluginIds.length === requested.length && pluginIds.every((id, index) => id === requested[index])) {
                publishedMembers = nextMembers;
                publishedPluginIds = nextPluginIds;
                return snapshot;
            }
            if (projection !== nextProjection) {
                projectionIndex = nextProjection ? readPublishedProjectionPluginIndex(nextProjection)
                    ?? prepareProjectionPluginIndex(nextProjection, projectionIndex) : null;
            }
            if (!arePluginUiProjectionUnionMembersEquivalentForPlugins(members, nextMembers, true)) {
                // Membership keys belong to the installed-package dictionary,
                // not currentness/generation. Rebind changed member facts to
                // their existing groups without rescanning sibling sources.
                const previousIds = new Map<PluginUiProjectionUnionMember, string[]>();
                for (const [id, suppliers] of membersByPluginId) for (const member of suppliers) {
                    const ids = previousIds.get(member) ?? [];
                    ids.push(id);
                    previousIds.set(member, ids);
                }
                const grouped = new Map<string, PluginUiProjectionUnionMember[]>();
                for (const member of nextMembers) {
                    const previous = members.find(old => old.machineId === member.machineId && old.serverId === member.serverId
                        && old.serverIdentityId === member.serverIdentityId
                        && old.projection?.installedPackagesById === member.projection?.installedPackagesById);
                    const ids = previous ? previousIds.get(previous) ?? [] : Object.keys(member.projection?.installedPackagesById ?? {});
                    for (const id of ids) {
                        const supplying = grouped.get(id) ?? [];
                        supplying.push(member);
                        grouped.set(id, supplying);
                    }
                }
                membersByPluginId = grouped;
            }
            const nextInputs = new Map<string, CandidatePublicationInput>();
            const nextSnapshot = new Map<string, PluginUiExecutionOriginCandidateFacts>();
            for (const id of requested) {
                const input: CandidatePublicationInput = {
                    entries: projectionIndex?.slices[id]?.entries ?? noEntries,
                    installed: nextProjection?.installedPackagesById[id],
                    establishing: nextProjection?.establishingExecutionTargetsByPluginId?.[id],
                    members: membersByPluginId.get(id) ?? [],
                };
                const previous = inputs.get(id);
                const facts = previous && previous.entries === input.entries && previous.installed === input.installed
                    && previous.establishing === input.establishing && sameCandidateMembers(previous.members, input.members, id)
                    ? snapshot.get(id)!
                    : derivePluginUiExecutionOriginCandidates({ projection: nextProjection, pluginId: id, members: input.members,
                        previous: snapshot.get(id) }, input.entries);
                nextInputs.set(id, input);
                nextSnapshot.set(id, facts);
            }
            if (pluginIds.length !== requested.length || requested.some((id, index) => id !== pluginIds[index] || snapshot.get(id) !== nextSnapshot.get(id))) {
                snapshot = nextSnapshot;
            }
            projection = nextProjection;
            members = [...nextMembers];
            pluginIds = requested;
            inputs = nextInputs;
            publishedMembers = nextMembers;
            publishedPluginIds = nextPluginIds;
            return snapshot;
        },
    };
}

function readPluginUiSupplyRejection(supply: PluginUiContributionOriginV1): PluginMachineExecutionOriginRejectionV1['reason'] | null {
    switch (supply.unavailableReasonCode) {
        case 'plugin_machine_unreachable': return 'home_unreachable';
        case 'plugin_daemon_unsupported': return 'daemon_unsupported';
        case 'plugin_daemon_invalid_response': return 'daemon_invalid_response';
        case 'plugin_daemon_unavailable': return 'daemon_unavailable';
        case 'plugin_activation_failed': return 'activation_refused';
        case 'plugin_source_not_ready': return 'source_not_ready';
        default: return null;
    }
}

/** A Resource without a View still has its own producer and current runtime slot. */
function resourceHasCurrentProducerOrigin(projection: PluginUiProjectionModel, entry: PluginUiResourceProjection): boolean {
    return readCurrentResourceProducerOrigin(projection, entry) !== null;
}

function readCurrentResourceProducerOrigin(projection: PluginUiProjectionModel, entry: PluginUiResourceProjection): PluginMachineExecutionOriginV1 | null {
    const origin = readPluginUiProjectionEntryExecutionOrigin(entry);
    return origin && entryHasCurrentOccurrence(projection, entry) ? origin : null;
}

function resolveMemberEntryExecutionOrigin(
    member: PluginUiProjectionUnionMember & Readonly<{ projection: PluginUiProjectionModel }>,
    entry: UnknownRecord,
    packageOriginsByPluginId?: Map<string, PluginMachineExecutionOriginV1 | null>,
): PluginMachineExecutionOriginV1 | null {
    const pluginId = readString(entry.pluginId);
    if (!pluginId) return null;
    const installation = member.materializationsByPluginId?.[pluginId];
    if (entry.executionOrigin === undefined && readString(entry.occurrenceId) === null && installation?.portableRelease) {
        return composePluginMachineExecutionOriginV1(installation);
    }
    return readPluginUiProjectionEntryOrPackageExecutionOrigin(member.projection, entry, packageOriginsByPluginId);
}

function memberHasActivationRefusal(member: PluginUiProjectionUnionMember, pluginId: string): boolean {
    return member.phase === 'current' && member.projection?.diagnostics?.some(diagnostic =>
        diagnostic.plugin.id === pluginId && diagnostic.host === 'daemon' && diagnostic.resolution.state === 'current'
        && diagnostic.data.code === 'plugin_activation_failed' && diagnostic.data.severity === 'error') === true;
}

function resolveMemberContributionOrigin(
    member: PluginUiProjectionUnionMember & Readonly<{ projection: PluginUiProjectionModel }>,
    entry: UnknownRecord,
    packageOriginsByPluginId?: Map<string, PluginMachineExecutionOriginV1 | null>,
): PluginUiContributionOriginV1 | null {
    const pluginId = readString(entry.pluginId);
    if (!pluginId) return null;
    const observedInstallation = member.materializationsByPluginId?.[pluginId];
    const activationRefused = memberHasActivationRefusal(member, pluginId);
    const unavailableReasonCode = member.unavailableReasonCode ?? (activationRefused ? 'plugin_activation_failed'
        : member.phase === 'establishing' ? 'plugin_source_not_ready' : undefined);
    return Object.freeze({ machineId: member.machineId, serverId: member.serverId,
        ...(member.serverIdentityId ? { serverIdentityId: member.serverIdentityId } : {}),
        ...(unavailableReasonCode ? { unavailableReasonCode } : {}),
        phase: member.phase,
        executionOrigin: resolveMemberEntryExecutionOrigin(member, entry, packageOriginsByPluginId),
        interactionEnabled: member.interactionEnabled && member.projection.generation !== null
            && member.projection.installedPackagesById[pluginId]?.enabled !== false
            && (!observedInstallation || (observedInstallation.enabled && observedInstallation.trustState === 'trusted'))
            && (readString(entry.occurrenceId) !== null || readPluginUiProjectionEntryExecutionOrigin(entry) !== null) });
}

/**
 * Whether two member lists describe the same union, so the caller can keep the
 * previously built model instead of publishing a new object identity. Member
 * projections are compared by IDENTITY, which is exactly the stability the
 * canonical per-machine projection owner guarantees for unchanged UI declarations.
 */
export function arePluginUiProjectionUnionMembersEquivalent(
    left: readonly PluginUiProjectionUnionMember[],
    right: readonly PluginUiProjectionUnionMember[],
): boolean {
    return arePluginUiProjectionUnionMembersEquivalentForPlugins(left, right);
}

function arePluginUiProjectionUnionMembersEquivalentForPlugins(
    left: readonly PluginUiProjectionUnionMember[],
    right: readonly PluginUiProjectionUnionMember[],
    ignoreSelectableOrigins = false,
): boolean {
    if (left === right) return true;
    if (left.length !== right.length) {
        return false;
    }
    return left.every((member, index) => right[index] !== undefined
        && samePluginUiProjectionUnionMemberInputs(member, right[index]!, ignoreSelectableOrigins));
}

function samePluginUiProjectionUnionMemberInputs(member: PluginUiProjectionUnionMember,
    other: PluginUiProjectionUnionMember, ignoreSelectableOrigins = false): boolean {
    return member === other || (
            member.machineId === other.machineId
            && member.serverId === other.serverId
            && member.serverIdentityId === other.serverIdentityId
            && member.projection === other.projection
            && arePluginUiMaterializationsEquivalent(member.materializationsByPluginId, other.materializationsByPluginId)
            && (ignoreSelectableOrigins || ((member.selectableExecutionOrigins?.length ?? 0) === (other.selectableExecutionOrigins?.length ?? 0)
                    && (member.selectableExecutionOrigins ?? []).every((origin, originIndex) => (
                        arePluginMachineExecutionOriginsEqual(origin, other.selectableExecutionOrigins![originIndex]!)
                    ))))
            && member.phase === other.phase
            && member.unavailableReasonCode === other.unavailableReasonCode
            && member.interactionEnabled === other.interactionEnabled);
}

/** Derive one descriptive Account catalog; exact effects remain origin-bound. */
export function unionPluginUiProjections(
    members: readonly PluginUiProjectionUnionMember[],
    selectedOriginsByPluginId: PluginUiProjectionUnionOriginSelections = new Map(),
): PluginUiProjectionUnion {
    return derivePluginUiProjectionUnion(members, selectedOriginsByPluginId, createDeclarationComparisons());
}

/** One admission/aggregate policy serves full adapters and incremental publications. */
function readUnionPublicationFacts(
    members: readonly PluginUiProjectionUnionMember[],
    selectedOriginsByPluginId: PluginUiProjectionUnionOriginSelections,
    source?: UnionPublicationSource,
) {
    const eligible = members.filter((member) => readString(member.machineId) !== null);
    const phase = resolveUnionProjectionPhase(eligible);
    const hasEstablishingMembers = eligible.some((member) => member.phase === 'establishing');
    // A known Account installation can precede its first runtime projection,
    // including all contribution supplies. Preserve that producer's pending
    // fact without inventing custody, an occurrence, or executable authority.
    const establishingExecutionTargetsByPluginId: Record<string, readonly MachineAdministrationTargetV1[]> = {};
    for (const member of eligible) {
        if (member.phase !== 'establishing') continue;
        for (const [pluginId, installation] of Object.entries(member.materializationsByPluginId ?? {})) {
            if (!installation.enabled || installation.trustState !== 'trusted' || installation.machineId !== member.machineId
                || installation.serverIdentityId !== member.serverIdentityId) continue;
            establishingExecutionTargetsByPluginId[pluginId] = Object.freeze([
                ...(establishingExecutionTargetsByPluginId[pluginId] ?? []),
                Object.freeze({ serverIdentityId: installation.serverIdentityId, machineId: installation.machineId }),
            ]);
        }
    }
    const establishingFacts = Object.keys(establishingExecutionTargetsByPluginId).length > 0
        ? { establishingExecutionTargetsByPluginId: Object.freeze(establishingExecutionTargetsByPluginId) } : {};
    const emptyProjection = 'establishingExecutionTargetsByPluginId' in establishingFacts
        ? Object.freeze({ ...EMPTY_PLUGIN_UI_PROJECTION, ...establishingFacts }) : null;
    const soleMember = eligible.length === 1 ? eligible[0] : undefined;
    const contributing = [...eligible]
        .filter((member): member is PluginUiProjectionUnionMember & Readonly<{ projection: PluginUiProjectionModel }> => (
            member.projection !== null
        ))
        // Deterministic and presence-free: machine id, never `activeAt`.
        .sort((left, right) => left.machineId.localeCompare(right.machineId)
            || (left.serverIdentityId ?? left.serverId ?? '').localeCompare(right.serverIdentityId ?? right.serverId ?? ''));

    const admittedContributing = contributing.filter(member => source
        ? source.hasDeclarations.get(member.projection) === true || memberHasAdmittedContribution(member, selectedOriginsByPluginId, false,
            source.modelIndexes.get(member.projection)?.resourceOrigins)
        : memberHasAdmittedContribution(member, selectedOriginsByPluginId));
    return { phase, hasEstablishingMembers, emptyProjection, soleMember, contributing, admittedContributing, establishingFacts };
}

function derivePluginUiProjectionUnion(
    members: readonly PluginUiProjectionUnionMember[],
    selectedOriginsByPluginId: PluginUiProjectionUnionOriginSelections,
    comparisons: DeclarationComparisons,
    supplyFacts?: ReadonlyMap<PluginUiProjectionUnionMember, UnionSupplyFacts>,
): PluginUiProjectionUnion {
    const { phase, hasEstablishingMembers, emptyProjection, soleMember, contributing, admittedContributing, establishingFacts }
        = readUnionPublicationFacts(members, selectedOriginsByPluginId);
    if (contributing.length === 0) {
        return Object.freeze({
            pluginUiProjection: emptyProjection,
            phase,
            unavailableReasonCode: soleMember?.unavailableReasonCode,
            hasEstablishingMembers,
            interactionEnabled: false,
            machineId: soleMember?.machineId ?? null,
            serverId: soleMember?.serverId ?? null,
        });
    }

    const suppliesByPluginId = new Map<string, (typeof contributing)[number][]>();
    for (const member of admittedContributing) {
        const pluginIds = new Set(declarationMaps(member.projection).flatMap(map => Object.values(map)
            .flatMap(entry => { const id = readString(asRecord(entry)?.pluginId); return id ? [id] : []; })));
        for (const pluginId of pluginIds) {
            const supplies = suppliesByPluginId.get(pluginId) ?? [];
            supplies.push(member);
            suppliesByPluginId.set(pluginId, supplies);
        }
    }
    const conflictedPluginIds = new Set([...suppliesByPluginId].flatMap(([pluginId, supplies]) => {
        // Retained declarations describe the Account catalog. Administration
        // owns exact selectability (reachability, trust and release admission);
        // a current projection alone cannot grant those facts.
        const agreement = resolveFleetSupplyAgreement({
            identity: () => pluginId,
            sameContent: (left, right) => samePluginDeclarationContent(left, right, pluginId, comparisons),
            supplies: supplies.map(member => ({ value: member, selectable: memberHasSelectableDeclaration(member, pluginId) })),
        });
        return agreement.conflictingIdentities;
    }));
    const selectedMembersByPluginId = new Map<string, (typeof contributing)[number]>();
    for (const [pluginId, supplies] of suppliesByPluginId) {
        const selected = selectedOriginsByPluginId.get(pluginId);
        if (!selected) continue;
        const selectedMember = supplies.find(member => declarationMaps(member.projection).some(map => Object.values(map).some(entry => {
            const record = asRecord(entry);
            if (record?.pluginId !== pluginId) return false;
            const origin = resolveMemberEntryExecutionOrigin(member, record);
            return origin !== null && getPluginMachineExecutionOriginRef(origin).machineId === member.machineId
                && arePluginMachineExecutionOriginsEqual(selected, origin);
        })));
        if (selectedMember) selectedMembersByPluginId.set(pluginId, selectedMember);
    }

    if (admittedContributing.length === 0) {
        return Object.freeze({
            pluginUiProjection: emptyProjection,
            phase,
            unavailableReasonCode: soleMember?.unavailableReasonCode,
            hasEstablishingMembers,
            interactionEnabled: false,
            machineId: soleMember?.machineId ?? null,
            serverId: soleMember?.serverId ?? null,
        });
    }

    // The aggregate has no exact contribution in hand. It is executable only
    // when its own catalog phase is current and at least one supplying source is
    // itself current. Concrete mounts use their per-entry origin below, so this
    // coarse fail-closed flag cannot revoke an unrelated current origin.
    const interactionEnabled = phase === 'current'
        && admittedContributing.some((member) => (
            member.phase === 'current' && member.interactionEnabled
        ));

    const translationsByPluginId: Record<string, PluginUiTranslationsProjection> = {};
    const installedPackagesById: Record<string, PluginProjectionInstalledPackageV2> = {};
    const sessionHeaderActionsById: Record<string, PluginUiSessionHeaderActionProjection> = {};
    const searchProvidersById: Record<string, PluginUiSearchProviderProjection> = {};
    const hostedWebById: Record<string, PluginUiHostedWebProjection> = {};
    const reactNativeBundlesById: Record<string, PluginUiReactNativeBundleProjection> = {};
    const surfacePlacementsById: Record<string, PluginUiPhysicalSurfacePlacementProjection> = {};
    const settingsGroupsById: Record<string, PluginUiSettingsGroupProjection> = {};
    const settingsPagesById: Record<string, PluginUiSettingsPageProjection> = {};
    const actionsById: Record<string, PluginUiActionProjection> = {};
    const voiceProvidersById: Record<string, PluginVoiceProviderProjection> = {};
    const dragSourcesById: Record<string, PluginUiDragSourceProjection> = {};
    const workItemsById: Record<string, PluginUiWorkItemsProjection> = {};
    const dropTargetsById: Record<string, PluginUiDropTargetProjection> = {};
    const resourcesById: Record<string, PluginUiResourceProjection> = {};
    const inputTypesById: Record<string, PluginUiInputTypeProjection> = {};
    const atmospherePicturesById: Record<string, PluginUiAtmospherePictureProjection> = {};
    const registrySourcesById: Record<string, PluginUiRegistrySourceProjection> = {};
    const storeKindsById: Record<string, PluginUiStoreKindProjection> = {};
    const skillsById: Record<string, PluginUiSkillProjection> = {};
    const unknownEntriesById: Record<string, UnknownRecord> = {};
    const composerControlsById: Record<string, PluginUiProjectionModel['composerControlsById'][string]> = {};
    const composerRegionsById: Record<string, PluginUiProjectionModel['composerRegionsById'][string]> = {};
    const composerReferencesById: Record<string, PluginUiProjectionModel['composerReferencesById'][string]> = {};

    // Aggregate equivalent declarations without appointing a producer. Exact
    // source facts are retained separately, including offline supplying copies.
    const normalizedSupplies = new Map<PluginUiContributionOriginV1, Readonly<{
        occurrenceId: string | null;
        resourceCapability: ReturnType<typeof readSelectedPluginUiResourceCapability>;
        supply: PluginUiContributionSupplyV1;
    }>>();
    const publishFirstAdmitted = <T>(member: PluginUiProjectionUnionMember & Readonly<{ projection: PluginUiProjectionModel }>, map: Record<string, T>, key: string, value: T, origin: PluginUiContributionOriginV1,
        retainDeclarationOccurrence = false): void => {
        const model = member.projection;
        const sourceEntry = asRecord(value);
        const pluginId = readString(sourceEntry?.pluginId);
        if (!sourceEntry || !pluginId) return;
        // Preserve the original stamp's field insertion slot without making a
        // fresh carrier the identity of the immutable authored source row.
        const entry: UnknownRecord = { ...sourceEntry, hostOrigin: origin };
        const previous = asRecord(map[key]);
        const installed = model.installedPackagesById[pluginId];
        const sourceCustody = installed?.sourceCustody ?? null;
        const occurrenceId = readString(entry.occurrenceId);
        const normalized = normalizedSupplies.get(origin);
        const prepared = supplyFacts?.get(member);
        const cached = prepared?.facts.get(sourceEntry);
        const resourceCapability = cached?.resourceCapability ?? readSelectedPluginUiResourceCapability(sourceEntry);
        let supply = cached ?? (normalized?.occurrenceId === occurrenceId
            && normalized.resourceCapability.readable === resourceCapability.readable
            && normalized.resourceCapability.dynamic === resourceCapability.dynamic ? normalized.supply : undefined);
        if (!supply) {
            const rawSupply: PluginUiContributionSupplyV1 = { ...origin, occurrenceId,
                pluginVersion: installed?.version ?? null, sourceCustody,
                executionTargetDefault: installed?.executionTarget?.default === 'installation',
                executionTargetAutoPick: installed?.executionTarget?.autoPick, resourceCapability };
            const parsedSupply = readPluginUiContributionSupplies({ hostSupplies: [rawSupply] })[0];
            if (!parsedSupply) return;
            supply = retainPluginUiProjectionValue(prepared?.previousFacts?.get(sourceEntry), parsedSupply) as PluginUiContributionSupplyV1;
            normalizedSupplies.set(origin, { occurrenceId, resourceCapability, supply });
        }
        if (!cached) prepared?.facts.set(sourceEntry, supply);
        const supplies = publishPluginUiContributionSupplies([...readPluginUiContributionSupplies(previous), supply]);
        const conflict = conflictedPluginIds.has(pluginId) && !selectedMembersByPluginId.has(pluginId);
        const selected = selectedOriginsByPluginId.get(pluginId);
        const binding = conflict ? null : selected
            ? supplies.find(supply => supply.executionOrigin && arePluginMachineExecutionOriginsEqual(selected, supply.executionOrigin)) ?? null
            : null;
        const representative = binding === supply || !previous ? entry : previous;
        const availability = asRecord(representative.availability);
        map[key] = Object.freeze({
            ...representative,
            // Complete the selected producer stamp so artifact adoption cannot
            // borrow a release version (and byte route) from another supply.
            ...(binding?.pluginVersion ? { pluginVersion: binding.pluginVersion } : {}),
            // The selected supply already owns the validated immutable origin.
            // Do not republish its raw representative and reparse it on reads.
            ...(binding && Object.hasOwn(representative, 'executionOrigin')
                ? { executionOrigin: binding.executionOrigin } : {}),
            // Executable rows may not borrow an unselected replica's runtime
            // identity. Schema declarations retain their separate type identity.
            ...(!binding ? { occurrenceId: retainDeclarationOccurrence && !conflict ? representative.occurrenceId : undefined,
                executionOrigin: undefined } : {}),
            hostOrigin: binding,
            hostSupplies: supplies,
            hostCompatibility: conflict ? 'conflict' : 'compatible',
            // A declaration conflict awaits Administration's exact selection;
            // it is not a terminal denial of this page. Keep the choice visible
            // and let the shared loading UI wait for the selected declaration.
            ...(conflict && availability?.state === 'available'
                ? { availability: Object.freeze({ ...availability, state: 'resolving' }) } : {}),
        }) as T;
    };

    for (const member of admittedContributing) {
        const model = member.projection;
        const admittedPluginIds = new Set<string>();
        const admittedOriginsByPluginId = new Map<string, PluginUiContributionOriginV1>();
        const packageOriginsByPluginId = new Map<string, PluginMachineExecutionOriginV1 | null>();
        const originFor = (entry: UnknownRecord): PluginUiContributionOriginV1 | null => {
            const origin = resolveMemberContributionOrigin(member, entry, packageOriginsByPluginId);
            if (!origin) return null;
            const pluginId = readString(entry.pluginId);
            if (pluginId) admittedPluginIds.add(pluginId);
            const executionOrigin = origin.executionOrigin;
            // These declarations share one member/plugin producer. Reuse its
            // origin within this synchronous union only; changed occurrence,
            // currentness or selection still goes through the real admission.
            const previous = pluginId ? admittedOriginsByPluginId.get(pluginId) : undefined;
            if (previous && previous.interactionEnabled === origin.interactionEnabled
                && (previous.executionOrigin === executionOrigin || (previous.executionOrigin !== null && executionOrigin !== null
                    && arePluginMachineExecutionOriginsEqual(previous.executionOrigin, executionOrigin)))) return previous;
            if (pluginId) admittedOriginsByPluginId.set(pluginId, origin);
            return origin;
        };

        for (const [pluginId, entry] of Object.entries(model.translationsByPluginId)) {
            const origin = originFor(entry);
            if (origin) publishFirstAdmitted(member, translationsByPluginId, pluginId, entry, origin);
        }
        for (const [id, entry] of Object.entries(model.sessionHeaderActionsById)) {
            const origin = originFor(entry);
            if (origin) publishFirstAdmitted(member, sessionHeaderActionsById, id, entry, origin);
        }
        for (const [id, entry] of Object.entries(model.searchProvidersById)) {
            const origin = originFor(entry);
            if (origin) publishFirstAdmitted(member, searchProvidersById, id, entry, origin);
        }
        for (const [id, entry] of Object.entries(model.composerControlsById)) {
            const origin = originFor(entry);
            if (origin) publishFirstAdmitted(member, composerControlsById, id, entry, origin);
        }
        for (const [id, entry] of Object.entries(model.composerRegionsById)) {
            const origin = originFor(entry);
            if (origin) publishFirstAdmitted(member, composerRegionsById, id, entry, origin);
        }
        for (const [id, entry] of Object.entries(model.composerReferencesById)) {
            const origin = originFor(entry);
            if (origin) publishFirstAdmitted(member, composerReferencesById, id, entry, origin);
        }
        for (const [id, entry] of Object.entries(model.hostedWebById)) {
            const origin = originFor(entry);
            if (origin) publishFirstAdmitted(member, hostedWebById, id, entry, origin);
        }
        for (const [id, entry] of Object.entries(model.reactNativeBundlesById)) {
            const origin = originFor(entry);
            if (origin) publishFirstAdmitted(member, reactNativeBundlesById, id, entry, origin);
        }
        for (const [id, entry] of Object.entries(model.surfacePlacementsById)) {
            const origin = originFor(entry);
            if (origin) publishFirstAdmitted(member, surfacePlacementsById, id, entry, origin);
        }
        for (const [id, entry] of Object.entries(model.settingsGroupsById)) {
            const origin = originFor(entry);
            if (origin) publishFirstAdmitted(member, settingsGroupsById, id, entry, origin);
        }
        for (const [id, entry] of Object.entries(model.settingsPagesById)) {
            const origin = originFor(entry);
            if (origin) publishFirstAdmitted(member, settingsPagesById, id, entry, origin);
        }
        for (const [id, entry] of Object.entries(model.actionsById)) {
            const origin = originFor(entry);
            if (origin) publishFirstAdmitted(member, actionsById, id, entry, origin);
        }
        for (const [id, entry] of Object.entries(model.voiceProvidersById)) {
            const origin = originFor(entry);
            if (origin) publishFirstAdmitted(member, voiceProvidersById, id, entry, origin);
        }
        for (const [id, entry] of Object.entries(model.dragSourcesById)) {
            const origin = originFor(entry);
            if (origin) publishFirstAdmitted(member, dragSourcesById, id, entry, origin);
        }
        for (const [id, entry] of Object.entries(model.workItemsById)) {
            const origin = originFor(entry);
            if (origin) publishFirstAdmitted(member, workItemsById, id, entry, origin);
        }
        for (const [id, entry] of Object.entries(model.dropTargetsById)) {
            const origin = originFor(entry);
            if (origin) publishFirstAdmitted(member, dropTargetsById, id, entry, origin);
        }
        for (const [id, entry] of Object.entries(model.unknownEntriesById)) {
            const origin = originFor(entry);
            if (origin) {
                publishFirstAdmitted(member, unknownEntriesById, id, entry, origin);
            }
        }
        for (const [id, entry] of Object.entries(model.resourcesById)) {
            const hasProducerStamp = entry.executionOrigin !== undefined;
            const origin = hasProducerStamp
                ? resourceHasCurrentProducerOrigin(model, entry)
                    && selectedOriginOwnsEntry({ entry, machineId: member.machineId, selectedOriginsByPluginId }) ? originFor(entry) : null
                // Earlier rows are only contextual facts of an admitted UI
                // contribution, never independent app-scope read authority.
                : admittedOriginsByPluginId.get(entry.pluginId);
            if (origin) publishFirstAdmitted(member, resourcesById, id, entry, origin);
        }
        for (const [id, entry] of Object.entries(model.inputTypesById)) {
            const origin = entryHasCurrentOccurrence(model, entry)
                && (readPluginUiProjectionEntryExecutionOrigin(entry) === null
                    || !selectedOriginsByPluginId.has(entry.pluginId)
                    || selectedOriginOwnsEntry({ entry, machineId: member.machineId, selectedOriginsByPluginId }))
                ? originFor(entry)
                : null;
            // A registered type's schema remains a declaration when its source
            // cannot execute. Keep that occurrence for schema/options identity;
            // only the selected hostOrigin may authorize Resource or picker effects.
            if (origin) publishFirstAdmitted(member, inputTypesById, id, entry, origin, true);
        }
        for (const [id, entry] of Object.entries(model.registrySourcesById)) {
            // Source visibility and suppliers are installation declarations;
            // Administration's executable selection does not remove an equivalent supplier.
            const representative = selectedMembersByPluginId.get(entry.pluginId)?.projection.registrySourcesById[id]
                ?? registrySourcesById[id];
            // A supplier must declare this row's content, not a conflicting URL.
            if (representative && !sameDeclarationContent(entry.definition, representative.definition, comparisons)) continue;
            const origin = model.installedPackagesById[entry.pluginId]?.enabled === true ? originFor(entry) : null;
            if (origin) publishFirstAdmitted(member, registrySourcesById, id, entry, origin);
        }
        for (const [id, entry] of Object.entries(model.storeKindsById)) {
            const representative = selectedMembersByPluginId.get(entry.pluginId)?.projection.storeKindsById[id]
                ?? storeKindsById[id];
            if (representative && !sameDeclarationContent(entry.definition, representative.definition, comparisons)) continue;
            const origin = model.installedPackagesById[entry.pluginId]?.enabled === true ? originFor(entry) : null;
            if (origin) publishFirstAdmitted(member, storeKindsById, id, entry, origin);
        }
        for (const [id, entry] of Object.entries(model.skillsById)) {
            const origin = model.installedPackagesById[entry.pluginId]?.enabled === true ? originFor(entry) : null;
            if (origin) publishFirstAdmitted(member, skillsById, id, entry, origin);
        }
        for (const [id, entry] of Object.entries(model.atmospherePicturesById)) {
            const origin = entryHasCurrentOccurrence(model, entry)
                && (readPluginUiProjectionEntryExecutionOrigin(entry) === null
                    || selectedOriginOwnsEntry({ entry, machineId: member.machineId, selectedOriginsByPluginId }))
                ? originFor(entry)
                : null;
            if (origin) publishFirstAdmitted(member, atmospherePicturesById, id, entry, origin);
        }
        // A package catalog fact has no contribution-level origin stamp of its
        // own. It is therefore visible in an app union only after one of that
        // same plugin's actual declarations were observed for this member —
        // by an exact installation or as an unmaterialized
        // contribution. This prevents a newer replica's brand from shadowing
        // the selected artifact's brand.
        for (const pluginId of admittedPluginIds) {
            let installedPackage = model.installedPackagesById[pluginId];
            if (installedPackage?.resourceDeclarationsComplete
                && (member.phase !== 'current' || conflictedPluginIds.has(pluginId))) {
                const { resourceDeclarationsComplete: _coverage, ...retainedPackage } = installedPackage;
                installedPackage = Object.freeze(retainedPackage);
            }
            if (installedPackage) {
                if (selectedMembersByPluginId.get(pluginId) === member) installedPackagesById[pluginId] = installedPackage;
                else if (!installedPackagesById[pluginId]) installedPackagesById[pluginId] = conflictedPluginIds.has(pluginId)
                    ? Object.freeze({ ...installedPackage, enabled: false, occurrenceId: undefined, sourceCustody: undefined, brand: undefined })
                    : installedPackage;
            }
        }
    }

    // Selection chooses one whole declaration, so entries exclusive to another
    // replica cannot leak into the selected artifact's catalog. Shared entries
    // keep their reported supplies for Administration's origin picker.
    const publishedMaps: readonly Record<string, unknown>[] = [translationsByPluginId, sessionHeaderActionsById, searchProvidersById,
        hostedWebById, reactNativeBundlesById, surfacePlacementsById, settingsGroupsById, settingsPagesById, actionsById,
        voiceProvidersById, dragSourcesById, workItemsById, dropTargetsById, atmospherePicturesById, registrySourcesById, storeKindsById, skillsById, unknownEntriesById, inputTypesById,
        composerControlsById, composerRegionsById, composerReferencesById, resourcesById];
    for (const [index, map] of publishedMaps.entries()) {
        for (const [key, entry] of Object.entries(map)) {
            const pluginId = readString(asRecord(entry)?.pluginId);
            const selectedMember = pluginId ? selectedMembersByPluginId.get(pluginId) : undefined;
            if (!selectedMember) continue;
            const selectedMaps = [...declarationMaps(selectedMember.projection), selectedMember.projection.resourcesById];
            if (!Object.hasOwn(selectedMaps[index]!, key)) delete map[key];
        }
    }

    const generation = resolveUnionGeneration(admittedContributing);
    const entryCount = Object.keys(translationsByPluginId).length
        + Object.keys(sessionHeaderActionsById).length
        + Object.keys(searchProvidersById).length
        + Object.keys(hostedWebById).length
        + Object.keys(reactNativeBundlesById).length
        + Object.keys(surfacePlacementsById).length
        + Object.keys(settingsGroupsById).length
        + Object.keys(settingsPagesById).length
        + Object.keys(actionsById).length
        + Object.keys(voiceProvidersById).length
        + Object.keys(dragSourcesById).length
        + Object.keys(workItemsById).length
        + Object.keys(dropTargetsById).length
        + Object.keys(resourcesById).length
        + Object.keys(inputTypesById).length
        + Object.keys(atmospherePicturesById).length
        + Object.keys(registrySourcesById).length
        + Object.keys(storeKindsById).length
        + Object.keys(skillsById).length
        + Object.keys(composerControlsById).length
        + Object.keys(composerRegionsById).length
        + Object.keys(composerReferencesById).length
        + Object.keys(unknownEntriesById).length;

    if (generation === null && entryCount === 0) {
        // Every member is still an ungeneration-ed empty snapshot, which is what
        // the canonical empty model already IS. Returning the shared instance
        // keeps a loading union from reading as a projection REPLACEMENT and
        // needlessly invalidating the React Native runtime.
        return Object.freeze({
            pluginUiProjection: emptyProjection ?? EMPTY_PLUGIN_UI_PROJECTION,
            phase,
            hasEstablishingMembers,
            interactionEnabled,
            machineId: soleMember?.machineId ?? null,
            serverId: soleMember?.serverId ?? null,
        });
    }

    const pluginUiProjection: PluginUiProjectionModel = Object.freeze({
        ...establishingFacts,
        generation,
        installedPackagesById: Object.freeze(installedPackagesById),
        // Account-owned composers consume the same admitted declarations and
        // per-plugin supplies; Administration still selects execution origins.
        // Attachment state remains with its existing Session host consumers.
        composerAttachmentsById: Object.freeze({}),
        composerControlsById: Object.freeze(composerControlsById),
        composerRegionsById: Object.freeze(composerRegionsById),
        composerReferencesById: Object.freeze(composerReferencesById),
        // Provisioner catalogs remain owned by their machine projection; no
        // App-union consumer selects or executes these contributions.
        machineProvisionersById: EMPTY_PLUGIN_UI_PROJECTION.machineProvisionersById,
        translationsByPluginId: Object.freeze(translationsByPluginId),
        sessionHeaderActionsById: Object.freeze(sessionHeaderActionsById),
        searchProvidersById: Object.freeze(searchProvidersById),
        hostedWebById: Object.freeze(hostedWebById),
        reactNativeBundlesById: Object.freeze(reactNativeBundlesById),
        surfacePlacementsById: Object.freeze(surfacePlacementsById),
        settingsGroupsById: Object.freeze(settingsGroupsById),
        settingsPagesById: Object.freeze(settingsPagesById),
        actionsById: Object.freeze(actionsById),
        voiceProvidersById: Object.freeze(voiceProvidersById),
        dragSourcesById: Object.freeze(dragSourcesById),
        workItemsById: Object.freeze(workItemsById),
        dropTargetsById: Object.freeze(dropTargetsById),
        resourcesById: Object.freeze(resourcesById),
        connectedAccountDescriptorsById: EMPTY_PLUGIN_UI_PROJECTION.connectedAccountDescriptorsById,
        inputTypesById: Object.freeze(inputTypesById),
        atmospherePicturesById: Object.freeze(atmospherePicturesById),
        registrySourcesById: Object.freeze(registrySourcesById),
        storeKindsById: Object.freeze(storeKindsById),
        skillsById: Object.freeze(skillsById),
        // Openable viewers are scoped to a session/project details host. There is
        // no app-union consumer, so do not make app scope a second projection
        // owner for them.
        openableContentViewersById: Object.freeze({}),
        unknownEntriesById: Object.freeze(unknownEntriesById),
        transcriptActivitiesById: Object.freeze({}),
        sessionInfoSectionsById: Object.freeze({}),
    });

    return Object.freeze({
        pluginUiProjection,
        phase,
        unavailableReasonCode: soleMember?.unavailableReasonCode,
        hasEstablishingMembers,
        interactionEnabled,
        machineId: soleMember?.machineId ?? null,
        serverId: soleMember?.serverId ?? null,
    });
}
