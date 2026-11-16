import { defineProtocolObject, defineProtocolString } from '@happier-dev/plugin-sdk/protocol';
import type { ProtocolSchemaOutput } from '@happier-dev/plugin-sdk/protocol';
import { defineMachineProvisionerSchemas, defineMachineProvisionerReconciliationSchemas, prepareMachineProvisionerStoredSchemas } from '@happier-dev/plugin-sdk/machine-provisioners';

// sbx v0.46.0 `create --help`: at least two characters, letter/digit first,
// then letters/digits/hyphens/periods; the exact name `default` is reserved.
export const DockerSandboxesNameSchema = defineProtocolString({
  pattern: '^(?!default$)[A-Za-z0-9][A-Za-z0-9.-]+$',
});

export const DockerSandboxesLaunchV1Schema = defineProtocolObject({
  templateId: defineProtocolString({ minLength: 1 }),
  name: DockerSandboxesNameSchema,
}, { policy: 'closed' });

// Local sbx v0.46.0 addresses resources by name. Managed acquisition derives
// this name from the durable host row; an opaque cloud sandbox ID is a different
// native contract and is deliberately absent from this local resource shape.
export const DockerSandboxesResourceV1Schema = defineProtocolObject({
  sandboxName: DockerSandboxesNameSchema,
}, { policy: 'closed' });

export const DOCKER_SANDBOXES_PREPARATION_BUILDER_PREFIX = 'happier-prepared-';
export const DOCKER_SANDBOXES_PREPARATION_TEMPLATE_PREFIX = 'happier-prepared:';
const operationIdPattern = '[a-z0-9](?:[a-z0-9-]*[a-z0-9])?';
// sbx 0.53.0 create --help: native sandbox names have at most 63 characters.
const operationIdMaxLength = 63 - DOCKER_SANDBOXES_PREPARATION_BUILDER_PREFIX.length;
export const DockerSandboxesPreparationOperationSchema = defineProtocolObject({
  operationId: defineProtocolString({ pattern: `^${operationIdPattern}$`, maxLength: operationIdMaxLength }),
}, { policy: 'closed' });
export const DockerSandboxesPreparationInputSchema = defineProtocolObject({
  templateId: defineProtocolString({ minLength: 1 }), setupScript: defineProtocolString({ minLength: 1 }),
}, { policy: 'closed' });
export const DockerSandboxesPreparedArtifactSchema = defineProtocolObject({
  templateId: defineProtocolString({ pattern: `^${DOCKER_SANDBOXES_PREPARATION_TEMPLATE_PREFIX}${operationIdPattern}$`,
    maxLength: DOCKER_SANDBOXES_PREPARATION_TEMPLATE_PREFIX.length + operationIdMaxLength }),
}, { policy: 'closed' });
export function isDockerSandboxesPreparedTemplateId(templateId: string) {
  return DockerSandboxesPreparedArtifactSchema.safeParse({ templateId }).success;
}

export const DOCKER_SANDBOXES_ROLE_SCHEMAS = defineMachineProvisionerSchemas({
  launch: DockerSandboxesLaunchV1Schema, resource: DockerSandboxesResourceV1Schema,
});
export const DOCKER_SANDBOXES_RECONCILIATION_SCHEMAS = defineMachineProvisionerReconciliationSchemas({
  launch: DockerSandboxesLaunchV1Schema, resource: DockerSandboxesResourceV1Schema, nativeOperation: DockerSandboxesResourceV1Schema,
});

// Preparation is demanded by retained-data consumers, never cold discovery.
export const prepareDockerSandboxesStoredSchemas = () => prepareMachineProvisionerStoredSchemas({
  launch: DockerSandboxesLaunchV1Schema, resource: DockerSandboxesResourceV1Schema, nativeOperation: DockerSandboxesResourceV1Schema,
});

export type DockerSandboxesLaunchV1 = ProtocolSchemaOutput<typeof DockerSandboxesLaunchV1Schema>;
export type DockerSandboxesResourceV1 = ProtocolSchemaOutput<typeof DockerSandboxesResourceV1Schema>;
