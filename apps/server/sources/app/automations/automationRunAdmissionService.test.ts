import { describe, expect, it } from 'vitest';
import {
  deriveAutomationManualOccurrenceKeyV1, AutomationTriggerIdSchema,
  MAX_NON_TERMINAL_EVENT_CONVERSATION_RUNS_PER_ACCOUNT,
  sealAutomationTriggerDefinitionStoredEnvelopeV1, serializeAutomationStoredWorkflowDefinitionRecipeV2,
  createAccountScopedCryptoMaterialSnapshotV1,
} from '@happier-dev/protocol';
import type { Tx } from '@/storage/inTx';
import { admitAutomationRunTx } from './automationRunAdmissionService';

const triggerId = AutomationTriggerIdSchema.parse('pr-trigger-one');
const scopedTrigger = { triggerId, triggerRevision: 1, triggerKind: 'prComment' as const, sessionId: 'session-one',
  pullRequest: { repository: 'owner/repo', number: 42 } };

function fixture(change: 'missing' | 'disabled' | 'scope' | 'kind' | 'selector' | 'encryptedRevision') {
  let locked = false;
  const definition = serializeAutomationStoredWorkflowDefinitionRecipeV2({ v: 2, templateVersion: 1, triggerEvidence: null,
    workflow: { t: 'plain', v: { workspace: { directory: '/repo' }, executionTarget: { kind: 'session' },
      inlineDefinition: { version: 1, blocks: [{ kind: 'action', id: 'notice', actionId: 'notifications.notify_me',
        input: { message: { kind: 'literal', value: 'PR changed' } } }] } } } });
  if (definition.kind !== 'available') throw new Error('Invalid fixture recipe');
  const row = () => locked && change === 'missing' ? null : {
    id: triggerId, automationId: 'automation-one', enabled: !(locked && change === 'disabled'), revision: locked && change === 'encryptedRevision' ? 2 : 1,
    kind: locked && change === 'kind' ? 'ciFailed' : 'prComment',
    sourceSessionId: locked && change === 'scope' ? 'another-session' : scopedTrigger.sessionId,
    definitionEnvelope: JSON.stringify(sealAutomationTriggerDefinitionStoredEnvelopeV1({
      ...(change === 'encryptedRevision' ? { mode: 'e2ee' as const,
        material: createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee',
          material: { type: 'legacy', secret: new Uint8Array(32).fill(7) } }).material,
        randomBytes: (length: number) => new Uint8Array(length).fill(1) } : { mode: 'plain' as const }),
      binding: { v: 1, automationId: 'automation-one', triggerId, triggerRevision: locked && change === 'encryptedRevision' ? 2 : 1, triggerKind: 'prComment' },
      definition: { kind: 'prComment', pullRequest: { ...scopedTrigger.pullRequest, number: locked && change === 'selector' ? 43 : 42 } } })),
  };
  // Database is the sole mocked boundary. Mutating at lock acquisition models a CRUD change
  // committed after Conversation preflight and before canonical admission's locked reread.
  const tx = {
    automationTrigger: {
      findMany: async (input: { select: { kind?: boolean } }) => input.select.kind
        ? row() ? [row()] : [] : [{ id: triggerId }],
      updateMany: async () => { locked = true; return { count: change === 'missing' ? 0 : 1 }; },
      findUniqueOrThrow: async () => ({ revision: 1, remainingOccurrences: null }),
      findFirst: async () => row()?.enabled ? row() : null,
    },
    account: { findUnique: async () => ({ encryptionMode: change === 'encryptedRevision' ? 'e2ee' : 'plain' }) },
    automation: { findMany: async () => [{ id: 'automation-one', enabled: true, scopeSessionId: scopedTrigger.sessionId,
      targetType: null, templateVersion: 1, templateCiphertext: definition.serialized,
      assignments: [{ machineId: 'machine-one', priority: 0,
        machine: { accountId: 'account-one', revokedAt: null, replacedByMachineId: null } }] }] },
    automationRun: { findMany: async () => [], count: async () => MAX_NON_TERMINAL_EVENT_CONVERSATION_RUNS_PER_ACCOUNT },
  };
  // Narrow synthetic persistent database adapter: the real admission, locking and selector codec run.
  return tx as unknown as Tx;
}

describe('canonical scoped Conversation run admission', () => {
  it.each([
    ['missing', 'triggerNotFound'], ['disabled', 'triggerDisabled'], ['scope', 'triggerKindMismatch'],
    ['kind', 'triggerKindMismatch'], ['selector', 'triggerKindMismatch'], ['encryptedRevision', 'triggerKindMismatch'],
  ] as const)('rereads %s trigger state after the existing lock', async (change, reason) => {
    const result = await admitAutomationRunTx({ tx: fixture(change), accountId: 'account-one', automationId: 'automation-one',
      now: new Date(100), recipeFeaturePolicy: { workflowsEnabled: true }, scopedConversationTrigger: scopedTrigger,
      cause: { kind: 'conversation', triggerId, occurrenceKey: deriveAutomationManualOccurrenceKeyV1({
        automationId: 'automation-one', idempotencyKey: 'occurrence-one' }), occurredAt: 100 },
      triggerEvidenceEnvelope: JSON.stringify({ t: 'plain', v: { text: 'PR changed' } }),
    });
    expect(result).toEqual({ kind: 'ineligible', reason });
  });
});
