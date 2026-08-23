import { z } from 'zod';

import { ConnectedAccountPurposeIdSchema } from '../../connect/connectedAccountPurposes.js';
import {
  QualifiedConnectedAccountPurposeBindingTargetV1Schema,
} from '../../connect/connectedAccountPurposeBindings.js';
import { PROVIDER_WIRE_PROTOCOL_LIMITS_V1 } from '../capabilities/v1.js';
import { ProviderConnectionIdSchema, ProviderContributionKeySchema, ProviderLocalIdSchema, ProviderMachineIdSchema } from '../ids.js';
import { CustomProviderTemplateV1Schema } from './customTemplateV1.js';
import { ProviderEndpointUrlSyntaxSchema } from '../endpointUrlSchema.js';

export const ProviderConnectionSourceV1Schema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('contribution'), contributionKey: ProviderContributionKeySchema }).strict(),
  z.object({ kind: z.literal('custom'), template: CustomProviderTemplateV1Schema }).strict(),
]);
export type ProviderConnectionSourceV1 = z.infer<typeof ProviderConnectionSourceV1Schema>;

export const ProviderEndpointOverrideV1Schema = z.object({
  endpointTemplateId: ProviderLocalIdSchema,
  baseUrl: ProviderEndpointUrlSyntaxSchema,
}).strict();
export type ProviderEndpointOverrideV1 = z.infer<typeof ProviderEndpointOverrideV1Schema>;

export const ProviderConnectionDeploymentV1Schema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('external') }).strict(),
  z.object({ kind: z.literal('managedLocal') }).strict(),
]);
export type ProviderConnectionDeploymentV1 = z.infer<typeof ProviderConnectionDeploymentV1Schema>;

export const ProviderConnectionPurposeBindingDefaultsV1Schema = z.record(
  ConnectedAccountPurposeIdSchema,
  QualifiedConnectedAccountPurposeBindingTargetV1Schema,
).superRefine((value, context) => {
  if (Object.keys(value).length > 256) {
    context.addIssue({
      code: 'custom',
      message: 'Too many Provider connected-account purpose defaults',
    });
  }
});
export type ProviderConnectionPurposeBindingDefaultsV1 = z.infer<
  typeof ProviderConnectionPurposeBindingDefaultsV1Schema
>;

function uniqueOverrides(overrides: readonly ProviderEndpointOverrideV1[], ctx: z.RefinementCtx, path: readonly (string | number)[]): void {
  const ids = new Set<string>();
  overrides.forEach((override, index) => {
    if (ids.has(override.endpointTemplateId)) ctx.addIssue({ code: 'custom', path: [...path, index, 'endpointTemplateId'], message: 'Duplicate endpoint override' });
    ids.add(override.endpointTemplateId);
  });
}

export const ProviderConnectionV1Schema = z.object({
  v: z.literal(1),
  id: ProviderConnectionIdSchema,
  source: ProviderConnectionSourceV1Schema,
  role: z.enum(['default', 'named']),
  displayName: z.string().trim().min(1).max(128),
  displayNameMode: z.enum(['automatic', 'custom']),
  deployment: ProviderConnectionDeploymentV1Schema.default({ kind: 'external' }),
  // One override per declared endpoint, and a contribution declares one endpoint per wire
  // protocol. The persisted contract therefore follows the authoring bound: a smaller number
  // here would leave endpoints of an admitted Provider permanently un-overridable.
  endpointOverrides: z.array(ProviderEndpointOverrideV1Schema)
    .max(PROVIDER_WIRE_PROTOCOL_LIMITS_V1.maxProtocolsPerDeclaration).optional(),
  endpointOverridesByMachineId: z.record(
    ProviderMachineIdSchema,
    z.array(ProviderEndpointOverrideV1Schema)
      .max(PROVIDER_WIRE_PROTOCOL_LIMITS_V1.maxProtocolsPerDeclaration),
  ).optional(),
  purposeBindingDefaults: ProviderConnectionPurposeBindingDefaultsV1Schema.optional(),
  revision: z.number().int().nonnegative(),
  createdAt: z.number().finite().nonnegative(),
  updatedAt: z.number().finite().nonnegative(),
}).strict().superRefine((value, ctx) => {
  if ((value.role === 'named' || value.source.kind === 'custom') && value.displayNameMode !== 'custom') {
    ctx.addIssue({ code: 'custom', path: ['displayNameMode'], message: 'Named and custom connections require a custom display name' });
  }
  if (value.source.kind === 'custom' && value.role !== 'named') {
    ctx.addIssue({ code: 'custom', path: ['role'], message: 'Custom connections must be named' });
  }
  if (value.deployment.kind === 'managedLocal') {
    if (value.source.kind !== 'contribution') {
      ctx.addIssue({ code: 'custom', path: ['deployment'], message: 'Managed deployment requires a contribution-backed connection' });
    }
    if (value.endpointOverrides !== undefined || value.endpointOverridesByMachineId !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['deployment'], message: 'Managed deployment does not accept endpoint overrides' });
    }
  } else if (value.purposeBindingDefaults !== undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['purposeBindingDefaults'],
      message: 'External deployment does not accept managed connected-account purpose defaults',
    });
  }
  uniqueOverrides(value.endpointOverrides ?? [], ctx, ['endpointOverrides']);
  for (const [machineId, overrides] of Object.entries(value.endpointOverridesByMachineId ?? {})) {
    uniqueOverrides(overrides, ctx, ['endpointOverridesByMachineId', machineId]);
  }
  if (value.source.kind === 'custom') {
    const declaredEndpointIds = new Set(value.source.template.endpointTemplates.map((endpoint) => endpoint.id));
    value.endpointOverrides?.forEach((override, index) => {
      if (!declaredEndpointIds.has(override.endpointTemplateId)) {
        ctx.addIssue({ code: 'custom', path: ['endpointOverrides', index, 'endpointTemplateId'], message: 'Custom endpoint override references an undeclared template' });
      }
    });
    for (const [machineId, overrides] of Object.entries(value.endpointOverridesByMachineId ?? {})) {
      overrides.forEach((override, index) => {
        if (!declaredEndpointIds.has(override.endpointTemplateId)) {
          ctx.addIssue({
            code: 'custom',
            path: ['endpointOverridesByMachineId', machineId, index, 'endpointTemplateId'],
            message: 'Custom endpoint override references an undeclared template',
          });
        }
      });
    }
  }
  if (value.updatedAt < value.createdAt) ctx.addIssue({ code: 'custom', path: ['updatedAt'], message: 'updatedAt must not precede createdAt' });
});
export type ProviderConnectionV1 = z.infer<typeof ProviderConnectionV1Schema>;
