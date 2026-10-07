import { defineProtocolLiteral, defineProtocolObject, defineProtocolString, defineProtocolUnion } from '@happier-dev/plugin-sdk/protocol';

const closed = { policy: 'closed' } as const;
export const TriageSourcePanelSelectionV1Schema = defineProtocolUnion([
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
export type TriageSourcePanelResultV1 = Readonly<{ status: 'applied' | 'unavailable' | 'rejected' }>;
export const TRIAGE_SOURCE_PANEL_REVEAL_ACTION_V1 = 'ui/reveal-source-user-v1';
export const TRIAGE_SOURCE_PANEL_INSERT_ACTION_V1 = 'ui/insert-selected-evidence-v1';
export function triageSourcePanelActionIdV1(operation: TriageSourcePanelOperationV1): string {
  return operation.kind === 'revealSourceUser' && operation.revealed ? TRIAGE_SOURCE_PANEL_REVEAL_ACTION_V1
    : operation.kind === 'insertSelectedEvidence' ? TRIAGE_SOURCE_PANEL_INSERT_ACTION_V1 : 'ui/mounted-v1';
}
