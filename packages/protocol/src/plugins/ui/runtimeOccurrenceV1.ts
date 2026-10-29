import { defineProtocolString } from '../actions/protocolComposableSchema.js';

const NO_OUTER_WHITESPACE_PATTERN = /^(?!\s)[\s\S]*\S$(?![\s\S])/u;

/** Committed plugin generation, independent of runtime materialization. */
export const PluginUiImmutableGenerationIdV1Schema = defineProtocolString({
  minLength: 1, maxLength: 256, pattern: NO_OUTER_WHITESPACE_PATTERN.source,
});
export type PluginUiImmutableGenerationIdV1 = ReturnType<typeof PluginUiImmutableGenerationIdV1Schema.parse>;
export const PluginUiRuntimeOccurrenceIdV1Schema = defineProtocolString({
  minLength: 1, maxLength: 512, pattern: NO_OUTER_WHITESPACE_PATTERN.source,
});
export type PluginUiRuntimeOccurrenceIdV1 = ReturnType<typeof PluginUiRuntimeOccurrenceIdV1Schema.parse>;
