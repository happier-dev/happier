import { createActionExecuteFailureError } from '../actions/actionExecutionResult.js';
import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { DeploymentEnvironmentContentCasV1Schema } from './deploymentArtifactContentReferenceV1.js';
import { sameStrictJsonValue } from '../json/strictJsonValue.js';
import { parseSavedSecretRefV1 } from '../account/settings/savedSecretReferenceV1.js';
import { DeploymentIdentifierV1Schema, DeploymentRevisionV1Schema } from './deploymentIdentifiersV1.js';
import { EnvironmentSecretBindingInputV1Schema, EnvironmentSecretBindingIdentityV1Schema, EnvironmentSecretBindingV1Schema,
    EnvironmentVariableBindingGrantReferenceV1Schema, DeploymentBackupDestinationBindingIdentityV1Schema,
    environmentSecretBindingIdentityV1, type EnvironmentSecretBindingIdentityV1,
    type EnvironmentSecretBindingInputV1, type EnvironmentSecretBindingV1 } from './storedAppInputV1.js';

/** Value-free coverage of current required Environment grants, under Environment read admission. */
export const DeploymentEnvironmentSecretScopeV1Schema = lazyZodSchema(() => z.strictObject({
    status: z.enum(['ready', 'actionNeeded', 'unavailable']), reason: DeploymentIdentifierV1Schema,
    requiredGrantCount: z.number().check(z.int(), z.nonnegative()),
    missingGrantCount: z.number().check(z.int(), z.nonnegative()),
}));
export type DeploymentEnvironmentSecretScopeV1 = z.infer<typeof DeploymentEnvironmentSecretScopeV1Schema>;

/** Server-visible routing only; binding names, origins and service selectors stay private. */
export const EnvironmentSecretBindingRoutingV1Schema = lazyZodSchema(() => z.union([
    z.strictObject({ purpose: z.literal('variable'), phase: z.enum(['build', 'runtime']) }),
    z.strictObject({ purpose: z.literal('registry'), targetLinkId: DeploymentIdentifierV1Schema, access: z.enum(['pull', 'pushPull']) }),
    z.strictObject({ purpose: z.literal('backupDestination'), role: z.optional(DeploymentBackupDestinationBindingIdentityV1Schema.shape.role) }),
    z.strictObject({ purpose: z.enum(['domainCredential', 'dataRole']) }),
]));
export type EnvironmentSecretBindingRoutingV1 = z.infer<typeof EnvironmentSecretBindingRoutingV1Schema>;

function routingFor(binding: EnvironmentSecretBindingRoutingV1): EnvironmentSecretBindingRoutingV1 {
    switch (binding.purpose) {
        case 'variable': return { purpose: 'variable', phase: binding.phase };
        case 'registry': return { purpose: 'registry', targetLinkId: binding.targetLinkId, access: binding.access };
        case 'backupDestination': return { purpose: binding.purpose, ...(binding.role ? { role: binding.role } : {}) };
        default: return { purpose: binding.purpose };
    }
}
const routingKey = (binding: EnvironmentSecretBindingRoutingV1) => JSON.stringify(routingFor(binding));

const captureShape = () => ({
    resourceId: DeploymentIdentifierV1Schema, revision: DeploymentRevisionV1Schema,
    // Absence is retained incomplete metadata, never proof of no required use.
    requiredBindings: z.optional(z.array(EnvironmentSecretBindingRoutingV1Schema).check(z.minLength(1),
        z.refine(bindings => new Set(bindings.map(routingKey)).size === bindings.length,
            { message: 'Required binding routing summaries must be unique.' }))),
});
const uniqueResources = (captures: readonly Readonly<{ resourceId: string }>[]) =>
    new Set(captures.map(capture => capture.resourceId)).size === captures.length;
export const DeploymentBindingSavedSecretRevisionsV1Schema = lazyZodSchema(() => z.array(z.strictObject(captureShape()))
    .check(z.refine(uniqueResources,
    { message: 'Saved Secret captures must have unique resource identities.' })));
export type DeploymentBindingSavedSecretRevisionV1 = z.infer<typeof DeploymentBindingSavedSecretRevisionsV1Schema>[number];
// Retained storage may contain unrelated additive fields. They never acquire
// routing meaning; known routing and resource identities remain schema-bound.
const storedCapturesSchema = lazyZodSchema(() => z.array(z.object(captureShape())).check(z.refine(uniqueResources)));

export function readDeploymentBindingSavedSecretRevisionsV1(value: unknown): DeploymentBindingSavedSecretRevisionV1[] | null {
    const parsed = storedCapturesSchema.safeParse(value);
    return parsed.success ? normalizeDeploymentBindingSavedSecretRevisionsV1(parsed.data) : null;
}

export function normalizeDeploymentBindingSavedSecretRevisionsV1(captures: readonly DeploymentBindingSavedSecretRevisionV1[]) {
    return captures.map(capture => ({ resourceId: capture.resourceId, revision: capture.revision,
        ...(capture.requiredBindings ? { requiredBindings: capture.requiredBindings.map(routingFor)
            .sort((a, b) => routingKey(a).localeCompare(routingKey(b))) } : {}),
    })).sort((a, b) => a.resourceId.localeCompare(b.resourceId));
}

// The pre-role producer collapsed all backup credentials to one purpose-only routing row.
// It remains incomplete metadata; a supplied known role must still cover every actual use.
function matchesRequiredRouting(expected: readonly EnvironmentSecretBindingRoutingV1[], supplied: readonly EnvironmentSecretBindingRoutingV1[]): boolean {
    const expectedKeys = new Set(expected.map(routingKey));
    const suppliedKeys = new Set(supplied.map(routingKey));
    const legacyBackupKey = routingKey({ purpose: 'backupDestination' });
    const hasLegacyBackup = suppliedKeys.has(legacyBackupKey);
    return supplied.every(binding => expectedKeys.has(routingKey(binding))
        || (binding.purpose === 'backupDestination' && binding.role === undefined
            && expected.some(binding => binding.purpose === 'backupDestination')))
        && expected.every(binding => suppliedKeys.has(routingKey(binding))
            || (hasLegacyBackup && binding.purpose === 'backupDestination'));
}

/** Older prepared callers may omit routing; supplied routing must match the opened content. */
export function matchesDeploymentBindingSavedSecretCapturesV1(
    expected: readonly DeploymentBindingSavedSecretRevisionV1[], captured: readonly DeploymentBindingSavedSecretRevisionV1[],
): boolean {
    const canonical = normalizeDeploymentBindingSavedSecretRevisionsV1(expected);
    const supplied = normalizeDeploymentBindingSavedSecretRevisionsV1(captured);
    return canonical.length === supplied.length && supplied.every((capture, index) => {
        const reference = canonical[index]!;
        return capture.resourceId === reference.resourceId && capture.revision === reference.revision
            && (!capture.requiredBindings || (reference.requiredBindings !== undefined
                && matchesRequiredRouting(reference.requiredBindings, capture.requiredBindings)));
    });
}

/** Complete exact captures, shared by authored and prepared binding callers. */
export function captureDeploymentBindingSavedSecretRevisionsV1(bindings: readonly EnvironmentSecretBindingV1[]) {
    const captures = new Map<string, { revision: number; bindings: Map<string, EnvironmentSecretBindingRoutingV1> }>();
    const refuse = (code: string): never => { throw createActionExecuteFailureError({ ok: false, errorCode: code, error: code }); };
    for (const binding of bindings) {
        if (binding.source.kind !== 'secret') continue;
        const ref = parseSavedSecretRefV1(binding.source.ref);
        if (ref.kind !== 'shared_resource') return refuse('personal_secret_requires_promotion');
        const previous = captures.get(ref.resourceId);
        if (previous && previous.revision !== binding.source.resourceRevision) return refuse('deployment_invalid');
        const capture = previous ?? { revision: binding.source.resourceRevision, bindings: new Map<string, EnvironmentSecretBindingRoutingV1>() };
        const routing = routingFor(binding);
        capture.bindings.set(routingKey(routing), routing);
        captures.set(ref.resourceId, capture);
    }
    return [...captures].map(([resourceId, capture]) => ({ resourceId, revision: capture.revision,
        requiredBindings: [...capture.bindings.values()].sort((a, b) => routingKey(a).localeCompare(routingKey(b))) }))
        .sort((a, b) => a.resourceId.localeCompare(b.resourceId));
}

/** Applies a settled patch and gives a new variable one opaque Machine-grant reference exactly once. */
export function applyEnvironmentSecretBindingsPatchV1(bindings: readonly EnvironmentSecretBindingV1[], patch: Readonly<{
    set: readonly EnvironmentSecretBindingInputV1[];
    remove: readonly EnvironmentSecretBindingIdentityV1[];
}>, createVariableGrantReference: () => string): EnvironmentSecretBindingV1[] {
    const current = new Map(bindings.map(binding => [environmentSecretBindingIdentityV1(binding), binding]));
    const replacements = new Map(patch.set.map(value => {
        const binding = EnvironmentSecretBindingInputV1Schema.parse(value);
        const identity = environmentSecretBindingIdentityV1(binding);
        const previous = current.get(identity);
        if (binding.purpose !== 'variable') return [identity, EnvironmentSecretBindingV1Schema.parse(binding)] as const;
        const grantRef = previous?.purpose === 'variable' && previous.grantRef ? previous.grantRef
            : EnvironmentVariableBindingGrantReferenceV1Schema.parse(createVariableGrantReference());
        return [identity, EnvironmentSecretBindingV1Schema.parse({ ...binding, grantRef })] as const;
    }));
    const removed = new Set(patch.remove.map(environmentSecretBindingIdentityV1));
    const result: EnvironmentSecretBindingV1[] = [];
    for (const binding of bindings) {
        const identity = environmentSecretBindingIdentityV1(binding);
        if (removed.has(identity)) continue;
        const replacement = replacements.get(identity);
        const saved = replacement && !sameStrictJsonValue(binding, replacement) ? replacement : binding;
        result.push(saved.purpose === 'variable' && !saved.grantRef
            ? EnvironmentSecretBindingV1Schema.parse({ ...saved, grantRef: createVariableGrantReference() }) : saved);
        replacements.delete(identity);
    }
    result.push(...replacements.values());
    return result;
}

const bindingPatchShape = () => ({
    set: z.array(EnvironmentSecretBindingInputV1Schema), remove: z.array(EnvironmentSecretBindingIdentityV1Schema),
});
const uniqueBindingPatchIdentities = (input: { set: readonly EnvironmentSecretBindingIdentityV1[];
    remove: readonly EnvironmentSecretBindingIdentityV1[] }) => {
    const identities = [...input.set, ...input.remove].map(environmentSecretBindingIdentityV1);
    return new Set(identities).size === identities.length;
};
/** One ordinary binding patch also participates in a reviewed Environment definition update. */
export const DeploymentBindingsPatchV1Schema = lazyZodSchema(() => z.strictObject(bindingPatchShape())
    .check(z.refine(uniqueBindingPatchIdentities, { message: 'Each binding identity may occur once in a patch.' })));
/** Authored binding intent is a leaf: Copy continuations must not import the Action catalog. */
export const DeploymentBindingsPatchInputV1Schema = lazyZodSchema(() => z.strictObject({
    serverId: DeploymentIdentifierV1Schema, environmentId: DeploymentIdentifierV1Schema,
    expectedRevision: DeploymentRevisionV1Schema, ...bindingPatchShape(),
    telemetryMachineId: z.optional(z.nullable(DeploymentIdentifierV1Schema)),
    providerVariables: z.optional(z.strictObject({
        useOurs: z.array(DeploymentIdentifierV1Schema), keepTheirs: z.array(DeploymentIdentifierV1Schema),
    })),
}).check(z.refine(uniqueBindingPatchIdentities, { message: 'Each binding identity may occur once in a patch.' })));
export type DeploymentBindingsPatchInputV1 = z.infer<typeof DeploymentBindingsPatchInputV1Schema>;

/** Prepared callers retain the complete Artifact/capture contract. */
export const DeploymentBindingsPreparedInputV1Schema = lazyZodSchema(() => z.strictObject({
  ...DeploymentEnvironmentContentCasV1Schema.shape,
  telemetryMachineId: z.optional(z.nullable(DeploymentIdentifierV1Schema)),
  referencedSavedSecretRevisions: DeploymentBindingSavedSecretRevisionsV1Schema,
}));
export type DeploymentBindingsPreparedInputV1 = z.infer<typeof DeploymentBindingsPreparedInputV1Schema>;
export const DeploymentBindingsSetInputV1Schema = lazyZodSchema(() => z.union([
  DeploymentBindingsPreparedInputV1Schema, DeploymentBindingsPatchInputV1Schema,
]));
export type DeploymentBindingsSetInputV1 = z.infer<typeof DeploymentBindingsSetInputV1Schema>;
