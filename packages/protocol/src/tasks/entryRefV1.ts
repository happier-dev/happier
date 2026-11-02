import { defineProtocolString } from '../plugins/actions/protocolComposableSchema.js';
import {
  defineProtocolObject,
  defineProtocolUtf8String,
  type ProtocolComposableSchema,
} from '../plugins/actions/protocolComposableSchema.js';
import { PluginContributionIdentityV1Schema, type PluginContributionIdentityV1 } from '../plugins/contributionIdentity.js';
import type { PluginJsonSchemaV2 } from '../plugins/contributions/publicTypes.js';

/** Existing Triage V1 projected-text grammar: no C0 controls or DEL. */
export const TRIAGE_SINGLE_LINE_STRING_PATTERN_V1 = '^[^\\u0000-\\u001f\\u007f]+$';

/**
 * Existing Triage V1 structural-key grammar. Only collisionScope and the
 * source's localInstanceKey admit one U+001F between nonempty components.
 */
export const TRIAGE_COMPOSITE_IDENTIFIER_PATTERN_V1 =
  '^[^\\u0000-\\u001f\\u007f]+(?:\\u001f[^\\u0000-\\u001f\\u007f]+)?$';

/** Existing V1 byte boundary for source-native identifiers, never truncation. */
export const MAX_TRIAGE_IDENTIFIER_UTF8_BYTES_V1 = 128;
/** Existing V1 entry-scope boundary, including an origin and native scope id. */
export const MAX_TRIAGE_COLLISION_SCOPE_UTF8_BYTES_V1 = 192;

/** The shared constructor also governs Triage's bounded display/routing text. */
export function defineTriageSingleLineStringV1(maxUtf8Bytes: number): ProtocolComposableSchema<string> {
  return defineProtocolUtf8String({
    maxUtf8Bytes, minLength: 1, pattern: TRIAGE_SINGLE_LINE_STRING_PATTERN_V1,
  });
}

/** One delimiter rule for entry scopes and source-local composite keys. */
export function defineTriageCompositeIdentifierStringV1(maxUtf8Bytes: number): ProtocolComposableSchema<string> {
  return defineProtocolUtf8String({
    maxUtf8Bytes, minLength: 1, pattern: TRIAGE_COMPOSITE_IDENTIFIER_PATTERN_V1,
  });
}

export const TriageIdentifierV1ProtocolSchema = defineTriageSingleLineStringV1(MAX_TRIAGE_IDENTIFIER_UTF8_BYTES_V1);
export const TriageCollisionScopeV1ProtocolSchema = defineTriageCompositeIdentifierStringV1(MAX_TRIAGE_COLLISION_SCOPE_UTF8_BYTES_V1);

/** Preserve Triage's public readonly identity independently of DSL inference. */
export type TriageEntryRefV1 = Readonly<{
  source: Readonly<PluginContributionIdentityV1>;
  kindId: string;
  collisionScope: string;
  entryId: string;
}>;

/**
 * The minimal source-qualified Task/entry identity, shared with Protocol
 * consumers such as Discussion anchors. Qualification is not execution/read
 * placement or access authority; mutable locators and configured instances
 * remain Triage-owned. Both this envelope and its source identity are closed.
 * Keep this leaf independent of the SDK and Triage feature protocol.
 */
export const TriageEntryRefV1Schema: ProtocolComposableSchema<TriageEntryRefV1> = defineProtocolObject({
  source: PluginContributionIdentityV1Schema,
  kindId: TriageIdentifierV1ProtocolSchema,
  collisionScope: TriageCollisionScopeV1ProtocolSchema,
  entryId: TriageIdentifierV1ProtocolSchema,
}, { policy: 'closed' });
export const TriageEntryRefV1JsonSchema: PluginJsonSchemaV2 = TriageEntryRefV1Schema.jsonSchema;

export const TRIAGE_SOURCE_INSTANCE_ID_PATTERN_V1 =
  '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';


export const TriageSourceInstanceIdV1Schema = defineProtocolString({
  minLength: 36, maxLength: 36, pattern: TRIAGE_SOURCE_INSTANCE_ID_PATTERN_V1,
});
