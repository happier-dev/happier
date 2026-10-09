import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';
import type { ActionRequiredAuthority, ActionSurfaces } from './metadata.js';

export const TerminalPresentUserPolicySchema = lazyZodSchema(() => z.enum(['allowed', 'disallowed']));
export type TerminalPresentUserPolicy = z.infer<typeof TerminalPresentUserPolicySchema>;
export const AUTHORITY_CEILING_HEADER_V1 = 'x-happier-authority-ceiling' as const;

/** A machine can narrow the Account policy, never widen it. */
export function combineTerminalPresentUserPolicies(
  ...values: readonly (TerminalPresentUserPolicy | null | undefined)[]
): TerminalPresentUserPolicy {
  return values.includes('disallowed') ? 'disallowed' : 'allowed';
}

/** The sole producer of invocation authority from verified credential provenance. */
export function resolveInvocationAuthority(input: Readonly<{
  credential: 'account' | 'terminal' | 'api_token' | 'plugin' | 'agent' | 'none';
  surface: keyof ActionSurfaces;
  terminalPolicy?: TerminalPresentUserPolicy;
}>): ActionRequiredAuthority {
  if (input.credential === 'account' && (input.surface === 'ui' || input.surface === 'rpc')) return 'present_user';
  if (input.credential === 'terminal'
    && input.terminalPolicy === 'allowed'
    && (input.surface === 'cli' || input.surface === 'rpc')) return 'present_user';
  return 'account_automation';
}
