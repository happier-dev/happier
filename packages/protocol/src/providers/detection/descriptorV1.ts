import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';

import { ProviderCatalogProbeV1Schema } from '../catalog/descriptorV1.js';
import { ProviderLocalIdSchema } from '../ids.js';

function isLiteralCommandToken(value: string): boolean {
  return !/[\u0000-\u001f\u007f]/u.test(value);
}

const BoundedTokenSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(256), z.refine(isLiteralCommandToken, 'Command token must be control free')));
const ExecutableLookupNameSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(256), z.refine((value) => value !== '.' && value !== '..' && !value.includes('/') && !value.includes('\\')
    && isLiteralCommandToken(value), 'Executable lookup names must be PATH/application basenames, not paths')));
const LookupNamesSchema = lazyZodSchema(() => z.array(ExecutableLookupNameSchema).check(z.minLength(1), z.maxLength(16)));
const EnvironmentVariableNameSchema = lazyZodSchema(() => z.string().check(z.minLength(1), z.maxLength(128), z.regex(/^[A-Za-z_][A-Za-z0-9_]*$/u)));

/** Open identifier for a command-output format implemented by its declaring Provider. */
export type ProviderCommandCatalogParserV1 = string & {};

export const ProviderCommandCatalogParserV1Schema:
  z.ZodMiniType<ProviderCommandCatalogParserV1, ProviderCommandCatalogParserV1> = ProviderLocalIdSchema;

export const ProviderCatalogCommandFallbackV1Schema = lazyZodSchema(() => z.strictObject({
  endpointTemplateId: ProviderLocalIdSchema,
  lookupNames: LookupNamesSchema,
  fixedArgs: z.array(BoundedTokenSchema).check(z.maxLength(32)),
  parser: ProviderCommandCatalogParserV1Schema,
  endpointEnvName: z.optional(EnvironmentVariableNameSchema),
}));
export type ProviderCatalogCommandFallbackV1 = z.infer<typeof ProviderCatalogCommandFallbackV1Schema>;

export const ProviderDetectionDescriptorV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  listener: z.strictObject({
    executableBasenames: z.array(z.string().check(z.trim(), z.minLength(1), z.maxLength(128), z.regex(/^[^/\\\u0000-\u001f]+$/u))).check(z.minLength(1), z.maxLength(32)),
    argvMatch: z.optional(z.strictObject({
      mode: z.enum(['containsAll', 'orderedSubsequence']),
      tokens: z.array(BoundedTokenSchema).check(z.minLength(1), z.maxLength(32)),
    })),
    defaultPorts: z.array(z.number().check(z.int(), z.minimum(1), z.maximum(65535))).check(z.maxLength(16)),
  }),
  availabilityProbe: ProviderCatalogProbeV1Schema,
  installedCheck: z.optional(z.strictObject({ lookupNames: LookupNamesSchema })),
  /**
   * An optional local-readiness shortcut. This vocabulary is deliberately
   * closed and is not a capability gate: `exit-zero-running` is the general
   * mechanism and is available identically to every Provider plugin, bundled or
   * external, while `lms-status-json` is a bundled convenience for one CLI
   * whose exit code is not a readiness signal. The fully general readiness
   * declaration is the required `availabilityProbe` above, whose catalog format
   * is open and plugin-implementable. Replace this with a declarative success
   * criterion if a plugin ever needs a readiness signal that neither an exit
   * code nor an availability probe can express.
   */
  presenceCheck: z.optional(z.strictObject({
    lookupNames: LookupNamesSchema,
    fixedArgs: z.array(BoundedTokenSchema).check(z.maxLength(32)),
    parser: z.enum(['exit-zero-running', 'lms-status-json']),
  })),
  catalogFallback: z.optional(ProviderCatalogCommandFallbackV1Schema),
}).check(z.superRefine((value, ctx) => {
  if (new Set(value.listener.executableBasenames.map((entry) => entry.toLowerCase())).size !== value.listener.executableBasenames.length) {
    ctx.addIssue({ code: 'custom', path: ['listener', 'executableBasenames'], message: 'Executable basenames must be unique' });
  }
  if (new Set(value.listener.defaultPorts).size !== value.listener.defaultPorts.length) {
    ctx.addIssue({ code: 'custom', path: ['listener', 'defaultPorts'], message: 'Default ports must be unique' });
  }
})));
export type ProviderDetectionDescriptorV1 = z.infer<typeof ProviderDetectionDescriptorV1Schema>;
