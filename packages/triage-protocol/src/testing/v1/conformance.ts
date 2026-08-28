import {
    parsePluginManifest,
    type ParsedPluginManifest,
} from '@happier-dev/plugin-sdk/manifest';
import { pluginJsonValuesEqual } from '@happier-dev/plugin-sdk/protocol';

import {
    TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1,
    TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1,
} from '../../v1/bounds.js';
import { TriageSourcesContributionProtocolV1 } from '../../v1/contribution.js';
import {
    admitTriageSourceDescriptorV1,
    TriageSourceDescriptorV1Schema,
} from '../../v1/descriptor.js';

/** The non-runtime result of checking one source manifest against Triage sources V1. */
export type TriageSourceConformanceResultV1 =
    | Readonly<{
        ok: true;
        manifest: ParsedPluginManifest;
    }>
    | Readonly<{
        ok: false;
        errors: readonly string[];
    }>;

const sourceOperations = TriageSourcesContributionProtocolV1.operations;
const sourceSurfaces = TriageSourcesContributionProtocolV1.surfaces;

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
    const admitted = admitTriageSourceDescriptorV1(parsed.data);
    if (!admitted.ok) {
        errors.push('Triage source descriptor kind ids must be unique.');
        return;
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
 * host-owned. Descriptor semantics delegate to the same target-owned admission
 * function production uses (`CONTRACT.md` §2.4, §9).
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
    // The public SDK parser is the structural authority, and its
    // declaration-safe projection already names every generic envelope fact
    // this reader consumes. Restating those field layouts locally would be a
    // second declaration of one shape, drifting silently the moment the parser
    // widens one.
    const contributes = parsedManifest.contributes;

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
            if (role !== 'prepareReviewWorkspace' && role !== 'verifyReviewWorkspace') {
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
        if (!pluginJsonValuesEqual(action.resultSchema, declaration.resultSchema.jsonSchema)) {
            errors.push(`Triage source role '${role}' Action '${actionId}' has an incompatible result schema.`);
        }
        // Every V1 role is `protocolDefined`, so the exact published input
        // JSON Schema is the only admissible declaration.
        if (!pluginJsonValuesEqual(action.inputSchema, declaration.input.schema.jsonSchema)) {
            errors.push(`Triage source role '${role}' Action '${actionId}' has an incompatible input schema.`);
        }
    }

    collectSurfaceErrors(contribution.surfaces, errors);

    return errors.length === 0
        ? Object.freeze({ ok: true, manifest: parsedManifest })
        : Object.freeze({ ok: false, errors: Object.freeze(errors) });
}
