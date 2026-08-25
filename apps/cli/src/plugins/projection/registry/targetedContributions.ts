import {
    buildQualifiedPluginContributionKey,
    createPluginContributionIdentity,
    isValidPluginJsonSchemaValue,
    preparePluginJsonSchema,
    rehydratePluginContributionPointSemanticsV1,
    type JsonValue,
    type PluginActionSurfaceV2,
    type PreparedPluginJsonSchema,
    type RehydratedPluginContributionPointOperationV1,
    type RehydratedPluginContributionPointSemanticsV1,
    type RehydratedPluginContributionPointSurfaceV1,
} from '@happier-dev/protocol';
import { PLUGIN_UI_TARGETED_CONTRIBUTIONS_MAX_V1 } from '@happier-dev/protocol/plugins/ui/targetedContributions';

import type {
    AdmittedTargetedContribution,
    AdmittedTargetedContributionActionInputSelection,
    AdmittedTargetedContributionOperation,
    AdmittedTargetedContributionSurface,
    AdmittedTargetedContributionSnapshot,
    ResolvedActionContribution,
    ResolvedPluginContributionPointDeclaration,
    ResolvedTargetedPluginContributionDeclaration,
    ResolvedUiRendererV2Contribution,
} from './types';
import type { PluginCompatibilityDiagnostic } from '@/plugins/validation/diagnostics/types';
import {
    buildPluginUiRendererContributionKey,
    resolvePluginUiRendererChain,
} from './rendererChain';

type TargetPoint = Readonly<{
    declaration: ResolvedPluginContributionPointDeclaration;
    immutableGenerationId: string;
}>;

type TargetPointProtocol = ResolvedPluginContributionPointDeclaration['definition']['protocols'][number];
type TargetSemanticProjection = Readonly<{
    descriptor?: JsonValue;
    operations: readonly RehydratedPluginContributionPointOperationV1[];
    surfaces: readonly RehydratedPluginContributionPointSurfaceV1[];
}>;
type TargetSemanticSchemas = RehydratedPluginContributionPointSemanticsV1;
type PendingAdmittedTargetedContributionOperation = Omit<
    AdmittedTargetedContributionOperation,
    'targetProtocol'
>;

type Candidate = Readonly<{
    declaration: ResolvedTargetedPluginContributionDeclaration;
    target: TargetPoint;
    contributorImmutableGenerationId: string;
}>;

type AdmissionResult = Readonly<{
    diagnosticsByPluginId: Readonly<Record<string, readonly PluginCompatibilityDiagnostic[]>>;
    read(request: Readonly<{
        targetPluginId: string;
        pointId: string;
        protocol: Readonly<{ id: string; version: number }>;
    }>): AdmittedTargetedContributionSnapshot | null;
}>;

const TARGETED_CONTRIBUTION_ADMISSION_DIAGNOSTIC_CODES = [
    'target_absent',
    'point_absent',
    'protocol_unsupported',
    'required_operation_missing',
    'action_not_found',
    'action_schema_invalid',
    'action_surface_mismatch',
    'action_danger_level_mismatch',
    'descriptor_unsupported',
    'descriptor_missing',
    'descriptor_invalid',
    'required_surface_missing',
    'surface_schema_invalid',
    'renderer_not_found',
    'renderer_chain_invalid',
    'contribution_identity_conflict',
    'contributor_contribution_limit_exceeded',
    'snapshot_limit_exceeded',
    'contributor_retired',
    'target_retired',
    'target_semantics_unavailable',
    'descriptor_semantic_invalid',
    'surface_semantic_invalid',
    'point_reference_invalid',
] as const satisfies readonly PluginCompatibilityDiagnostic['code'][];

const TARGETED_CONTRIBUTION_ADMISSION_DIAGNOSTIC_CODE_SET = new Set<string>(
    TARGETED_CONTRIBUTION_ADMISSION_DIAGNOSTIC_CODES,
);

type TargetedContributionAdmissionDiagnosticCode =
    (typeof TARGETED_CONTRIBUTION_ADMISSION_DIAGNOSTIC_CODES)[number];

/**
 * A resolver-local ordering fact. It is converted directly into the canonical
 * plugin diagnostics map before crossing this module boundary.
 */
type TargetedContributionAdmissionDiagnostic = Readonly<{
    code: TargetedContributionAdmissionDiagnosticCode;
    targetPluginId: string;
    pointId: string;
    contributorPluginId: string;
    contributionId: string;
    protocol: Readonly<{ id: string; version: number }>;
    owner: 'targetPoint' | 'contributor';
}>;

function snapshotKey(targetPluginId: string, pointId: string): string {
    return `${targetPluginId}\u0000${pointId}`;
}

function admittedSnapshotKey(
    targetPluginId: string,
    pointId: string,
    protocol: Readonly<{ id: string; version: number }>,
): string {
    return `${snapshotKey(targetPluginId, pointId)}\u0000${protocol.id}\u0000${protocol.version}`;
}

function actionKey(pluginId: string, localId: string): string {
    return buildQualifiedPluginContributionKey(createPluginContributionIdentity({ pluginId, localId }));
}

function candidateSortKey(candidate: Candidate): string {
    const definition = candidate.declaration.definition;
    return [
        definition.target.pluginId,
        definition.target.pointId,
        candidate.declaration.pluginId,
        definition.id,
    ].join('\u0000');
}

function diagnosticSortKey(diagnostic: TargetedContributionAdmissionDiagnostic): string {
    return [
        diagnostic.targetPluginId,
        diagnostic.pointId,
        diagnostic.contributorPluginId,
        diagnostic.contributionId,
        diagnostic.code,
    ].join('\u0000');
}

function toDiagnostic(
    candidate: ResolvedTargetedPluginContributionDeclaration,
    code: TargetedContributionAdmissionDiagnosticCode,
    owner: TargetedContributionAdmissionDiagnostic['owner'] = 'contributor',
): TargetedContributionAdmissionDiagnostic {
    return Object.freeze({
        code,
        targetPluginId: candidate.definition.target.pluginId,
        pointId: candidate.definition.target.pointId,
        contributorPluginId: candidate.pluginId,
        contributionId: candidate.definition.id,
        protocol: Object.freeze({
            id: candidate.definition.protocol.id,
            version: candidate.definition.protocol.version,
        }),
        owner,
    });
}

function toPluginDiagnostic(
    diagnostic: TargetedContributionAdmissionDiagnostic,
): PluginCompatibilityDiagnostic {
    return Object.freeze({
        code: diagnostic.code,
        message: `Targeted contribution admission rejected (${diagnostic.code}).`,
        stage: 'normalization',
        contribution: createPluginContributionIdentity(
            diagnostic.owner === 'targetPoint'
                ? { pluginId: diagnostic.targetPluginId, localId: diagnostic.pointId }
                : { pluginId: diagnostic.contributorPluginId, localId: diagnostic.contributionId },
        ),
        details: Object.freeze({
            targetPluginId: diagnostic.targetPluginId,
            pointId: diagnostic.pointId,
            protocol: diagnostic.protocol,
        }),
    });
}

function toPluginDiagnosticsByPluginId(
    diagnostics: readonly TargetedContributionAdmissionDiagnostic[],
): Readonly<Record<string, readonly PluginCompatibilityDiagnostic[]>> {
    const diagnosticsByPluginId = new Map<string, PluginCompatibilityDiagnostic[]>();
    for (const diagnostic of diagnostics) {
        const pluginId = diagnostic.owner === 'targetPoint'
            ? diagnostic.targetPluginId
            : diagnostic.contributorPluginId;
        const current = diagnosticsByPluginId.get(pluginId) ?? [];
        current.push(toPluginDiagnostic(diagnostic));
        diagnosticsByPluginId.set(pluginId, current);
    }
    return Object.freeze(Object.fromEntries(
        [...diagnosticsByPluginId.entries()]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([pluginId, entries]) => [pluginId, Object.freeze(entries)]),
    ));
}

function hasUsableSchema(action: ResolvedActionContribution): boolean {
    const inputSchema = action.definition.inputSchema;
    const outputSchema = action.definition.outputSchema;
    return Boolean(inputSchema)
        && typeof inputSchema === 'object'
        && !Array.isArray(inputSchema)
        && Boolean(outputSchema)
        && typeof outputSchema === 'object'
        && !Array.isArray(outputSchema);
}

/**
 * Keep the one Action-form selection rule beside the admitted Action
 * definition. The UI selector publishes only a transient settlement; later
 * target execution must not trust a field path carried by that settlement.
 */
function selectedActionInputForAction(
    action: ResolvedActionContribution,
): AdmittedTargetedContributionActionInputSelection {
    const fields = action.definition.inputHints?.fields ?? [];
    if (fields.some((field) => field.widget === 'secret')) {
        return Object.freeze({ kind: 'unavailable' as const });
    }
    const connectedAccountFields = fields.filter(
        (field) => field.connectedAccountOptions === true,
    );
    if (connectedAccountFields.length === 0) {
        return Object.freeze({ kind: 'none' as const });
    }
    if (connectedAccountFields.length !== 1) {
        return Object.freeze({ kind: 'unavailable' as const });
    }
    return Object.freeze({
        kind: 'connectedAccount' as const,
        fieldPath: connectedAccountFields[0]!.path,
    });
}

function hasRequiredActionSurface(
    action: ResolvedActionContribution,
    surface: PluginActionSurfaceV2,
): boolean {
    const contributionSurfaces = action.definition.contributionSurfaces;
    return Array.isArray(contributionSurfaces) && contributionSurfaces.includes(surface);
}

function prepareDescriptorValidation(
    validationsByPointProtocol: Map<TargetPointProtocol, PreparedPluginJsonSchema | null>,
    protocol: TargetPointProtocol,
): PreparedPluginJsonSchema | null {
    const cached = validationsByPointProtocol.get(protocol);
    if (cached !== undefined || validationsByPointProtocol.has(protocol)) return cached ?? null;
    if (protocol.descriptor === undefined) return null;
    try {
        const prepared = preparePluginJsonSchema(protocol.descriptor);
        validationsByPointProtocol.set(protocol, prepared);
        return prepared;
    } catch {
        validationsByPointProtocol.set(protocol, null);
        return null;
    }
}

function surfaceValidationKey(
    candidate: Candidate,
    protocol: TargetPointProtocol,
    role: string,
): string {
    return [
        candidate.target.immutableGenerationId,
        candidate.contributorImmutableGenerationId,
        candidate.target.declaration.pluginId,
        candidate.target.declaration.definition.id,
        protocol.id,
        protocol.version,
        role,
    ].join('\u0000');
}

function prepareSurfaceValidation(
    validationsByLifecycleKey: Map<string, PreparedPluginJsonSchema | null>,
    candidate: Candidate,
    protocol: TargetPointProtocol,
    role: string,
    inputSchema: Parameters<typeof preparePluginJsonSchema>[0],
): PreparedPluginJsonSchema | null {
    const key = surfaceValidationKey(candidate, protocol, role);
    const cached = validationsByLifecycleKey.get(key);
    if (cached !== undefined || validationsByLifecycleKey.has(key)) return cached ?? null;
    try {
        const prepared = preparePluginJsonSchema(inputSchema);
        validationsByLifecycleKey.set(key, prepared);
        return prepared;
    } catch {
        validationsByLifecycleKey.set(key, null);
        return null;
    }
}

function oneDiagnostic(
    diagnostics: TargetedContributionAdmissionDiagnostic[],
    candidate: ResolvedTargetedPluginContributionDeclaration,
    code: TargetedContributionAdmissionDiagnosticCode,
): void {
    diagnostics.push(toDiagnostic(candidate, code));
}

function oneSemanticDiagnostic(
    diagnostics: TargetedContributionAdmissionDiagnostic[],
    targetDiagnosticsSeen: Set<string>,
    candidate: ResolvedTargetedPluginContributionDeclaration,
    code: Extract<TargetedContributionAdmissionDiagnosticCode,
        | 'target_semantics_unavailable'
        | 'descriptor_semantic_invalid'
        | 'surface_semantic_invalid'
        | 'point_reference_invalid'
    >,
): void {
    if (code !== 'target_semantics_unavailable') {
        diagnostics.push(toDiagnostic(candidate, code));
        return;
    }
    const targetDiagnosticKey = [
        candidate.definition.target.pluginId,
        candidate.definition.target.pointId,
        candidate.definition.protocol.id,
        candidate.definition.protocol.version,
    ].join('\u0000');
    if (targetDiagnosticsSeen.has(targetDiagnosticKey)) return;
    targetDiagnosticsSeen.add(targetDiagnosticKey);
    diagnostics.push(toDiagnostic(candidate, code, 'targetPoint'));
}

function requiresTargetSemanticProjection(protocol: TargetPointProtocol): boolean {
    return protocol.descriptor !== undefined
        || Object.keys(protocol.operations).length > 0
        || Object.keys(protocol.surfaces ?? {}).length > 0;
}

/**
 * Targeted admission is recomputed after executable current-generation
 * authority has selected a committed module. Retain unrelated diagnostics,
 * but never carry a prior semantic/currentness observation into that pass.
 */
export function dropTargetedContributionAdmissionDiagnostics(
    diagnosticsByPluginId: Readonly<Record<string, readonly PluginCompatibilityDiagnostic[]>>,
): Readonly<Record<string, readonly PluginCompatibilityDiagnostic[]>> {
    return Object.freeze(Object.fromEntries(
        Object.entries(diagnosticsByPluginId).flatMap(([pluginId, diagnostics]) => {
            const retained = diagnostics.filter((diagnostic) => (
                !TARGETED_CONTRIBUTION_ADMISSION_DIAGNOSTIC_CODE_SET.has(diagnostic.code)
            ));
            return retained.length > 0
                ? [[pluginId, Object.freeze(retained)] as const]
                : [];
        }),
    ));
}

/**
 * Cold deterministic targeted-contribution admission. This reads only
 * normalized declarations and committed immutable generations: it neither
 * starts an activation target nor touches a runtime implementation.
 */
export function resolveAdmittedTargetedContributions(params: Readonly<{
    pluginContributionPoints: readonly ResolvedPluginContributionPointDeclaration[];
    targetedPluginContributions: readonly ResolvedTargetedPluginContributionDeclaration[];
    actions: readonly ResolvedActionContribution[];
    uiRenderersV2: readonly ResolvedUiRendererV2Contribution[];
    immutableGenerationIdsByPluginId: Readonly<Record<string, string>>;
}>): AdmissionResult {
    const diagnostics: TargetedContributionAdmissionDiagnostic[] = [];
    const pointsByKey = new Map<string, TargetPoint>();
    for (const declaration of [...params.pluginContributionPoints].sort((left, right) => (
        snapshotKey(left.pluginId, left.definition.id).localeCompare(snapshotKey(right.pluginId, right.definition.id))
    ))) {
        const immutableGenerationId = params.immutableGenerationIdsByPluginId[declaration.pluginId];
        if (!immutableGenerationId) continue;
        const key = snapshotKey(declaration.pluginId, declaration.definition.id);
        if (!pointsByKey.has(key)) {
            pointsByKey.set(key, Object.freeze({ declaration, immutableGenerationId }));
        }
    }

    const declaredTargetPluginIds = new Set(params.pluginContributionPoints.map((point) => point.pluginId));
    const actionsByQualifiedId = new Map<string, ResolvedActionContribution>();
    for (const action of params.actions) {
        if (!action.pluginId) continue;
        const key = actionKey(action.pluginId, action.definition.id);
        if (!actionsByQualifiedId.has(key)) actionsByQualifiedId.set(key, action);
    }
    const renderersByQualifiedId = new Map<string, ResolvedUiRendererV2Contribution>();
    for (const renderer of params.uiRenderersV2) {
        const key = buildPluginUiRendererContributionKey(renderer.pluginId, renderer.definition.id);
        if (!renderersByQualifiedId.has(key)) renderersByQualifiedId.set(key, renderer);
    }

    const candidates: Candidate[] = [];
    for (const declaration of [...params.targetedPluginContributions].sort((left, right) => (
        [
            left.definition.target.pluginId,
            left.definition.target.pointId,
            left.pluginId,
            left.definition.id,
        ].join('\u0000').localeCompare([
            right.definition.target.pluginId,
            right.definition.target.pointId,
            right.pluginId,
            right.definition.id,
        ].join('\u0000'))
    ))) {
        const targetPluginId = declaration.definition.target.pluginId;
        const pointId = declaration.definition.target.pointId;
        const point = pointsByKey.get(snapshotKey(targetPluginId, pointId));
        if (!point) {
            const targetGeneration = params.immutableGenerationIdsByPluginId[targetPluginId];
            oneDiagnostic(
                diagnostics,
                declaration,
                targetGeneration
                    ? 'point_absent'
                    : declaredTargetPluginIds.has(targetPluginId)
                        ? 'target_retired'
                        : 'target_absent',
            );
            continue;
        }
        const contributorImmutableGenerationId = params.immutableGenerationIdsByPluginId[declaration.pluginId];
        if (!contributorImmutableGenerationId) {
            oneDiagnostic(diagnostics, declaration, 'contributor_retired');
            continue;
        }
        candidates.push(Object.freeze({ declaration, target: point, contributorImmutableGenerationId }));
    }

    const conflictingCandidateKeys = new Set<string>();
    const candidateIdentityCounts = new Map<string, number>();
    for (const candidate of candidates) {
        const definition = candidate.declaration.definition;
        const identity = [
            definition.target.pluginId,
            definition.target.pointId,
            candidate.declaration.pluginId,
            definition.id,
        ].join('\u0000');
        candidateIdentityCounts.set(identity, (candidateIdentityCounts.get(identity) ?? 0) + 1);
    }
    for (const [identity, count] of candidateIdentityCounts) {
        if (count > 1) conflictingCandidateKeys.add(identity);
    }

    const candidatesByContributorPoint = new Map<string, Candidate[]>();
    for (const candidate of candidates) {
        const definition = candidate.declaration.definition;
        const key = [
            definition.target.pluginId,
            definition.target.pointId,
            candidate.declaration.pluginId,
        ].join('\u0000');
        const group = candidatesByContributorPoint.get(key) ?? [];
        group.push(candidate);
        candidatesByContributorPoint.set(key, group);
    }
    const overLimitCandidateKeys = new Set<string>();
    for (const group of candidatesByContributorPoint.values()) {
        const limit = group[0]!.target.declaration.definition.maxContributionsPerContributor;
        if (limit === undefined || group.length <= limit) continue;
        for (const candidate of group) overLimitCandidateKeys.add(candidateSortKey(candidate));
    }

    const admittedByPoint = new Map<string, AdmittedTargetedContribution[]>();
    // This resolver owns one immutable point/protocol generation. Retain its
    // descriptor validator locally so every candidate uses the same compiled
    // schema without creating a cross-generation cache or second lifecycle.
    const descriptorValidationsByPointProtocol = new Map<TargetPointProtocol, PreparedPluginJsonSchema | null>();
    // A surface input schema is owned by the exact target/contributor point
    // lifecycle, not an individual contribution identity. Retain its prepared
    // form only for this cold resolver invocation so a generation replacement
    // necessarily receives fresh validation.
    const surfaceValidationsByLifecycleKey = new Map<string, PreparedPluginJsonSchema | null>();
    // Exact Protocol-emitted parser pairs are rehydrated once for the target
    // protocol in this cold resolution pass. A generation replacement creates
    // a fresh point object and therefore a fresh parser set.
    const semanticSchemasByPointProtocol = new Map<TargetPointProtocol, TargetSemanticSchemas | null>();
    const targetSemanticDiagnosticsSeen = new Set<string>();
    for (const candidate of candidates) {
        const definition = candidate.declaration.definition;
        const targetKey = snapshotKey(definition.target.pluginId, definition.target.pointId);
        const identity = [
            definition.target.pluginId,
            definition.target.pointId,
            candidate.declaration.pluginId,
            definition.id,
        ].join('\u0000');
        if (conflictingCandidateKeys.has(identity)) {
            oneDiagnostic(diagnostics, candidate.declaration, 'contribution_identity_conflict');
            continue;
        }
        if (overLimitCandidateKeys.has(candidateSortKey(candidate))) {
            oneDiagnostic(diagnostics, candidate.declaration, 'contributor_contribution_limit_exceeded');
            continue;
        }
        const pointProtocol = candidate.target.declaration.definition.protocols.find((protocol) => (
            protocol.id === definition.protocol.id && protocol.version === definition.protocol.version
        ));
        if (!pointProtocol) {
            oneDiagnostic(diagnostics, candidate.declaration, 'protocol_unsupported');
            continue;
        }
        const needsTargetSemanticProjection = requiresTargetSemanticProjection(pointProtocol);
        let semanticSchemas: TargetSemanticSchemas | undefined;
        if (needsTargetSemanticProjection) {
            const cached = semanticSchemasByPointProtocol.get(pointProtocol);
            if (cached !== undefined || semanticSchemasByPointProtocol.has(pointProtocol)) {
                semanticSchemas = cached ?? undefined;
            } else {
                semanticSchemas = rehydratePluginContributionPointSemanticsV1(pointProtocol) ?? undefined;
                semanticSchemasByPointProtocol.set(pointProtocol, semanticSchemas ?? null);
            }
            if (!semanticSchemas) {
                oneSemanticDiagnostic(
                    diagnostics,
                    targetSemanticDiagnosticsSeen,
                    candidate.declaration,
                    'target_semantics_unavailable',
                );
                continue;
            }
        }
        if (definition.descriptor !== undefined) {
            if (pointProtocol.descriptor === undefined) {
                oneDiagnostic(diagnostics, candidate.declaration, 'descriptor_unsupported');
                continue;
            }
            const descriptorValidation = prepareDescriptorValidation(
                descriptorValidationsByPointProtocol,
                pointProtocol,
            );
            if (!descriptorValidation
                || !isValidPluginJsonSchemaValue(descriptorValidation.validate, definition.descriptor)) {
                oneDiagnostic(diagnostics, candidate.declaration, 'descriptor_invalid');
                continue;
            }
        } else if (pointProtocol.descriptor !== undefined) {
            // Declaring a descriptor schema IS the requirement: the protocol
            // carries no optionality flag, so an omitted descriptor is as
            // inadmissible as a missing required operation role.
            oneDiagnostic(diagnostics, candidate.declaration, 'descriptor_missing');
            continue;
        }
        const knownRoles = Object.keys(pointProtocol.operations).sort();
        const requiredRole = knownRoles.find((role) => (
            pointProtocol.operations[role]!.required && definition.operations[role] === undefined
        ));
        if (requiredRole !== undefined) {
            oneDiagnostic(diagnostics, candidate.declaration, 'required_operation_missing');
            continue;
        }
        const knownSurfaceRoles = Object.keys(pointProtocol.surfaces ?? {}).sort();
        const requiredSurfaceRole = knownSurfaceRoles.find((role) => (
            pointProtocol.surfaces?.[role]?.required && definition.surfaces?.[role] === undefined
        ));
        if (requiredSurfaceRole !== undefined) {
            oneDiagnostic(diagnostics, candidate.declaration, 'required_surface_missing');
            continue;
        }
        const contributor = Object.freeze({
            pluginId: candidate.declaration.pluginId,
            contributionId: definition.id,
            immutableGenerationId: candidate.contributorImmutableGenerationId,
        });
        let failure: TargetedContributionAdmissionDiagnosticCode | undefined;
        const operations: PendingAdmittedTargetedContributionOperation[] = [];
        for (const role of Object.keys(definition.operations).sort()) {
            const localId = definition.operations[role]!;
            const action = actionsByQualifiedId.get(actionKey(candidate.declaration.pluginId, localId));
            if (!action) {
                failure = 'action_not_found';
                break;
            }
            if (!hasUsableSchema(action)) {
                failure = 'action_schema_invalid';
                break;
            }
            // An additive role from a newer contributor has no authority on
            // an older target, but its reference still belongs to the
            // contributor's structurally admitted declaration.
            const requirement = pointProtocol.operations[role];
            if (!requirement) continue;
            if (!hasRequiredActionSurface(action, requirement.action.surface)) {
                failure = 'action_surface_mismatch';
                break;
            }
            if (action.definition.dangerLevel !== requirement.action.dangerLevel) {
                failure = 'action_danger_level_mismatch';
                break;
            }
            operations.push(Object.freeze({
                role,
                action: Object.freeze({ pluginId: candidate.declaration.pluginId, localId }),
                contributor,
                selectedActionInput: selectedActionInputForAction(action),
            }));
        }
        const surfaces: AdmittedTargetedContributionSurface[] = [];
        if (!failure) {
            for (const role of Object.keys(definition.surfaces ?? {}).sort()) {
                const binding = definition.surfaces![role]!;
                const chain = resolvePluginUiRendererChain({
                    binding,
                    contributorPluginId: candidate.declaration.pluginId,
                    renderersByQualifiedId,
                });
                if (!chain.ok) {
                    failure = chain.code;
                    break;
                }
                // As above, validate an additive binding against its owning
                // contributor first, then omit it where the older target has
                // no role contract to project.
                const requirement = pointProtocol.surfaces?.[role];
                if (!requirement) continue;
                const inputValidation = prepareSurfaceValidation(
                    surfaceValidationsByLifecycleKey,
                    candidate,
                    pointProtocol,
                    role,
                    requirement.inputSchema,
                );
                if (!inputValidation) {
                    failure = 'surface_schema_invalid';
                    break;
                }
                surfaces.push(Object.freeze({
                    role,
                    inputSchema: inputValidation.jsonSchema,
                    inputValidation,
                    presentation: requirement.presentation,
                    rendererChain: chain.rendererChain,
                    contributor,
                }));
            }
        }
        if (failure) {
            oneDiagnostic(diagnostics, candidate.declaration, failure);
            continue;
        }
        let semanticProjection: TargetSemanticProjection | undefined;
        if (needsTargetSemanticProjection) {
            let descriptor: JsonValue | undefined;
            if (definition.descriptor !== undefined) {
                const parsed = semanticSchemas?.descriptor?.safeParse(definition.descriptor);
                if (!parsed?.success) {
                    oneSemanticDiagnostic(
                        diagnostics,
                        targetSemanticDiagnosticsSeen,
                        candidate.declaration,
                        'descriptor_semantic_invalid',
                    );
                    continue;
                }
                descriptor = parsed.data;
            }
            const surfaceRoles = new Set(surfaces.map((surface) => surface.role));
            const declaredSurfaceRoles = new Map(
                semanticSchemas?.surfaces.map((surface) => [surface.role, surface]) ?? [],
            );
            if (surfaces.some((surface) => (
                declaredSurfaceRoles.get(surface.role)?.presentation !== surface.presentation
            ))) {
                oneSemanticDiagnostic(
                    diagnostics,
                    targetSemanticDiagnosticsSeen,
                    candidate.declaration,
                    'surface_semantic_invalid',
                );
                continue;
            }
            semanticProjection = Object.freeze({
                ...(descriptor === undefined ? {} : { descriptor }),
                operations: semanticSchemas?.operations ?? [],
                surfaces: (semanticSchemas?.surfaces ?? []).filter((surface) => surfaceRoles.has(surface.role)),
            });
        }
        const semanticOperationsByRole = semanticProjection === undefined
            ? undefined
            : new Map(semanticProjection.operations.map((operation) => [operation.role, operation]));
        const admittedOperations: AdmittedTargetedContributionOperation[] = [];
        for (const operation of operations) {
            const targetProtocol = semanticOperationsByRole?.get(operation.role);
            if (!targetProtocol) {
                oneSemanticDiagnostic(
                    diagnostics,
                    targetSemanticDiagnosticsSeen,
                    candidate.declaration,
                    'target_semantics_unavailable',
                );
                failure = 'target_semantics_unavailable';
                break;
            }
            admittedOperations.push(Object.freeze({ ...operation, targetProtocol }));
        }
        if (failure) continue;
        const semanticSurfaceRoles = semanticProjection === undefined
            ? undefined
            : new Set(semanticProjection.surfaces.map((surface) => surface.role));
        const admitted: AdmittedTargetedContribution = Object.freeze({
            contributor,
            protocol: Object.freeze({ id: definition.protocol.id, version: definition.protocol.version }),
            ...(semanticProjection?.descriptor === undefined
                ? {}
                : { descriptor: semanticProjection.descriptor }),
            operations: Object.freeze(admittedOperations),
            surfaces: Object.freeze(semanticSurfaceRoles === undefined
                ? surfaces
                : surfaces.filter((surface) => semanticSurfaceRoles.has(surface.role))),
        });
        const active = admittedByPoint.get(targetKey) ?? [];
        active.push(admitted);
        admittedByPoint.set(targetKey, active);
    }

    const snapshots = new Map<string, AdmittedTargetedContributionSnapshot>();
    for (const [key, point] of pointsByKey) {
        const active = [...(admittedByPoint.get(key) ?? [])].sort((left, right) => (
            `${left.contributor.pluginId}\u0000${left.contributor.contributionId}`.localeCompare(
                `${right.contributor.pluginId}\u0000${right.contributor.contributionId}`,
            )
        ));
        const retained = active.slice(0, PLUGIN_UI_TARGETED_CONTRIBUTIONS_MAX_V1);
        for (const excess of active.slice(PLUGIN_UI_TARGETED_CONTRIBUTIONS_MAX_V1)) {
            const declaration = params.targetedPluginContributions.find((candidate) => (
                candidate.pluginId === excess.contributor.pluginId
                && candidate.definition.id === excess.contributor.contributionId
                && candidate.definition.target.pluginId === point.declaration.pluginId
                && candidate.definition.target.pointId === point.declaration.definition.id
            ));
            if (declaration) oneDiagnostic(diagnostics, declaration, 'snapshot_limit_exceeded');
        }
        for (const targetProtocol of point.declaration.definition.protocols) {
            const protocol = Object.freeze({ id: targetProtocol.id, version: targetProtocol.version });
            snapshots.set(admittedSnapshotKey(
                point.declaration.pluginId,
                point.declaration.definition.id,
                protocol,
            ), Object.freeze({
                target: Object.freeze({
                    pluginId: point.declaration.pluginId,
                    pointId: point.declaration.definition.id,
                    immutableGenerationId: point.immutableGenerationId,
                }),
                contributions: Object.freeze(retained.filter((contribution) => (
                    contribution.protocol.id === protocol.id
                    && contribution.protocol.version === protocol.version
                ))),
            }));
        }
    }

    const sortedDiagnostics = Object.freeze([...diagnostics].sort((left, right) => (
        diagnosticSortKey(left).localeCompare(diagnosticSortKey(right))
    )));
    return Object.freeze({
        diagnosticsByPluginId: toPluginDiagnosticsByPluginId(sortedDiagnostics),
        read(request) {
            return snapshots.get(admittedSnapshotKey(
                request.targetPluginId,
                request.pointId,
                request.protocol,
            )) ?? null;
        },
    });
}
