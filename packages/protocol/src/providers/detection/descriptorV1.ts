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

/**
 * The command-output catalog formats Happier bundles an implementation for.
 * This list answers only "does the host already implement this format"; it
 * never decides whether a declared format is valid. A Provider plugin
 * contributes its own command-output format through the `providers`
 * contribution family, exactly like a bundled Provider does, and implements it
 * with the same registered catalog parser it uses for HTTP catalog formats.
 */
export const BUNDLED_PROVIDER_COMMAND_CATALOG_PARSERS_V1 = Object.freeze([
  'ollama-list-table',
] as const);

export const BundledProviderCommandCatalogParserV1Schema = z.enum(
  BUNDLED_PROVIDER_COMMAND_CATALOG_PARSERS_V1,
);
export type BundledProviderCommandCatalogParserV1 = z.infer<
  typeof BundledProviderCommandCatalogParserV1Schema
>;

/**
 * An open command-output catalog-format identifier: a bundled format, or any
 * format a currently installed Provider plugin contributes. Never narrow this
 * to the bundled set to reject an id or gate a capability.
 */
export type ProviderCommandCatalogParserV1 =
  | BundledProviderCommandCatalogParserV1
  | (string & {});

export const ProviderCommandCatalogParserV1Schema:
  z.ZodType<ProviderCommandCatalogParserV1, ProviderCommandCatalogParserV1> = ProviderLocalIdSchema;

const BUNDLED_PROVIDER_COMMAND_CATALOG_PARSER_IDS: ReadonlySet<string> = new Set(
  BUNDLED_PROVIDER_COMMAND_CATALOG_PARSERS_V1,
);

/**
 * Answers only whether the host bundles an implementation for this format.
 * A `false` result means "no bundled implementation", never "invalid format".
 */
export function isBundledProviderCommandCatalogParserV1(
  parser: ProviderCommandCatalogParserV1,
): parser is BundledProviderCommandCatalogParserV1 {
  return BUNDLED_PROVIDER_COMMAND_CATALOG_PARSER_IDS.has(parser);
}

/**
 * Read a bundled command-output catalog-format fact by an open format id.
 *
 * Bundled fact records are exhaustive over the bundled formats only. A
 * contributed format has no entry, so the lookup reports a typed unavailable
 * instead of borrowing another format's fact.
 */
export function readBundledProviderCommandCatalogParserFactV1<T>(
  factsByParser: Readonly<Record<BundledProviderCommandCatalogParserV1, T>>,
  parser: ProviderCommandCatalogParserV1,
): T | null {
  return isBundledProviderCommandCatalogParserV1(parser) ? factsByParser[parser] : null;
}

export const ProviderCatalogCommandFallbackV1Schema = z.object({
  endpointTemplateId: ProviderLocalIdSchema,
  lookupNames: LookupNamesSchema,
  fixedArgs: z.array(BoundedTokenSchema).max(32),
  parser: ProviderCommandCatalogParserV1Schema,
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
