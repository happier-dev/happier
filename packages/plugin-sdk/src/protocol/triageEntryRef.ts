import * as canonical from '@happier-dev/protocol/tasks/entryRefV1';

import type { PluginContributionIdentity } from '../identity.js';
import type { PluginJsonSchema, ProtocolComposableSchema } from './protocolFacade.js';

/** Declaration-neutral projection of the canonical source-qualified identity. */
export type TriageEntryRefV1 = Readonly<{
    source: PluginContributionIdentity;
    kindId: string;
    collisionScope: string;
    entryId: string;
}>;

/** The SDK projects the same executable values; it owns no identity parser. */
export const TriageEntryRefV1Fields: {
    readonly [Field in keyof TriageEntryRefV1]: ProtocolComposableSchema<TriageEntryRefV1[Field]>;
} = canonical.TriageEntryRefV1Fields;
export const TriageEntryRefV1Schema: ProtocolComposableSchema<TriageEntryRefV1> = canonical.TriageEntryRefV1Schema;
export const TriageEntryRefV1JsonSchema: PluginJsonSchema = canonical.TriageEntryRefV1JsonSchema;
export const TriageIdentifierV1ProtocolSchema: ProtocolComposableSchema<string> = canonical.TriageIdentifierV1ProtocolSchema;
export const TriageCollisionScopeV1ProtocolSchema: ProtocolComposableSchema<string> = canonical.TriageCollisionScopeV1ProtocolSchema;
export const defineTriageSingleLineStringV1: (maxUtf8Bytes: number) => ProtocolComposableSchema<string> = canonical.defineTriageSingleLineStringV1;
export const defineTriageCompositeIdentifierStringV1: (maxUtf8Bytes: number) => ProtocolComposableSchema<string> = canonical.defineTriageCompositeIdentifierStringV1;
export const MAX_TRIAGE_IDENTIFIER_UTF8_BYTES_V1 = canonical.MAX_TRIAGE_IDENTIFIER_UTF8_BYTES_V1;
export const MAX_TRIAGE_COLLISION_SCOPE_UTF8_BYTES_V1 = canonical.MAX_TRIAGE_COLLISION_SCOPE_UTF8_BYTES_V1;
export const TRIAGE_SINGLE_LINE_STRING_PATTERN_V1 = canonical.TRIAGE_SINGLE_LINE_STRING_PATTERN_V1;
export const TRIAGE_COMPOSITE_IDENTIFIER_PATTERN_V1 = canonical.TRIAGE_COMPOSITE_IDENTIFIER_PATTERN_V1;
export const TriageSourceInstanceIdV1Schema: ProtocolComposableSchema<string> = canonical.TriageSourceInstanceIdV1Schema;
export type TriageSourceInstanceIdV1 = string;
export const TRIAGE_SOURCE_INSTANCE_ID_PATTERN_V1 = canonical.TRIAGE_SOURCE_INSTANCE_ID_PATTERN_V1;
export const INTERNAL_TASK_SOURCE_V1: Readonly<PluginContributionIdentity> = canonical.INTERNAL_TASK_SOURCE_V1;
export const internalTaskLocalRefV1: (taskId: string, ownerAccountId?: string) => Omit<TriageEntryRefV1, 'source'> = canonical.internalTaskLocalRefV1;
export const internalTaskOwnerAccountIdV1: (ref: Pick<TriageEntryRefV1, 'kindId' | 'collisionScope'>, viewerAccountId: string) => string | null = canonical.internalTaskOwnerAccountIdV1;
export const isInternalTaskReferenceV1: (ref: TriageEntryRefV1) => boolean = canonical.isInternalTaskReferenceV1;
