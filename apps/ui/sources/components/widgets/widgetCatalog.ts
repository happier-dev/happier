import type { ConnectedAccountUiProjectionEntryV1} from '@happier-dev/protocol/connect/connectedAccountUiProjectionV1';
import type { PluginContributionIdentityV1} from '@happier-dev/protocol/plugins/contribution-identity';
import type { PluginJsonSchemaV2} from '@happier-dev/protocol/plugins/contributions/jsonSchema';
import type { PluginProjectedResourceV2 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { WidgetPublicSnapshotPresentationV1Schema, type SessionBuiltinWidgetIdV1, type WidgetPublicSnapshotPresentationV1 } from '@happier-dev/protocol/widgets';
import { readWidgetInputTargetV1, WidgetConnectedAccountPurposeBindingV1Schema, WidgetSizeDeclarationV1Schema, type WidgetSizeDeclarationV1, type WidgetConnectedAccountPurposeBindingV1, type WidgetDefinitionAuthorV1, type WidgetDefinitionSummaryV1 } from '@happier-dev/protocol/widgets';
import { buildQualifiedPluginContributionKey, PluginContributionIdentityV1Schema } from '@happier-dev/protocol/plugins/contribution-identity';
import { PluginJsonSchemaV2Schema } from '@happier-dev/protocol/plugins/contributions/jsonSchema';
import { InputHintsSchema, InputPathSchema, type InputHints } from '@happier-dev/protocol/inputs';
import { BUILTIN_WIDGET_DESCRIPTORS_V1, readBuiltinWidgetDescriptorV1, readWidgetDefinitionResourcesV1, type BuiltinWidgetDescriptorV1, type WidgetDefinitionV1, type WidgetInstanceV1, type WidgetDefinitionRefV1, type WidgetCandidateIdentityV1 } from '@happier-dev/protocol/widgets';
import { t } from '@/text';
import { readUsageBreakdownsInstanceTitle } from '@/components/settings/usage/usageBreakdownTitle';
import { localizeBuiltinInputHints, localizeBuiltinInputLabel } from '@/text/builtinInputPrompts';
import { isAtmosphereMomentOn, readAtmosphereMoments } from '@/components/atmosphere/atmosphereMoments';

import type { IconName } from '@/components/ui/icons/Icon';
import {
    resolvePluginSurfaceDestinationIcon,
    resolvePluginSurfaceDestinationLabel,
} from '@/components/plugins/surfaces/pluginSurfaceDestinations';
import type { SessionPluginRuntimeState } from '@/components/sessions/plugins/useSessionPluginRuntime';
import { createPluginLocalizedTextResolver, type PluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';
import type { PluginUiPolicyEvaluationContext } from '@/sync/domains/plugins/ui/policy';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import {
    readWidgetHomeDefault,
    readWidgetTargetKind,
    selectRenderableWidgetPlacements,
    selectWidgetPlacementsBySurface,
    type WidgetHomeDefault,
    type WidgetTargetKind,
} from '@/sync/domains/plugins/ui/widgetContract';

/**
 * Universal widget inventory metadata and creation candidates for every host.
 *
 * This is a projection over the canonical widget inventory selector — NOT a
 * widget catalog, store or second contribution registry. It adds exactly two
 * decisions the selector cannot make: naming a row for a person, and refusing
 * to offer a qualified identity that the mount resolver would later reject as
 * ambiguous.
 */
export type WidgetCandidate = WidgetCandidateIdentityV1 & Readonly<{
    sizeDeclaration: WidgetSizeDeclarationV1;
    /** Exactly what a placement persists; no renderer, version or generation. */
    /** `pluginId/localId`, the widget's stable qualified key. */
    key: string;
    /** The contribution's own localized title. */
    title: string;
    /** Purpose/scope copy for Gallery and setup, separate from provenance. */
    description?: string;
    /** The installed plugin's display name. */
    pluginName: string;
    /** True when another installed plugin presents the same display name. */
    sharedPluginName: boolean;
    icon: IconName;
    /** Whether Home shows it before the person chooses. */
    homeDefault: WidgetHomeDefault;
    /** Actual execution context; the gallery's physical host never chooses it. */
    target: WidgetTargetKind;
    inputs?: InputHints;
    inputSchema?: PluginJsonSchemaV2;
    publicPresentation?: WidgetPublicSnapshotPresentationV1;
    sessionInputPath?: string;
    connectedAccountPurposeBindings?: readonly WidgetConnectedAccountPurposeBindingV1[];
    resources?: readonly PluginContributionIdentityV1[];
    /** Current admitted read metadata, never serialized in an instance. */
    resourceDeclarations?: readonly PluginProjectedResourceV2[];
    connectedAccountDescriptors?: readonly ConnectedAccountUiProjectionEntryV1[];
    /** Current Account Artifact or explicit shared copy, never a private credential. */
    authoredDefinition?: WidgetDefinitionV1;
    sourceDefinition?: Extract<WidgetDefinitionRefV1, { kind: 'installed' }>;
    bodyKind?: WidgetDefinitionSummaryV1['bodyKind'];
    /** An Account definition's maker and creation time, as its provenance recorded them. */
    madeBy?: Readonly<{ author: WidgetDefinitionAuthorV1; createdAt?: number }>;
}>;

/** Whether this widget's body is an HTML page (a live picture in its frame), from its saved definition or its header. */
export function widgetCandidateHoldsHtml(candidate: WidgetCandidate | null | undefined): boolean {
    const authored = candidate?.authoredDefinition;
    return authored ? authored.body.kind === 'html' : candidate?.bodyKind === 'html';
}

/** The header supplies setup and frame metadata; the demanded mount opens the executable body. */
export function describeWidgetDefinitionSummaryV1(summary: WidgetDefinitionSummaryV1, installed?: WidgetCandidate | null): WidgetCandidate {
    return { definition: { kind: 'artifact', artifactId: summary.artifactId }, key: `artifact:${summary.artifactId}`,
        title: summary.name, pluginName: installed?.pluginName ?? summary.name, sharedPluginName: false,
        icon: installed?.icon ?? 'stack', homeDefault: 'available', target: installed?.target === 'project' ? 'project' : summary.sessionInputPath ? 'session' : 'app',
        inputs: summary.inputs, inputSchema: summary.inputSchema, bodyKind: summary.bodyKind, sizeDeclaration: summary.sizeDeclaration,
        ...(summary.publicPresentation ? { publicPresentation: summary.publicPresentation } : installed?.publicPresentation ? { publicPresentation: installed.publicPresentation } : {}),
        ...(summary.author ? { madeBy: { author: summary.author, ...(summary.createdAt !== undefined ? { createdAt: summary.createdAt } : {}) } } : {}),
        ...(summary.sessionInputPath ? { sessionInputPath: summary.sessionInputPath } : {}),
        ...(summary.connectedAccountPurposeBindings ? { connectedAccountPurposeBindings: summary.connectedAccountPurposeBindings } : {}),
        resources: installed?.resources ?? summary.resources,
        ...(installed?.resourceDeclarations ? { resourceDeclarations: installed.resourceDeclarations } : {}),
        ...(installed?.connectedAccountDescriptors ? { connectedAccountDescriptors: installed.connectedAccountDescriptors } : {}),
        ...(summary.sourceDefinition ? { sourceDefinition: summary.sourceDefinition } : {}) };
}

/** Metadata projection over one definition, with installed admission kept at its current owner. */
export function describeAuthoredWidgetDefinitionV1(definition: WidgetDefinitionV1,
    reference: Extract<WidgetDefinitionRefV1, { kind: 'artifact' | 'inline' }>,
    installed?: WidgetCandidate | null): WidgetCandidate {
    const native = definition.body.kind === 'builtin' ? readWidgetDescriptor(null, definition.body) : null;
    return { definition: reference, key: reference.kind === 'artifact' ? `artifact:${reference.artifactId}` : `inline:${definition.id}`,
        title: definition.name, pluginName: installed?.pluginName ?? definition.name, sharedPluginName: false,
        icon: native?.icon ?? installed?.icon ?? 'stack', homeDefault: 'available', target: installed?.target === 'project' ? 'project' : readWidgetInputTargetV1(definition).kind === 'session' ? 'session' : 'app',
        inputs: definition.inputs, inputSchema: definition.inputSchema, sizeDeclaration: definition.sizeDeclaration,
        ...(definition.publicPresentation ? { publicPresentation: definition.publicPresentation } : installed?.publicPresentation ? { publicPresentation: installed.publicPresentation } : {}),
        ...(definition.sessionInputPath ? { sessionInputPath: definition.sessionInputPath } : {}),
        ...(definition.connectedAccountPurposeBindings ? { connectedAccountPurposeBindings: definition.connectedAccountPurposeBindings } : {}),
        resources: installed?.resources ?? readWidgetDefinitionResourcesV1(definition), authoredDefinition: definition,
        bodyKind: definition.body.kind,
        ...(definition.provenance.author ? { madeBy: { author: definition.provenance.author,
            ...(definition.provenance.createdAt !== undefined ? { createdAt: definition.provenance.createdAt } : {}) } } : {}),
        ...(installed?.resourceDeclarations ? { resourceDeclarations: installed.resourceDeclarations } : {}),
        ...(installed?.connectedAccountDescriptors ? { connectedAccountDescriptors: installed.connectedAccountDescriptors } : {}),
        ...(definition.body.kind === 'installed' ? { sourceDefinition: definition.body } : {}),
    };
}

export function selectWidgetCandidates(
    projection: PluginUiProjectionModel | null | undefined,
    policyContext?: PluginUiPolicyEvaluationContext,
    moments: Readonly<Record<string, boolean>> = readAtmosphereMoments(),
    localize?: PluginLocalizedTextResolver,
): readonly WidgetCandidate[] {
    return Object.freeze([...selectBuiltinWidgetCandidates(moments), ...describeWidgetPlacements(projection, projection ? selectRenderableWidgetPlacements(projection, policyContext) : [], localize)]);
}

/**
 * Happier's own widgets a person may add. A built-in that is one of the Home atmosphere's moments
 * (Your Home) follows that moment's switch: off, it is not offered here, and a copy already placed
 * is not drawn (see {@link isBuiltinWidgetSwitchedOff}); the copy stays in its layout for when the
 * switch comes back on.
 */
export function selectBuiltinWidgetCandidates(moments: Readonly<Record<string, boolean>> = readAtmosphereMoments()): readonly WidgetCandidate[] {
    return BUILTIN_WIDGET_DESCRIPTORS_V1.filter(descriptor => !isBuiltinWidgetSwitchedOff(descriptor.definition, moments))
        .map(describeBuiltinWidgetCandidate);
}

/** The one decision for a built-in withdrawn by the person's own switch. */
export function isBuiltinWidgetSwitchedOff(definition: WidgetDefinitionRefV1, moments: Readonly<Record<string, boolean>>): boolean {
    return definition.kind === 'builtin' && definition.id === 'your_home' && !isAtmosphereMomentOn(moments, 'yourHome');
}

function describeBuiltinWidgetCandidate(descriptor: BuiltinWidgetDescriptorV1): WidgetCandidate {
    // A built-in with no purpose of its own has none: its title is never repeated as its description.
    const description = descriptor.descriptionKey ? t(descriptor.descriptionKey)
        : readWidgetInputTargetV1(descriptor).kind !== 'session' ? null
        : t(`widgetAdd.nativeDescriptions.${descriptor.definition.id as SessionBuiltinWidgetIdV1}`);
    return Object.freeze({ ...descriptor, title: t(descriptor.titleKey),
        inputs: descriptor.inputs ? localizeBuiltinInputHints(descriptor.inputs) : undefined,
        ...(description === null ? {} : { description }),
        pluginName: t('widgetAdd.builtIn'), sharedPluginName: false });
}

/**
 * A built-in placed with its own inputs may be called by what they make it show: two Usage Breakdowns widgets, one
 * ranking Models and one Machines, are not both "Breakdowns". Every other widget keeps its definition's title.
 */
export function describeBuiltinWidgetInstance(candidate: WidgetCandidate, instance: WidgetInstanceV1): WidgetCandidate {
    const title = readUsageBreakdownsInstanceTitle(instance);
    return title === null || title === candidate.title ? candidate : Object.freeze({ ...candidate, title });
}

type WidgetInstanceTitleContext = Readonly<{
    definitionState?: 'loading' | 'available' | 'unavailable';
    pluginUiProjection?: PluginUiProjectionModel | null;
    projectionPending?: boolean;
    /** A Session record or placement may already carry a human name while its descriptor is absent. */
    fallbackTitle?: string;
}>;
type NamedWidgetInstance = Pick<WidgetInstanceV1, 'definition' | 'displayName'> & Partial<Pick<WidgetInstanceV1, 'bindings'>>;

/**
 * One title for cards, groups, menus and summaries. Known names survive pending/failed reads;
 * only an explicitly pending name returns null for a frame's skeleton. Unreadable authored
 * definitions keep the neutral noun, while an absent plugin keeps its unavailable title.
 */
export function resolveWidgetInstanceTitle(instance: NamedWidgetInstance | null | undefined, candidate: Readonly<{ title: string }> | null | undefined, context?: WidgetInstanceTitleContext & Readonly<{ definitionState?: 'available' | 'unavailable'; projectionPending?: false }>): string;
export function resolveWidgetInstanceTitle(instance: NamedWidgetInstance | null | undefined, candidate: Readonly<{ title: string }> | null | undefined, context: WidgetInstanceTitleContext): string | null;
export function resolveWidgetInstanceTitle(instance: NamedWidgetInstance | null | undefined, candidate: Readonly<{ title: string }> | null | undefined, context?: WidgetInstanceTitleContext): string | null {
    const definition = instance?.definition;
    let displayName = instance?.displayName;
    const style = instance?.bindings?.style;
    if (displayName !== undefined && definition?.kind === 'builtin' && style?.kind === 'value') {
        const option = readBuiltinWidgetDescriptorV1(definition)?.inputs?.fields.find(field => field.path === 'style')
            ?.options?.find(option => option.value === style.value);
        // Presets retained the declaration's style name; custom names remain the person's own words.
        if (option?.label === displayName) displayName = localizeBuiltinInputLabel(option.label);
    }
    const name = displayName ?? candidate?.title
        ?? (definition?.kind === 'inline' ? definition.definition.name : undefined);
    if (name !== undefined) return name;
    if (context?.fallbackTitle !== undefined) return context.fallbackTitle;
    if (definition?.kind === 'installed') {
        const pluginName = context?.pluginUiProjection?.installedPackagesById[definition.surface.pluginId]?.displayName.trim();
        if (pluginName) return pluginName;
    }
    if (definition?.kind === 'artifact' && context?.definitionState === 'loading') return null;
    if (definition?.kind !== 'artifact' && context?.projectionPending) return null;
    const authored = !definition || definition.kind === 'artifact' || definition.kind === 'inline';
    return t(authored ? 'composerReferences.kindWidget' : 'sessionBoard.item.pluginUnavailable.title');
}

/** All Gallery/setup surfaces share descriptive copy; provenance remains available for About. */
export function describeWidgetCandidatePurpose(candidate: WidgetCandidate): string {
    return candidate.description ?? (candidate.sharedPluginName && candidate.surface
        ? `${candidate.pluginName} (${candidate.surface.pluginId})` : candidate.pluginName);
}

/** Retained declaration metadata is not admission to execute or create an instance. */
export function readWidgetDescriptor(
    projection: PluginUiProjectionModel | null | undefined,
    identity: PluginContributionIdentityV1 | WidgetDefinitionRefV1,
    localize?: PluginLocalizedTextResolver,
): WidgetCandidate | null {
    if ('kind' in identity) {
        if (identity.kind === 'builtin') {
            const descriptor = readBuiltinWidgetDescriptorV1(identity);
            return descriptor ? describeBuiltinWidgetCandidate(descriptor) : null;
        }
        if (identity.kind !== 'installed') return null;
        return readWidgetDescriptor(projection, identity.surface, localize);
    }
    const surface = identity;
    return describeWidgetPlacements(projection, projection ? selectWidgetPlacementsBySurface(projection, surface) : [], localize)[0] ?? null;
}

/**
 * How a Session host (Companion, Board) names an installed widget. The app shell publishes App and Project
 * placements only; a Session-target placement is published by the exact Session's Machine projection, so the
 * host falls back to that projection when the app shell does not name it. Execution authority still comes
 * from the configured target's own runtime (`useConfiguredWidgetTarget`), never from this naming read.
 */
export function readSessionHostWidgetDescriptor(
    projections: Readonly<{ app: PluginUiProjectionModel | null | undefined; session: PluginUiProjectionModel | null | undefined }>,
    identity: PluginContributionIdentityV1 | WidgetDefinitionRefV1,
    localize?: Readonly<{ app?: PluginLocalizedTextResolver; session?: PluginLocalizedTextResolver }>,
): WidgetCandidate | null {
    return readWidgetDescriptor(projections.app, identity, localize?.app)
        ?? (projections.session ? readWidgetDescriptor(projections.session, identity, localize?.session) : null);
}

/**
 * The plugin a widget card names as its source. A saved copy of an installed widget is named by that plugin
 * (as the installed widget itself is), not by its own name, which is already the card's title.
 */
export function readWidgetSourcePluginName(projection: PluginUiProjectionModel | null | undefined, candidate: WidgetCandidate | null | undefined): string | undefined {
    if (!candidate) return undefined;
    return (candidate.sourceDefinition ? readWidgetDescriptor(projection, candidate.sourceDefinition)?.pluginName : undefined) ?? candidate.pluginName;
}

function describeWidgetPlacements(
    projection: PluginUiProjectionModel | null | undefined,
    placements: ReturnType<typeof selectRenderableWidgetPlacements>,
    localizedText?: PluginLocalizedTextResolver,
): readonly WidgetCandidate[] {
    if (!projection) return EMPTY_CANDIDATES;

    // A duplicate qualified identity is a projection violation. The mount
    // resolver fails closed on it, so offering it here would create an item that
    // can never mount.
    const localize = localizedText ?? createPluginLocalizedTextResolver({ projection });
    const displayNameCounts = new Map<string, number>();
    for (const installed of Object.values(projection.installedPackagesById)) {
        const name = installed.displayName.trim();
        displayNameCounts.set(name, (displayNameCounts.get(name) ?? 0) + 1);
    }

    const candidates: WidgetCandidate[] = [];
    for (const placement of placements) {
        const surface = placement.binding.surface;
        const key = buildQualifiedPluginContributionKey(surface);
        if (selectWidgetPlacementsBySurface(projection, surface).length !== 1) continue;
        const installed = projection.installedPackagesById[surface.pluginId];
        // A projected contribution whose package row is absent has no truthful
        // provenance to show; the person cannot tell what they are adding.
        if (!installed) continue;
        const pluginName = installed.displayName.trim();
        const inputs = InputHintsSchema.safeParse(placement.inputs);
        const inputSchema = PluginJsonSchemaV2Schema.safeParse(placement.inputSchema);
        const sessionInputPath = InputPathSchema.safeParse(placement.sessionInputPath);
        const sizeDeclaration = WidgetSizeDeclarationV1Schema.safeParse(placement.sizeDeclaration);
        const publicPresentation = WidgetPublicSnapshotPresentationV1Schema.safeParse(placement.publicPresentation);
        if (!sizeDeclaration.success) continue;
        const purposeBindings = Array.isArray(placement.connectedAccountPurposeBindings)
            ? placement.connectedAccountPurposeBindings.map((binding) => WidgetConnectedAccountPurposeBindingV1Schema.safeParse(binding)) : [];
        const resources = Array.isArray(placement.resources)
            ? placement.resources.map(resource => PluginContributionIdentityV1Schema.safeParse(resource)) : [];
        candidates.push(Object.freeze({
            sizeDeclaration: sizeDeclaration.data,
            ...(publicPresentation.success ? { publicPresentation: publicPresentation.data } : {}),
            surface,
            key,
            title: resolvePluginSurfaceDestinationLabel(placement, localize),
            pluginName,
            sharedPluginName: (displayNameCounts.get(pluginName) ?? 0) > 1,
            icon: resolvePluginSurfaceDestinationIcon(placement),
            homeDefault: readWidgetHomeDefault(placement),
            target: readWidgetTargetKind(placement),
            ...(resources.length > 0 && resources.every(resource => resource.success && resource.data.pluginId === surface.pluginId)
                ? { resources: resources.flatMap(resource => resource.success ? [resource.data] : []),
                    resourceDeclarations: Object.values(projection.resourcesById).filter(resource => resources.some(candidate => candidate.success
                        && candidate.data.pluginId === resource.pluginId && candidate.data.localId === resource.id)) } : {}),
            ...(inputs.success ? { inputs: inputs.data } : {}),
            ...(inputSchema.success ? { inputSchema: inputSchema.data } : {}),
            ...(sessionInputPath.success ? { sessionInputPath: sessionInputPath.data } : {}),
            ...(purposeBindings.length > 0 && purposeBindings.every((binding) => binding.success)
                ? { connectedAccountPurposeBindings: purposeBindings.flatMap((binding) => binding.success ? [binding.data] : []) } : {}),
        }));
    }
    return candidates.length === 0 ? EMPTY_CANDIDATES : Object.freeze(candidates);
}

/**
 * The one executable creation projection consumed by BOTH the Board's Add
 * visibility and its picker rows. A retained catalog is useful for
 * existing-widget provenance, but it is not current authority to create a new
 * executable reference.
 */
export function selectCurrentSessionWidgetCandidates(input: Readonly<{
    runtime: SessionPluginRuntimeState;
    boardFeatureEnabled: boolean;
    canEdit: boolean;
    policyContext: PluginUiPolicyEvaluationContext;
    localize?: PluginLocalizedTextResolver;
}>): readonly WidgetCandidate[] {
    if (!input.boardFeatureEnabled || !input.canEdit) {
        return EMPTY_CANDIDATES;
    }
    if (input.runtime.phase !== 'current' || !input.runtime.interactionEnabled) return selectBuiltinWidgetCandidates();
    return selectWidgetCandidates(input.runtime.pluginUiProjection, input.policyContext, undefined, input.localize);
}

const EMPTY_CANDIDATES: readonly WidgetCandidate[] = Object.freeze([]);
