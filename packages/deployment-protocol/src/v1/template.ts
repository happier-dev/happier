import { z } from 'zod/mini';
import { DeploymentTemplateDataV1Schema, DeploymentTemplateV1Schema } from '@happier-dev/protocol/plugins/contributions/deploymentTemplates';
import { DeploymentTemplateRefV1Schema, DeploymentDigestV1Schema, DeploymentRepositoryDefinitionV1Schema } from '@happier-dev/protocol/deployments/storedAppInputV1';
import { DeploymentEnvironmentUpdateInputV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { DeploymentRevisionV1Schema } from '@happier-dev/protocol/deployments/deploymentIdentifiersV1';

// Current Environment artifacts may contain the scalar written before multiple database additions.
// Normalize that stored input once; every live consumer receives the same service inventory.
const databaseInventory = z.union([z.array(DeploymentTemplateDataV1Schema), DeploymentTemplateDataV1Schema]);

/** Private provenance only. Definition owns Compose; bindings own all credential references. */
export const DeploymentEnvironmentTemplateProvenanceV1Schema = z.strictObject({
    templateRef: DeploymentTemplateRefV1Schema,
    definition: z.union([
        z.strictObject({ kind: z.literal('stored'), contentRevision: DeploymentRevisionV1Schema, composeDigest: DeploymentDigestV1Schema }),
        DeploymentRepositoryDefinitionV1Schema,
    ]),
    services: z.array(z.string().check(z.minLength(1))),
    health: DeploymentTemplateV1Schema.shape.health,
    volumes: z.optional(DeploymentTemplateV1Schema.shape.volumes),
    data: z.optional(z.pipe(databaseInventory, z.transform((data: z.infer<typeof databaseInventory>) => Array.isArray(data) ? data : [data]))),
    exports: DeploymentTemplateV1Schema.shape.exports,
    loginFields: DeploymentTemplateV1Schema.shape.loginFields,
    firstRunSetup: DeploymentTemplateV1Schema.shape.firstRunSetup,
});
export type DeploymentEnvironmentTemplateProvenanceV1 = z.infer<typeof DeploymentEnvironmentTemplateProvenanceV1Schema>;

/** Instantiation's private metadata CAS transport; a caller cannot acquire another writer with a flag. */
export const DeploymentEnvironmentTemplateSetInputV1Schema = z.omit(DeploymentEnvironmentUpdateInputV1Schema, { patch: true });
export type DeploymentEnvironmentTemplateSetInputV1 = z.infer<typeof DeploymentEnvironmentTemplateSetInputV1Schema>;
