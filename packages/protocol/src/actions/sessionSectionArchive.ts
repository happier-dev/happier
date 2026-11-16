import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { pluginJsonValuesEqual } from '../plugins/contributions/jsonSchemaValues.js';
import { RPC_METHODS } from '../rpc/methods.js';

const id = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1)));
export const SessionSectionRefV1Schema = lazyZodSchema(() => z.strictObject({ sectionId: id }));

/** The captured member is a signed Session operand, never a new Machine-wide grant. */
export function readSessionStopChildTargetV1(params: unknown): Readonly<{ kind: 'session'; sessionId: string }> | null {
  const parsed = z.strictObject({ sessionId: id }).safeParse(params);
  return parsed.success ? { kind: 'session', sessionId: parsed.data.sessionId } : null;
}

export function isSessionStopChildRootV1(actionId: unknown): actionId is 'session.sections.archive' | 'session.delete' {
  return actionId === 'session.sections.archive' || actionId === 'session.delete';
}

/** Roots whose admitted native Stop runs, and is signed, as the `session.stop` phase. */
export function isSessionStopPhaseRootV1(actionId: unknown): boolean {
  return actionId === 'session.stop' || actionId === 'session.archive' || isSessionStopChildRootV1(actionId);
}

export function isSessionStopChildEffectV1(rootActionId: string, effectActionId: string): boolean {
  return isSessionStopChildRootV1(rootActionId) && effectActionId === 'session.stop';
}

export function isSessionStopChildV1(input: Readonly<{
  rootActionId: string; effectActionId: string; method: string; target: unknown; params?: unknown; rootInput?: unknown;
}>): boolean {
  if (!isSessionStopChildEffectV1(input.rootActionId, input.effectActionId)
    || input.method !== RPC_METHODS.STOP_SESSION
    || input.rootActionId === 'session.sections.archive' && input.rootInput !== undefined
      && !SessionSectionRefV1Schema.safeParse(input.rootInput).success) return false;
  const target = z.strictObject({ kind: z.literal('session'), sessionId: id }).safeParse(input.target);
  if (!target.success) return false;
  if (input.rootActionId === 'session.delete' && input.rootInput !== undefined
    && !pluginJsonValuesEqual(readSessionStopChildTargetV1(input.rootInput), target.data)) return false;
  // Home may see opaque ciphertext; its admitted receiver checks the exact opened operand.
  return typeof input.params === 'string' || pluginJsonValuesEqual(readSessionStopChildTargetV1(input.params), target.data);
}
