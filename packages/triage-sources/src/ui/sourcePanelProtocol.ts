import { defineProtocolLiteral, defineProtocolObject, defineProtocolString, defineProtocolUnion } from '@happier-dev/plugin-sdk/protocol';
import type { ComposerReferenceCandidatePageV1 } from '@happier-dev/plugin-sdk';
import type { PluginUiContributionIdentityV1 } from '@happier-dev/plugin-sdk/ui';

/**
 * One disclosure-approved candidate, qualified by the reference contribution
 * that resolves it at dispatch.
 *
 * The candidate shape is the public Composer provider's own bounded page item,
 * not a Triage mirror: Triage never receives, stores or interprets the selected
 * provider response bytes, and the reference identity is what re-reads them at
 * dispatch time.
 */
export type TriageEvidenceCandidateV1 = Readonly<{
  reference: PluginUiContributionIdentityV1;
  candidate: ComposerReferenceCandidatePageV1[number];
}>;

const closed = { policy: 'closed' } as const;
export const TriageSourcePanelSelectionV1Schema = defineProtocolUnion([
  defineProtocolObject({ kind: defineProtocolLiteral('loadMoreSourceItems'), list: defineProtocolString({ minLength: 1 }) }, closed),
  defineProtocolObject({ kind: defineProtocolLiteral('setSourceItemExpanded'), list: defineProtocolString({ minLength: 1 }),
    itemId: defineProtocolString({ minLength: 1 }), expanded: defineProtocolUnion([defineProtocolLiteral(true), defineProtocolLiteral(false)]) }, closed),
  defineProtocolObject({ kind: defineProtocolLiteral('selectSourceOccurrence'), occurrenceId: defineProtocolString({ minLength: 1 }) }, closed),
  defineProtocolObject({ kind: defineProtocolLiteral('setSourceOrdering'), order: defineProtocolUnion([defineProtocolLiteral('provider'), defineProtocolLiteral('spread')]) }, closed),
  defineProtocolObject({ kind: defineProtocolLiteral('revealSourceUser'), occurrenceId: defineProtocolString({ minLength: 1 }), revealed: defineProtocolLiteral(false) }, closed),
]);
export const TriageSourcePanelRevealV1Schema = defineProtocolObject({
  kind: defineProtocolLiteral('revealSourceUser'), occurrenceId: defineProtocolString({ minLength: 1 }), revealed: defineProtocolLiteral(true),
}, closed);
export const TriageSourcePanelInsertV1Schema = defineProtocolObject({ kind: defineProtocolLiteral('insertSelectedEvidence'), occurrenceId: defineProtocolString({ minLength: 1 }) }, closed);
export const TriageSourcePanelOperationV1Schema = defineProtocolUnion([
  TriageSourcePanelSelectionV1Schema, TriageSourcePanelRevealV1Schema, TriageSourcePanelInsertV1Schema,
]);
export type TriageSourcePanelOperationV1 = ReturnType<typeof TriageSourcePanelOperationV1Schema.parse>;
type ListOperation = Extract<TriageSourcePanelOperationV1, { list: string }>;
export type TriageSourcePanelIntentV1 =
  | Exclude<TriageSourcePanelOperationV1['kind'], ListOperation['kind']>
  | Readonly<Pick<ListOperation, 'kind' | 'list'>>;
/** One panel may contain several lists supporting the same operation. */
export function triageSourcePanelIntentKeyV1(intent: TriageSourcePanelIntentV1 | TriageSourcePanelOperationV1): string {
  return typeof intent === 'string' ? intent : 'list' in intent ? JSON.stringify([intent.kind, intent.list]) : intent.kind;
}
export type TriageSourcePanelResultV1 = Readonly<{ status: 'applied' | 'unavailable' | 'rejected' }>;
export const TRIAGE_MOUNTED_UI_ACTION_LOCAL_ID_V1 = 'ui/mounted-v1';
export const TRIAGE_SOURCE_PANEL_REVEAL_ACTION_V1 = 'ui/reveal-source-user-v1';
export const TRIAGE_SOURCE_PANEL_INSERT_ACTION_V1 = 'ui/insert-selected-evidence-v1';
export function triageSourcePanelActionIdV1(operation: TriageSourcePanelOperationV1): string {
  return operation.kind === 'revealSourceUser' && operation.revealed ? TRIAGE_SOURCE_PANEL_REVEAL_ACTION_V1
    : operation.kind === 'insertSelectedEvidence' ? TRIAGE_SOURCE_PANEL_INSERT_ACTION_V1 : TRIAGE_MOUNTED_UI_ACTION_LOCAL_ID_V1;
}
