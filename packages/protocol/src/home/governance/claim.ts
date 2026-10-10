import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

/**
 * Claiming an ownerless Home from the app with a one-time code (plan
 * `2026-09-26-home-owner-console` §3.5, decision A(b), AM-1, D-5).
 *
 * The code is minted on demand by the deployment-local `happier-server
 * --print-home-claim-code` command, lives 15 minutes and is single use. The app
 * sends it to `home.governance.claim`; every refusal reads the same
 * (`home_claim_refused`), so a failed attempt learns nothing.
 */
export const HOME_CLAIM_CODE_COMMAND_ARGUMENT_V1 = '--print-home-claim-code';

/** Characters of a printed code: RFC 4648 base32, without padding. */
const HOME_CLAIM_CODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
/** 32 random bytes encode to 52 base32 characters. */
export const HOME_CLAIM_CODE_LENGTH_V1 = 52;
const HOME_CLAIM_CODE_GROUP = 4;

/**
 * Canonical form of a typed or pasted code: separators and whitespace removed,
 * upper case. `null` when what remains cannot be a code, so a client can keep
 * Claim disabled; the server applies the same rule and refuses the rest.
 */
export function normalizeHomeClaimCodeV1(input: string): string | null {
  const compact = input.replace(/[\s-]+/g, '').toUpperCase();
  if (compact.length !== HOME_CLAIM_CODE_LENGTH_V1) return null;
  for (const character of compact) {
    if (!HOME_CLAIM_CODE_ALPHABET.includes(character)) return null;
  }
  return compact;
}

/** Encodes random bytes as a code in its canonical form. */
export function encodeHomeClaimCodeV1(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += HOME_CLAIM_CODE_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += HOME_CLAIM_CODE_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** How a canonical code is printed: groups of four joined by dashes. */
export function formatHomeClaimCodeV1(code: string): string {
  const groups: string[] = [];
  for (let index = 0; index < code.length; index += HOME_CLAIM_CODE_GROUP) {
    groups.push(code.slice(index, index + HOME_CLAIM_CODE_GROUP));
  }
  return groups.join('-');
}

export const HomeGovernanceClaimInputV1Schema = lazyZodSchema(() => z.object({
  /** As typed or pasted; the server normalizes it. Bounded so a paste cannot be arbitrarily large. */
  code: z.string().min(1).max(256),
}).strict());
export type HomeGovernanceClaimInputV1 = z.infer<typeof HomeGovernanceClaimInputV1Schema>;

export const HomeGovernanceClaimResultV1Schema = lazyZodSchema(() => z.object({
  status: z.literal('claimed'),
}).strict());
export type HomeGovernanceClaimResultV1 = z.infer<typeof HomeGovernanceClaimResultV1Schema>;

/**
 * The deployment-local owner claim (`happier-server --claim-home-owner=<accountId>`),
 * decision A(a). The hosting desktop runs it through the hsetup system task
 * `relay.runtime.personal_home.claim_owner.v1`; there is no HTTP equivalent.
 */
export const HOME_OWNER_CLAIM_COMMAND_ARGUMENT_V1 = '--claim-home-owner';

/** Account ids are bounded like every other protocol Account id. */
export const HomeOwnerClaimAccountIdV1Schema = lazyZodSchema(() => z.string().trim().min(1).max(256));

export const HomeOwnerClaimResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.object({ status: z.literal('claimed'), ownerAccountId: z.string().min(1) }),
  z.object({ status: z.literal('already_owned'), activeOwnerCount: z.number().int().min(1) }),
  z.object({ status: z.literal('target_inactive') }),
  z.object({ status: z.literal('target_not_found') }),
]));
export type HomeOwnerClaimResultV1 = z.infer<typeof HomeOwnerClaimResultV1Schema>;

/**
 * The one-shot's structured stdout line. A refusal is a result, not a failure:
 * the command exits nonzero for every status except `claimed` and still prints
 * this exact shape. `homeServerIdentityId` names the Home that was changed.
 */
export const HomeOwnerClaimCommandOutputV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  command: z.literal('claim-home-owner'),
  intent: z.enum(['initial_claim', 'lost_owner_recovery']),
  homeServerIdentityId: z.string().min(1).nullable(),
  targetAccountId: z.string().min(1),
  result: HomeOwnerClaimResultV1Schema,
}));
export type HomeOwnerClaimCommandOutputV1 = z.infer<typeof HomeOwnerClaimCommandOutputV1Schema>;
