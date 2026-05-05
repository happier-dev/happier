import { z } from 'zod';

const FORBIDDEN_DESCRIPTOR_VALUE_KEYS = new Set([
  'apikey',
  'accesstoken',
  'clientsecret',
  'oauthclientsecret',
  'personalaccesstoken',
  'pat',
  'refreshtoken',
  'token',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeDescriptorValueKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
}

function rejectSecretValueKeys(value: unknown, ctx: z.RefinementCtx, path: readonly (string | number)[] = []): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => rejectSecretValueKeys(entry, ctx, [...path, index]));
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_DESCRIPTOR_VALUE_KEYS.has(normalizeDescriptorValueKey(key))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, key],
        message: `Plugin descriptors must not contain raw secret field '${key}'. Store secret values through ctx.secrets.`,
      });
      continue;
    }
    rejectSecretValueKeys(child, ctx, [...path, key]);
  }
}

export const PluginDescriptorClearWhenEmptyV1Schema = z.enum(['omit', 'persist']);
export type PluginDescriptorClearWhenEmptyV1 = z.infer<typeof PluginDescriptorClearWhenEmptyV1Schema>;

export const PluginDescriptorRedactionV1Schema = z.enum(['none', 'masked', 'secret']);
export type PluginDescriptorRedactionV1 = z.infer<typeof PluginDescriptorRedactionV1Schema>;

export const PluginDescriptorBaseV1Schema = z.object({
  id: z.string().trim().min(1),
  kind: z.string().trim().min(1),
  version: z.string().trim().min(1),
  displayKey: z.string().trim().min(1).optional(),
  descriptionKey: z.string().trim().min(1).optional(),
  groupId: z.string().trim().min(1).nullable().optional(),
  order: z.number().int().optional(),
  capabilityGates: z.array(z.string().trim().min(1)).default([]),
  permissionGates: z.array(z.string().trim().min(1)).default([]),
  redaction: PluginDescriptorRedactionV1Schema.default('none'),
  hidden: z.boolean().default(false),
  defaultValue: z.unknown().optional(),
  clearWhenEmpty: PluginDescriptorClearWhenEmptyV1Schema.optional(),
}).passthrough().superRefine((value, ctx) => {
  rejectSecretValueKeys(value, ctx);
});
export type PluginDescriptorBaseV1 = z.infer<typeof PluginDescriptorBaseV1Schema>;
