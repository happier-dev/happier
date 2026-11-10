import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from '../../../zodRuntimePolicy.js';

export const SERVER_IDENTITY_ID_PATTERN = /^srv_[A-Za-z0-9._-]{1,60}$(?![\s\S])/;

export function normalizeServerIdentityIdCapability(value: unknown): string | null | undefined {
  if (value == null) return value;
  if (typeof value !== 'string') return null;

  const trimmed = value.trim();
  return SERVER_IDENTITY_ID_PATTERN.test(trimmed) ? trimmed : null;
}

/** Resolves an identifier using the host's established profile/portable Home binding. */
export type ServerProfileScopeResolver = (identifier: string) => string | null | undefined;

/** One equivalence rule for local profile ids and portable Home ids; unknown ids fail closed. */
export function areServerProfileIdentifiersEquivalent(
  leftRaw: string | null | undefined,
  rightRaw: string | null | undefined,
  resolveScopeId?: ServerProfileScopeResolver,
): boolean {
  const left = leftRaw?.trim();
  const right = rightRaw?.trim();
  if (!left || !right) return false;
  if (left === right) return true;
  const leftScope = resolveScopeId?.(left)?.trim();
  const rightScope = resolveScopeId?.(right)?.trim();
  return Boolean(leftScope && rightScope && leftScope === rightScope);
}

const ServerIdentityIdSchema = lazyZodSchema(() => (<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform(normalizeServerIdentityIdCapability), z._default(z.optional(z.nullable(z.string())), null)));

export const ServerIdentityCapabilitiesSchema = lazyZodSchema(() => z.object({
  serverIdentityId: ServerIdentityIdSchema,
}));

export type ServerIdentityCapabilities = z.infer<typeof ServerIdentityCapabilitiesSchema>;

export const DEFAULT_SERVER_IDENTITY_CAPABILITIES: ServerIdentityCapabilities = {
  serverIdentityId: null,
};
