/**
 * Browser-safe validator-neutral data-only protocol/schema algebra, plus the
 * host-owned protocol values a feature protocol embeds in its own declarations.
 * Cross-plugin contribution authoring lives on the sibling `/contributions`
 * entrypoint so the two public owners remain disjoint.
 */
export type {
    PluginJsonSchema,
    ProtocolArrayOptions,
    ProtocolComposableSchema,
    ProtocolJsonValue,
    ProtocolJsonValueOptions,
    ProtocolNumberOptions,
    ProtocolObjectEvolutionPolicy,
    ProtocolObjectOptions,
    ProtocolSchemaInput,
    ProtocolSchemaOutput,
    ProtocolSchemaSafeParseResult,
    ProtocolStringOptions,
    ProtocolUniqueJsonArrayOptions,
    ProtocolUtf8StringOptions,
    ProtocolValidationIssue,
} from './protocolFacade.js';
export {
    defineProtocolArray,
    defineProtocolJsonValue,
    defineProtocolLiteral,
    defineProtocolNumber,
    defineProtocolObject,
    defineProtocolString,
    defineProtocolUnion,
    defineProtocolUniqueArray,
    defineProtocolUtf8String,
    pluginJsonValuesEqual,
    ProtocolValidationError,
} from './protocolFacade.js';
/**
 * The composable projection of one exact Composer scope. `/ui` publishes the
 * same canonical value as `ComposerRefV1Schema`, declaration-only, for reading
 * Host API payloads; this one is composable, for declaring protocol objects.
 */
export type { ProtocolComposerRefV1 } from './composerRef.js';
export { ProtocolComposerRefV1Schema } from './composerRef.js';
