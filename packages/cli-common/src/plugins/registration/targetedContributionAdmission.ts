/** @moduleRealm any */
import type { PluginContributionPointV1, PluginTargetedContributionV1, PluginActionContributionV2, PluginContributionIdentityV1, PluginSourceCustodyV1 } from '@happier-dev/protocol';
import type { ParsedPluginManifestV2 } from '@happier-dev/protocol/plugins/manifest';
import { buildPluginUiRendererContributionKey, resolvePluginUiRendererChain } from './targetedContributionRendererChain.js';
import type { AdmittedTargetedContribution, AdmittedTargetedContributionActionInputSelection, AdmittedTargetedContributionOperation, AdmittedTargetedContributionSurface, AdmittedTargetedContributionSnapshot } from './targetedContributionTypes.js';
import { buildQualifiedPluginContributionKey, createPluginContributionIdentity } from '@happier-dev/protocol/plugins/contribution-identity';
import { isValidPluginJsonSchemaValue } from '@happier-dev/protocol/plugins/actions/protocol-composable-schema';
import { preparePluginJsonSchema } from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import { rehydratePluginContributionPointSemanticsV1 } from '@happier-dev/protocol/plugins/contributions/targeted';
import type { JsonValue, PluginActionSurfaceV2, PreparedPluginJsonSchema, RehydratedPluginContributionPointOperationV1, RehydratedPluginContributionPointSemanticsV1, RehydratedPluginContributionPointSurfaceV1 } from '@happier-dev/protocol';
import { PLUGIN_UI_TARGETED_CONTRIBUTIONS_MAX_V1 } from '@happier-dev/protocol/plugins/ui/targetedContributions';
import { pluginSourceCustodyV1Equal } from '@happier-dev/protocol/plugins/runtime/sourceCustody';

type TargetedOperationSource = Readonly<{ occurrenceId: string; localId: string; unavailable?: true }>;

/** Role declarations cap consequences; the Action still owns its approval default. */
const ACTION_DANGER_ORDER = {
    safe: 0, writesLocal: 1, writesRemote: 2, externalSideEffect: 3, destructive: 4,
} as const satisfies Record<PluginActionContributionV2['dangerLevel'], number>;

function actionDangerFitsRequirement(
    actual: PluginActionContributionV2['dangerLevel'],
    required: PluginActionContributionV2['dangerLevel'],
): boolean {
    return ACTION_DANGER_ORDER[actual] <= ACTION_DANGER_ORDER[required];
}
export type TargetedContributionPointDeclaration = Readonly<{ pluginId: string; definition: PluginContributionPointV1; occurrenceId?: string }>;
export type TargetedContributionDeclaration = Readonly<{
    pluginId: string; definition: PluginTargetedContributionV1; occurrenceId?: string;
    operationSourcesByRole?: Readonly<Record<string, TargetedOperationSource>>;
}>;
export type TargetedContributionActionDeclaration = Readonly<{
    pluginId?: string;
    occurrenceId?: string;
    definition: Readonly<{
        id: string;
        inputSchema?: unknown;
        outputSchema?: unknown;
        inputHints?: Readonly<{ fields?: readonly Readonly<{ path: string; widget: string; connectedAccountOptions?: boolean }>[] }> | null;
        connectedAccountPurposeBindings?: PluginActionContributionV2['connectedAccountPurposeBindings'];
        contributionSurfaces?: readonly PluginActionSurfaceV2[];
        dangerLevel: PluginActionContributionV2['dangerLevel'];
    }>;
}>;
export type TargetedContributionRendererDeclaration = Readonly<{
    pluginId: string;
    occurrenceId?: string;
    identity: PluginContributionIdentityV1;
    definition: Readonly<{ id: string }>;
}>;
export type TargetedContributionCompatibilityDiagnostic = Readonly<{
    code: TargetedContributionAdmissionDiagnosticCode;
    message: string;
    stage: 'normalization';
    contribution: PluginContributionIdentityV1;
    details: JsonValue;
}>;

/** Current host-admitted release or Machine declarations; this grants no execution authority itself. */
export type TargetedContributionManifestDeclaration = Readonly<{
    manifest: Readonly<{
        id: ParsedPluginManifestV2['id'];
        contributes: Readonly<
            Pick<ParsedPluginManifestV2['contributes'], 'actions' | 'pluginContributionPoints' | 'targetedPluginContributions'> & {
                ui: Pick<ParsedPluginManifestV2['contributes']['ui'], 'renderers'>;
            }
        >;
    }>;
    occurrenceId: string;
    sourceCustody: PluginSourceCustodyV1;
    /** Selected target-operation custody, distinct from this declaration's own renderer/Action source. */
    targetSourceCustody?: PluginSourceCustodyV1;
    /** Host-selected physical role sources, never authored manifest data. */
    operationSourcesByContributionId?: Readonly<Record<string, Readonly<Record<string, TargetedOperationSource>>>>;
}>;

function readBoundTargetedActionPlacement(
    row: TargetedContributionManifestDeclaration,
    contribution: PluginTargetedContributionV1,
): 'account' | 'machine' | 'mixed' | 'none' {
    const actionIds = new Set(Object.values(contribution.operations));
    let account = false;
    let machine = false;
    for (const action of row.manifest.contributes.actions) {
        if (!actionIds.has(action.id)) continue;
        if (action.execution.target === 'account') account = true;
        else machine = true;
    }
    return account ? (machine ? 'mixed' : 'account') : (machine ? 'machine' : 'none');
}

/** Combines current host declaration snapshots without creating a second catalog. */
export function mergeTargetedContributionManifestDeclarations(params: Readonly<{
    targetPluginId: string;
    accountDeclarations: readonly TargetedContributionManifestDeclaration[];
    machineDeclarations: readonly TargetedContributionManifestDeclaration[];
}>): readonly TargetedContributionManifestDeclaration[] {
    const machineRows = new Map(params.machineDeclarations.map((row) => [row.manifest.id, row]));
    const accountIds = new Set(params.accountDeclarations.map((row) => row.manifest.id));
    const machineContributions = new Map<string, Map<string, PluginTargetedContributionV1>>();
    const usedMachineRows = new Set<string>();
    const rows: TargetedContributionManifestDeclaration[] = [];
    for (const row of params.accountDeclarations) {
        const machine = machineRows.get(row.manifest.id);
        // Portable target selections fence the selected Machine, but the
        // Account declaration still owns its self-contributed Actions/renderers.
        // Rebranding that source would make its own Account child look like a
        // Machine child even though its captured Account custody never changed.
        const targetRow = row.manifest.id === params.targetPluginId && machine && !pluginSourceCustodyV1Equal(machine.sourceCustody, row.sourceCustody)
            ? { ...row, targetSourceCustody: machine.sourceCustody } : row;
        const retained: PluginTargetedContributionV1[] = [];
        const sources: Record<string, Record<string, TargetedOperationSource>> = {};
        for (const contribution of row.manifest.contributes.targetedPluginContributions) {
            if (contribution.target.pluginId !== params.targetPluginId || !machine) {
                // Descriptive Machine-only declarations survive without a
                // selected Machine; the Action dispatcher owns Machine-required.
                retained.push(contribution);
                continue;
            }
            const current = machine.manifest.contributes.targetedPluginContributions.find((entry) => (
                entry.id === contribution.id && entry.target.pluginId === contribution.target.pluginId
                && entry.target.pointId === contribution.target.pointId
                && entry.protocol.id === contribution.protocol.id && entry.protocol.version === contribution.protocol.version
            ));
            const roleSources: Record<string, TargetedOperationSource> = {};
            for (const [role, localId] of Object.entries(contribution.operations)) {
                const action = row.manifest.contributes.actions.find((entry) => entry.id === localId);
                if (!action || action.execution.target === 'account') continue;
                const currentLocalId = current?.operations[role];
                const currentAction = machine.manifest.contributes.actions.find((entry) => entry.id === currentLocalId);
                roleSources[role] = currentAction && currentAction.execution.target !== 'account'
                    ? { occurrenceId: machine.occurrenceId, localId: currentAction.id }
                    : { occurrenceId: row.occurrenceId, localId, unavailable: true };
            }
            if (current && readBoundTargetedActionPlacement(row, contribution) === 'machine'
                && readBoundTargetedActionPlacement(machine, current) === 'machine'
                && Object.values(roleSources).every((source) => !source.unavailable)) {
                const selected = machineContributions.get(row.manifest.id) ?? new Map();
                selected.set(current.id, current);
                machineContributions.set(row.manifest.id, selected);
                usedMachineRows.add(row.manifest.id);
                continue;
            }
            retained.push(contribution);
            if (Object.keys(roleSources).length > 0) {
                sources[contribution.id] = roleSources;
                if (Object.values(roleSources).some((source) => source.occurrenceId === machine.occurrenceId)) usedMachineRows.add(row.manifest.id);
            }
        }
        if (retained.length > 0 || row.manifest.id === params.targetPluginId
            || row.manifest.contributes.pluginContributionPoints.length > 0
            || row.manifest.contributes.targetedPluginContributions.length === 0) {
            rows.push(retained.length === row.manifest.contributes.targetedPluginContributions.length && Object.keys(sources).length === 0
                ? targetRow : { ...targetRow, manifest: { ...row.manifest, contributes: { ...row.manifest.contributes,
                    targetedPluginContributions: retained,
                } }, ...(Object.keys(sources).length === 0 ? {} : { operationSourcesByContributionId: sources }) });
        }
    }
    for (const machine of params.machineDeclarations) {
        const selected = machineContributions.get(machine.manifest.id);
        const contributions = accountIds.has(machine.manifest.id) ? [...(selected?.values() ?? [])]
            : machine.manifest.contributes.targetedPluginContributions.filter((entry) => entry.target.pluginId === params.targetPluginId);
        if (contributions.length === 0 && !usedMachineRows.has(machine.manifest.id)) continue;
        const sources: Record<string, Record<string, TargetedOperationSource>> = {};
        if (!accountIds.has(machine.manifest.id)) {
            for (const contribution of contributions) {
                const roleSources: Record<string, TargetedOperationSource> = {};
                for (const [role, localId] of Object.entries(contribution.operations)) {
                    if (machine.manifest.contributes.actions.find((action) => action.id === localId)?.execution.target !== 'account') continue;
                    roleSources[role] = { occurrenceId: machine.occurrenceId, localId, unavailable: true };
                }
                if (Object.keys(roleSources).length > 0) sources[contribution.id] = roleSources;
            }
        }
        rows.push({ ...machine, manifest: { ...machine.manifest, contributes: { ...machine.manifest.contributes,
            pluginContributionPoints: [], targetedPluginContributions: contributions,
        } }, ...(Object.keys(sources).length === 0 ? {} : { operationSourcesByContributionId: sources }) });
    }
    return rows;
}

/** The canonical targeted-admission projection of a normalized Action declaration. */
export function projectTargetedContributionActionDefinition(definition: PluginActionContributionV2): Readonly<
    Pick<PluginActionContributionV2, 'id' | 'inputSchema' | 'inputHints' | 'connectedAccountPurposeBindings' | 'dangerLevel'> & {
        outputSchema?: PluginActionContributionV2['resultSchema'];
        contributionSurfaces: PluginActionContributionV2['surfaces'];
    }
> {
    return {
        id: definition.id,
        ...(definition.inputSchema === undefined ? {} : { inputSchema: definition.inputSchema }),
        ...(definition.resultSchema === undefined ? {} : { outputSchema: definition.resultSchema }),
        ...(definition.inputHints === undefined ? {} : { inputHints: definition.inputHints }),
        ...(definition.connectedAccountPurposeBindings === undefined ? {} : {
            connectedAccountPurposeBindings: definition.connectedAccountPurposeBindings,
        }),
        contributionSurfaces: definition.surfaces,
        dangerLevel: definition.dangerLevel,
    };
}

/** Projects already-admitted manifests into the existing cold admission owner without retaining a catalog. */
export function resolveManifestTargetedContributions(declarations: readonly TargetedContributionManifestDeclaration[]): TargetedContributionAdmissionResult {
    return resolveAdmittedTargetedContributions({
        pluginContributionPoints: declarations.flatMap(({ manifest, occurrenceId }) => (
            manifest.contributes.pluginContributionPoints.map((definition) => ({ pluginId: manifest.id, definition, occurrenceId }))
        )),
        targetedPluginContributions: declarations.flatMap(({ manifest, occurrenceId, operationSourcesByContributionId }) => (
            manifest.contributes.targetedPluginContributions.map((definition) => ({ pluginId: manifest.id, definition, occurrenceId,
                ...(operationSourcesByContributionId && Object.hasOwn(operationSourcesByContributionId, definition.id)
                    ? { operationSourcesByRole: operationSourcesByContributionId[definition.id] } : {}),
            }))
        )),
        actions: declarations.flatMap(({ manifest, occurrenceId }) => (
            manifest.contributes.actions.map((definition) => ({
                pluginId: manifest.id,
                occurrenceId,
                definition: projectTargetedContributionActionDefinition(definition),
            }))
        )),
        uiRenderersV2: declarations.flatMap(({ manifest, occurrenceId }) => (
            manifest.contributes.ui.renderers.map((definition) => ({
                pluginId: manifest.id,
                occurrenceId,
                identity: createPluginContributionIdentity({ pluginId: manifest.id, localId: definition.id }),
                definition,
            }))
        )),
        occurrenceIdsByPluginId: Object.fromEntries(declarations.map((row) => [row.manifest.id, row.occurrenceId])),
    });
}

type TargetPoint = Readonly<{
    declaration: TargetedContributionPointDeclaration;
    occurrenceId: string;
}>;

type TargetPointProtocol = TargetedContributionPointDeclaration['definition']['protocols'][number];
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
type PendingAdmittedTargetedContributionSurface<TRenderer extends TargetedContributionRendererDeclaration> = Omit<
    AdmittedTargetedContributionSurface<TRenderer>,
    'targetProtocol'
>;

type Candidate = Readonly<{
    declaration: TargetedContributionDeclaration;
    target: TargetPoint;
    contributorOccurrenceId: string;
}>;

export type TargetedContributionAdmissionResult<TRenderer extends TargetedContributionRendererDeclaration = TargetedContributionRendererDeclaration> = Readonly<{
    diagnosticsByPluginId: Readonly<Record<string, readonly TargetedContributionCompatibilityDiagnostic[]>>;
    read(request: Readonly<{
        targetPluginId: string;
        pointId: string;
        protocol: Readonly<{ id: string; version: number }>;
    }>): AdmittedTargetedContributionSnapshot<TRenderer> | null;
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
    'contribution_identity_conflict',
    'contributor_contribution_limit_exceeded',
    'snapshot_limit_exceeded',
    'contributor_retired',
    'target_retired',
    'target_semantics_unavailable',
    'descriptor_semantic_invalid',
    'surface_semantic_invalid',
] as const;

const TARGETED_CONTRIBUTION_ADMISSION_DIAGNOSTIC_CODE_SET = new Set<string>(
    TARGETED_CONTRIBUTION_ADMISSION_DIAGNOSTIC_CODES,
);

export type TargetedContributionAdmissionDiagnosticCode =
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

function occurrenceKey(pluginId: string, occurrenceId: string): string {
    return `${pluginId}\u0000${occurrenceId}`;
}

function scopedActionKey(pluginId: string, localId: string, occurrenceId: string): string {
    return `${actionKey(pluginId, localId)}\u0000${occurrenceId}`;
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
    candidate: TargetedContributionDeclaration,
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
): TargetedContributionCompatibilityDiagnostic {
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
            target: Object.freeze({
                pluginId: diagnostic.targetPluginId,
                pointId: diagnostic.pointId,
            }),
            contributor: Object.freeze({
                pluginId: diagnostic.contributorPluginId,
                contributionId: diagnostic.contributionId,
            }),
            protocol: diagnostic.protocol,
            reason: diagnostic.code,
        }),
    });
}

function toPluginDiagnosticsByPluginId(
    diagnostics: readonly TargetedContributionAdmissionDiagnostic[],
): Readonly<Record<string, readonly TargetedContributionCompatibilityDiagnostic[]>> {
    const diagnosticsByPluginId = new Map<string, TargetedContributionCompatibilityDiagnostic[]>();
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

function hasUsableSchema(action: TargetedContributionActionDeclaration): boolean {
    const inputSchema = action.definition.inputSchema;
    const outputSchema = action.definition.outputSchema;
    // An absent author input contract is unconstrained, not an unusable
    // contributor-defined input. Normalization must not fabricate a schema.
    return (inputSchema === undefined || (Boolean(inputSchema)
        && typeof inputSchema === 'object'
        && !Array.isArray(inputSchema)))
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
    action: TargetedContributionActionDeclaration,
): AdmittedTargetedContributionActionInputSelection {
    const fields = action.definition.inputHints?.fields ?? [];
    if (fields.some((field) => field.widget === 'secret')) {
        return Object.freeze({ kind: 'unavailable' as const });
    }
    // A transport Action can bind a credential without exposing a form. The
    // semantic binding and any form hint must agree on one Account field.
    const accountPaths = [...new Set([
        ...fields.filter((field) => field.connectedAccountOptions === true).map((field) => field.path),
        ...(action.definition.connectedAccountPurposeBindings ?? []).map((binding) => binding.path),
    ])];
    if (accountPaths.length === 0) {
        return Object.freeze({ kind: 'none' as const });
    }
    if (accountPaths.length !== 1) {
        return Object.freeze({ kind: 'unavailable' as const });
    }
    return Object.freeze({
        kind: 'connectedAccount' as const,
        fieldPath: accountPaths[0]!,
    });
}

function hasRequiredActionSurface(
    action: TargetedContributionActionDeclaration,
    surface: PluginActionSurfaceV2,
): boolean {
    const contributionSurfaces = action.definition.contributionSurfaces;
    return Array.isArray(contributionSurfaces) && contributionSurfaces.includes(surface);
}

function hasRequiredActionSurfaces(
    action: TargetedContributionActionDeclaration,
    surfaces: readonly PluginActionSurfaceV2[],
): boolean {
    return surfaces.every((surface) => hasRequiredActionSurface(action, surface));
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
        candidate.target.occurrenceId,
        candidate.contributorOccurrenceId,
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
    candidate: TargetedContributionDeclaration,
    code: TargetedContributionAdmissionDiagnosticCode,
): void {
    diagnostics.push(toDiagnostic(candidate, code));
}

function oneSemanticDiagnostic(
    diagnostics: TargetedContributionAdmissionDiagnostic[],
    candidate: TargetedContributionDeclaration,
    code: Extract<TargetedContributionAdmissionDiagnosticCode,
        | 'target_semantics_unavailable'
        | 'descriptor_semantic_invalid'
        | 'surface_semantic_invalid'
    >,
): void {
    // Semantic validation is computed once per target protocol below, but
    // ownership stays with each rejected contributor. A shared parser/cache
    // must not collapse actionable diagnostics under the target plugin.
    diagnostics.push(toDiagnostic(candidate, code));
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
export function dropTargetedContributionAdmissionDiagnostics<TDiagnostic extends Readonly<{ code: string }>>(
    diagnosticsByPluginId: Readonly<Record<string, readonly TDiagnostic[]>>,
): Readonly<Record<string, readonly TDiagnostic[]>> {
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
 * normalized declarations and candidate-local runtime occurrences: it neither
 * starts an activation target nor touches a runtime implementation.
 */
export function resolveAdmittedTargetedContributions<TRenderer extends TargetedContributionRendererDeclaration>(params: Readonly<{
    pluginContributionPoints: readonly TargetedContributionPointDeclaration[];
    targetedPluginContributions: readonly TargetedContributionDeclaration[];
    actions: readonly TargetedContributionActionDeclaration[];
    uiRenderersV2: readonly TRenderer[];
    occurrenceIdsByPluginId: Readonly<Record<string, string>>;
}>): TargetedContributionAdmissionResult<TRenderer> {
    const diagnostics: TargetedContributionAdmissionDiagnostic[] = [];
    const pointsByKey = new Map<string, TargetPoint>();
    for (const declaration of [...params.pluginContributionPoints].sort((left, right) => (
        snapshotKey(left.pluginId, left.definition.id).localeCompare(snapshotKey(right.pluginId, right.definition.id))
    ))) {
        const occurrenceId = declaration.occurrenceId ?? params.occurrenceIdsByPluginId[declaration.pluginId];
        if (!occurrenceId) continue;
        const key = snapshotKey(declaration.pluginId, declaration.definition.id);
        if (!pointsByKey.has(key)) {
            pointsByKey.set(key, Object.freeze({ declaration, occurrenceId }));
        }
    }

    const declaredTargetPluginIds = new Set(params.pluginContributionPoints.map((point) => point.pluginId));
    const actionsByQualifiedId = new Map<string, TargetedContributionActionDeclaration>();
    for (const action of params.actions) {
        if (!action.pluginId) continue;
        const key = scopedActionKey(action.pluginId, action.definition.id,
            action.occurrenceId ?? params.occurrenceIdsByPluginId[action.pluginId] ?? '');
        if (!actionsByQualifiedId.has(key)) actionsByQualifiedId.set(key, action);
    }
    const renderersByOccurrence = new Map<string, Map<string, TRenderer>>();
    for (const renderer of params.uiRenderersV2) {
        const source = occurrenceKey(renderer.pluginId, renderer.occurrenceId ?? params.occurrenceIdsByPluginId[renderer.pluginId] ?? '');
        const renderersByQualifiedId = renderersByOccurrence.get(source) ?? new Map<string, TRenderer>();
        const key = buildPluginUiRendererContributionKey(renderer.pluginId, renderer.definition.id);
        if (!renderersByQualifiedId.has(key)) renderersByQualifiedId.set(key, renderer);
        renderersByOccurrence.set(source, renderersByQualifiedId);
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
            const targetOccurrence = params.occurrenceIdsByPluginId[targetPluginId];
            oneDiagnostic(
                diagnostics,
                declaration,
                targetOccurrence
                    ? 'point_absent'
                    : declaredTargetPluginIds.has(targetPluginId)
                        ? 'target_retired'
                        : 'target_absent',
            );
            continue;
        }
        const contributorOccurrenceId = declaration.occurrenceId ?? params.occurrenceIdsByPluginId[declaration.pluginId];
        if (!contributorOccurrenceId) {
            oneDiagnostic(diagnostics, declaration, 'contributor_retired');
            continue;
        }
        candidates.push(Object.freeze({ declaration, target: point, contributorOccurrenceId }));
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

    const admittedByPoint = new Map<string, AdmittedTargetedContribution<TRenderer>[]>();
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
                    candidate.declaration,
                    'target_semantics_unavailable',
                );
                continue;
            }
        }
        let normalizedDescriptor: JsonValue | undefined;
        if (definition.descriptor !== undefined) {
            if (pointProtocol.descriptor === undefined) {
                oneDiagnostic(diagnostics, candidate.declaration, 'descriptor_unsupported');
                continue;
            }
            // The target's executable parser owns descriptor semantics and
            // normalization. The emitted schema then confirms projection parity
            // over that normalized output; it is not a pre-parser gate, which
            // would mask the parser-owned diagnostic and admit a value the
            // exact generation never validated.
            const parsed = semanticSchemas?.descriptor?.safeParse(definition.descriptor);
            if (!parsed?.success) {
                oneSemanticDiagnostic(
                    diagnostics,
                    candidate.declaration,
                    'descriptor_semantic_invalid',
                );
                continue;
            }
            const descriptorValidation = prepareDescriptorValidation(
                descriptorValidationsByPointProtocol,
                pointProtocol,
            );
            if (!descriptorValidation
                || !isValidPluginJsonSchemaValue(descriptorValidation.validate, parsed.data)) {
                oneDiagnostic(diagnostics, candidate.declaration, 'descriptor_invalid');
                continue;
            }
            normalizedDescriptor = parsed.data;
        } else if (pointProtocol.descriptor !== undefined) {
            // Declaring a descriptor schema IS the requirement: the protocol
            // carries no optionality flag, so an omitted descriptor is as
            // inadmissible as a missing required operation role.
            oneDiagnostic(diagnostics, candidate.declaration, 'descriptor_missing');
            continue;
        }
        const knownRoles = Object.keys(pointProtocol.operations).sort();
        const requiredRole = knownRoles.find((role) => (
            pointProtocol.operations[role]!.required
                && (!Object.hasOwn(definition.operations, role) || definition.operations[role] === undefined)
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
            occurrenceId: candidate.contributorOccurrenceId,
        });
        let failure: TargetedContributionAdmissionDiagnosticCode | undefined;
        const operations: PendingAdmittedTargetedContributionOperation[] = [];
        for (const role of Object.keys(definition.operations).sort()) {
            const roleSources = candidate.declaration.operationSourcesByRole;
            const source = roleSources && Object.hasOwn(roleSources, role) ? roleSources[role] : undefined;
            const localId = source?.localId ?? definition.operations[role]!;
            const roleContributor = source ? Object.freeze({ ...contributor, occurrenceId: source.occurrenceId }) : contributor;
            const action = actionsByQualifiedId.get(scopedActionKey(candidate.declaration.pluginId, localId, roleContributor.occurrenceId));
            const requirement = Object.hasOwn(pointProtocol.operations, role) ? pointProtocol.operations[role] : undefined;
            if (source && (source.unavailable || !action || !hasUsableSchema(action)
                || (requirement && (!hasRequiredActionSurfaces(action, requirement.action.surfaces)
                    || !actionDangerFitsRequirement(action.definition.dangerLevel, requirement.action.dangerLevel))))) {
                if (requirement) operations.push(Object.freeze({ role,
                    action: Object.freeze({ pluginId: candidate.declaration.pluginId, localId }),
                    contributor: roleContributor, selectedActionInput: Object.freeze({ kind: 'none' as const }), unavailable: true,
                }));
                continue;
            }
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
            if (!requirement) continue;
            if (!hasRequiredActionSurfaces(action, requirement.action.surfaces)) {
                failure = 'action_surface_mismatch';
                break;
            }
            if (!actionDangerFitsRequirement(action.definition.dangerLevel, requirement.action.dangerLevel)) {
                failure = 'action_danger_level_mismatch';
                break;
            }
            operations.push(Object.freeze({
                role,
                action: Object.freeze({ pluginId: candidate.declaration.pluginId, localId }),
                contributor: roleContributor,
                selectedActionInput: selectedActionInputForAction(action),
            }));
        }
        const surfaces: PendingAdmittedTargetedContributionSurface<TRenderer>[] = [];
        if (!failure) {
            for (const role of Object.keys(definition.surfaces ?? {}).sort()) {
                const binding = definition.surfaces![role]!;
                const chain = resolvePluginUiRendererChain({
                    binding,
                    contributorPluginId: candidate.declaration.pluginId,
                    renderersByQualifiedId: renderersByOccurrence.get(occurrenceKey(candidate.declaration.pluginId, candidate.contributorOccurrenceId))
                        ?? new Map<string, TRenderer>(),
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
            const surfaceRoles = new Set(surfaces.map((surface) => surface.role));
            const declaredSurfaceRoles = new Map(
                semanticSchemas?.surfaces.map((surface) => [surface.role, surface]) ?? [],
            );
            if (surfaces.some((surface) => (
                declaredSurfaceRoles.get(surface.role)?.presentation !== surface.presentation
            ))) {
                oneSemanticDiagnostic(
                    diagnostics,
                    candidate.declaration,
                    'surface_semantic_invalid',
                );
                continue;
            }
            semanticProjection = Object.freeze({
                ...(normalizedDescriptor === undefined ? {} : { descriptor: normalizedDescriptor }),
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
                    candidate.declaration,
                    'target_semantics_unavailable',
                );
                failure = 'target_semantics_unavailable';
                break;
            }
            admittedOperations.push(Object.freeze({ ...operation, targetProtocol }));
        }
        if (failure) continue;
        const semanticSurfacesByRole = semanticProjection === undefined
            ? undefined
            : new Map(semanticProjection.surfaces.map((surface) => [surface.role, surface]));
        const admittedSurfaces: AdmittedTargetedContributionSurface<TRenderer>[] = [];
        for (const surface of surfaces) {
            const targetProtocol = semanticSurfacesByRole?.get(surface.role);
            if (!targetProtocol) {
                oneSemanticDiagnostic(
                    diagnostics,
                    candidate.declaration,
                    'target_semantics_unavailable',
                );
                failure = 'target_semantics_unavailable';
                break;
            }
            admittedSurfaces.push(Object.freeze({ ...surface, targetProtocol }));
        }
        if (failure) continue;
        const admitted: AdmittedTargetedContribution<TRenderer> = Object.freeze({
            contributor,
            protocol: Object.freeze({ id: definition.protocol.id, version: definition.protocol.version }),
            ...(semanticProjection?.descriptor === undefined
                ? {}
                : { descriptor: semanticProjection.descriptor }),
            operations: Object.freeze(admittedOperations),
            surfaces: Object.freeze(admittedSurfaces),
        });
        const active = admittedByPoint.get(targetKey) ?? [];
        active.push(admitted);
        admittedByPoint.set(targetKey, active);
    }

    const snapshots = new Map<string, AdmittedTargetedContributionSnapshot<TRenderer>>();
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
                    occurrenceId: point.occurrenceId,
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
