import { defineProtocolString } from '../actions/protocolComposableSchema.js';

/**
 * Opaque direct and UI-query continuation evidence; callers cannot interpret it.
 *
 * It is authored as a validator-neutral composable because a feature protocol
 * must be able to embed this exact cursor grammar in its own closed Action
 * wire shapes and publish the result as portable JSON Schema. The incumbent
 * Zod Collection wire parents compose this same value through one
 * `asProtocolZod` bridge; there is one parser, not two.
 *
 * This grammar has its own leaf module — rather than living beside the rest of
 * the Collection wire in `collectionUiQueryWireV1.ts` — because it is the only
 * Data value projected onto the browser-safe public authoring surface
 * (`@happier-dev/plugin-sdk/protocol`). Publishing it from the wire module
 * would pull Zod and the contribution graph into every feature-protocol
 * browser bundle.
 */
export const PluginCollectionOpaqueCursorV1Schema = defineProtocolString({
  minLength: 1,
  maxLength: 4096,
  pattern: '^[A-Za-z0-9_-]+$',
});
export type PluginCollectionOpaqueCursorV1 = ReturnType<typeof PluginCollectionOpaqueCursorV1Schema.parse>;
