import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';

import { ConnectedAccountPurposeIdSchema } from '../../connect/connectedAccountPurposes.js';
import {
  QualifiedConnectedAccountPurposeBindingTargetV1Schema,
} from '../../connect/connectedAccountPurposeBindings.js';
import { PROVIDER_WIRE_PROTOCOL_LIMITS_V1 } from '../capabilities/v1.js';
import { ProviderConnectionIdSchema, ProviderContributionKeySchema, ProviderLocalIdSchema, ProviderMachineIdSchema, ProviderModelIdSchema } from '../ids.js';
import { CustomProviderTemplateV1Schema } from './customTemplateV1.js';
import { ProviderEndpointUrlSyntaxSchema } from '../endpointUrlSchema.js';

export const ProviderConnectionSourceV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('contribution'), contributionKey: ProviderContributionKeySchema }),
  z.strictObject({ kind: z.literal('custom'), template: CustomProviderTemplateV1Schema }),
]));
export type ProviderConnectionSourceV1 = z.infer<typeof ProviderConnectionSourceV1Schema>;

export const ProviderEndpointOverrideV1Schema = lazyZodSchema(() => z.strictObject({
  endpointTemplateId: ProviderLocalIdSchema,
  baseUrl: ProviderEndpointUrlSyntaxSchema,
}));
export type ProviderEndpointOverrideV1 = z.infer<typeof ProviderEndpointOverrideV1Schema>;

export const ProviderConnectionDeploymentV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('external') }),
  z.strictObject({ kind: z.literal('managedLocal') }),
]));
export type ProviderConnectionDeploymentV1 = z.infer<typeof ProviderConnectionDeploymentV1Schema>;

export const ProviderGatewayPlacementV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('sessionMachine') }),
  z.strictObject({ kind: z.literal('machine'), machineId: ProviderMachineIdSchema }),
]));
export type ProviderGatewayPlacementV1 = z.infer<typeof ProviderGatewayPlacementV1Schema>;

export const ProviderClaudeHelperModelsV1Schema = lazyZodSchema(() => z.strictObject({
  fast: z.optional(ProviderModelIdSchema),
  default: z.optional(ProviderModelIdSchema),
  strongest: z.optional(ProviderModelIdSchema),
}));
export type ProviderClaudeHelperModelsV1 = z.infer<typeof ProviderClaudeHelperModelsV1Schema>;

export const ProviderConnectionPurposeBindingDefaultsV1Schema = lazyZodSchema(() => z.record(
  ConnectedAccountPurposeIdSchema,
  QualifiedConnectedAccountPurposeBindingTargetV1Schema,
).check(z.superRefine((value, context) => {
  if (Object.keys(value).length > 256) {
    context.addIssue({
      code: 'custom',
      message: 'Too many Provider connected-account purpose defaults',
    });
  }
})));
export type ProviderConnectionPurposeBindingDefaultsV1 = z.infer<
  typeof ProviderConnectionPurposeBindingDefaultsV1Schema
>;

function uniqueOverrides(overrides: readonly ProviderEndpointOverrideV1[], ctx: z.core.$RefinementCtx, path: readonly (string | number)[]): void {
  const ids = new Set<string>();
  overrides.forEach((override, index) => {
    if (ids.has(override.endpointTemplateId)) ctx.addIssue({ code: 'custom', path: [...path, index, 'endpointTemplateId'], message: 'Duplicate endpoint override' });
    ids.add(override.endpointTemplateId);
  });
}

export const ProviderModelGenerationSettingsV1Schema = lazyZodSchema(() => z.strictObject({
  temperature: z.optional(z.nullable(z.number().check(z.minimum(0), z.maximum(2)))),
  maxTokens: z.optional(z.nullable(z.number().check(z.int()))),
}));

/** A per-model patch; null removes that model's overrides. Omitted fields retain intent. */
export const ProviderConnectionModelSettingsUpdateV1Schema = lazyZodSchema(() => z.record(
  ProviderModelIdSchema, z.nullable(ProviderModelGenerationSettingsV1Schema),
));

export const ProviderConnectionV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  id: ProviderConnectionIdSchema,
  source: ProviderConnectionSourceV1Schema,
  role: z.enum(['default', 'named']),
  displayName: z.string().check(z.trim(), z.minLength(1), z.maxLength(128)),
  displayNameMode: z.enum(['automatic', 'custom']),
  deployment: z._default(ProviderConnectionDeploymentV1Schema, { kind: 'external' }),
  // One override per declared endpoint, and a contribution declares one endpoint per wire
  // protocol. The persisted contract therefore follows the authoring bound: a smaller number
  // here would leave endpoints of an admitted Provider permanently un-overridable.
  endpointOverrides: z.optional(z.array(ProviderEndpointOverrideV1Schema).check(z.maxLength(PROVIDER_WIRE_PROTOCOL_LIMITS_V1.maxProtocolsPerDeclaration))),
  endpointOverridesByMachineId: z.optional(z.record(
    ProviderMachineIdSchema,
    z.array(ProviderEndpointOverrideV1Schema).check(z.maxLength(PROVIDER_WIRE_PROTOCOL_LIMITS_V1.maxProtocolsPerDeclaration)),
  )),
  purposeBindingDefaults: z.optional(ProviderConnectionPurposeBindingDefaultsV1Schema),
  gatewayPlacement: z.optional(ProviderGatewayPlacementV1Schema),
  claudeHelperModels: z.optional(ProviderClaudeHelperModelsV1Schema),
  modelSettings: z.optional(z.record(ProviderModelIdSchema, ProviderModelGenerationSettingsV1Schema)),
  revision: z.number().check(z.int(), z.nonnegative()),
  createdAt: z.number().check(z.nonnegative()),
  updatedAt: z.number().check(z.nonnegative()),
}).check(z.superRefine((value, ctx) => {
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
  } else {
    for (const field of ['purposeBindingDefaults', 'gatewayPlacement', 'claudeHelperModels'] as const) {
      if (value[field] !== undefined) ctx.addIssue({
        code: 'custom', path: [field], message: 'External deployment does not accept managed gateway configuration',
      });
    }
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
})));
export type ProviderConnectionV1 = z.infer<typeof ProviderConnectionV1Schema>;
