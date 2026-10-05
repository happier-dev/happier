import tweetnacl from 'tweetnacl';
import { decodeBase64 } from '../crypto/base64.js';
import { parseSerializedJsonValue } from '../crypto/serializedJsonValue.js';
import { openAccountScopedBlobCiphertext, type AccountScopedCryptoMaterial } from '../crypto/accountScopedCipher.js';
import { AUTOMATION_TEMPLATE_CIPHERTEXT_MAX_CHARS, AUTOMATION_TEMPLATE_PLAIN_V1_KIND,
  normalizeAutomationTemplateEnvelopeStoredRead, type AutomationTemplateEnvelopeStoredRead } from './automationTemplateEnvelope.js';
import { AutomationTemplatePayloadV1Schema, type AutomationTemplatePayloadV1 } from './automationTemplatePayloadV1.js';

export type AutomationTemplateStoredOpenResultV1 =
  | Readonly<{ ok: true; template: AutomationTemplatePayloadV1 }>
  | Readonly<{ ok: false; code: 'invalid_template' | 'encryption_mode_mismatch' | 'encryption_material_unavailable' | 'session_key_required' }>;

export type AutomationTemplateRetainedSessionV1 = Readonly<{
  /** Resolved by the authenticated Session owner, never from encrypted content or key presence. */
  sessionId: string;
  encryptionMode: 'plain' | 'e2ee';
  /** Genuine predecessor custody, used only to open this retained Session's template. */
  material?: AccountScopedCryptoMaterial;
}>;

/** Parses only the persisted framing. It never treats an outer Session id as content authority. */
export function readAutomationTemplateStoredEnvelopeV1(bytes: string): AutomationTemplateEnvelopeStoredRead | null {
  if (typeof bytes !== 'string' || bytes.length > AUTOMATION_TEMPLATE_CIPHERTEXT_MAX_CHARS) return null;
  try { return normalizeAutomationTemplateEnvelopeStoredRead(JSON.parse(bytes)); } catch { return null; }
}

/** Both decrypted and plain content take the same predecessor schema and outer-id consistency check. */
export function readAutomationTemplateStoredPayloadV1(stored: AutomationTemplateEnvelopeStoredRead, payload: unknown): AutomationTemplatePayloadV1 | null {
  const parsed = AutomationTemplatePayloadV1Schema.safeParse(payload);
  if (!parsed.success || !automationTemplateStoredPayloadMatchesEnvelopeV1(stored, parsed.data)) return null;
  return parsed.data;
}

/** Framing-only consumers must check the authenticated id before returning arbitrary content. */
export function automationTemplateStoredPayloadMatchesEnvelopeV1(stored: AutomationTemplateEnvelopeStoredRead, payload: unknown): boolean {
  if (!stored.legacyExistingSessionId) return true;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !('existingSessionId' in payload)) return false;
  return typeof payload.existingSessionId === 'string' && payload.existingSessionId.trim() === stored.legacyExistingSessionId;
}

/** Exact released template-only recovery; generic Account crypto deliberately does not accept untagged blobs. */
function openPredecessorTemplateCiphertext(ciphertext: string, material: AccountScopedCryptoMaterial): unknown {
  const scoped = openAccountScopedBlobCiphertext({ kind: 'automation_template_payload', ciphertext, material });
  if (scoped) return scoped.value;
  const bytes = decodeBase64(ciphertext, 'base64');
  const key = material.type === 'legacy' ? material.secret : material.machineKey;
  if (key.length !== tweetnacl.secretbox.keyLength
    || bytes.length < tweetnacl.secretbox.nonceLength + tweetnacl.secretbox.overheadLength) return null;
  const plain = tweetnacl.secretbox.open(bytes.slice(tweetnacl.secretbox.nonceLength),
    bytes.slice(0, tweetnacl.secretbox.nonceLength), key);
  return plain ? parseSerializedJsonValue(new TextDecoder().decode(plain)) : null;
}

function openStored(stored: AutomationTemplateEnvelopeStoredRead, material?: AccountScopedCryptoMaterial): AutomationTemplateStoredOpenResultV1 {
  if (stored.envelope.kind !== AUTOMATION_TEMPLATE_PLAIN_V1_KIND && !material) return { ok: false, code: 'encryption_material_unavailable' };
  try {
    const payload = stored.envelope.kind === AUTOMATION_TEMPLATE_PLAIN_V1_KIND ? stored.envelope.payload
      : openPredecessorTemplateCiphertext(stored.envelope.payloadCiphertext, material!);
    const template = readAutomationTemplateStoredPayloadV1(stored, payload);
    return template ? { ok: true, template } as const : { ok: false, code: 'invalid_template' } as const;
  } catch { return { ok: false, code: 'invalid_template' } as const; }
}

/** Account mode comes from its persisted authority. Retained Session custody is a separate explicit branch. */
export function openAutomationTemplateStoredV1(params: Readonly<{
  templateCiphertext: string; accountMode: 'plain' | 'e2ee'; material?: AccountScopedCryptoMaterial;
  retainedSession?: AutomationTemplateRetainedSessionV1;
}>): AutomationTemplateStoredOpenResultV1 {
  const stored = readAutomationTemplateStoredEnvelopeV1(params.templateCiphertext);
  if (!stored) return { ok: false, code: 'invalid_template' };
  const plain = stored.envelope.kind === AUTOMATION_TEMPLATE_PLAIN_V1_KIND;
  if (!plain && params.accountMode === 'plain' && stored.legacyExistingSessionId) {
    const session = params.retainedSession;
    if (!session) return { ok: false, code: 'session_key_required' };
    if (session.sessionId !== stored.legacyExistingSessionId || session.encryptionMode !== 'e2ee') {
      return { ok: false, code: 'encryption_mode_mismatch' };
    }
    if (!session.material) return { ok: false, code: 'session_key_required' };
    return openStored(stored, session.material);
  }
  if (plain !== (params.accountMode === 'plain')) return { ok: false, code: 'encryption_mode_mismatch' };
  return openStored(stored, params.material);
}

/** Only the Account transition owner uses historical ciphertext as a source before rewriting by CAS. */
export function openAutomationTemplateStoredForMigrationV1(params: Readonly<{
  templateCiphertext: string; material?: AccountScopedCryptoMaterial;
}>): AutomationTemplateStoredOpenResultV1 {
  const stored = readAutomationTemplateStoredEnvelopeV1(params.templateCiphertext);
  return stored ? openStored(stored, params.material) : { ok: false, code: 'invalid_template' };
}
