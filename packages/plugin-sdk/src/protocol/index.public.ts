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
/**
 * The canonical executable parser for a complete Composer reference
 * resolution, including Protocol's whole-value 16KiB boundary.
 */
export { ProtocolComposerReferenceResolutionV1Schema } from './composerReferenceResolution.js';
/**
 * The composable projection of the Account Data Collection's opaque
 * continuation cursor, for feature protocols declaring their own Action wire
 * shapes. It is the one canonical Protocol value; the 4096-character base64url
 * grammar is owned and bounded by the Protocol parser alone.
 */
export type { ProtocolCollectionOpaqueCursorV1 } from './collectionCursor.js';
export { ProtocolCollectionOpaqueCursorV1Schema } from './collectionCursor.js';
