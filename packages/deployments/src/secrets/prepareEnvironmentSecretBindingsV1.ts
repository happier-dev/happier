import { EnvironmentSecretBindingV1Schema, environmentSecretBindingIdentityV1, machineSecretGrantSubjectKey, parseSavedSecretRefV1,
    captureDeploymentBindingSavedSecretRevisionsV1,
    type EnvironmentSecretBindingV1, type MachineSecretGrantSubjectV1, type MachineSecretGrantV1 } from '@happier-dev/deployment-protocol';
import { environmentSecretBindingInstallationsV1, type EnvironmentSecretRequiredUseV1 } from './projectEnvironmentSecretBindingRequiredUsesV1.js';

/** Compare the exact admitted binding vocabulary, independent of object property order. */
function sameBinding(left: EnvironmentSecretBindingV1, right: EnvironmentSecretBindingV1): boolean {
    if (environmentSecretBindingIdentityV1(left) !== environmentSecretBindingIdentityV1(right)) return false;
    if (left.purpose === 'registry' && (right.purpose !== 'registry' || left.access !== right.access)) return false;
    const a = left.source, b = right.source;
    switch (a.kind) {
        case 'secret': return b.kind === 'secret' && a.ref === b.ref && a.resourceRevision === b.resourceRevision;
        case 'value': return b.kind === 'value' && a.value === b.value;
        case 'reference': return b.kind === 'reference' && a.environmentId === b.environmentId && a.export === b.export && a.via === b.via;
        case 'deploymentFact': return b.kind === 'deploymentFact' && a.fact === b.fact
            && (a.fact !== 'domainUrl' || b.fact === 'domainUrl' && a.domainId === b.domainId);
    }
}
function sameUses(left: readonly EnvironmentSecretBindingV1[], right: readonly EnvironmentSecretBindingV1[]): boolean {
    return left.length === right.length && left.every((binding, index) => sameBinding(binding, right[index]!));
}

export type EnvironmentOperationalSecretBinding = Exclude<EnvironmentSecretBindingV1, { purpose: 'variable' }>;
export type EnvironmentSecretInstallation = Readonly<{ machineId: string; installationId: string; publicKey: Uint8Array }>;
export type EnvironmentDomainSecretDestinationsV1 = Readonly<{
    status: 'complete' | 'incomplete';
    domains: readonly Readonly<{ domainId: string; installations: readonly EnvironmentSecretInstallation[] }>[];
}>;
type OperationalDestination = Readonly<{
    binding: EnvironmentOperationalSecretBinding;
    /** Produced by the destination/Domain/data owner under the same admitted mutation. */
    installations: readonly EnvironmentSecretInstallation[];
}>;
type Destinations = Readonly<{
    runtimeInstallations: readonly EnvironmentSecretInstallation[];
    buildInstallation?: EnvironmentSecretInstallation;
    operationalDestinations?: readonly OperationalDestination[];
    domainDestinations?: EnvironmentDomainSecretDestinationsV1;
}>;

function refuse(code: 'secret_missing' | 'client_required' | 'personal_secret_requires_promotion'): never {
    throw Object.assign(new Error(code), { code });
}
function sharedResourceId(binding: EnvironmentSecretBindingV1): string {
    if (binding.source.kind !== 'secret') return refuse('secret_missing');
    const parsed = parseSavedSecretRefV1(binding.source.ref);
    if (parsed.kind !== 'shared_resource') return refuse('personal_secret_requires_promotion');
    return parsed.resourceId;
}
function orderedUses(bindings: readonly EnvironmentSecretBindingV1[]) {
    return [...bindings].sort((a, b) => environmentSecretBindingIdentityV1(a).localeCompare(environmentSecretBindingIdentityV1(b))
        || JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
function destinationsFor(binding: EnvironmentSecretBindingV1, destinations: Destinations,
    operational: ReadonlyMap<string, OperationalDestination>) {
    if (binding.purpose === 'variable') return environmentSecretBindingInstallationsV1(binding, destinations)!
        .map(installation => ({ installation, use: binding }));
    if (binding.purpose === 'registry') {
        const pull = { ...binding, access: 'pull' as const };
        return [
            ...environmentSecretBindingInstallationsV1(binding, destinations)!.map(installation => ({ installation, use: pull })),
            ...(destinations.buildInstallation && binding.access === 'pushPull'
                ? [{ installation: destinations.buildInstallation, use: binding }] : []),
        ];
    }
    if (binding.purpose === 'domainCredential') {
        const domains = destinations.domainDestinations;
        return (domains?.status === 'complete'
            ? domains.domains.find(domain => domain.domainId === binding.domainId)?.installations ?? [] : [])
            .map(installation => ({ installation, use: binding }));
    }
    const destination = operational.get(environmentSecretBindingIdentityV1(binding));
    return (destination && sameBinding(destination.binding, binding) ? destination.installations : [])
        .map(installation => ({ installation, use: binding }));
}

/** Host preparation only: the caller commits the complete set through P40's one bindings CAS. */
export async function prepareEnvironmentSecretBindingsV1(input: Destinations & Readonly<{
    environmentId: string;
    bindings: readonly EnvironmentSecretBindingV1[];
    previousBindings: readonly EnvironmentSecretBindingV1[];
    /** Placement mutations supply the prior admitted assignment for exact retained-use comparison. */
    previousDestinations?: Destinations;
    existingGrants: readonly MachineSecretGrantV1[];
    resolveSecret?: (binding: Extract<EnvironmentSecretBindingV1['source'], { kind: 'secret' }>) => Promise<string>;
    sealGrant: (input: Readonly<{ subject: MachineSecretGrantSubjectV1; installationPublicKey: Uint8Array;
        content: Readonly<{ kind: 'secret'; value: string }>
            | Readonly<{ kind: 'environmentValues'; definition: Exclude<EnvironmentSecretBindingV1['source'], { kind: 'secret' }> }> }>) => MachineSecretGrantV1;
    /** Canonical admission rechecks principal, exact purpose owners, resources, installations and approval. */
    assertCurrent: () => Promise<void>;
}>) {
    await input.assertCurrent();
    const bindings = input.bindings.map(binding => {
        const parsed = EnvironmentSecretBindingV1Schema.safeParse(binding);
        return parsed.success ? parsed.data : refuse('secret_missing');
    });
    let captures: ReturnType<typeof captureDeploymentBindingSavedSecretRevisionsV1>;
    try { captures = captureDeploymentBindingSavedSecretRevisionsV1(bindings); }
    catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'deployment_invalid') return refuse('secret_missing');
        throw error;
    }
    const operational = new Map(input.operationalDestinations?.map(destination => [environmentSecretBindingIdentityV1(destination.binding), destination]));
    const previousDestinations = input.previousDestinations ?? input;
    const previousOperational = new Map(previousDestinations.operationalDestinations?.map(destination => [environmentSecretBindingIdentityV1(destination.binding), destination]));
    const groups = new Map<string, { subject: MachineSecretGrantSubjectV1; installation: EnvironmentSecretInstallation; uses: EnvironmentSecretBindingV1[] }>();
    const previousUses = new Map<string, EnvironmentSecretBindingV1[]>();
    const subjectFor = (binding: EnvironmentSecretBindingV1, installation: EnvironmentSecretInstallation): MachineSecretGrantSubjectV1 => {
        const common = { v: 1 as const, machineId: installation.machineId, installationId: installation.installationId, environmentId: input.environmentId };
        if (binding.source.kind === 'secret') return { ...common, kind: 'secret', resourceId: sharedResourceId(binding), resourceRevision: binding.source.resourceRevision };
        if (binding.purpose !== 'variable') return refuse('secret_missing');
        return { ...common, kind: 'environmentValues', binding: { purpose: 'variable', phase: binding.phase, name: binding.name } };
    };
    const addUse = (uses: EnvironmentSecretBindingV1[], use: EnvironmentSecretBindingV1) => {
        if (!uses.some(existing => sameBinding(existing, use))) uses.push(use);
    };
    for (const binding of input.previousBindings) for (const { installation, use } of destinationsFor(binding, previousDestinations, previousOperational)) {
        const key = machineSecretGrantSubjectKey(subjectFor(use, installation));
        const uses = previousUses.get(key) ?? [];
        addUse(uses, use);
        previousUses.set(key, uses);
    }
    for (const binding of bindings) {
        const destinations = destinationsFor(binding, input, operational);
        // Runtime variables may be authored before a target is linked; there is nothing to seal yet.
        if (!destinations.length && (binding.purpose !== 'variable' || binding.phase !== 'runtime')) return refuse('secret_missing');
        for (const { installation, use } of destinations) {
            const subject = subjectFor(use, installation);
            const key = machineSecretGrantSubjectKey(subject);
            const group = groups.get(key) ?? { subject, installation, uses: [] };
            addUse(group.uses, use);
            groups.set(key, group);
        }
    }
    const existing = new Map(input.existingGrants.map(grant => [machineSecretGrantSubjectKey(grant), grant]));
    const resolved = new Map<string, string>();
    const grants: MachineSecretGrantV1[] = [];
    try {
        for (const [key, { subject, installation, uses }] of groups) {
            const retained = existing.get(key);
            const previous = previousUses.get(key) ?? [];
            // Secret ciphertext authenticates only the exact resource subject;
            // the current binding owns its names, phase and use permissions.
            // Non-secret ciphertext still contains its exact source definition.
            const retainsContent = subject.kind === 'secret' || sameUses(orderedUses(previous), orderedUses(uses));
            if (retained && retainsContent) {
                grants.push(retained);
                continue;
            }
            if (subject.kind === 'secret') {
                if (!input.resolveSecret) return refuse('client_required');
                const first = uses[0];
                if (first.source.kind !== 'secret') return refuse('secret_missing');
                const resourceKey = JSON.stringify([subject.resourceId, subject.resourceRevision]);
                let value = resolved.get(resourceKey);
                if (value === undefined) {
                    value = await input.resolveSecret(first.source);
                    await input.assertCurrent();
                    resolved.set(resourceKey, value);
                }
                grants.push(input.sealGrant({ subject, installationPublicKey: installation.publicKey, content: { kind: 'secret', value } }));
            } else if (subject.kind === 'environmentValues') {
                const binding = uses[0];
                if (binding.source.kind === 'secret') return refuse('secret_missing');
                grants.push(input.sealGrant({ subject, installationPublicKey: installation.publicKey,
                    content: { kind: 'environmentValues', definition: binding.source } }));
            }
        }
        await input.assertCurrent();
        const requiredSecretUses: EnvironmentSecretRequiredUseV1[] = [];
        for (const { subject } of groups.values()) if (subject.kind === 'secret') requiredSecretUses.push({
            resourceId: subject.resourceId, resourceRevision: subject.resourceRevision,
            machineId: subject.machineId, installationId: subject.installationId,
        });
        return { grants, referencedSavedSecretRevisions: captures, requiredSecretUses };
    } finally { resolved.clear(); }
}
