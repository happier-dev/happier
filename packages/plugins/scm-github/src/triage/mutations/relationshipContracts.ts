import {
  defineProtocolArray, defineProtocolLiteral, defineProtocolNumber, defineProtocolObject,
  defineProtocolString, defineProtocolUnion,
} from '@happier-dev/plugin-sdk/protocol';
import { TriageSourceFailureV1Schema } from '@happier-dev/triage-protocol/v1';
import { mutationTargetShape } from './contracts.js';

const NodeId = defineProtocolString({ minLength: 1 });
/** Related entries retain the source's exact identity and observed repository route. */
const RelatedEntry = defineProtocolObject({
  localRef: mutationTargetShape.localRef, routingToken: mutationTargetShape.routingToken,
}, { policy: 'closed' });
export const GithubRelatedEntryInputV1Schema = defineProtocolObject({
  ...mutationTargetShape, related: RelatedEntry,
}, { policy: 'closed' });
export const GithubSubIssueAddInputV1Schema = defineProtocolObject({
  ...mutationTargetShape, related: RelatedEntry,
  replaceParent: defineProtocolUnion([defineProtocolLiteral(true), defineProtocolLiteral(false)]).optional(),
}, { policy: 'closed' });
export const GithubSubIssueReprioritizeInputV1Schema = defineProtocolUnion([
  defineProtocolObject({ ...mutationTargetShape, related: RelatedEntry, before: RelatedEntry }, { policy: 'closed' }),
  defineProtocolObject({ ...mutationTargetShape, related: RelatedEntry, after: RelatedEntry }, { policy: 'closed' }),
]);
export const GithubProjectItemAddInputV1Schema = defineProtocolObject({
  ...mutationTargetShape, projectId: NodeId,
}, { policy: 'closed' });
export const GithubProjectItemRemoveInputV1Schema = defineProtocolObject({
  ...mutationTargetShape, projectId: NodeId, itemId: NodeId,
}, { policy: 'closed' });
const projectFieldShape = { ...mutationTargetShape, projectId: NodeId, itemId: NodeId, fieldId: NodeId };
/** GitHub's ProjectV2FieldValue accepts exactly one typed field value per call. */
export const GithubProjectFieldValueV1Schema = defineProtocolUnion([
  defineProtocolObject({ text: defineProtocolString() }, { policy: 'closed' }),
  defineProtocolObject({ number: defineProtocolNumber() }, { policy: 'closed' }),
  defineProtocolObject({ date: defineProtocolString({ minLength: 1 }) }, { policy: 'closed' }),
  defineProtocolObject({ singleSelectOptionId: NodeId }, { policy: 'closed' }),
  defineProtocolObject({ iterationId: NodeId }, { policy: 'closed' }),
  defineProtocolObject({ multiSelectOptionIds: defineProtocolArray(NodeId) }, { policy: 'closed' }),
]);
export const GithubProjectFieldSetInputV1Schema = defineProtocolObject({
  ...projectFieldShape, value: GithubProjectFieldValueV1Schema,
}, { policy: 'closed' });
export const GithubProjectFieldClearInputV1Schema = defineProtocolObject(projectFieldShape, { policy: 'closed' });

export const GithubRelationshipMutationResultV1Schema = defineProtocolUnion([
  defineProtocolObject({
    kind: defineProtocolLiteral('applied'), effect: defineProtocolLiteral('changed'),
    localRef: mutationTargetShape.localRef,
    related: RelatedEntry.optional(), projectId: NodeId.optional(), itemId: NodeId.optional(), fieldId: NodeId.optional(),
  }, { policy: 'closed' }),
  defineProtocolObject({ kind: defineProtocolLiteral('failed'), failure: TriageSourceFailureV1Schema }, { policy: 'closed' }),
  defineProtocolObject({ kind: defineProtocolLiteral('uncertain'), failure: TriageSourceFailureV1Schema.optional() }, { policy: 'closed' }),
]);
export type GithubRelationshipMutationResultV1 = ReturnType<typeof GithubRelationshipMutationResultV1Schema.parse>;
