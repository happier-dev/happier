import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { readRecord } from '../inputs/inputRecords.js';
import { DeploymentRetainPreviousDeploymentsV1Schema } from '../projects/deploymentCreationDefaultsV1.js';
import { DeploymentComposeDefinitionInputV1Schema, DeploymentIngressV1Schema,
    DeploymentPrivateServiceExportsV1Schema, OwnServerEnvironmentReleasePolicyV1Schema,
    OwnServerEnvironmentMigrationPolicyV1Schema } from './storedAppInputV1.js';
import { DeploymentPreviewTemplateV1Schema } from './deploymentPreviewTemplateV1.js';
import { DeploymentBindingsPatchV1Schema } from './deploymentBindingPatchV1.js';

/** Content authoring operands share one schema and classification across admission and preparation. */
export const DeploymentEnvironmentContentPatchV1Schema = lazyZodSchema(() => z.strictObject({
    ingress: z.optional(z.nullable(DeploymentIngressV1Schema)),
    ownServer: z.optional(z.strictObject({ ...z.partial(OwnServerEnvironmentReleasePolicyV1Schema).shape,
        ...OwnServerEnvironmentMigrationPolicyV1Schema.shape,
        migration: z.optional(z.nullable(OwnServerEnvironmentMigrationPolicyV1Schema.shape.migration)),
        serviceExports: z.optional(DeploymentPrivateServiceExportsV1Schema) })),
    definition: z.optional(DeploymentComposeDefinitionInputV1Schema),
    bindings: z.optional(DeploymentBindingsPatchV1Schema),
    retainPreviousDeployments: z.optional(DeploymentRetainPreviousDeploymentsV1Schema),
    previewTemplate: z.optional(z.nullable(DeploymentPreviewTemplateV1Schema)),
}));

/** These authored leaves travel only in the private invocation and prepared Artifact. */
export const deploymentEnvironmentPrivateContentPatchFieldsV1 = { previewTemplate: true, definition: true, bindings: true } as const;

type MetadataPatch<T extends object> = Omit<T, keyof typeof deploymentEnvironmentPrivateContentPatchFieldsV1 | 'ownServer'> & {
    ownServer?: T extends { ownServer?: infer Policy } ? Omit<NonNullable<Policy>, 'serviceExports' | 'migration'> : never;
};

export function omitDeploymentEnvironmentPrivateContentPatchV1<T extends object>(patch: T): MetadataPatch<T> {
    const metadata = Object.fromEntries(Object.entries(patch).filter(([key]) =>
        !Object.hasOwn(deploymentEnvironmentPrivateContentPatchFieldsV1, key)));
    const ownServer = readRecord(metadata.ownServer);
    if (Object.hasOwn(ownServer, 'serviceExports') || Object.hasOwn(ownServer, 'migration')) {
        const { serviceExports: _exports, migration: _migration, ...policy } = ownServer;
        if (Object.keys(policy).length > 0) metadata.ownServer = policy;
        else delete metadata.ownServer;
    }
    return metadata as MetadataPatch<T>;
}

export function hasDeploymentEnvironmentContentPatchV1(patch: unknown): boolean {
    const value = readRecord(patch);
    return Object.keys(DeploymentEnvironmentContentPatchV1Schema.shape).some(key => value[key] !== undefined);
}
