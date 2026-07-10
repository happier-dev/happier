import { z } from 'zod';

import { ProviderConnectionIdSchema, ProviderContributionKeySchema, ProviderLocalIdSchema, ProviderMachineIdSchema } from '../ids.js';
import { CustomProviderTemplateV1Schema } from './customTemplateV1.js';
import { ProviderEndpointUrlSyntaxSchema } from '../endpointUrlSchema.js';
import { PROVIDER_SETTINGS_LIMITS_V1 } from '../settings/limits.js';

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
  endpointOverrides: z.array(ProviderEndpointOverrideV1Schema).max(4).optional(),
  endpointOverridesByMachineId: z.record(ProviderMachineIdSchema, z.array(ProviderEndpointOverrideV1Schema).max(4)).optional(),
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
  uniqueOverrides(value.endpointOverrides ?? [], ctx, ['endpointOverrides']);
  for (const [machineId, overrides] of Object.entries(value.endpointOverridesByMachineId ?? {})) {
    uniqueOverrides(overrides, ctx, ['endpointOverridesByMachineId', machineId]);
  }
  if (Object.keys(value.endpointOverridesByMachineId ?? {}).length > PROVIDER_SETTINGS_LIMITS_V1.machinesPerConnection) {
    ctx.addIssue({ code: 'custom', path: ['endpointOverridesByMachineId'], message: 'Too many machine endpoint-override branches' });
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
