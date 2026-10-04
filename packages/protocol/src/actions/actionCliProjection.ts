import { z } from 'zod';

import { ActionInputHintsSchema } from './metadata.js';
import { ActionInputPathSchema } from './actionInputPredicates.js';
import type { ActionId } from './actionIds.js';

/**
 * The friendly command spelling an Action owns in *this* packaged CLI.
 *
 * It is deliberately not part of `serializeActionSpec`/`ActionDefinitionV1`:
 * command paths and binder functions describe one shipped binary's ergonomics,
 * not a cross-version wire contract, and remote discovery already publishes the
 * canonical JSON schema plus input hints that a third-party generator needs.
 */
const ActionCliCommandSegmentSchema = z
  .string()
  .regex(/^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/, 'Command segments are lowercase kebab-case or snake_case');

const ActionCliFlagNameSchema = z
  .string()
  .regex(/^(?:--[a-z][a-z0-9]*(?:-[a-z0-9]+)*|-[a-z])$/, 'Flags are lowercase kebab-case starting with -- or one lowercase short alias');

export const ActionCliCommandBindingSchema = z.object({
  path: z.array(ActionCliCommandSegmentSchema).min(1),
  /** Passive observation uses the same Action and its owner's change source. */
  observation: z.enum(['condition', 'changes']).optional(),
  /**
   * Caller-input paths supplied positionally, in argv order. They name fields of
   * the *effective CLI caller* schema — the `inputSchema` below when the Action
   * declares one, otherwise the canonical Action input.
   */
  positionals: z.array(ActionInputPathSchema).optional(),
  /**
   * One final caller field that receives every remaining positional word.
   * This preserves established commands such as `actions search query words`
   * without teaching the CLI host a command-specific argv parser.
   */
  variadicPositional: ActionInputPathSchema.optional(),
  visibility: z.enum(['canonical', 'alias', 'hidden']).default('canonical'),
  deprecated: z.object({
    replacement: z.string().min(1),
    removalCondition: z.string().min(1),
  }).strict().optional(),
}).strict();
export type ActionCliCommandBinding = z.infer<typeof ActionCliCommandBindingSchema>;

export type ActionCliBindContext = Readonly<{
  actionId: ActionId;
  invocationId: string;
  /** Caller presentation mode; binders may request data needed only by human output. */
  output?: 'human' | 'json';
}>;

/**
 * A pure caller-shape projection. It may reshape already parsed argv values into
 * canonical Action input and nothing else: it receives no credentials, no
 * authorization decision, no target resolver and no execution callback, and the
 * canonical Action schema validates whatever it returns.
 */
export type ActionCliBindInput = (
  value: unknown,
  context: ActionCliBindContext,
) => unknown;

const ACTION_CLI_DERIVED_DEFAULT = Symbol.for('happier.actionCli.derivedDefault');

/**
 * A value a binder supplies on the caller's behalf — an intent-derived run shape,
 * a generated local id, a presentation default — rather than one the caller typed.
 * The binder is the only owner that knows this provenance, so it states it here
 * instead of the composer guessing it from field spelling. When canonical
 * whole-input JSON already carries the field, the JSON value is kept; a value the
 * caller actually typed for that field is still a duplicate source and is refused.
 */
export type ActionCliDerivedDefault<T = unknown> = Readonly<{
  [ACTION_CLI_DERIVED_DEFAULT]: true;
  value: T;
}>;

export function actionCliDerivedDefault<T>(value: T): ActionCliDerivedDefault<T> {
  return Object.freeze({ [ACTION_CLI_DERIVED_DEFAULT]: true as const, value });
}

export function readActionCliDerivedDefault(value: unknown): Readonly<{ value: unknown }> | null {
  return typeof value === 'object'
    && value !== null
    && (value as Partial<ActionCliDerivedDefault>)[ACTION_CLI_DERIVED_DEFAULT] === true
    ? { value: (value as ActionCliDerivedDefault).value }
    : null;
}

const ActionCliBindInputSchema = z.custom<ActionCliBindInput>(
  (value) => typeof value === 'function',
  { message: 'Expected an Action CLI input binder' },
);

const ZodSchemaLike = z.custom<z.ZodTypeAny>((value) => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { safeParse?: unknown; parse?: unknown };
  return typeof candidate.safeParse === 'function' && typeof candidate.parse === 'function';
}, { message: 'Expected a Zod schema' });

export const ActionCliProjectionSchema = z.object({
  // Generic `actions invoke <id>` may own CLI policy without a friendly path.
  commands: z.array(ActionCliCommandBindingSchema),
  /** Accept the established CLI-only `--server-id` exact-Home selector. */
  acceptsServerId: z.literal(true).optional(),
  /** Refuse ambient active-Home selection; the caller must name an exact saved Home. */
  requiresServerId: z.literal(true).optional(),
  /** Apply an existing CLI request lifetime without making it Action input. */
  requestTimeout: z.enum(['session_control']).optional(),
  /** Caller schema when the friendly syntax differs from canonical Action input. */
  inputSchema: ZodSchemaLike.optional(),
  /**
   * Whole-object schema for `--input-json`. This is normally the canonical
   * Action input, but public CLI surfaces may deliberately expose a strict
   * subset while retaining canonical fields that have no friendly shorthand.
   */
  wholeInputSchema: ZodSchemaLike.optional(),
  inputHints: ActionInputHintsSchema.optional(),
  flagAliases: z.array(z.object({
    path: ActionInputPathSchema,
    aliases: z.array(ActionCliFlagNameSchema).min(1),
  }).strict()).optional(),
  bindInput: ActionCliBindInputSchema.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.requiresServerId && !value.acceptsServerId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'cli.requiresServerId requires cli.acceptsServerId',
      path: ['requiresServerId'],
    });
  }
  if (value.bindInput && !value.inputSchema) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'cli.bindInput requires a caller input schema',
      path: ['inputSchema'],
    });
  }
  const seenPaths = new Set<string>();
  for (const [index, command] of value.commands.entries()) {
    const key = command.path.join(' ');
    if (seenPaths.has(key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `cli.commands declares the path "${key}" twice`,
        path: ['commands', index, 'path'],
      });
    }
    seenPaths.add(key);
    const seenPositionals = new Set<string>();
    for (const [positionalIndex, positional] of (command.positionals ?? []).entries()) {
      if (seenPositionals.has(positional)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `cli.commands positional "${positional}" is supplied twice`,
          path: ['commands', index, 'positionals', positionalIndex],
        });
      }
      seenPositionals.add(positional);
    }
    if (command.variadicPositional && seenPositionals.has(command.variadicPositional)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `cli variadic positional "${command.variadicPositional}" is also a fixed positional`,
        path: ['commands', index, 'variadicPositional'],
      });
    }
  }
  const seenAliases = new Set<string>();
  for (const [index, entry] of (value.flagAliases ?? []).entries()) {
    for (const [aliasIndex, alias] of entry.aliases.entries()) {
      if (seenAliases.has(alias)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `cli.flagAliases declares ${alias} twice`,
          path: ['flagAliases', index, 'aliases', aliasIndex],
        });
      }
      seenAliases.add(alias);
    }
  }
});
export type ActionCliProjection = z.infer<typeof ActionCliProjectionSchema>;

/**
 * The top-level field names a caller schema declares, or `null` when the shape
 * is not a plain object (a union or a refined wrapper). `null` means "cannot be
 * checked here", not "no fields": the canonical Action schema still validates
 * the bound input, so declaration validation stays silent rather than guessing.
 */
export function readActionSchemaTopLevelFieldNames(
  schema: z.ZodTypeAny,
): ReadonlySet<string> | null {
  const shape = (schema as { shape?: unknown }).shape;
  if (!shape || typeof shape !== 'object') return null;
  return new Set(Object.keys(shape as Record<string, unknown>));
}

/** The canonical `--kebab-case` flag a top-level camelCase field is spelled as. */
export function actionCliFlagNameForField(field: string): string {
  return `--${field.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/_/g, '-').toLowerCase()}`;
}
