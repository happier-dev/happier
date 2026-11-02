import { z } from 'zod/mini';
import { DeploymentActionFailureV1Schema, DeploymentDomainPlacementV1Schema, computeCanonicalDomainSeparatedDigest,
    EnvironmentDomainCredentialBindingV1Schema } from '@happier-dev/protocol';
import { createCanonicalJsonSigningInput } from '@happier-dev/protocol/crypto/canonicalJson';
import { MachineInstallationProofV1Schema, MachineInstallationPublicKeySchema } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { DeploymentIdentifierV1Schema as id, DeploymentRevisionV1Schema as revision } from '../v1/ids.js';
import { MachineConnectorSecretGrantSubjectV1Schema, MachineSecretGrantV1Schema } from './machineSecretGrantV1.js';

/** Private installed-daemon transport, never an Action or public binding projection. */
export const EnvironmentSecretLaunchAdmissionBodyV1Schema = z.strictObject({
    serverId: id, environmentId: id, targetLinkId: id, machineId: id, installationId: id,
    materialization: z.discriminatedUnion('kind', [
        z.strictObject({ kind: z.literal('review'), contentArtifactId: id }),
        z.strictObject({ kind: z.literal('deployment'), deploymentId: id, actionOperationId: id }),
        z.strictObject({ kind: z.literal('bindings'), expectedRevision: revision, buildMachineId: z.optional(id), domainIds: z.optional(z.array(id)) }),
        z.strictObject({ kind: z.literal('domain'), domainId: id, expectedDomainRevision: revision,
            actionOperationId: id, capture: DeploymentDomainPlacementV1Schema,
            use: z.optional(EnvironmentDomainCredentialBindingV1Schema) }),
    ]),
});
export type EnvironmentSecretLaunchAdmissionBodyV1 = z.infer<typeof EnvironmentSecretLaunchAdmissionBodyV1Schema>;
export const EnvironmentSecretLaunchAdmissionInputV1Schema = z.extend(EnvironmentSecretLaunchAdmissionBodyV1Schema,
    { proof: MachineInstallationProofV1Schema });
export type EnvironmentSecretLaunchAdmissionInputV1 = z.infer<typeof EnvironmentSecretLaunchAdmissionInputV1Schema>;

/** Private Account-authenticated binding preparation; the route requires current manager authority. */
export const EnvironmentSecretClientBindingsInputV1Schema = z.strictObject({
    kind: z.literal('clientBindings'), serverId: id, environmentId: id, expectedRevision: revision,
    buildMachineId: z.optional(id),
    domainIds: z.optional(z.array(id)),
});
export const EnvironmentSecretAdmissionRequestV1Schema = z.union([
    EnvironmentSecretLaunchAdmissionInputV1Schema, EnvironmentSecretClientBindingsInputV1Schema,
]);
export type EnvironmentSecretAdmissionRequestV1 = z.infer<typeof EnvironmentSecretAdmissionRequestV1Schema>;

const installation = z.strictObject({ machineId: id, installationId: id, publicKey: MachineInstallationPublicKeySchema });
/** Facts from the accepted Domain job and its verified controller; never caller-authored grant authority. */
export const EnvironmentDomainSecretLaunchAdmissionV1Schema = z.strictObject({
    controller: installation, target: installation, actionOperationId: id,
});
export type EnvironmentDomainSecretLaunchAdmissionV1 = z.infer<typeof EnvironmentDomainSecretLaunchAdmissionV1Schema>;
export const EnvironmentSecretBindingPreparationV1Schema = z.strictObject({
    runtimeInstallations: z.array(installation), buildInstallation: z.optional(installation),
    proposedBuildInstallation: z.optional(installation),
    domainDestinations: z.optional(z.strictObject({ status: z.enum(['complete', 'incomplete']),
        domains: z.array(z.strictObject({ domainId: id, installations: z.array(installation) })) })),
});
export const EnvironmentSecretLaunchAdmissionResultV1Schema = z.union([
    z.strictObject({ ok: z.literal(true), grants: z.array(MachineSecretGrantV1Schema),
        bindingPreparation: z.optional(EnvironmentSecretBindingPreparationV1Schema),
        domainAdmission: z.optional(EnvironmentDomainSecretLaunchAdmissionV1Schema) }),
    DeploymentActionFailureV1Schema,
    z.strictObject({ ok: z.literal(false), error: z.literal('secret_missing') }),
]);
export type EnvironmentSecretLaunchAdmissionResultV1 = z.infer<typeof EnvironmentSecretLaunchAdmissionResultV1Schema>;

const machineConnectorRequest = { serverId: id, hostMachineId: id, hostInstallationId: id,
    subject: MachineConnectorSecretGrantSubjectV1Schema };
/** Machine setup custody uses the same installed proof and grant repository, without an Environment operand. */
const connectorRead = z.strictObject({ ...machineConnectorRequest, operation: z.literal('read') });
const connectorSet = z.strictObject({ ...machineConnectorRequest, operation: z.literal('set'), grant: MachineSecretGrantV1Schema });
const connectorRemove = z.strictObject({ ...machineConnectorRequest, operation: z.literal('remove') });
export const MachineConnectorSecretGrantBodyV1Schema = z.discriminatedUnion('operation', [connectorRead, connectorSet, connectorRemove]);
export type MachineConnectorSecretGrantBodyV1 = z.infer<typeof MachineConnectorSecretGrantBodyV1Schema>;
export const MachineConnectorSecretGrantInputV1Schema = z.discriminatedUnion('operation', [
    z.extend(connectorRead, { proof: MachineInstallationProofV1Schema }),
    z.extend(connectorSet, { proof: MachineInstallationProofV1Schema }),
    z.extend(connectorRemove, { proof: MachineInstallationProofV1Schema }),
]);
export type MachineConnectorSecretGrantInputV1 = z.infer<typeof MachineConnectorSecretGrantInputV1Schema>;
export const MachineConnectorSecretGrantResultV1Schema = z.union([
    z.strictObject({ ok: z.literal(true), grant: z.optional(MachineSecretGrantV1Schema) }),
    DeploymentActionFailureV1Schema,
    z.strictObject({ ok: z.literal(false), error: z.literal('secret_missing') }),
]);
export type MachineConnectorSecretGrantResultV1 = z.infer<typeof MachineConnectorSecretGrantResultV1Schema>;

export function computeEnvironmentSecretLaunchAdmissionDigestV1(body: EnvironmentSecretLaunchAdmissionBodyV1 | MachineConnectorSecretGrantBodyV1): string {
    return computeCanonicalDomainSeparatedDigest('happier-environment-secret-launch-v1', [createCanonicalJsonSigningInput(body)]);
}
