import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { pluginJsonValuesEqual } from '../plugins/contributions/jsonSchemaValues.js';
import { RPC_METHODS } from '../rpc/methods.js';

const id = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1)));
export const SessionSectionRefV1Schema = lazyZodSchema(() => z.strictObject({ sectionId: id }));

/** The captured member is a signed Session operand, never a new Machine-wide grant. */
export function readSessionSectionArchiveStopTargetV1(params: unknown): Readonly<{ kind: 'session'; sessionId: string }> | null {
  const parsed = z.strictObject({ sessionId: id }).safeParse(params);
  return parsed.success ? { kind: 'session', sessionId: parsed.data.sessionId } : null;
}

export function isSessionSectionArchiveStopChildV1(input: Readonly<{
  rootActionId: string; effectActionId: string; method: string; target: unknown; params?: unknown; rootInput?: unknown;
}>): boolean {
  if (input.rootActionId !== 'session.sections.archive' || input.effectActionId !== 'session.stop'
    || input.method !== RPC_METHODS.STOP_SESSION
    || input.rootInput !== undefined && !SessionSectionRefV1Schema.safeParse(input.rootInput).success) return false;
  const target = z.strictObject({ kind: z.literal('session'), sessionId: id }).safeParse(input.target);
  if (!target.success) return false;
  // Home may see opaque ciphertext; its admitted receiver checks the exact opened operand.
  return typeof input.params === 'string' || pluginJsonValuesEqual(readSessionSectionArchiveStopTargetV1(input.params), target.data);
}
