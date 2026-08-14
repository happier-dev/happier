import { z } from 'zod';

import { ProviderCatalogProbeV1Schema } from '../catalog/descriptorV1.js';
import { ProviderLocalIdSchema } from '../ids.js';

function isLiteralCommandToken(value: string): boolean {
  return !/[\u0000-\u001f\u007f]/u.test(value)
    && !/[;&|`$<>]/u.test(value)
    && !/^[A-Za-z_][A-Za-z0-9_]*=/u.test(value);
}

const BoundedTokenSchema = z.string().trim().min(1).max(256).refine(
  isLiteralCommandToken,
  'Command token must be literal and control/operator free',
);
const ExecutableLookupNameSchema = z.string().trim().min(1).max(256).refine(
  (value) => value !== '.' && value !== '..' && !value.includes('/') && !value.includes('\\')
    && isLiteralCommandToken(value),
  'Executable lookup names must be PATH/application basenames, not paths',
);
const LookupNamesSchema = z.array(ExecutableLookupNameSchema).min(1).max(16);
const EnvironmentVariableNameSchema = z.string().min(1).max(128).regex(/^[A-Za-z_][A-Za-z0-9_]*$/u);

export const ProviderCatalogCommandFallbackV1Schema = z.object({
  endpointTemplateId: ProviderLocalIdSchema,
  lookupNames: LookupNamesSchema,
  fixedArgs: z.array(BoundedTokenSchema).max(32),
  parser: z.literal('ollama-list-table'),
  endpointEnvName: EnvironmentVariableNameSchema.optional(),
}).strict();
export type ProviderCatalogCommandFallbackV1 = z.infer<typeof ProviderCatalogCommandFallbackV1Schema>;

export const ProviderDetectionDescriptorV1Schema = z.object({
  v: z.literal(1),
  listener: z.object({
    executableBasenames: z.array(z.string().trim().min(1).max(128).regex(/^[^/\\\u0000-\u001f]+$/u)).min(1).max(32),
    argvMatch: z.object({
      mode: z.enum(['containsAll', 'orderedSubsequence']),
      tokens: z.array(BoundedTokenSchema).min(1).max(32),
    }).strict().optional(),
    defaultPorts: z.array(z.number().int().min(1).max(65535)).max(16),
  }).strict(),
  availabilityProbe: ProviderCatalogProbeV1Schema,
  installedCheck: z.object({ lookupNames: LookupNamesSchema }).strict().optional(),
  presenceCheck: z.object({
    lookupNames: LookupNamesSchema,
    fixedArgs: z.array(BoundedTokenSchema).max(32),
    parser: z.enum(['exit-zero-running', 'lms-status-json']),
  }).strict().optional(),
  catalogFallback: ProviderCatalogCommandFallbackV1Schema.optional(),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.listener.executableBasenames.map((entry) => entry.toLowerCase())).size !== value.listener.executableBasenames.length) {
    ctx.addIssue({ code: 'custom', path: ['listener', 'executableBasenames'], message: 'Executable basenames must be unique' });
  }
  if (new Set(value.listener.defaultPorts).size !== value.listener.defaultPorts.length) {
    ctx.addIssue({ code: 'custom', path: ['listener', 'defaultPorts'], message: 'Default ports must be unique' });
  }
});
export type ProviderDetectionDescriptorV1 = z.infer<typeof ProviderDetectionDescriptorV1Schema>;
