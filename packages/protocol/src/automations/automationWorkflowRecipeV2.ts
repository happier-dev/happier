import { createStoredReadSchema } from '../json/storedReadSchema.js';
import { AutomationStoredContentEnvelopeV1Schema } from './automationStoredContentEnvelopeV1.js';
import {
  isAvailableE2eeAutomationAccountEncryptionV1,
  type AvailableAutomationAccountEncryptionV1,
} from './automationAccountCurrentnessV1.js';
import { openAccountScopedBlobCiphertext } from '../crypto/accountScopedCipher.js';
import {
  AutomationStoredWorkflowDefinitionV2ReadSchema,
  type AutomationStoredWorkflowDefinitionV2,
} from './automationWorkflowRecipeSchemaV2.js';

// Preserve the Protocol subpath for callers that open stored Workflow content.
export * from './automationWorkflowRecipeSchemaV2.js';

export type AutomationStoredWorkflowDefinitionV2OpenResult =
  | Readonly<{ kind: 'available'; definition: AutomationStoredWorkflowDefinitionV2 }>
  | Readonly<{ kind: 'contentInvalid' | 'modeMismatch' }>;

/**
 * The one Account-codec opener for the V2 Workflow definition carrier. It
 * never reinterprets an E2EE envelope as plain content, while stored reads
 * retain the released fields needed by pre-display rows.
 */
export function openAutomationStoredWorkflowDefinitionV2(params: Readonly<{
  workflow: unknown;
  encryption: AvailableAutomationAccountEncryptionV1;
}>): AutomationStoredWorkflowDefinitionV2OpenResult {
  const envelope = createStoredReadSchema(AutomationStoredContentEnvelopeV1Schema).safeParse(params.workflow);
  if (!envelope.success) return { kind: 'contentInvalid' };
  let raw: unknown;
  if (!isAvailableE2eeAutomationAccountEncryptionV1(params.encryption)) {
    if (envelope.data.t !== 'plain') return { kind: 'modeMismatch' };
    raw = envelope.data.v;
  } else {
    if (envelope.data.t !== 'encrypted') return { kind: 'modeMismatch' };
    const opened = openAccountScopedBlobCiphertext({
      kind: 'automation_template_payload',
      material: params.encryption.material.material,
      ciphertext: envelope.data.c,
    });
    if (!opened) return { kind: 'contentInvalid' };
    raw = opened.value;
  }
  const definition = AutomationStoredWorkflowDefinitionV2ReadSchema.safeParse(raw);
  return definition.success
    ? { kind: 'available', definition: definition.data }
    : { kind: 'contentInvalid' };
}
