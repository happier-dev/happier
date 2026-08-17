import {
    computeCanonicalDomainSeparatedDigest as canonicalComputeCanonicalDomainSeparatedDigest,
} from '@happier-dev/protocol/crypto/canonicalDigest';

/**
 * The protocol facade owns the canonical public JSON vocabulary. Identity
 * retains these type-only projections for existing SDK-internal/root
 * consumers. `JsonValue` is the SDK root name for the one strict runtime value
 * the facade publishes as `ProtocolJsonValue`: one declaration, two published
 * names, so the strict and the mutable authoring vocabularies cannot drift
 * apart here. Runtime validation and normalization remain Protocol-owned.
 */
export type {
    PluginJsonSchema,
    PluginJsonValueV2,
    ProtocolJsonValue as JsonValue,
} from './protocol/protocolFacade.js';

/** Canonical framed digest for stable plugin-owned identifiers. */
export const computeCanonicalDomainSeparatedDigest: (
    domain: string,
    parts: readonly (string | Uint8Array)[],
) => string = canonicalComputeCanonicalDomainSeparatedDigest;

/** Local contribution-id projection; Protocol owns its parser and bounds. */
export type PluginContributionLocalId = string;

export {
    isRecord,
    parseJsonLine,
    parseTimestampMs,
    readString,
    readTrimmedString,
} from './sessions/fileStores/records.js';

export type PluginContributionRef = Readonly<{
    pluginId: string;
    localId: string;
}>;

export type PluginReference = string | PluginContributionRef;

export type PluginIdentity = Readonly<{
    id: string;
    version: string;
}>;

export type PluginInvocationContributionIdentity = Readonly<{
    id: string;
    qualifiedId: string;
}>;
