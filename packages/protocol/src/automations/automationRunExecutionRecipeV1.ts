import { z } from '../zodRuntimePolicy.js';
import { createStoredReadSchema } from '../json/storedReadSchema.js';
import { AutomationStoredContentEnvelopeV1Schema } from './automationStoredContentEnvelopeV1.js';
import {
  openAccountScopedBlobCiphertext,
  sealAccountScopedBlobCiphertext,
} from '../crypto/accountScopedCipher.js';
import {
  isAvailableE2eeAutomationAccountEncryptionV1,
  type AvailableAutomationAccountEncryptionV1,
} from './automationAccountCurrentnessV1.js';
import {
  AutomationRunTemplateV1ReadSchema,
  AutomationRunTemplateV1Schema,
  type AutomationRunTemplateV1,
} from './automationRunRecipeSchemaV1.js';

// Preserve the Protocol subpath for callers that open or seal stored Action content.
export * from './automationRunRecipeSchemaV1.js';

export type AutomationStoredActionDefinitionTemplateOpenResultV1 =
  | Readonly<{ kind: 'available'; template: AutomationRunTemplateV1 }>
  | Readonly<{ kind: 'contentInvalid' | 'modeMismatch' }>;

/**
 * The current Action-definition template carrier uses the same Account blob
 * codec as Workflow definitions. This is the only reader that exposes its
 * optional Automation display label to an Account host.
 */
export function openAutomationStoredActionDefinitionTemplateV1(params: Readonly<{
  template: unknown;
  encryption: AvailableAutomationAccountEncryptionV1;
}>): AutomationStoredActionDefinitionTemplateOpenResultV1 {
  const envelope = createStoredReadSchema(AutomationStoredContentEnvelopeV1Schema).safeParse(params.template);
  if (!envelope.success) return { kind: 'contentInvalid' };
  let raw: unknown;
  if (isAvailableE2eeAutomationAccountEncryptionV1(params.encryption)) {
    if (envelope.data.t !== 'encrypted') return { kind: 'modeMismatch' };
    const opened = openAccountScopedBlobCiphertext({
      kind: 'automation_template_payload',
      material: params.encryption.material.material,
      ciphertext: envelope.data.c,
    });
    if (!opened) return { kind: 'contentInvalid' };
    raw = opened.value;
  } else {
    if (envelope.data.t !== 'plain') return { kind: 'modeMismatch' };
    raw = envelope.data.v;
  }
  const template = AutomationRunTemplateV1ReadSchema.safeParse(raw);
  return template.success
    ? { kind: 'available', template: template.data }
    : { kind: 'contentInvalid' };
}

/** The matching current Action-definition writer; it never creates a second envelope. */
export function sealAutomationStoredActionDefinitionTemplateV1(params: Readonly<{
  template: AutomationRunTemplateV1;
  encryption: AvailableAutomationAccountEncryptionV1;
  randomBytes: (length: number) => Uint8Array;
}>): z.infer<typeof AutomationStoredContentEnvelopeV1Schema> {
  const template = AutomationRunTemplateV1Schema.parse(params.template);
  if (!isAvailableE2eeAutomationAccountEncryptionV1(params.encryption)) {
    return AutomationStoredContentEnvelopeV1Schema.parse({ t: 'plain', v: template });
  }
  return AutomationStoredContentEnvelopeV1Schema.parse({
    t: 'encrypted',
    c: sealAccountScopedBlobCiphertext({
      kind: 'automation_template_payload',
      material: params.encryption.material.material,
      payload: template,
      randomBytes: params.randomBytes,
    }),
  });
}
