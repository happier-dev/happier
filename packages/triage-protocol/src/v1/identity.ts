import { triageListSourceSchemasV1 } from './listSourceSchemaInstances.js';
import {
    defineProtocolObject,
    defineProtocolString,
    TriageIdentifierV1ProtocolSchema,
    TriageSourceInstanceIdV1Schema,
    MAX_TRIAGE_IDENTIFIER_UTF8_BYTES_V1,
    TRIAGE_SINGLE_LINE_STRING_PATTERN_V1,
} from '@happier-dev/plugin-sdk/protocol';
import { PluginContributionIdentityV1Schema } from '@happier-dev/plugin-sdk/manifest';

import {
    MAX_TRIAGE_LOCATION_UTF8_BYTES_V1,
    MAX_TRIAGE_TEXT_UTF8_BYTES_V1,
    TRIAGE_SOURCE_WORKFLOW_SUBJECTS_V1,
    TRIAGE_ACTION_SUBJECTS_V1,
} from './bounds.js';
import { defineTriageStringUnionV1, defineTriageSingleLineStringV1 } from './strings.js';

// Preserve the feature ABI while Protocol consumers use the dependency-safe
// owner directly. The SDK facade publishes these exact parser instances.
export {
    INTERNAL_TASK_SOURCE_V1,
    internalTaskLocalRefV1,
    internalTaskOwnerAccountIdV1,
    isInternalTaskReferenceV1,
    TriageEntryRefV1Schema,
    TriageEntryRefV1JsonSchema,
    TriageIdentifierV1ProtocolSchema,
    TriageCollisionScopeV1ProtocolSchema,
    TriageSourceInstanceIdV1Schema,
    TRIAGE_SOURCE_INSTANCE_ID_PATTERN_V1,
} from '@happier-dev/plugin-sdk/protocol';
export type { TriageEntryRefV1, TriageSourceInstanceIdV1 } from '@happier-dev/plugin-sdk/protocol';

/** Stable identity in the configured triage.actions catalog. */
export const TriageActionIdV1Schema = defineProtocolString({
    minLength: 1,
    maxLength: MAX_TRIAGE_IDENTIFIER_UTF8_BYTES_V1,
    pattern: TRIAGE_SINGLE_LINE_STRING_PATTERN_V1,
});

/** The configured action label grammar; catalog normalization remains its writer's authority. */
export const TriageActionLabelV1Schema = defineProtocolString({
    minLength: 1,
    pattern: TRIAGE_SINGLE_LINE_STRING_PATTERN_V1,
});

/** @internal Relative-only bounded one-line display text. */
export const TriageTextV1ProtocolSchema = defineTriageSingleLineStringV1(
    MAX_TRIAGE_TEXT_UTF8_BYTES_V1,
);

/** Selection and snapshot joins share one opaque source-native key, including retained repository paths. */
export const { TriageSourceScopeUnitIdV1Schema } = triageListSourceSchemasV1;
export type TriageSourceScopeUnitIdV1 = ReturnType<typeof TriageSourceScopeUnitIdV1Schema.parse>;

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
export const TriageSourceWorkflowSubjectV1Schema = defineTriageStringUnionV1(TRIAGE_SOURCE_WORKFLOW_SUBJECTS_V1);
export type TriageSourceWorkflowSubjectV1 = ReturnType<
    typeof TriageSourceWorkflowSubjectV1Schema.parse
>;

/** A configured action's `appliesTo` member: a source subject or a declared native subject. */
export const TriageActionSubjectV1Schema = defineTriageStringUnionV1(TRIAGE_ACTION_SUBJECTS_V1);
export type TriageActionSubjectV1 = (typeof TRIAGE_ACTION_SUBJECTS_V1)[number];

/**
 * The source-local entry reference. `CONTRACT.md` §6 publishes only this
 * grammar: each source owns the native parser and the collision-scope
 * derivation, and the target validates the grammar plus the declared kind.
 */
export const { TriageSourceEntryLocalRefV1Schema } = triageListSourceSchemasV1;
export type TriageSourceEntryLocalRefV1 = ReturnType<
    typeof TriageSourceEntryLocalRefV1Schema.parse
>;

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

/**
 * Mutable presentation and routing for one observed entry. Every member is
 * replaceable by a later observation without rekeying the entry, and
 * `routingToken` is a bounded source-private string the target never parses.
 */
export const { TriageEntryLocatorV1Schema } = triageListSourceSchemasV1;
export type TriageEntryLocatorV1 = ReturnType<typeof TriageEntryLocatorV1Schema.parse>;
