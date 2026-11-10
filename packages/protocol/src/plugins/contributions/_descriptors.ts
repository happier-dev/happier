import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

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

function rejectSecretValueKeys(value: unknown, ctx: z.core.$RefinementCtx, path: readonly (string | number)[] = []): void {
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
        code: "custom",
        path: [...path, key],
        message: `Plugin descriptors must not contain raw secret field '${key}'. Store secret values through ctx.secrets.`,
      });
      continue;
    }
    rejectSecretValueKeys(child, ctx, [...path, key]);
  }
}

export const PluginDescriptorClearWhenEmptyV1Schema = lazyZodSchema(() => z.enum(['omit', 'persist']));
export type PluginDescriptorClearWhenEmptyV1 = z.infer<typeof PluginDescriptorClearWhenEmptyV1Schema>;

export const PluginDescriptorRedactionV1Schema = lazyZodSchema(() => z.enum(['none', 'masked', 'secret']));
export type PluginDescriptorRedactionV1 = z.infer<typeof PluginDescriptorRedactionV1Schema>;

export const PluginDescriptorBaseV1Schema = lazyZodSchema(() => z.looseObject({
  id: z.string().check(z.trim(), z.minLength(1)),
  kind: z.string().check(z.trim(), z.minLength(1)),
  version: z.string().check(z.trim(), z.minLength(1)),
  displayKey: z.optional(z.string().check(z.trim(), z.minLength(1))),
  descriptionKey: z.optional(z.string().check(z.trim(), z.minLength(1))),
  groupId: z.optional(z.nullable(z.string().check(z.trim(), z.minLength(1)))),
  order: z.optional(z.number().check(z.int())),
  capabilityGates: z._default(z.array(z.string().check(z.trim(), z.minLength(1))), []),
  permissionGates: z._default(z.array(z.string().check(z.trim(), z.minLength(1))), []),
  redaction: z._default(PluginDescriptorRedactionV1Schema, 'none'),
  hidden: z._default(z.boolean(), false),
  defaultValue: z.optional(z.unknown()),
  clearWhenEmpty: z.optional(PluginDescriptorClearWhenEmptyV1Schema),
}).check(z.superRefine((value, ctx) => {
  rejectSecretValueKeys(value, ctx);
})));
export type PluginDescriptorBaseV1 = z.infer<typeof PluginDescriptorBaseV1Schema>;
