/**
 * Browser-safe validator-neutral data-only protocol/schema algebra.
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
