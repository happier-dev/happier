import type { PluginJsonSchema } from '@happier-dev/plugin-sdk/protocol';

import {
    defineProtocolLiteral,
    defineProtocolObject,
    defineProtocolString,
    defineProtocolUnion,
} from '@happier-dev/plugin-sdk/protocol';
import { PluginContributionIdentityV1Schema } from '@happier-dev/plugin-sdk/manifest';

import {
    MAX_TRIAGE_COLLISION_SCOPE_UTF8_BYTES_V1,
    MAX_TRIAGE_IDENTIFIER_UTF8_BYTES_V1,
    MAX_TRIAGE_LOCATION_UTF8_BYTES_V1,
    MAX_TRIAGE_ROUTING_TOKEN_UTF8_BYTES_V1,
    MAX_TRIAGE_TEXT_UTF8_BYTES_V1,
    TRIAGE_SOURCE_WORKFLOW_SUBJECTS_V1,
} from './bounds.js';
import {
    defineTriageCompositeIdentifierStringV1,
    defineTriageSingleLineStringV1,
} from './strings.js';

/** The target-minted stable configured-instance identity is a lowercase UUID. */
export const TRIAGE_SOURCE_INSTANCE_ID_PATTERN_V1 =
    '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

/**
 * `CONTRACT.md` §3: the target mints this stable UUID inside the private
 * configured-instance payload. It is never a source-minted routing value, an
 * entry-identity component, or a Collection tag.
 */
export const TriageSourceInstanceIdV1Schema = defineProtocolString({
    minLength: 36,
    maxLength: 36,
    pattern: TRIAGE_SOURCE_INSTANCE_ID_PATTERN_V1,
});
export type TriageSourceInstanceIdV1 = ReturnType<typeof TriageSourceInstanceIdV1Schema.parse>;
export const TriageSourceInstanceIdV1JsonSchema: PluginJsonSchema =
    TriageSourceInstanceIdV1Schema.jsonSchema;

/** @internal Relative-only bounded provider/source identifier component. */
export const TriageIdentifierV1ProtocolSchema = defineTriageSingleLineStringV1(
    MAX_TRIAGE_IDENTIFIER_UTF8_BYTES_V1,
);

/**
 * @internal Relative-only bounded source-owned composite entry-scope key. It is
 * one of the two V1 strings that admit the `U+001F` separator a first-party
 * mapping uses (`CONTRACT.md` §6), `localInstanceKey` being the other; it is a
 * structural key and is never rendered.
 */
export const TriageCollisionScopeV1ProtocolSchema = defineTriageCompositeIdentifierStringV1(
    MAX_TRIAGE_COLLISION_SCOPE_UTF8_BYTES_V1,
);

/** @internal Relative-only bounded one-line display text. */
export const TriageTextV1ProtocolSchema = defineTriageSingleLineStringV1(
    MAX_TRIAGE_TEXT_UTF8_BYTES_V1,
);

/**
 * @internal Relative-only bounded location string: a URL or an absolute local
 * path. It is never truncated into a shorter destination — a source that cannot
 * fit one omits it.
 */
export const TriageLocationV1ProtocolSchema = defineTriageSingleLineStringV1(
    MAX_TRIAGE_LOCATION_UTF8_BYTES_V1,
);

/**
 * The source-neutral workflow subject of one declared kind. `CONTRACT.md` §5.3
 * admits optional review-workspace preparation only for `pullRequest`.
 */
export const TriageSourceWorkflowSubjectV1Schema = defineProtocolUnion([
    defineProtocolLiteral(TRIAGE_SOURCE_WORKFLOW_SUBJECTS_V1[0]),
    defineProtocolLiteral(TRIAGE_SOURCE_WORKFLOW_SUBJECTS_V1[1]),
    defineProtocolLiteral(TRIAGE_SOURCE_WORKFLOW_SUBJECTS_V1[2]),
    defineProtocolLiteral(TRIAGE_SOURCE_WORKFLOW_SUBJECTS_V1[3]),
]);
export type TriageSourceWorkflowSubjectV1 = ReturnType<
    typeof TriageSourceWorkflowSubjectV1Schema.parse
>;
export const TriageSourceWorkflowSubjectV1JsonSchema: PluginJsonSchema =
    TriageSourceWorkflowSubjectV1Schema.jsonSchema;

/**
 * The source-local entry reference. `CONTRACT.md` §6 publishes only this
 * grammar: each source owns the native parser and the collision-scope
 * derivation, and the target validates the grammar plus the declared kind.
 */
export const TriageSourceEntryLocalRefV1Schema = defineProtocolObject({
    kindId: TriageIdentifierV1ProtocolSchema,
    collisionScope: TriageCollisionScopeV1ProtocolSchema,
    entryId: TriageIdentifierV1ProtocolSchema,
}, { policy: 'closed' });
export type TriageSourceEntryLocalRefV1 = ReturnType<
    typeof TriageSourceEntryLocalRefV1Schema.parse
>;
export const TriageSourceEntryLocalRefV1JsonSchema: PluginJsonSchema =
    TriageSourceEntryLocalRefV1Schema.jsonSchema;

/**
 * The canonical target-qualified entry reference. It carries the admitted
 * source contribution identity and never an account, credential, mutable path,
 * slug, display name, remote URL, or `sourceInstanceId` (`CONTRACT.md` §6).
 */
export const TriageEntryRefV1Schema = defineProtocolObject({
    source: PluginContributionIdentityV1Schema,
    kindId: TriageIdentifierV1ProtocolSchema,
    collisionScope: TriageCollisionScopeV1ProtocolSchema,
    entryId: TriageIdentifierV1ProtocolSchema,
}, { policy: 'closed' });
export type TriageEntryRefV1 = ReturnType<typeof TriageEntryRefV1Schema.parse>;
export const TriageEntryRefV1JsonSchema: PluginJsonSchema = TriageEntryRefV1Schema.jsonSchema;

/**
 * The canonical configured-instance reference: the admitted source contribution
 * plus the target-minted stable id. `CONTRACT.md` §3 makes this the only
 * configured-instance identity that Composer, Session, and detail values carry.
 */
export const TriageSourceInstanceRefV1Schema = defineProtocolObject({
    source: PluginContributionIdentityV1Schema,
    sourceInstanceId: TriageSourceInstanceIdV1Schema,
}, { policy: 'closed' });
export type TriageSourceInstanceRefV1 = ReturnType<typeof TriageSourceInstanceRefV1Schema.parse>;
export const TriageSourceInstanceRefV1JsonSchema: PluginJsonSchema =
    TriageSourceInstanceRefV1Schema.jsonSchema;

/**
 * Mutable presentation and routing for one observed entry. Every member is
 * replaceable by a later observation without rekeying the entry, and
 * `routingToken` is a bounded source-private string the target never parses.
 */
export const TriageEntryLocatorV1Schema = defineProtocolObject({
    v: defineProtocolLiteral(1),
    webUrl: TriageLocationV1ProtocolSchema.optional(),
    displayPath: TriageTextV1ProtocolSchema.optional(),
    routingToken: defineTriageSingleLineStringV1(
        MAX_TRIAGE_ROUTING_TOKEN_UTF8_BYTES_V1,
    ).optional(),
}, { policy: 'closed' });
export type TriageEntryLocatorV1 = ReturnType<typeof TriageEntryLocatorV1Schema.parse>;
export const TriageEntryLocatorV1JsonSchema: PluginJsonSchema =
    TriageEntryLocatorV1Schema.jsonSchema;
