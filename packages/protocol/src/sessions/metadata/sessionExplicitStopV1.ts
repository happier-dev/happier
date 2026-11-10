import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';
import type { ActionExecutorContext } from '../../actions/executor/types.js';
import { SessionSpawnLaunchErrorV1Schema } from '../creation/sessionSpawnLaunchErrorV1.js';

/** Resource/lifecycle Stop frees the runner; explicit Stop also holds future automatic wake. */
export type SessionStopIntent = 'explicit_stop' | 'lifecycle_control';

/** Classifies an admitted Stop author; Action dispatch and Home own target scope. */
export function resolveSessionExplicitControlIntent(input: Readonly<{
  rawSession: Readonly<{ id: string }>;
  executionAuthority?: ActionExecutorContext['authority'];
  actionContext?: ActionExecutorContext;
}>): 'person' | 'manager' | 'automatic' | 'unauthorized' | 'self_stop_forbidden' {
  const caller = input.actionContext?.actionCaller;
  const admittedCaller = input.actionContext?.agentStartContext?.caller;
  if (caller?.kind === 'session') {
    if (admittedCaller?.kind !== 'session' || admittedCaller.sessionId !== caller.sessionId) return 'unauthorized';
    return input.rawSession.id === caller.sessionId ? 'self_stop_forbidden' : 'manager';
  }
  return (input.actionContext?.authority ?? input.executionAuthority) === 'account_automation'
    ? 'automatic' : 'person';
}

export const SESSION_EXPLICIT_STOP_METADATA_KEY = 'sessionExplicitStopV1' as const;

export const SessionExplicitStopV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  cause: z.literal('explicit_stop'),
  requestId: z.string().check(z.trim(), z.minLength(1)),
  requestedAtMs: z.number().check(z.int(), z.nonnegative()),
  /** Present only when an admitted managing Session authored Stop. Legacy holds are person-only. */
  managerSessionId: z.optional(z.string().check(z.trim(), z.minLength(1))),
}));
export type SessionExplicitStopV1 = z.infer<typeof SessionExplicitStopV1Schema>;

/** Validates the admitted author before deciding whether this Stop authors a hold. */
export function buildSessionStopHoldV1(input: Parameters<typeof resolveSessionExplicitControlIntent>[0] & Readonly<{
  stopIntent: SessionStopIntent;
  requestId: string;
  requestedAtMs: number;
}>): Readonly<{ kind: 'refused'; reason: 'unauthorized' | 'self_stop_forbidden' }>
  | Readonly<{ kind: 'no_hold' }> | Readonly<{ kind: 'hold'; stop: SessionExplicitStopV1 }> {
  const author = resolveSessionExplicitControlIntent(input);
  if (author === 'unauthorized' || author === 'self_stop_forbidden') return { kind: 'refused', reason: author };
  if (input.stopIntent === 'lifecycle_control' || author === 'automatic') return { kind: 'no_hold' };
  const caller = input.actionContext?.actionCaller;
  return { kind: 'hold', stop: SessionExplicitStopV1Schema.parse({
    v: 1, cause: 'explicit_stop', requestId: input.requestId, requestedAtMs: input.requestedAtMs,
    ...(author === 'manager' && caller?.kind === 'session' ? { managerSessionId: caller.sessionId } : {}),
  }) };
}

export const SessionAutoResumeRefusalV1Schema = lazyZodSchema(() => z.enum([
  'held_by_person', 'archived', 'machine_unavailable', 'authority_unavailable',
]));
export type SessionAutoResumeRefusalV1 = z.infer<typeof SessionAutoResumeRefusalV1Schema>;
export type SessionAutoResumeAdmissionV1 = 'eligible' | SessionAutoResumeRefusalV1;

/** Read the existing presentation carrier; a refusal never grants launch or retry authority. */
export function readSessionAutoResumeRefusalV1(detail: unknown): SessionAutoResumeRefusalV1 | null {
  const launchError = SessionSpawnLaunchErrorV1Schema.safeParse(detail);
  return launchError.success ? SessionAutoResumeRefusalV1Schema.safeParse(launchError.data.code).data ?? null : null;
}

/** Shared by absent-runtime delivery and the machine's automatic launch owner. */
export function resolveSessionAutoResumeAdmissionV1(input: Readonly<{
  metadata: unknown;
  archivedAt?: unknown;
  machineAvailable: boolean;
  authorityAvailable: boolean;
}>): SessionAutoResumeAdmissionV1 {
  if (input.archivedAt !== null && input.archivedAt !== undefined) return 'archived';
  if (!input.authorityAvailable) return 'authority_unavailable';
  const stop = readSessionExplicitStopV1FromMetadata(input.metadata);
  if (stop && 'status' in stop) return 'authority_unavailable';
  if (stop) return 'held_by_person';
  if (!input.machineAvailable) return 'machine_unavailable';
  return 'eligible';
}

/** Absent means never explicitly stopped. Malformed state is not absence. */
export function readSessionExplicitStopV1FromMetadata(metadata: unknown):
  | SessionExplicitStopV1 | Readonly<{ status: 'invalid' }> | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return { status: 'invalid' };
  const raw = (metadata as Record<string, unknown>)[SESSION_EXPLICIT_STOP_METADATA_KEY];
  if (raw === undefined) return null;
  const parsed = SessionExplicitStopV1Schema.safeParse(raw);
  return parsed.success ? parsed.data : { status: 'invalid' };
}

export function writeSessionExplicitStopV1ToMetadata<M extends Record<string, unknown>>(
  metadata: M, stop: SessionExplicitStopV1,
): M & Record<typeof SESSION_EXPLICIT_STOP_METADATA_KEY, SessionExplicitStopV1> {
  return { ...metadata, [SESSION_EXPLICIT_STOP_METADATA_KEY]: SessionExplicitStopV1Schema.parse(stop) };
}

/** A completed older resume cannot clear a newer Stop. */
export function clearSessionExplicitStopV1FromMetadata(
  metadata: Record<string, unknown>, expectedRequestId: string,
): Record<string, unknown> {
  const current = readSessionExplicitStopV1FromMetadata(metadata);
  if (!current || 'status' in current || current.requestId !== expectedRequestId) return metadata;
  const next = { ...metadata };
  delete next[SESSION_EXPLICIT_STOP_METADATA_KEY];
  return next;
}
