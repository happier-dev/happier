import { expect, it } from 'vitest';
import {
  AutomationDefinitionPatchRequestSchema,
  type AutomationDefinitionPatchRequest,
} from '../../automations/automationApiV3.js';
import {
  isAvailableE2eeAutomationAccountEncryptionV1,
  type AvailableAutomationAccountEncryptionV1,
} from '../../automations/automationAccountCurrentnessV1.js';
import {
  AutomationTriggerDefinitionBindingV1Schema,
  openAutomationTriggerDefinitionStoredEnvelopeV1,
} from '../../automations/automationTriggerDefinitionStoredContent.js';
import { createAccountScopedCryptoMaterialSnapshotV1 } from '../../crypto/accountScopedCipher.js';
import { backfillAutomationManagedTargetsV1 } from './workflowTriggerAccountHost.js';

const plain: AvailableAutomationAccountEncryptionV1 = {
  kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null },
};
const encrypted: AvailableAutomationAccountEncryptionV1 = {
  kind: 'available', witness: { mode: 'e2ee', version: 1, contentKeyFingerprint: 'current' },
  material: createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee',
    material: { type: 'legacy', secret: new Uint8Array(32).fill(7) } }),
};

it.each([plain, encrypted])('seals retained Session selection at the same revision and recovers a lost migration response', async current => {
  const selection = {
    triggerId: 'legacy-session-trigger', triggerRevision: 7,
    subject: { kind: 'session', serverId: 'portable-home', sessionId: 'watched-session' },
    events: ['parentTurnCompleted'], policy: { kind: 'currentTurn', sourceTurnId: 'accepted-turn' },
  } as const;
  const definition = { automationId: 'legacy-session-habit', expectedTemplateVersion: 5, selections: [selection] };
  let legacy = true;
  const writes: AutomationDefinitionPatchRequest[] = [];
  // The HTTP/database boundary commits then loses its response. Real crypto,
  // migration orchestration and canonical wire schemas remain beneath it.
  const params = {
    resolveEncryption: async () => current,
    randomBytes: (length: number) => new Uint8Array(length).fill(3),
    automations: {
      listDetails: async (input: Readonly<Record<string, unknown>>) => ({
        automations: [], nextCursor: null,
        ...(input.legacySessionLifecycleSelections === true
          ? { legacySessionLifecycleSelections: legacy ? [definition] : [] } : {}),
      }),
      patch: async (_id: string, input: AutomationDefinitionPatchRequest, beforeWrite?: () => Promise<void>): Promise<never> => {
        await beforeWrite?.();
        writes.push(AutomationDefinitionPatchRequestSchema.parse(input));
        legacy = false;
        throw Object.assign(new Error('Response lost after commit'), { code: 'workflow_outcome_unresolved' });
      },
    },
  };
  expect(await backfillAutomationManagedTargetsV1(params)).toEqual({ updated: 0, unresolved: 1 });
  expect(writes).toHaveLength(1);
  expect(Object.keys(writes[0]!).sort()).toEqual(['expectedTemplateVersion', 'sessionLifecycleMigrations']);
  const migration = writes[0]!.sessionLifecycleMigrations![0]!;
  expect(migration).toMatchObject({ triggerId: selection.triggerId, expectedRevision: selection.triggerRevision });
  const binding = AutomationTriggerDefinitionBindingV1Schema.parse({ v: 1,
    automationId: definition.automationId, triggerId: selection.triggerId,
    triggerRevision: selection.triggerRevision, triggerKind: 'sessionLifecycle' });
  const opened = openAutomationTriggerDefinitionStoredEnvelopeV1({ binding,
    envelope: migration.triggerDefinitionEnvelope,
    ...(isAvailableE2eeAutomationAccountEncryptionV1(current)
      ? { mode: 'e2ee' as const, material: current.material.material } : { mode: 'plain' as const }),
  });
  expect(opened).toMatchObject({ kind: 'available', definition: { kind: 'sessionLifecycle',
    subject: selection.subject, events: selection.events, policy: selection.policy } });
  expect(await backfillAutomationManagedTargetsV1(params)).toEqual({ updated: 0, unresolved: 0 });
  expect(writes).toHaveLength(1);
});
