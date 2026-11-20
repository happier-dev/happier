import { z } from '@happier-dev/protocol/zodRuntimePolicy';
import { DeploymentEnvironmentCapabilitiesV1Schema, DeploymentEnvironmentHeaderV1Schema, DeploymentEnvironmentListResultV1Schema, DeploymentEnvironmentOwnerV1Schema, DeploymentIngressV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { DeploymentComposeSelectorsV1Schema, DeploymentStoredDefinitionV1Schema, EnvironmentSecretBindingV1Schema, EnvironmentSecretBindingStoredReadV1Schema, environmentSecretBindingIdentityV1, DeploymentRepositoryDefinitionV1Schema, DeploymentPendingDeployV1Schema, OwnServerEnvironmentConfigurationV1Schema, type OwnServerEnvironmentConfigurationV1, parseDeploymentComposeSourceV1 } from '@happier-dev/protocol/deployments/storedAppInputV1';
import { DeploymentRetainPreviousDeploymentsV1Schema } from '@happier-dev/protocol/projects/deploymentCreationDefaultsV1';
import { hasCompleteDeploymentPreviewRelationV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';

import { DeploymentTextV1Schema as text } from './deploymentIdentity.js';
import { deploymentStoredContentV1Schema } from './storedDeploymentContent.js';
import { DeploymentEnvironmentTemplateProvenanceV1Schema } from '../templates/deploymentTemplateProvenance.js';
import { DeploymentPreviewProvenanceV1Schema, DeploymentPreviewTemplateV1Schema } from '../projection/deploymentPreviewSchemas.js';
import { DeploymentEnvironmentBackupV1Schema } from '../backups/deploymentBackupContracts.js';
import { DeploymentTelemetryCapabilitiesV1Schema } from '@happier-dev/protocol/deployments/deploymentTelemetryV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { WorkflowRunIdV1Schema } from '@happier-dev/protocol/workflows/workflowIdsV1';
import { parseSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import type { EnvironmentSecretBindingV1 } from '@happier-dev/protocol';
import type { MachineSecretGrantV1 } from '@happier-dev/protocol/deployments/machineSecretGrantV1';

export { DeploymentComposeSelectorsV1Schema, DeploymentStoredDefinitionV1Schema, DeploymentSecretBindingSourceV1Schema, DeploymentVariableBindingSourceV1Schema, DeploymentNonSecretVariableBindingSourceV1Schema, EnvironmentVariableBindingV1Schema, EnvironmentVariableBindingInputV1Schema, EnvironmentVariableBindingGrantReferenceV1Schema, StoredAppPresetInputV1Schema, DeploymentTemplateRefV1Schema, StoredAppPresetBindingV1Schema } from '@happier-dev/protocol/deployments/storedAppInputV1';
export type { EnvironmentVariableBindingV1, EnvironmentVariableBindingInputV1, EnvironmentVariableBindingGrantReferenceV1, StoredAppPresetInputV1 } from '@happier-dev/protocol';
export { EnvironmentSecretBindingV1Schema, EnvironmentSecretBindingStoredReadV1Schema, EnvironmentSecretBindingInputV1Schema, EnvironmentSecretBindingIdentityV1Schema, EnvironmentDataRoleAddressV1Schema, environmentSecretBindingIdentityV1, isSettledEnvironmentSecretBindingV1 } from '@happier-dev/protocol/deployments/storedAppInputV1';
export type { EnvironmentSecretBindingV1, EnvironmentSecretBindingInputV1, EnvironmentSecretBindingIdentityV1,
    EnvironmentDataRoleAddressV1 } from '@happier-dev/protocol';
export { DeploymentCreationDefaultsV1Schema, DEFAULT_DEPLOYMENT_RETAIN_PREVIOUS_DEPLOYMENTS_V1, ResolvedDeploymentCreationDefaultsV1Schema, DeploymentCreationDefaultSourceV1Schema } from '@happier-dev/protocol/projects/deploymentCreationDefaultsV1';
export { ProjectDeploymentDefaultsV1Schema, ProjectDeploymentDefaultsPayloadV1Schema, ProjectDeploymentDefaultsContentV1Schema } from '@happier-dev/protocol/projects/projectDeploymentDefaultsV1';
export type { DeploymentCreationDefaultsV1, ProjectDeploymentDefaultsV1, ProjectDeploymentDefaultsPayloadV1,
    ProjectDeploymentDefaultsContentV1, ResolvedDeploymentCreationDefaultsV1, DeploymentCreationDefaultSourceV1 } from '@happier-dev/protocol';
export type { ProjectSourceOwnerV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
export { DeploymentRepositoryComposeV1Schema } from '@happier-dev/protocol/deployments/storedAppInputV1';
export const DeploymentEnvironmentDefinitionV1Schema = z.discriminatedUnion('kind', [
    DeploymentRepositoryDefinitionV1Schema,
    DeploymentStoredDefinitionV1Schema,
]);
export type DeploymentEnvironmentDefinitionV1 = z.infer<typeof DeploymentEnvironmentDefinitionV1Schema>;

/** Definition revisions describe document/selectors, not unrelated Environment edits.
 * Repository definitions cannot become stored content through an ordinary update.
 * The source owner independently validates the document's digest before native use. */
export function resolveDeploymentStoredDefinitionRevisionV1(
    previous: DeploymentEnvironmentDefinitionV1 | undefined,
    candidate: Omit<Extract<DeploymentEnvironmentDefinitionV1, { kind: 'stored' }>, 'contentRevision'>,
): number | null {
    if (!previous) return 1;
    if (previous.kind !== 'stored') return null;
    const sameSource = previous.document === candidate.document
        && sameStrictJsonValue(previous.publicFiles ?? [], candidate.publicFiles ?? []);
    if (sameSource && previous.composeDigest !== candidate.composeDigest) return null;
    const sameList = (left: readonly string[], right: readonly string[]) =>
        left.length === right.length && left.every((value, index) => value === right[index]);
    const unchanged = sameSource
        && sameList(previous.profiles, candidate.profiles) && sameList(previous.services, candidate.services)
        && previous.primaryService === candidate.primaryService;
    return previous.contentRevision + (unchanged ? 0 : 1);
}

export { OwnServerEnvironmentConfigurationV1Schema, type OwnServerEnvironmentConfigurationV1 } from '@happier-dev/protocol/deployments/storedAppInputV1';

/** Author defaults once for a newly selected own-server configuration; stored readers and edits preserve omissions. */
export function createOwnServerEnvironmentConfigurationV1(
    input: Partial<OwnServerEnvironmentConfigurationV1> = {},
): OwnServerEnvironmentConfigurationV1 {
    return OwnServerEnvironmentConfigurationV1Schema.parse({
        ...input,
        rollout: input.rollout === undefined ? 'recreate' : input.rollout,
        autoRestorePreviousRelease: input.autoRestorePreviousRelease === undefined ? true : input.autoRestorePreviousRelease,
        backupBeforeMigration: input.backupBeforeMigration === undefined ? true : input.backupBeforeMigration,
        migrationFailurePolicy: input.migrationFailurePolicy === undefined ? 'ask' : input.migrationFailurePolicy,
        serviceExports: input.serviceExports === undefined ? [] : input.serviceExports,
    });
}

/** Policy and private export authoring share one partial-update/default rule. */
export function applyOwnServerEnvironmentConfigurationPatchV1(current: OwnServerEnvironmentConfigurationV1 | undefined,
    patch: Omit<Partial<OwnServerEnvironmentConfigurationV1>, 'migration'> & {
        migration?: OwnServerEnvironmentConfigurationV1['migration'] | null;
    }): OwnServerEnvironmentConfigurationV1 | undefined {
    const selected = Object.fromEntries(Object.entries(patch).filter(([key, value]) => value !== undefined
        && !(key === 'migration' && value === null)));
    const next = current ? { ...current, ...selected }
        : Object.keys(selected).length ? createOwnServerEnvironmentConfigurationV1(selected) : undefined;
    if (next && patch.migration === null) delete next.migration;
    return next;
}

const environmentContentShape = {
    name: text, retainPreviousDeployments: DeploymentRetainPreviousDeploymentsV1Schema,
    definition: DeploymentEnvironmentDefinitionV1Schema, bindings: z.array(EnvironmentSecretBindingV1Schema),
    ownServer: z.optional(OwnServerEnvironmentConfigurationV1Schema),
    ingress: z.optional(DeploymentIngressV1Schema),
    /** Vendor-acknowledged creation of the Environment's shared tunnel. */
    cloudflareTunnels: z.optional(z.array(z.strictObject({ accountId: text, tunnelId: text }))),
    backup: z.optional(DeploymentEnvironmentBackupV1Schema),
    telemetry: z.optional(DeploymentTelemetryCapabilitiesV1Schema),
    template: z.optional(DeploymentEnvironmentTemplateProvenanceV1Schema),
    previewTemplate: z.optional(DeploymentPreviewTemplateV1Schema),
    previewProvenance: z.optional(DeploymentPreviewProvenanceV1Schema),
    /** Existing Workflow custody locates the authenticated branch-create captures on PR close. */
    previewCreationRunId: z.optional(WorkflowRunIdV1Schema),
};
const uniqueBindings = z.refine<{ bindings: readonly EnvironmentSecretBindingV1[] }>((content) =>
    new Set(content.bindings.map(environmentSecretBindingIdentityV1)).size === content.bindings.length,
    { message: 'Binding purpose identities must be unique.' });
const uniqueGrantRefs = z.refine<{ bindings: readonly EnvironmentSecretBindingV1[] }>((content) => {
    const refs = content.bindings.flatMap(binding => binding.purpose === 'variable' && binding.grantRef ? [binding.grantRef] : []);
    return new Set(refs).size === refs.length;
}, { message: 'Variable Machine-grant references must be unique.' });
export const DeploymentEnvironmentContentV1Schema = z.strictObject(environmentContentShape).check(uniqueBindings, uniqueGrantRefs);
/** The stored read boundary preserves legacy bindings; a new content write still requires opaque references. */
export const DeploymentEnvironmentContentStoredReadV1Schema = z.strictObject({ ...environmentContentShape,
    bindings: z.array(EnvironmentSecretBindingStoredReadV1Schema) }).check(uniqueBindings, uniqueGrantRefs);
export type DeploymentEnvironmentContentV1 = z.infer<typeof DeploymentEnvironmentContentStoredReadV1Schema>;

/** The credential writer also authors backup and data-role references. Combined definition
 * updates preserve them, alongside the other operational owners' rows. */
export function isEnvironmentSecretBindingManagedByBindingsWriterV1(binding: EnvironmentSecretBindingV1,
    writer: 'environment' | 'bindings' | 'variables' = 'environment'):
    binding is Extract<EnvironmentSecretBindingV1, { purpose: 'variable' | 'registry' | 'backupDestination' }>
        | Extract<EnvironmentSecretBindingV1, { purpose: 'dataRole' }> {
    return binding.purpose === 'variable' || writer !== 'variables' && binding.purpose === 'registry'
        || writer === 'bindings' && (binding.purpose === 'backupDestination'
            || binding.purpose === 'dataRole');
}

/** A combined definition update carries existing operational custody without authoring it. */
export function readRetainedOperationalEnvironmentBindingGrantsV1(input: Readonly<{
    previousBindings: readonly EnvironmentSecretBindingV1[];
    bindings: readonly EnvironmentSecretBindingV1[];
    existingGrants: readonly MachineSecretGrantV1[];
    /** Only the explicit credential writer may edit backup and data-role references. */
    writer?: 'environment' | 'bindings' | 'variables';
}>): readonly MachineSecretGrantV1[] | null {
    const operational = (bindings: readonly EnvironmentSecretBindingV1[]) => bindings
        .filter(binding => !isEnvironmentSecretBindingManagedByBindingsWriterV1(binding, input.writer))
        .sort((left, right) => environmentSecretBindingIdentityV1(left).localeCompare(environmentSecretBindingIdentityV1(right)));
    const previous = operational(input.previousBindings);
    if (!sameStrictJsonValue(previous, operational(input.bindings))) return null;
    const resources = new Map<string, number>();
    for (const binding of previous) {
        if (binding.source.kind !== 'secret') continue;
        const source = parseSavedSecretRefV1(binding.source.ref);
        if (source.kind === 'shared_resource') resources.set(source.resourceId, binding.source.resourceRevision);
    }
    return input.existingGrants.filter(grant => grant.kind === 'secret'
        && resources.get(grant.resourceId) === grant.resourceRevision);
}

/** A reviewed definition may retire a local database; its metadata cannot keep naming the removed service.
 * This changes desired configuration only. Physical volumes and retained backup snapshots keep their existing owners. */
export async function reconcileDeploymentRemovedDataServicesV1(content: DeploymentEnvironmentContentV1,
    definition: Extract<DeploymentEnvironmentDefinitionV1, { kind: 'stored' }>): Promise<DeploymentEnvironmentContentV1> {
    const updated = { ...content, definition };
    const template = content.template;
    if (!template?.data?.length || content.definition.kind !== 'stored'
        || definition.document === content.definition.document) return updated;
    const source = await parseDeploymentComposeSourceV1(definition.document);
    const previousSource = await parseDeploymentComposeSourceV1(content.definition.document);
    const services = source.services;
    const previousServices = previousSource.services;
    if (!services || typeof services !== 'object' || Array.isArray(services)
        || !previousServices || typeof previousServices !== 'object' || Array.isArray(previousServices))
        throw Object.assign(new Error('Compose services are required'), { code: 'invalid_request' });
    const removed = new Set(template.data.filter(data => Object.hasOwn(previousServices, data.service)
        && !Object.hasOwn(services, data.service)).map(data => data.service));
    if (!removed.size) return updated;
    const { data: _data, health: _health, exports: _exports, ...provenance } = template;
    const data = template.data.filter(entry => !removed.has(entry.service));
    const health = template.health?.filter(entry => !removed.has(entry.service));
    const exports = template.exports && Object.fromEntries(Object.entries(template.exports).filter(([, entry]) => !removed.has(entry.service)));
    updated.template = { ...provenance, services: template.services.filter(service => !removed.has(service)),
        ...(data.length ? { data } : {}), ...(health?.length ? { health } : {}),
        ...(exports && Object.keys(exports).length ? { exports } : {}) };
    if (content.ownServer?.serviceExports) {
        const { serviceExports, ...policy } = content.ownServer;
        const retained = serviceExports.filter(entry => !removed.has(entry.service));
        updated.ownServer = { ...policy, ...(retained.length ? { serviceExports: retained } : {}) };
    }
    if (content.backup && 'configRevision' in content.backup) {
        const sources = content.backup.sources.filter(entry => !removed.has(entry.service));
        if (sources.length !== content.backup.sources.length) {
            if (sources.length) updated.backup = { ...content.backup, sources, configRevision: content.backup.configRevision + 1 };
            else delete updated.backup;
        }
    }
    return updated;
}
/** A binding writer may replace only bindings, never another owner's content leaves. */
export function isDeploymentEnvironmentBindingsOnlyUpdateV1(
    previous: DeploymentEnvironmentContentV1, candidate: DeploymentEnvironmentContentV1,
    writer: 'bindings' | 'telemetry' = 'bindings',
): boolean {
    return sameStrictJsonValue({ ...previous, bindings: [], ...(writer === 'telemetry' ? { telemetry: undefined } : {}) },
        { ...candidate, bindings: [], ...(writer === 'telemetry' ? { telemetry: undefined } : {}) });
}
export const DeploymentEnvironmentStoredContentV1Schema = deploymentStoredContentV1Schema(DeploymentEnvironmentContentStoredReadV1Schema);
export type DeploymentEnvironmentStoredContentV1 = z.infer<typeof DeploymentEnvironmentStoredContentV1Schema>;

export { DeploymentEnvironmentCapabilitiesV1Schema, DeploymentEnvironmentHeaderV1Schema, DeploymentEnvironmentOwnerV1Schema };
export type { DeploymentEnvironmentHeaderV1 } from '@happier-dev/protocol';
const { contentArtifactId: _contentArtifactId, contentHeaderVersion: _contentHeaderVersion,
    contentBodyVersion: _contentBodyVersion, ...deploymentEnvironmentMetadataShape } = DeploymentEnvironmentHeaderV1Schema.shape;
export const DeploymentEnvironmentV1Schema = z.strictObject({
    ...deploymentEnvironmentMetadataShape,
    content: DeploymentEnvironmentStoredContentV1Schema,
    pendingDeploy: z.optional(DeploymentPendingDeployV1Schema),
}).check(z.refine(hasCompleteDeploymentPreviewRelationV1,
{ message: 'Preview relationships are complete and absent on standard Environments.' }));
export type DeploymentEnvironmentV1 = z.infer<typeof DeploymentEnvironmentV1Schema>;
export { DeploymentEnvironmentListResultV1Schema };
export type DeploymentEnvironmentListResultV1 = z.infer<typeof DeploymentEnvironmentListResultV1Schema>;
