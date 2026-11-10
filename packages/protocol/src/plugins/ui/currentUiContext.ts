import { lazyDefinition, lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';
import { zodSchemaToJsonSchemaObject } from '../../actions/actionInputJsonSchema.js';
import { normalizePluginJsonSchema } from '../actions/protocolComposableSchema.js';

import { PluginUiJsonValueV1Schema } from '../contributions/ui/json.js';
import { PluginUiSemanticCommandV1Schema } from './semanticCommands.js';

/** The standard composer attachment that carries one captured app screen. */
export const CURRENT_UI_CONTEXT_ATTACHMENT_IDENTITY_V1 = Object.freeze({
  pluginId: 'happier.app-context', localId: 'current-screen',
} as const);

/**
 * Explicitly tells a reader that this surface withheld invalid context.
 * It is a data-only detail fragment:
 * it never carries a command payload, identity, or execution authority.
 */
export const CurrentUiContextBoundedIncompletenessV1Schema = lazyZodSchema(() => z.strictObject({
  incomplete: z.literal(true),
}));
export type CurrentUiContextBoundedIncompletenessV1 = Readonly<
  z.infer<typeof CurrentUiContextBoundedIncompletenessV1Schema>
>;
export const CURRENT_UI_CONTEXT_BOUNDED_INCOMPLETENESS_V1:
  CurrentUiContextBoundedIncompletenessV1 = Object.freeze({ incomplete: true });

const CurrentUiTextV1Schema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1)));

export const CurrentUiContextEntityV1Schema = lazyZodSchema(() => z.strictObject({
  kind: CurrentUiTextV1Schema,
  label: CurrentUiTextV1Schema,
  summary: z.optional(CurrentUiTextV1Schema),
  reference: z.optional(PluginUiJsonValueV1Schema),
}));
export type CurrentUiContextEntityV1 = z.infer<typeof CurrentUiContextEntityV1Schema>;

export const CurrentUiCommandDeclarationV1Schema = lazyZodSchema(() => z.strictObject({
  title: CurrentUiTextV1Schema,
  description: z.optional(CurrentUiTextV1Schema),
  command: PluginUiSemanticCommandV1Schema,
}));
export type CurrentUiCommandDeclarationV1 = z.infer<typeof CurrentUiCommandDeclarationV1Schema>;

/** A host-generated opaque command handle; semantic payloads never cross it. */
export const CurrentUiCommandDescriptorV1Schema = lazyZodSchema(() => z.strictObject({
  id: CurrentUiTextV1Schema,
  title: CurrentUiTextV1Schema,
  description: z.optional(CurrentUiTextV1Schema),
}));
export type CurrentUiCommandDescriptorV1 = z.infer<typeof CurrentUiCommandDescriptorV1Schema>;

export const PluginUiContextEnrichmentV1Schema = lazyZodSchema(() => z.strictObject({
  entity: z.optional(CurrentUiContextEntityV1Schema),
  detail: z.optional(PluginUiJsonValueV1Schema),
  commands: z.optional(z.array(CurrentUiCommandDeclarationV1Schema)),
}));
export type PluginUiContextEnrichmentV1 = z.infer<typeof PluginUiContextEnrichmentV1Schema>;

export const CurrentUiContextSnapshotV1Schema = lazyZodSchema(() => z.strictObject({
  navigation: z.strictObject({
    area: CurrentUiTextV1Schema,
    screen: CurrentUiTextV1Schema,
    title: z.optional(CurrentUiTextV1Schema),
    presentation: z.optional(z.enum(['screen', 'modal', 'pane'])),
  }),
  entity: z.optional(CurrentUiContextEntityV1Schema),
  detail: z.optional(PluginUiJsonValueV1Schema),
  commands: z.array(CurrentUiCommandDescriptorV1Schema),
}));
export type CurrentUiContextSnapshotV1 = z.infer<typeof CurrentUiContextSnapshotV1Schema>;

/** Standalone attachment declaration; document-local JSON references stay at this root. */
export const CurrentUiContextSnapshotV1AttachmentSchema = lazyDefinition(() => Object.freeze({
  jsonSchema: normalizePluginJsonSchema(zodSchemaToJsonSchemaObject(CurrentUiContextSnapshotV1Schema, { target: 'draft-7' })),
  parse: (value: unknown) => CurrentUiContextSnapshotV1Schema.parse(value),
  safeParse: (value: unknown) => CurrentUiContextSnapshotV1Schema.safeParse(value),
}));
