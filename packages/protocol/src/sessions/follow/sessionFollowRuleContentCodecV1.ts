import tweetnacl from 'tweetnacl';
import { z } from '../../zodRuntimePolicy.js';

import { lazyZodSchema } from '../../lazyZodSchema.js';
import { openAccountScopedBlobCiphertext, sealAccountScopedBlobCiphertext, type AccountScopedCryptoMaterial } from '../../crypto/accountScopedCipher.js';
import { FollowReceiverRefV1Schema, type FollowReceiverRefV1 } from './sessionDeliveryMuteV1.js';
import {
  SESSION_FOLLOW_RULE_CIPHER_KIND_V1, SessionFollowRuleIdV1Schema, SessionFollowRuleDefinitionV1Schema,
  SessionFollowRuleContentStoredReadV1Schema, assertSessionFollowRuleContentForModeV1, equalFollowRuleReceiverV1,
  type SessionFollowRuleDefinitionV1, type SessionFollowRuleContentV1,
} from './sessionFollowRuleV1.js';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';

const bindingSchema = lazyZodSchema(() => z.strictObject({
  ruleId: SessionFollowRuleIdV1Schema, receiver: FollowReceiverRefV1Schema, definition: SessionFollowRuleDefinitionV1Schema,
}));

/** Runtime crypto stays separate from the portable Rule schemas consumed by Actions. */
export function openSessionFollowRuleContentV1(input: Readonly<{
  ruleId: string; receiver: FollowReceiverRefV1; content: unknown; mode: 'plain' | 'e2ee'; material: AccountScopedCryptoMaterial | null;
}>): Readonly<{ status: 'opened'; definition: SessionFollowRuleDefinitionV1 }> | Readonly<{
  status: 'unavailable'; reason: 'account-mode-mismatch' | 'encryption-material-unavailable' | 'invalid-stored-content';
}> {
  const parsed = SessionFollowRuleContentStoredReadV1Schema.safeParse(input.content);
  if (!parsed.success) return { status: 'unavailable', reason: 'invalid-stored-content' };
  try { assertSessionFollowRuleContentForModeV1(parsed.data, input.mode); }
  catch { return { status: 'unavailable', reason: 'account-mode-mismatch' }; }
  if (input.mode === 'plain' && input.material !== null) return { status: 'unavailable', reason: 'account-mode-mismatch' };
  if (parsed.data.t === 'plain') return { status: 'opened', definition: parsed.data.v };
  if (!input.material) return { status: 'unavailable', reason: 'encryption-material-unavailable' };
  const opened = openAccountScopedBlobCiphertext({ kind: SESSION_FOLLOW_RULE_CIPHER_KIND_V1, material: input.material, ciphertext: parsed.data.c });
  const binding = createStoredReadSchema(bindingSchema).safeParse(opened?.value);
  return binding.success && binding.data.ruleId === input.ruleId && equalFollowRuleReceiverV1(binding.data.receiver, input.receiver)
    ? { status: 'opened', definition: binding.data.definition }
    : { status: 'unavailable', reason: 'invalid-stored-content' };
}

export function sealSessionFollowRuleContentV1(input: Readonly<{
  ruleId: string; receiver: FollowReceiverRefV1; definition: SessionFollowRuleDefinitionV1;
  mode: 'plain' | 'e2ee'; material: AccountScopedCryptoMaterial | null; randomBytes?: (length: number) => Uint8Array;
}>): SessionFollowRuleContentV1 {
  const binding = bindingSchema.parse({ ruleId: input.ruleId, receiver: input.receiver, definition: input.definition });
  if (input.mode === 'plain') {
    if (input.material !== null) throw new Error('account-mode-mismatch');
    return { t: 'plain', v: binding.definition };
  }
  if (!input.material) throw new Error('encryption-material-unavailable');
  return { t: 'encrypted', c: sealAccountScopedBlobCiphertext({ kind: SESSION_FOLLOW_RULE_CIPHER_KIND_V1,
    material: input.material, payload: binding, randomBytes: input.randomBytes ?? tweetnacl.randomBytes }) };
}
