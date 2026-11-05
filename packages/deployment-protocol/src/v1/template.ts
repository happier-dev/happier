import { z } from 'zod/mini';
import { DeploymentTemplateV1Schema } from '@happier-dev/protocol/plugins/contributions/deploymentTemplates';
import { DeploymentTemplateRefV1Schema, DeploymentDigestV1Schema } from '@happier-dev/protocol/deployments/storedAppInputV1';
import { DeploymentEnvironmentUpdateInputV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { DeploymentRevisionV1Schema } from '@happier-dev/protocol/deployments/deploymentIdentifiersV1';

/** Private provenance only. Definition owns Compose; bindings own all credential references. */
export const DeploymentEnvironmentTemplateProvenanceV1Schema = z.strictObject({
    templateRef: DeploymentTemplateRefV1Schema,
    definition: z.strictObject({ kind: z.literal('stored'), contentRevision: DeploymentRevisionV1Schema, composeDigest: DeploymentDigestV1Schema }),
    services: z.array(z.string().check(z.minLength(1))),
    health: DeploymentTemplateV1Schema.shape.health,
    data: DeploymentTemplateV1Schema.shape.data,
    exports: DeploymentTemplateV1Schema.shape.exports,
    loginFields: DeploymentTemplateV1Schema.shape.loginFields,
    firstRunSetup: DeploymentTemplateV1Schema.shape.firstRunSetup,
});
export type DeploymentEnvironmentTemplateProvenanceV1 = z.infer<typeof DeploymentEnvironmentTemplateProvenanceV1Schema>;

/** Instantiation's private metadata CAS transport; a caller cannot acquire another writer with a flag. */
export const DeploymentEnvironmentTemplateSetInputV1Schema = z.omit(DeploymentEnvironmentUpdateInputV1Schema, { patch: true });
export type DeploymentEnvironmentTemplateSetInputV1 = z.infer<typeof DeploymentEnvironmentTemplateSetInputV1Schema>;
