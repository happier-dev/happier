import type { ConnectedAccountUiProjectionEntryV1, PluginContributionIdentityV1, PluginJsonSchemaV2, PluginProjectedResourceV2 } from '@happier-dev/protocol';
import { WidgetConnectedAccountPurposeBindingV1Schema, WidgetSizeDeclarationV1Schema, type WidgetSizeDeclarationV1, type WidgetConnectedAccountPurposeBindingV1, type WidgetDefinitionSummaryV1 } from '@happier-dev/protocol/widgets';
import { buildQualifiedPluginContributionKey, PluginContributionIdentityV1Schema } from '@happier-dev/protocol/plugins/contribution-identity';
import { PluginJsonSchemaV2Schema } from '@happier-dev/protocol/plugins/contributions/jsonSchema';
import { InputHintsSchema, InputPathSchema, type InputHints } from '@happier-dev/protocol/inputs';
import { BUILTIN_WIDGET_DESCRIPTORS_V1, readBuiltinWidgetDescriptorV1, readWidgetDefinitionResourcesV1, type BuiltinWidgetDescriptorV1, type WidgetDefinitionV1, type WidgetDefinitionRefV1, type WidgetCandidateIdentityV1 } from '@happier-dev/protocol/widgets';
import { t } from '@/text';

import type { IconName } from '@/components/ui/icons/Icon';
import {
    resolvePluginSurfaceDestinationIcon,
    resolvePluginSurfaceDestinationLabel,
} from '@/components/plugins/surfaces/pluginSurfaceDestinations';
import type { SessionPluginRuntimeState } from '@/components/sessions/plugins/useSessionPluginRuntime';
import { createPluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';
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
}>;

/** The header supplies setup and frame metadata; the demanded mount opens the executable body. */
export function describeWidgetDefinitionSummaryV1(summary: WidgetDefinitionSummaryV1, installed?: WidgetCandidate | null): WidgetCandidate {
    return { definition: { kind: 'artifact', artifactId: summary.artifactId }, key: `artifact:${summary.artifactId}`,
        title: summary.name, pluginName: installed?.pluginName ?? summary.name, sharedPluginName: false,
        icon: installed?.icon ?? 'stack', homeDefault: 'available', target: summary.sessionInputPath ? 'session' : 'app',
        inputs: summary.inputs, inputSchema: summary.inputSchema, bodyKind: summary.bodyKind, sizeDeclaration: summary.sizeDeclaration,
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
    return { definition: reference, key: reference.kind === 'artifact' ? `artifact:${reference.artifactId}` : `inline:${definition.id}`,
        title: definition.name, pluginName: installed?.pluginName ?? definition.name, sharedPluginName: false,
        icon: installed?.icon ?? 'stack', homeDefault: 'available', target: definition.sessionInputPath ? 'session' : 'app',
        inputs: definition.inputs, inputSchema: definition.inputSchema, sizeDeclaration: definition.sizeDeclaration,
        ...(definition.sessionInputPath ? { sessionInputPath: definition.sessionInputPath } : {}),
        ...(definition.connectedAccountPurposeBindings ? { connectedAccountPurposeBindings: definition.connectedAccountPurposeBindings } : {}),
        resources: installed?.resources ?? readWidgetDefinitionResourcesV1(definition), authoredDefinition: definition,
        ...(installed?.resourceDeclarations ? { resourceDeclarations: installed.resourceDeclarations } : {}),
        ...(installed?.connectedAccountDescriptors ? { connectedAccountDescriptors: installed.connectedAccountDescriptors } : {}),
        ...(definition.body.kind === 'installed' ? { sourceDefinition: definition.body } : {}),
    };
}

export function selectWidgetCandidates(
    projection: PluginUiProjectionModel | null | undefined,
    policyContext?: PluginUiPolicyEvaluationContext,
): readonly WidgetCandidate[] {
    return Object.freeze([...selectBuiltinWidgetCandidates(), ...describeWidgetPlacements(projection, projection ? selectRenderableWidgetPlacements(projection, policyContext) : [])]);
}

export function selectBuiltinWidgetCandidates(): readonly WidgetCandidate[] {
    return BUILTIN_WIDGET_DESCRIPTORS_V1.map(describeBuiltinWidgetCandidate);
}

function describeBuiltinWidgetCandidate(descriptor: BuiltinWidgetDescriptorV1): WidgetCandidate {
    return Object.freeze({ ...descriptor, title: t(descriptor.titleKey),
        description: t(`widgetAdd.nativeDescriptions.${descriptor.definition.id}`),
        pluginName: t('widgetAdd.builtIn'), sharedPluginName: false });
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
): WidgetCandidate | null {
    if ('kind' in identity) {
        if (identity.kind === 'builtin') {
            const descriptor = readBuiltinWidgetDescriptorV1(identity);
            return descriptor ? describeBuiltinWidgetCandidate(descriptor) : null;
        }
        if (identity.kind !== 'installed') return null;
        return readWidgetDescriptor(projection, identity.surface);
    }
    const surface = identity;
    return describeWidgetPlacements(projection, projection ? selectWidgetPlacementsBySurface(projection, surface) : [])[0] ?? null;
}

function describeWidgetPlacements(
    projection: PluginUiProjectionModel | null | undefined,
    placements: ReturnType<typeof selectRenderableWidgetPlacements>,
): readonly WidgetCandidate[] {
    if (!projection) return EMPTY_CANDIDATES;

    // A duplicate qualified identity is a projection violation. The mount
    // resolver fails closed on it, so offering it here would create an item that
    // can never mount.
    const localize = createPluginLocalizedTextResolver({ projection });
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
        if (!sizeDeclaration.success) continue;
        const purposeBindings = Array.isArray(placement.connectedAccountPurposeBindings)
            ? placement.connectedAccountPurposeBindings.map((binding) => WidgetConnectedAccountPurposeBindingV1Schema.safeParse(binding)) : [];
        const resources = Array.isArray(placement.resources)
            ? placement.resources.map(resource => PluginContributionIdentityV1Schema.safeParse(resource)) : [];
        candidates.push(Object.freeze({
            sizeDeclaration: sizeDeclaration.data,
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
}>): readonly WidgetCandidate[] {
    if (!input.boardFeatureEnabled || !input.canEdit) {
        return EMPTY_CANDIDATES;
    }
    if (input.runtime.phase !== 'current' || !input.runtime.interactionEnabled) return selectBuiltinWidgetCandidates();
    return selectWidgetCandidates(input.runtime.pluginUiProjection, input.policyContext);
}

const EMPTY_CANDIDATES: readonly WidgetCandidate[] = Object.freeze([]);
