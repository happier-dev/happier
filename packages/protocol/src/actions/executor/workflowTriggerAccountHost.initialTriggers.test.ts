import { expect, it } from 'vitest';
import { createAccountWorkflowTriggerActions, type WorkflowTriggerAccountHostParams } from './workflowTriggerAccountHost.js';
import { SessionInitialTriggerAdmissionV1Schema } from '../../sessions/creation/sessionInitialTriggerAdmissionV1.js';
import { AutomationTriggerDefinitionBindingV1Schema, openAutomationTriggerDefinitionStoredEnvelopeV1 } from '../../automations/automationTriggerDefinitionStoredContent.js';
import { isAvailableE2eeAutomationAccountEncryptionV1, type AvailableAutomationAccountEncryptionV1 } from '../../automations/automationAccountCurrentnessV1.js';
import { createAccountScopedCryptoMaterialSnapshotV1 } from '../../crypto/accountScopedCipher.js';
import { WorkflowDefinitionV1Schema } from '../../workflows/workflowV1.js';

const definition = WorkflowDefinitionV1Schema.parse({ version: 1, defaults: {}, blocks: [{ kind: 'action', id: 'notice',
  actionId: 'notifications.notify_me', input: { message: { kind: 'literal', value: 'Session started' } } }] });
const modes: AvailableAutomationAccountEncryptionV1[] = [
  { kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } },
  { kind: 'available', witness: { mode: 'e2ee', version: 1, contentKeyFingerprint: 'current' },
    material: createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee',
      material: { type: 'legacy', secret: new Uint8Array(32).fill(7) } }) },
];

it.each(modes)('serializes a sealed initial Session trigger through the strict birth DTO ($witness.mode)', async current => {
  const unexpectedWrite = async (): Promise<never> => { throw new Error('Initial triggers commit only with Session birth'); };
  let nextId = 0;
  // Automation HTTP persistence is the boundary. Account sealing, trigger
  // preparation and the strict Session birth DTO stay real.
  const params: WorkflowTriggerAccountHostParams = {
    resolveEncryption: async () => current, randomBytes: length => new Uint8Array(length).fill(3),
    newId: () => `initial-${++nextId}`, resolveWorkflow: async () => ({ definition }),
    automations: { list: async () => ({ automations: [], nextCursor: null }),
      listDetails: async () => ({ automations: [], nextCursor: null }), get: async () => null,
      create: unexpectedWrite, reconcile: unexpectedWrite, delete: unexpectedWrite },
  };
  const prepared = await createAccountWorkflowTriggerActions(params).prepareSessionInitialTriggers({
    project: { machineId: 'machine-one', directory: '/workspace' }, preparedFinalSessionId: 'born-session',
    initialTriggers: [{ target: { kind: 'inline', definition },
      trigger: { kind: 'sessionLifecycle', enabled: true, events: ['sessionStarted'], policy: { kind: 'firstMatch' } } }],
    caller: { surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' }, serverId: 'home', serverIdentityId: 'portable-home' },
  });
  const admission = SessionInitialTriggerAdmissionV1Schema.parse(JSON.parse(JSON.stringify(prepared[0])));
  const trigger = admission.triggers[0]!;
  expect(trigger.trigger).toMatchObject({ kind: 'sessionLifecycle', enabled: true, events: ['sessionStarted'], policy: { kind: 'firstMatch' } });
  if (!('triggerDefinitionEnvelope' in trigger.trigger)) throw new Error('Expected sealed birth trigger');
  const binding = AutomationTriggerDefinitionBindingV1Schema.parse({ v: 1, automationId: admission.automationId,
    triggerId: trigger.triggerId, triggerRevision: 0, triggerKind: 'sessionLifecycle' });
  expect(openAutomationTriggerDefinitionStoredEnvelopeV1({ binding, envelope: trigger.trigger.triggerDefinitionEnvelope,
    ...(isAvailableE2eeAutomationAccountEncryptionV1(current)
      ? { mode: 'e2ee', material: current.material.material } : { mode: 'plain' }) })).toMatchObject({ kind: 'available',
    definition: { kind: 'sessionLifecycle', subject: { kind: 'session', serverId: 'portable-home', sessionId: 'born-session' } } });
});
