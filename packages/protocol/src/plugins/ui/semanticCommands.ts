import { z } from 'zod';

import {
  PluginContributionIdentityV1Schema,
  PluginContributionLocalIdSchema,
  type PluginContributionIdentityV1,
} from '../contributionIdentity.js';
import { PluginIdSchema } from '../pluginId.js';
import {
  cloneStrictPluginJsonValue,
  measureSerializedValidatedStrictPluginJsonUtf8Bytes,
} from '../actions/protocolComposableSchema.js';
import { asProtocolZod } from '../actions/internalProtocolZodAdapter.js';
import type { PluginUiJsonValueV1 } from '../contributions/ui/json.js';

const PluginContributionIdentityV1ZodSchema = asProtocolZod(PluginContributionIdentityV1Schema);
const PluginContributionLocalIdZodSchema = asProtocolZod(PluginContributionLocalIdSchema);
const PluginIdZodSchema = asProtocolZod(PluginIdSchema);

/** The bound on `openSurface(view, input)` launch input. */
export const PLUGIN_UI_LAUNCH_INPUT_MAX_UTF8_BYTES_V1 = 8_192;

/** A bounded `openSurface` launch-input value. */
export const PluginUiLaunchInputV1Schema = z.unknown().transform((value, ctx): PluginUiJsonValueV1 => {
  let normalized: PluginUiJsonValueV1;
  try {
    normalized = cloneStrictPluginJsonValue(value, 'input') as PluginUiJsonValueV1;
  } catch {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Plugin UI launch input must contain strict JSON data.',
    });
    return z.NEVER;
  }
  if (measureSerializedValidatedStrictPluginJsonUtf8Bytes(
    normalized,
    'input',
    PLUGIN_UI_LAUNCH_INPUT_MAX_UTF8_BYTES_V1,
  ) > PLUGIN_UI_LAUNCH_INPUT_MAX_UTF8_BYTES_V1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Plugin UI launch input exceeds the ${PLUGIN_UI_LAUNCH_INPUT_MAX_UTF8_BYTES_V1}-byte canonical UTF-8 limit.`,
      });
  }
  return normalized;
});
export type PluginUiLaunchInputV1 = PluginUiJsonValueV1;

/** The bound on a full-page destination's plugin-local location. */
export const PLUGIN_UI_SUB_PATH_MAX_UTF8_BYTES_V1 = 1_024;

/** Canonicalize a plugin-local sub-path without permitting namespace escape. */
export function normalizePluginUiSubPathV1(value: string): string | null {
  if (new TextEncoder().encode(value).byteLength > PLUGIN_UI_SUB_PATH_MAX_UTF8_BYTES_V1) return null;
  // eslint-disable-next-line no-control-regex -- control characters are exactly what this rejects.
  if (/[\u0000-\u001f\u007f]/u.test(value)) return null;
  const segments = value.split('/').filter((segment) => segment.length > 0);
  if (segments.some((segment) => segment === '.' || segment === '..')) return null;
  return segments.join('/');
}

/** A canonical plugin-local sub-path. Parsing normalizes; it never truncates. */
export const PluginUiSubPathV1Schema = z.string().transform((value, ctx) => {
  const normalized = normalizePluginUiSubPathV1(value);
  if (normalized === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Plugin UI sub-path is not a legal plugin-local location.',
    });
    return z.NEVER;
  }
  return normalized;
});
export type PluginUiSubPathV1 = string;

/** Instance identity is bounded and opaque to the host's route/pane owner. */
export const PLUGIN_UI_INSTANCE_KEY_MAX_UTF8_BYTES_V1 = 256;
export const PluginUiInstanceKeyV1Schema = z.string().trim().min(1).superRefine((value, ctx) => {
  if (new TextEncoder().encode(value).byteLength > PLUGIN_UI_INSTANCE_KEY_MAX_UTF8_BYTES_V1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Plugin UI instance key exceeds the ${PLUGIN_UI_INSTANCE_KEY_MAX_UTF8_BYTES_V1}-byte UTF-8 limit.`,
    });
  }
});
export type PluginUiInstanceKeyV1 = z.infer<typeof PluginUiInstanceKeyV1Schema>;

/**
 * Semantic chrome Action declarations are same-plugin author input. Surface
 * declarations accept either that local-id sugar or one exact qualified
 * destination, then normalize once at the compiled projection boundary. This
 * leaf stays independent of host request envelopes and surface context so
 * contribution schemas can use it without introducing a public-UI-barrel
 * initialization cycle.
 */
export const PluginUiSemanticExecuteActionCommandV1Schema = z.object({
  kind: z.literal('executeAction'),
  action: PluginContributionLocalIdZodSchema,
  input: PluginUiLaunchInputV1Schema.optional(),
}).strict();
export type PluginUiSemanticExecuteActionCommandV1 =
  z.infer<typeof PluginUiSemanticExecuteActionCommandV1Schema>;

/** A local same-plugin destination id or an exact qualified destination. */
export const PluginUiSemanticDestinationReferenceV1Schema = z.union([
  PluginContributionLocalIdZodSchema,
  PluginContributionIdentityV1ZodSchema,
]);
export type PluginUiSemanticDestinationReferenceV1 =
  z.infer<typeof PluginUiSemanticDestinationReferenceV1Schema>;

export const PluginUiSemanticOpenSurfaceCommandV1Schema = z.object({
  kind: z.literal('openSurface'),
  destination: PluginUiSemanticDestinationReferenceV1Schema,
  input: PluginUiLaunchInputV1Schema.optional(),
  subPath: PluginUiSubPathV1Schema.optional(),
  instanceKey: PluginUiInstanceKeyV1Schema.optional(),
}).strict();
export type PluginUiSemanticOpenSurfaceCommandV1 =
  z.infer<typeof PluginUiSemanticOpenSurfaceCommandV1Schema>;

export const PluginUiSemanticCommandV1Schema = z.discriminatedUnion('kind', [
  PluginUiSemanticExecuteActionCommandV1Schema,
  PluginUiSemanticOpenSurfaceCommandV1Schema,
]);
export type PluginUiSemanticCommandV1 =
  z.infer<typeof PluginUiSemanticCommandV1Schema>;

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
export const PluginUiSemanticActionDeclarationV1Schema = z.union([
  PluginContributionLocalIdZodSchema.transform((action): PluginUiSemanticCommandV1 => ({
    kind: 'executeAction' as const,
    action,
  })),
  PluginUiSemanticCommandV1Schema,
]);
export type PluginUiSemanticActionDeclarationV1Input =
  z.input<typeof PluginUiSemanticActionDeclarationV1Schema>;

/**
 * The post-normalization command carried by compiled UI projection entries.
 *
 * Author declarations use local ids above. Consumers of compiled projection
 * must accept only this qualified form so no UI reader recreates local-id
 * qualification or a parallel command parser.
 */
export const PluginUiResolvedSemanticExecuteActionCommandV1Schema = z.object({
  kind: z.literal('executeAction'),
  action: PluginContributionIdentityV1ZodSchema,
  input: PluginUiLaunchInputV1Schema.optional(),
}).strict();
export type PluginUiResolvedSemanticExecuteActionCommandV1 =
  Readonly<z.infer<typeof PluginUiResolvedSemanticExecuteActionCommandV1Schema>>;

export const PluginUiResolvedSemanticOpenSurfaceCommandV1Schema = z.object({
  kind: z.literal('openSurface'),
  destination: PluginContributionIdentityV1ZodSchema,
  input: PluginUiLaunchInputV1Schema.optional(),
  subPath: PluginUiSubPathV1Schema.optional(),
  instanceKey: PluginUiInstanceKeyV1Schema.optional(),
}).strict();
export type PluginUiResolvedSemanticOpenSurfaceCommandV1 =
  Readonly<z.infer<typeof PluginUiResolvedSemanticOpenSurfaceCommandV1Schema>>;

export const PluginUiResolvedSemanticCommandV1Schema = z.discriminatedUnion('kind', [
  PluginUiResolvedSemanticExecuteActionCommandV1Schema,
  PluginUiResolvedSemanticOpenSurfaceCommandV1Schema,
]);
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
    ...(command.subPath === undefined ? {} : { subPath: command.subPath }),
    ...(command.instanceKey === undefined ? {} : { instanceKey: command.instanceKey }),
  });
}
