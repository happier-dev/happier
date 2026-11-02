import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { sameStrictJsonValue } from '../json/strictJsonValue.js';
import { parseSavedSecretRefV1 } from '../account/settings/savedSecretReferenceV1.js';
import { DeploymentIdentifierV1Schema, DeploymentRevisionV1Schema } from './deploymentIdentifiersV1.js';
import { environmentSecretBindingIdentityV1, type EnvironmentSecretBindingIdentityV1,
    type EnvironmentSecretBindingV1 } from './storedAppInputV1.js';

/** Server-visible routing only; binding names, origins and service selectors stay private. */
export const EnvironmentSecretBindingRoutingV1Schema = lazyZodSchema(() => z.union([
    z.strictObject({ purpose: z.literal('variable'), phase: z.enum(['build', 'runtime']) }),
    z.strictObject({ purpose: z.literal('registry'), targetLinkId: DeploymentIdentifierV1Schema, access: z.enum(['pull', 'pushPull']) }),
    z.strictObject({ purpose: z.enum(['backupDestination', 'domainCredential', 'dataRole']) }),
]));
export type EnvironmentSecretBindingRoutingV1 = z.infer<typeof EnvironmentSecretBindingRoutingV1Schema>;

function routingFor(binding: EnvironmentSecretBindingRoutingV1): EnvironmentSecretBindingRoutingV1 {
    switch (binding.purpose) {
        case 'variable': return { purpose: 'variable', phase: binding.phase };
        case 'registry': return { purpose: 'registry', targetLinkId: binding.targetLinkId, access: binding.access };
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

/** Older prepared callers may omit routing; supplied routing must match the opened content. */
export function matchesDeploymentBindingSavedSecretCapturesV1(
    expected: readonly DeploymentBindingSavedSecretRevisionV1[], captured: readonly DeploymentBindingSavedSecretRevisionV1[],
): boolean {
    const canonical = normalizeDeploymentBindingSavedSecretRevisionsV1(expected);
    const supplied = normalizeDeploymentBindingSavedSecretRevisionsV1(captured);
    return canonical.length === supplied.length && supplied.every((capture, index) => {
        const reference = canonical[index]!;
        return capture.resourceId === reference.resourceId && capture.revision === reference.revision
            && (!capture.requiredBindings || sameStrictJsonValue(capture.requiredBindings, reference.requiredBindings));
    });
}

/** Complete exact captures, shared by authored and prepared binding callers. */
export function captureDeploymentBindingSavedSecretRevisionsV1(bindings: readonly EnvironmentSecretBindingV1[]) {
    const captures = new Map<string, { revision: number; bindings: Map<string, EnvironmentSecretBindingRoutingV1> }>();
    const refuse = (code: string): never => { throw Object.assign(new Error(code), { code }); };
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

/** Applies a settled, schema-admitted patch without disturbing unchanged purpose rows. */
export function applyEnvironmentSecretBindingsPatchV1(bindings: readonly EnvironmentSecretBindingV1[], patch: Readonly<{
    set: readonly EnvironmentSecretBindingV1[];
    remove: readonly EnvironmentSecretBindingIdentityV1[];
}>): EnvironmentSecretBindingV1[] {
    const replacements = new Map(patch.set.map(binding => [environmentSecretBindingIdentityV1(binding), binding]));
    const removed = new Set(patch.remove.map(environmentSecretBindingIdentityV1));
    const result: EnvironmentSecretBindingV1[] = [];
    for (const binding of bindings) {
        const identity = environmentSecretBindingIdentityV1(binding);
        if (removed.has(identity)) continue;
        const replacement = replacements.get(identity);
        result.push(replacement && !sameStrictJsonValue(binding, replacement) ? replacement : binding);
        replacements.delete(identity);
    }
    result.push(...replacements.values());
    return result;
}
