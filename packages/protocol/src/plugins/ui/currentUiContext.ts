import { z } from 'zod';

import {
  cloneStrictPluginJsonValue,
  measureSerializedValidatedStrictPluginJsonUtf8Bytes,
} from '../actions/protocolComposableSchema.js';
import type { PluginUiJsonValueV1 } from '../contributions/ui/json.js';
import {
  PluginUiLaunchInputV1Schema,
  PluginUiSemanticCommandV1Schema,
} from './semanticCommands.js';

/** The complete current-UI snapshot/enrichment transport bound. */
export const CURRENT_UI_CONTEXT_MAX_UTF8_BYTES_V1 = 8_192;
/** A snapshot cannot publish an unbounded command menu. */
export const CURRENT_UI_CONTEXT_MAX_COMMANDS_V1 = 32;

/**
 * Explicitly tells a reader that this surface withheld some context to remain
 * within the canonical transport bounds. It is a data-only detail fragment:
 * it never carries a command payload, identity, or execution authority.
 */
export const CurrentUiContextBoundedIncompletenessV1Schema = z.object({
  incomplete: z.literal(true),
}).strict();
export type CurrentUiContextBoundedIncompletenessV1 = Readonly<
  z.infer<typeof CurrentUiContextBoundedIncompletenessV1Schema>
>;
export const CURRENT_UI_CONTEXT_BOUNDED_INCOMPLETENESS_V1:
  CurrentUiContextBoundedIncompletenessV1 = Object.freeze({ incomplete: true });

const CurrentUiTextV1Schema = z.string().trim().min(1);

function assertCurrentUiContextSize(
  value: unknown,
  ctx: z.RefinementCtx,
): void {
  let normalized: PluginUiJsonValueV1;
  try {
    normalized = cloneStrictPluginJsonValue(value, 'current UI context') as PluginUiJsonValueV1;
  } catch {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Current UI context must contain strict JSON data.',
    });
    return;
  }
  if (measureSerializedValidatedStrictPluginJsonUtf8Bytes(
    normalized,
    'current UI context',
    CURRENT_UI_CONTEXT_MAX_UTF8_BYTES_V1,
  ) > CURRENT_UI_CONTEXT_MAX_UTF8_BYTES_V1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Current UI context exceeds the ${CURRENT_UI_CONTEXT_MAX_UTF8_BYTES_V1}-byte canonical UTF-8 limit.`,
    });
  }
}

export const CurrentUiContextEntityV1Schema = z.object({
  kind: CurrentUiTextV1Schema,
  label: CurrentUiTextV1Schema,
  summary: CurrentUiTextV1Schema.optional(),
  reference: PluginUiLaunchInputV1Schema.optional(),
}).strict();
export type CurrentUiContextEntityV1 = z.infer<typeof CurrentUiContextEntityV1Schema>;

export const CurrentUiCommandDeclarationV1Schema = z.object({
  title: CurrentUiTextV1Schema,
  description: CurrentUiTextV1Schema.optional(),
  command: PluginUiSemanticCommandV1Schema,
}).strict();
export type CurrentUiCommandDeclarationV1 = z.infer<typeof CurrentUiCommandDeclarationV1Schema>;

/** A host-generated opaque command handle; semantic payloads never cross it. */
export const CurrentUiCommandDescriptorV1Schema = z.object({
  id: CurrentUiTextV1Schema,
  title: CurrentUiTextV1Schema,
  description: CurrentUiTextV1Schema.optional(),
}).strict();
export type CurrentUiCommandDescriptorV1 = z.infer<typeof CurrentUiCommandDescriptorV1Schema>;

export const PluginUiContextEnrichmentV1Schema = z.object({
  entity: CurrentUiContextEntityV1Schema.optional(),
  detail: PluginUiLaunchInputV1Schema.optional(),
  commands: z.array(CurrentUiCommandDeclarationV1Schema).max(CURRENT_UI_CONTEXT_MAX_COMMANDS_V1).optional(),
}).strict().superRefine(assertCurrentUiContextSize);
export type PluginUiContextEnrichmentV1 = z.infer<typeof PluginUiContextEnrichmentV1Schema>;

export const CurrentUiContextSnapshotV1Schema = z.object({
  navigation: z.object({
    area: CurrentUiTextV1Schema,
    screen: CurrentUiTextV1Schema,
    title: CurrentUiTextV1Schema.optional(),
    presentation: z.enum(['screen', 'modal', 'pane']).optional(),
  }).strict(),
  entity: CurrentUiContextEntityV1Schema.optional(),
  detail: PluginUiLaunchInputV1Schema.optional(),
  commands: z.array(CurrentUiCommandDescriptorV1Schema).max(CURRENT_UI_CONTEXT_MAX_COMMANDS_V1),
}).strict().superRefine(assertCurrentUiContextSize);
export type CurrentUiContextSnapshotV1 = z.infer<typeof CurrentUiContextSnapshotV1Schema>;
