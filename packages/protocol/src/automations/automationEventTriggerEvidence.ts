import {
  deriveAutomationTriggerEvidenceEqualityKeyV1,
  isAccountScopedBlobCiphertextForKind,
  sealAccountScopedBlobCiphertext,
  type AccountScopedCryptoMaterial,
} from '../crypto/accountScopedCipher.js';
import {
  deriveAutomationOccurrenceEvidenceEqualityTagV1,
  deriveAutomationOccurrenceKeyV1,
  AutomationOccurrenceEvidenceV1Schema,
  type AutomationConversationOccurrenceEvidenceV1,
  type AutomationOccurrenceEvidenceEqualityTagV1,
  type AutomationOccurrenceEvidenceV1,
  type AutomationPluginEventOccurrenceEvidenceV1,
} from './automationOccurrenceV1.js';
import { AutomationTriggerIdSchema } from './automationTriggerIdentity.js';
import {
  AutomationRunTriggerEvidenceV1Schema,
  type AutomationRunTriggerEvidenceV1,
} from './automationRunExecutionRecipeV1.js';

export const AUTOMATION_TRIGGER_EVIDENCE_ACCOUNT_SCOPED_BLOB_KIND_V1 =
  'automation_trigger_evidence' as const;

export type AutomationTriggerEvidenceEnvelopeV1 = Readonly<{
  t: 'encrypted';
  c: string;
}>;

/**
 * Seals one host-derived occurrence evidence payload — Event or Conversation —
 * for durable E2EE Automation rejoin. Plugin Action input never supplies this
 * envelope.
 */
export function sealAutomationOccurrenceTriggerEvidenceEnvelopeV1(params: Readonly<{
  material: AccountScopedCryptoMaterial;
  evidence: AutomationOccurrenceEvidenceV1;
  randomBytes: (length: number) => Uint8Array;
}>): AutomationTriggerEvidenceEnvelopeV1 {
  const evidence = AutomationOccurrenceEvidenceV1Schema.parse(params.evidence);
  return {
    t: 'encrypted',
    c: sealAccountScopedBlobCiphertext({
      kind: AUTOMATION_TRIGGER_EVIDENCE_ACCOUNT_SCOPED_BLOB_KIND_V1,
      material: params.material,
      payload: evidence,
      randomBytes: params.randomBytes,
    }),
  };
}

/**
 * Seals the complete immutable occurrence evidence retained by a frozen Run
 * recipe, for either cause arm. The base occurrence helper remains the
 * equality-tag input owner; this keeps source/filter and Conversation
 * correspondence in the same Account-scoped trigger-evidence ciphertext domain.
 */
export function sealAutomationRunTriggerEvidenceEnvelopeV1(params: Readonly<{
  material: AccountScopedCryptoMaterial;
  evidence: AutomationRunTriggerEvidenceV1;
  randomBytes: (length: number) => Uint8Array;
}>): AutomationTriggerEvidenceEnvelopeV1 {
  const evidence = AutomationRunTriggerEvidenceV1Schema.parse(params.evidence);
  return {
    t: 'encrypted',
    c: sealAccountScopedBlobCiphertext({
      kind: AUTOMATION_TRIGGER_EVIDENCE_ACCOUNT_SCOPED_BLOB_KIND_V1,
      material: params.material,
      payload: evidence,
      randomBytes: params.randomBytes,
    }),
  };
}

/**
 * Lets the ciphertext-blind server reject an otherwise valid Account-scoped
 * envelope whose authenticated domain is not occurrence trigger evidence.
 */
export function isAutomationTriggerEvidenceCiphertextV1(
  ciphertext: string,
): boolean {
  return isAccountScopedBlobCiphertextForKind({
    kind: AUTOMATION_TRIGGER_EVIDENCE_ACCOUNT_SCOPED_BLOB_KIND_V1,
    ciphertext,
  });
}

/**
 * Produces the opaque E2EE rejoin tag with the dedicated Account-content
 * derivation. The server compares the tag but cannot calculate it.
 */
export function deriveAutomationOccurrenceTriggerEvidenceEqualityTagV1(params:
  | Readonly<{
    material: AccountScopedCryptoMaterial;
    accountId: string;
    automationId: string;
    triggerId: string;
    evidence: AutomationPluginEventOccurrenceEvidenceV1;
  }>
  | Readonly<{
    material: AccountScopedCryptoMaterial;
    accountId: string;
    automationId: string;
    evidence: AutomationConversationOccurrenceEvidenceV1;
  }>
): AutomationOccurrenceEvidenceEqualityTagV1 {
  const purposeSeparatedAccountKey = deriveAutomationTriggerEvidenceEqualityKeyV1({
    material: params.material,
  });
  if ('triggerId' in params) {
    const triggerId = AutomationTriggerIdSchema.parse(params.triggerId);
    const occurrenceKey = deriveAutomationOccurrenceKeyV1({
      triggerId,
      evidence: params.evidence,
    });
    return deriveAutomationOccurrenceEvidenceEqualityTagV1({
      purposeSeparatedAccountKey,
      accountId: params.accountId,
      automationId: params.automationId,
      triggerId,
      occurrenceKey,
      evidence: params.evidence,
    });
  }

  const occurrenceKey = deriveAutomationOccurrenceKeyV1(params.evidence);
  return deriveAutomationOccurrenceEvidenceEqualityTagV1({
    purposeSeparatedAccountKey,
    accountId: params.accountId,
    automationId: params.automationId,
    occurrenceKey,
    evidence: params.evidence,
  });
}
