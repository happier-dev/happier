import {
    parsePluginManifest,
    type ParsedPluginManifest,
} from '@happier-dev/plugin-sdk/manifest';

import {
    TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1,
    TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1,
} from '../../v1/bounds.js';
import { TriageSourcesContributionProtocolV1 } from '../../v1/contribution.js';
import { TriageSourceDescriptorV1Schema } from '../../v1/descriptor.js';

/** The canonical parsed Action fields relevant to a Triage source binding. */
export type TriageSourceActionDeclarationV1 = Readonly<{
    id: string;
    inputSchema?: unknown;
    resultSchema?: unknown;
    surfaces: readonly string[];
    dangerLevel: string;
}>;

/** The canonical parsed contribution fields relevant to Triage sources V1. */
export type TriageSourceContributionV1 = Readonly<{
    target: Readonly<{
        pluginId: string;
        pointId: string;
    }>;
    protocol: Readonly<{
        id: string;
        version: number;
    }>;
    descriptor?: unknown;
    operations: Readonly<Record<string, string>>;
    surfaces?: unknown;
}>;

type TriageSourceContributesV1 = Readonly<{
    actions: readonly TriageSourceActionDeclarationV1[];
    targetedPluginContributions: readonly TriageSourceContributionV1[];
}>;

/** The non-runtime result of checking one source manifest against Triage sources V1. */
export type TriageSourceConformanceResultV1 =
    | Readonly<{
        ok: true;
        manifest: ParsedPluginManifest;
        contribution: TriageSourceContributionV1;
    }>
    | Readonly<{
        ok: false;
        errors: readonly string[];
    }>;

const sourceOperations = TriageSourcesContributionProtocolV1.operations;
const sourceSurfaces = TriageSourcesContributionProtocolV1.surfaces;

function isJsonEqual(left: unknown, right: unknown): boolean {
    if (Object.is(left, right)) return true;
    if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') {
        return false;
    }
    if (Array.isArray(left) || Array.isArray(right)) {
        return Array.isArray(left)
            && Array.isArray(right)
            && left.length === right.length
            && left.every((entry, index) => isJsonEqual(entry, right[index]));
    }
    const leftRecord = left as Readonly<Record<string, unknown>>;
    const rightRecord = right as Readonly<Record<string, unknown>>;
    const leftKeys = Object.keys(leftRecord).sort();
    const rightKeys = Object.keys(rightRecord).sort();
    return leftKeys.length === rightKeys.length
        && leftKeys.every((key, index) => (
            key === rightKeys[index] && isJsonEqual(leftRecord[key], rightRecord[key])
        ));
}

function includesRequiredStrings(
    actual: readonly string[],
    required: readonly string[],
): boolean {
    return required.every((value) => actual.includes(value));
}

function collectDescriptorErrors(descriptor: unknown, errors: string[]): void {
    if (descriptor === undefined) {
        errors.push('Triage sources V1 requires a declared source descriptor.');
        return;
    }
    const parsed = TriageSourceDescriptorV1Schema.safeParse(descriptor);
    if (!parsed.success) {
        errors.push(`Triage source descriptor is invalid: ${parsed.error.issues
            .map((issue) => `${issue.path.join('.') || 'descriptor'}: ${issue.code}`)
            .join('; ')}.`);
        return;
    }
    const kindIds = parsed.data.kinds.map((kind) => kind.id);
    if (new Set(kindIds).size !== kindIds.length) {
        errors.push('Triage source descriptor kind ids must be unique.');
    }
}

function collectSurfaceErrors(declared: unknown, errors: string[]): void {
    if (declared !== undefined && (declared === null || typeof declared !== 'object')) {
        errors.push('Triage source surface bindings must be a declaration record.');
        return;
    }
    const bindings: Readonly<Record<string, unknown>> = declared === undefined
        ? {}
        : declared as Readonly<Record<string, unknown>>;
    for (const role of Object.keys(bindings)) {
        if (!Object.hasOwn(sourceSurfaces, role)) {
            errors.push(`Triage sources V1 does not define surface role '${role}'.`);
        }
    }
    for (const role of Object.keys(sourceSurfaces)) {
        const binding = bindings[role];
        if (binding === null || typeof binding !== 'object') {
            errors.push(`Triage sources V1 requires the '${role}' surface binding.`);
            continue;
        }
        const renderer = Reflect.get(binding, 'renderer');
        if (typeof renderer !== 'string' || renderer.length === 0) {
            errors.push(`Triage source surface '${role}' must bind one declared same-plugin renderer.`);
        }
    }
}

/**
 * Checks the source-level declaration for exactly one Triage source
 * contribution.
 *
 * The canonical SDK parser owns manifest structure. This helper only composes
 * that parsed declaration with the public Triage sources V1 role contract;
 * host installation, generation currentness, and runtime admission remain
 * host-owned, and descriptor kind-id uniqueness is checked here because the
 * public composition algebra has no keyed-uniqueness constructor
 * (`CONTRACT.md` §2.4, §9).
 */
export function checkTriageSourceContributionV1(
    manifestInput: unknown,
): TriageSourceConformanceResultV1 {
    const parsed = parsePluginManifest(manifestInput);
    if (!parsed.ok) {
        return Object.freeze({
            ok: false,
            errors: Object.freeze(parsed.diagnostics.map((diagnostic) => (
                `${diagnostic.path?.join('.') || 'manifest'}: ${diagnostic.message}`
            ))),
        });
    }
    const parsedManifest = parsed.manifest;
    // The public SDK parser is the structural authority. Its declaration-safe
    // projection names the generic envelope facts this feature conformance
    // reader consumes without importing a private Protocol parser.
    const contributes: TriageSourceContributesV1 = parsedManifest.contributes;

    const contributions = contributes.targetedPluginContributions.filter((contribution) => (
        contribution.target.pluginId === TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1
        && contribution.target.pointId === TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1
    ));
    if (contributions.length !== 1) {
        return Object.freeze({
            ok: false,
            errors: Object.freeze([
                `Triage sources V1 requires exactly one '${TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1}/`
                + `${TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1}' contribution; found ${contributions.length}.`,
            ]),
        });
    }

    const contribution = contributions[0]!;
    const errors: string[] = [];
    if (
        contribution.protocol.id !== TriageSourcesContributionProtocolV1.id
        || contribution.protocol.version !== TriageSourcesContributionProtocolV1.version
    ) {
        errors.push(
            `Triage source contribution must declare protocol '${TriageSourcesContributionProtocolV1.id}'`
            + ` version ${TriageSourcesContributionProtocolV1.version}.`,
        );
    }
    collectDescriptorErrors(contribution.descriptor, errors);

    const actionsById = new Map(contributes.actions.map((action) => [action.id, action]));
    for (const role of Object.keys(contribution.operations)) {
        if (!Object.hasOwn(sourceOperations, role)) {
            errors.push(`Triage sources V1 does not define source role '${role}'.`);
        }
    }

    for (const role of Object.keys(sourceOperations) as Array<keyof typeof sourceOperations>) {
        const operation = sourceOperations[role];
        const declaration = operation.declaration;
        const actionId = contribution.operations[role];
        if (actionId === undefined) {
            if (role !== 'prepareReviewWorkspace') {
                errors.push(`Triage sources V1 requires the '${role}' source role binding.`);
            }
            continue;
        }

        const action = actionsById.get(actionId);
        if (!action) {
            errors.push(`Triage source role '${role}' references undeclared Action '${actionId}'.`);
            continue;
        }
        if (!includesRequiredStrings(action.surfaces, declaration.surfaces)) {
            errors.push(`Triage source role '${role}' Action '${actionId}' has an incompatible surface.`);
        }
        if (action.dangerLevel !== declaration.dangerLevel) {
            errors.push(`Triage source role '${role}' Action '${actionId}' has an incompatible danger level.`);
        }
        if (!isJsonEqual(action.resultSchema, declaration.resultSchema.jsonSchema)) {
            errors.push(`Triage source role '${role}' Action '${actionId}' has an incompatible result schema.`);
        }
        // Every V1 role is `protocolDefined`, so the exact published input
        // JSON Schema is the only admissible declaration.
        if (!isJsonEqual(action.inputSchema, declaration.input.schema.jsonSchema)) {
            errors.push(`Triage source role '${role}' Action '${actionId}' has an incompatible input schema.`);
        }
    }

    collectSurfaceErrors(contribution.surfaces, errors);

    return errors.length === 0
        ? Object.freeze({ ok: true, manifest: parsedManifest, contribution })
        : Object.freeze({ ok: false, errors: Object.freeze(errors) });
}
