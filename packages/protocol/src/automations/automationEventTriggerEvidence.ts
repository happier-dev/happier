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
  type AutomationOccurrenceEvidenceEqualityTagV1,
  type AutomationOccurrenceEvidenceV1,
} from './automationOccurrenceV1.js';
import {
  AutomationRunPluginEventTriggerEvidenceV1Schema,
  type AutomationRunPluginEventTriggerEvidenceV1,
} from './automationRunExecutionRecipeV1.js';

export const AUTOMATION_TRIGGER_EVIDENCE_ACCOUNT_SCOPED_BLOB_KIND_V1 =
  'automation_trigger_evidence' as const;

export type AutomationEventTriggerEvidenceEnvelopeV1 = Readonly<{
  t: 'encrypted';
  c: string;
}>;

/**
 * Seals one host-derived Event occurrence evidence payload for durable E2EE
 * Automation rejoin. Plugin Action input never supplies this envelope.
 */
export function sealAutomationEventTriggerEvidenceEnvelopeV1(params: Readonly<{
  material: AccountScopedCryptoMaterial;
  evidence: AutomationOccurrenceEvidenceV1;
  randomBytes: (length: number) => Uint8Array;
}>): AutomationEventTriggerEvidenceEnvelopeV1 {
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
 * Seals the complete immutable Event evidence retained by a frozen Run recipe.
 * The base occurrence helper remains the equality-tag input owner; this keeps
 * source/filter correspondence in the same Account-scoped Event-evidence
 * ciphertext domain.
 */
export function sealAutomationRunPluginEventTriggerEvidenceEnvelopeV1(params: Readonly<{
  material: AccountScopedCryptoMaterial;
  evidence: AutomationRunPluginEventTriggerEvidenceV1;
  randomBytes: (length: number) => Uint8Array;
}>): AutomationEventTriggerEvidenceEnvelopeV1 {
  const evidence = AutomationRunPluginEventTriggerEvidenceV1Schema.parse(params.evidence);
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
 * envelope whose authenticated domain is not Event trigger evidence.
 */
export function isAutomationEventTriggerEvidenceCiphertextV1(
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
export function deriveAutomationEventTriggerEvidenceEqualityTagV1(params: Readonly<{
  material: AccountScopedCryptoMaterial;
  accountId: string;
  automationId: string;
  evidence: AutomationOccurrenceEvidenceV1;
}>): AutomationOccurrenceEvidenceEqualityTagV1 {
  const evidence = AutomationOccurrenceEvidenceV1Schema.parse(params.evidence);
  return deriveAutomationOccurrenceEvidenceEqualityTagV1({
    purposeSeparatedAccountKey: deriveAutomationTriggerEvidenceEqualityKeyV1({
      material: params.material,
    }),
    accountId: params.accountId,
    automationId: params.automationId,
    occurrenceKey: deriveAutomationOccurrenceKeyV1(evidence),
    evidence,
  });
}
