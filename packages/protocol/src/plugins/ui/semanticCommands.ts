import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

import {
  PluginContributionIdentityV1Schema,
  PluginContributionLocalIdSchema,
  type PluginContributionIdentityV1,
} from '../contributionIdentity.js';
import { PluginIdSchema } from '../pluginId.js';
import {
  defineProtocolJsonValue,
  defineProtocolLiteral,
  defineProtocolObject,
  defineProtocolUnion,
  defineProtocolUtf8String,
  type ProtocolComposableSchema,
} from '../actions/protocolComposableSchema.js';
import { asProtocolZod } from '../actions/internalProtocolZodAdapter.js';
import type { PluginUiJsonValueV1 } from '../contributions/ui/json.js';

const PluginContributionIdentityV1ZodSchema = asProtocolZod(PluginContributionIdentityV1Schema);
const PluginContributionLocalIdZodSchema = asProtocolZod(PluginContributionLocalIdSchema);
const PluginIdZodSchema = asProtocolZod(PluginIdSchema);

/** The bound on `openSurface(view, input)` launch input. */
export const PLUGIN_UI_LAUNCH_INPUT_MAX_UTF8_BYTES_V1 = 8_192;

/** A bounded `openSurface` launch-input value. */
const launchInput = defineProtocolJsonValue({
  maxSerializedUtf8Bytes: PLUGIN_UI_LAUNCH_INPUT_MAX_UTF8_BYTES_V1,
});
export const PluginUiLaunchInputV1Schema = asProtocolZod(launchInput);
export type PluginUiLaunchInputV1 = PluginUiJsonValueV1;

/** The bound on a full-page destination's plugin-local location. */
export const PLUGIN_UI_SUB_PATH_MAX_UTF8_BYTES_V1 = 1_024;

// Validate the authored spelling. Slash canonicalization belongs to the
// navigation operation, not to a data-only composable command boundary.
const subPath = defineProtocolUtf8String({
  maxUtf8Bytes: PLUGIN_UI_SUB_PATH_MAX_UTF8_BYTES_V1,
  pattern: '^(?![\\s\\S]*(?:^|/)\\.{1,2}(?:/|$))[^\\u0000-\\u001f\\u007f]*$(?![\\s\\S])',
});

/** Canonicalize a plugin-local sub-path without permitting namespace escape. */
export function normalizePluginUiSubPathV1(value: string): string | null {
  if (!subPath.safeParse(value).success) return null;
  const segments = value.split('/').filter((segment) => segment.length > 0);
  return segments.join('/');
}

/** A canonical plugin-local sub-path. Parsing normalizes; it never truncates. */
export const PluginUiSubPathV1Schema = lazyZodSchema(() => z.string().transform((value, ctx) => {
  const normalized = normalizePluginUiSubPathV1(value);
  if (normalized === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Plugin UI sub-path is not a legal plugin-local location.',
    });
    return z.NEVER;
  }
  return normalized;
}));
export type PluginUiSubPathV1 = string;

/** Instance identity is bounded and opaque to the host's route/pane owner. */
export const PLUGIN_UI_INSTANCE_KEY_MAX_UTF8_BYTES_V1 = 256;
const instanceKey = defineProtocolUtf8String({
  minLength: 1,
  maxUtf8Bytes: PLUGIN_UI_INSTANCE_KEY_MAX_UTF8_BYTES_V1,
  pattern: '^(?!\\s)[\\s\\S]*\\S$(?![\\s\\S])',
});
export const PluginUiInstanceKeyV1Schema = asProtocolZod(instanceKey);
export type PluginUiInstanceKeyV1 = z.infer<typeof PluginUiInstanceKeyV1Schema>;

/**
 * Semantic chrome Action declarations are same-plugin author input. Surface
 * declarations accept either that local-id sugar or one exact qualified
 * destination, then normalize once at the compiled projection boundary. This
 * leaf stays independent of host request envelopes and surface context so
 * contribution schemas can use it without introducing a public-UI-barrel
 * initialization cycle.
 */
const executeActionCommand = defineProtocolObject({
  kind: defineProtocolLiteral('executeAction'),
  action: PluginContributionLocalIdSchema,
  input: launchInput.optional(),
}, { policy: 'closed' });
export const PluginUiSemanticExecuteActionCommandV1Schema = asProtocolZod(executeActionCommand);
export type PluginUiSemanticExecuteActionCommandV1 =
  z.infer<typeof PluginUiSemanticExecuteActionCommandV1Schema>;

/** A local same-plugin destination id or an exact qualified destination. */
const destinationReference = defineProtocolUnion([
  PluginContributionLocalIdSchema,
  PluginContributionIdentityV1Schema,
]);
export const PluginUiSemanticDestinationReferenceV1Schema = asProtocolZod(destinationReference);
export type PluginUiSemanticDestinationReferenceV1 =
  z.infer<typeof PluginUiSemanticDestinationReferenceV1Schema>;

const openSurfaceCommand = defineProtocolObject({
  kind: defineProtocolLiteral('openSurface'),
  destination: destinationReference,
  input: launchInput.optional(),
  subPath: subPath.optional(),
  instanceKey: instanceKey.optional(),
}, { policy: 'closed' });
export const PluginUiSemanticOpenSurfaceCommandV1Schema = asProtocolZod(openSurfaceCommand);
export type PluginUiSemanticOpenSurfaceCommandV1 =
  z.infer<typeof PluginUiSemanticOpenSurfaceCommandV1Schema>;

export const PluginUiSemanticCommandV1Schema = asProtocolZod(defineProtocolUnion([
  executeActionCommand,
  openSurfaceCommand,
]));
export type PluginUiSemanticCommandV1 =
  z.infer<typeof PluginUiSemanticCommandV1Schema>;

/**
 * The composable-schema binding of the union above.
 *
 * A Protocol position that carries a command inside a composable Action
 * contract — today a Universal Search row — binds this rather than a bare
 * bounded JSON value. The union stays the only parser, so a `null`, `{}`,
 * missing-discriminator, unknown-key or namespace-escaping command is refused
 * by the same owner that refuses one on a session header action, and no second
 * grammar for the command exists alongside the composable DSL. Instance keys
 * are admitted only in canonical unpadded form; sub-path spellings are
 * normalized only by the navigation operation below.
 *
 * The caller owns the byte bound because it is the boundary the value crosses.
 */
export function definePluginUiSemanticCommandProtocolSchemaV1(
  options: Readonly<{ maxSerializedUtf8Bytes: number }>,
): ProtocolComposableSchema<PluginUiSemanticCommandV1, PluginUiSemanticCommandV1> {
  return defineProtocolUnion([executeActionCommand, openSurfaceCommand], options);
}

/**
 * What a semantic chrome affordance does, as its author declares it.
 *
 * Every other Action-referencing family — `commands`, `tools`,
 * `browserActions` — spells this field `action` and accepts a bare same-plugin
 * Action local id. Header actions accept that same sugar and additionally the
 * explicit `openSurface` form, which no plain Action reference can express.
 * The bare id widens to `executeAction` here, at the one owner, so nothing
 * downstream sees two shapes.
 */
export const PluginUiSemanticActionDeclarationV1Schema = lazyZodSchema(() => z.union([
  PluginContributionLocalIdZodSchema.transform((action): PluginUiSemanticCommandV1 => ({
    kind: 'executeAction' as const,
    action,
  })),
  PluginUiSemanticCommandV1Schema,
]));
export type PluginUiSemanticActionDeclarationV1Input =
  z.input<typeof PluginUiSemanticActionDeclarationV1Schema>;

/**
 * The post-normalization command carried by compiled UI projection entries.
 *
 * Author declarations use local ids above. Consumers of compiled projection
 * must accept only this qualified form so no UI reader recreates local-id
 * qualification or a parallel command parser.
 */
export const PluginUiResolvedSemanticExecuteActionCommandV1Schema = lazyZodSchema(() => z.object({
  kind: z.literal('executeAction'),
  action: PluginContributionIdentityV1ZodSchema,
  input: PluginUiLaunchInputV1Schema.optional(),
}).strict());
export type PluginUiResolvedSemanticExecuteActionCommandV1 =
  Readonly<z.infer<typeof PluginUiResolvedSemanticExecuteActionCommandV1Schema>>;

export const PluginUiResolvedSemanticOpenSurfaceCommandV1Schema = lazyZodSchema(() => z.object({
  kind: z.literal('openSurface'),
  destination: PluginContributionIdentityV1ZodSchema,
  input: PluginUiLaunchInputV1Schema.optional(),
  subPath: PluginUiSubPathV1Schema.optional(),
  instanceKey: PluginUiInstanceKeyV1Schema.optional(),
}).strict());
export type PluginUiResolvedSemanticOpenSurfaceCommandV1 =
  Readonly<z.infer<typeof PluginUiResolvedSemanticOpenSurfaceCommandV1Schema>>;

export const PluginUiResolvedSemanticCommandV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  PluginUiResolvedSemanticExecuteActionCommandV1Schema,
  PluginUiResolvedSemanticOpenSurfaceCommandV1Schema,
]));
export type PluginUiResolvedSemanticCommandV1 =
  Readonly<z.infer<typeof PluginUiResolvedSemanticCommandV1Schema>>;

/**
 * Normalizes semantic chrome data into qualified Action/open components. Local
 * surface ids qualify to the caller plugin; exact qualified destinations are
 * preserved for the one destination resolver. A `null` result is fail-closed
 * for malformed projection input; the resolver still owns
 * installed/current/admitted destination and Action checks.
 */
export function normalizePluginUiSemanticCommandV1(
  input: unknown,
): PluginUiResolvedSemanticCommandV1 | null {
  const parsed = z.object({
    pluginId: PluginIdZodSchema,
    command: PluginUiSemanticCommandV1Schema,
  }).strict().safeParse(input);
  if (!parsed.success) return null;
  const { pluginId, command } = parsed.data;
  if (command.kind === 'executeAction') {
    const action = PluginContributionIdentityV1Schema.parse({
      pluginId,
      localId: command.action,
    });
    return Object.freeze({
      kind: 'executeAction' as const,
      action: Object.freeze(action),
      ...(command.input === undefined ? {} : { input: command.input }),
    });
  }
  const destination: PluginContributionIdentityV1 = typeof command.destination === 'string'
    ? PluginContributionIdentityV1Schema.parse({ pluginId, localId: command.destination })
    : PluginContributionIdentityV1Schema.parse(command.destination);
  return Object.freeze({
    kind: 'openSurface' as const,
    destination: Object.freeze(destination),
    ...(command.input === undefined ? {} : { input: command.input }),
    ...(command.subPath === undefined ? {} : { subPath: normalizePluginUiSubPathV1(command.subPath)! }),
    ...(command.instanceKey === undefined ? {} : { instanceKey: command.instanceKey }),
  });
}
