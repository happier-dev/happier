import { z } from 'zod';

import { createStoredReadSchema } from '../json/storedReadSchema.js';
import { lazyZodSchema } from '../lazyZodSchema.js';

// Action input/output inference consumes the classic schema at this public seam.
export const MachineFinitePolicyV1Schema = lazyZodSchema(() => z.object({
  accepting: z.boolean(),
  runAtMost: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
}).strict());
export type MachineFinitePolicyV1 = z.infer<typeof MachineFinitePolicyV1Schema>;
export const MachineFinitePolicyV1StoredSchema = createStoredReadSchema(MachineFinitePolicyV1Schema);

export const MachineFinitePolicyMutationV1Schema = lazyZodSchema(() => z.object({
  expectedPolicy: MachineFinitePolicyV1Schema,
  expectedMetadataVersion: z.number().int().nonnegative(),
  policy: MachineFinitePolicyV1Schema,
}).strict());
export type MachineFinitePolicyMutationV1 = z.infer<typeof MachineFinitePolicyMutationV1Schema>;

export const MachineFinitePolicyGetResultV1Schema = lazyZodSchema(() => z.union([
  z.object({ status: z.literal('ready'), policy: MachineFinitePolicyV1Schema,
    source: z.enum(['default', 'stored']), metadataVersion: z.number().int().nonnegative() }).strict(),
  z.object({ status: z.enum(['locked', 'invalid', 'unavailable']) }).strict(),
]));
export type MachineFinitePolicyGetResultV1 = z.infer<typeof MachineFinitePolicyGetResultV1Schema>;

export const MachineFinitePolicyMutationResultV1Schema = lazyZodSchema(() => z.union([
  z.object({ status: z.enum(['applied', 'satisfied', 'unchanged', 'conflict']),
    policy: MachineFinitePolicyV1Schema, metadataVersion: z.number().int().nonnegative() }).strict(),
  z.object({ status: z.enum(['outcomeUnknown', 'cancelled', 'locked', 'invalid', 'unavailable']) }).strict(),
]));
export type MachineFinitePolicyMutationResultV1 = z.infer<typeof MachineFinitePolicyMutationResultV1Schema>;

type OpenedMetadata = Record<string, unknown>;
export type MachineFinitePolicyMetadataReadV1 =
  | Readonly<{ status: 'ready'; metadata: OpenedMetadata; metadataVersion: number }>
  | Readonly<{ status: 'locked' | 'invalid' | 'unavailable' }>;

/** The existing Machine mode/key reader and metadata CAS own transport admission. */
export type MachineFinitePolicyMetadataPortV1 = Readonly<{
  read: () => Promise<MachineFinitePolicyMetadataReadV1>;
  compareAndSwap: (input: Readonly<{ metadata: OpenedMetadata; expectedMetadataVersion: number }>) => Promise<
    | Readonly<{ status: 'applied' | 'conflict'; metadata: OpenedMetadata; metadataVersion: number }>
    | Readonly<{ status: 'outcomeUnknown' | 'locked' | 'invalid' | 'unavailable' }>
  >;
}>;

export function readMachineFinitePolicyV1(openedMetadata: unknown):
  | Readonly<{ status: 'ready'; policy: MachineFinitePolicyV1; source: 'default' | 'stored' }>
  | Readonly<{ status: 'invalid' | 'unavailable' }> {
  if (openedMetadata === null || openedMetadata === undefined) return { status: 'unavailable' };
  if (typeof openedMetadata !== 'object' || Array.isArray(openedMetadata)) return { status: 'invalid' };
  const value = (openedMetadata as OpenedMetadata).finitePolicyV1;
  if (value === undefined) return { status: 'ready', policy: { accepting: true, runAtMost: null }, source: 'default' };
  const parsed = MachineFinitePolicyV1StoredSchema.safeParse(value);
  return parsed.success ? { status: 'ready', policy: parsed.data, source: 'stored' } : { status: 'invalid' };
}

export async function getMachineFinitePolicyV1(port: MachineFinitePolicyMetadataPortV1): Promise<MachineFinitePolicyGetResultV1> {
  const snapshot = await readSnapshot(port);
  if (snapshot.status !== 'ready') return snapshot;
  const result = readMachineFinitePolicyV1(snapshot.metadata);
  return result.status === 'ready' ? { ...result, metadataVersion: snapshot.metadataVersion } : result;
}

function policiesEqual(left: MachineFinitePolicyV1, right: MachineFinitePolicyV1): boolean {
  return left.accepting === right.accepting && left.runAtMost === right.runAtMost;
}

async function readSnapshot(port: MachineFinitePolicyMetadataPortV1): Promise<MachineFinitePolicyMetadataReadV1> {
  try { return await port.read(); } catch { return { status: 'unavailable' }; }
}

/** Compare only policy semantics; unrelated metadata contention rebases through the incumbent CAS. */
export async function mutateMachineFinitePolicyV1(
  input: unknown,
  port: MachineFinitePolicyMetadataPortV1,
  options?: Readonly<{ signal?: AbortSignal }>,
): Promise<MachineFinitePolicyMutationResultV1> {
  const parsed = MachineFinitePolicyMutationV1Schema.safeParse(input);
  if (!parsed.success) return { status: 'invalid' };
  const mutation = parsed.data;
  if (options?.signal?.aborted) return { status: 'cancelled' };
  let snapshot = await readSnapshot(port);
  while (snapshot.status === 'ready') {
    const current = readMachineFinitePolicyV1(snapshot.metadata);
    if (current.status !== 'ready') return current;
    if (policiesEqual(current.policy, mutation.policy)) {
      return { status: policiesEqual(current.policy, mutation.expectedPolicy) ? 'unchanged' : 'satisfied',
        policy: current.policy, metadataVersion: snapshot.metadataVersion };
    }
    if (!policiesEqual(current.policy, mutation.expectedPolicy) || snapshot.metadataVersion < mutation.expectedMetadataVersion) {
      return { status: 'conflict', policy: current.policy, metadataVersion: snapshot.metadataVersion };
    }
    if (options?.signal?.aborted) return { status: 'cancelled' };
    let answer: Awaited<ReturnType<MachineFinitePolicyMetadataPortV1['compareAndSwap']>>;
    try {
      answer = await port.compareAndSwap({ metadata: { ...snapshot.metadata, finitePolicyV1: mutation.policy },
        expectedMetadataVersion: snapshot.metadataVersion });
    } catch { answer = { status: 'outcomeUnknown' }; }
    if (answer.status === 'conflict') {
      snapshot = { ...answer, status: 'ready' };
      continue;
    }
    if (answer.status === 'applied') {
      const observed = readMachineFinitePolicyV1(answer.metadata);
      if (observed.status !== 'ready') return { status: 'outcomeUnknown' };
      return policiesEqual(observed.policy, mutation.policy)
        ? { status: 'applied', policy: observed.policy, metadataVersion: answer.metadataVersion }
        : { status: 'outcomeUnknown' };
    }
    if (answer.status !== 'outcomeUnknown') return { status: answer.status };
    // A transport failure may follow acceptance. Observe; never replay this attempt.
    const observation = await readSnapshot(port);
    if (observation.status === 'ready') {
      const observed = readMachineFinitePolicyV1(observation.metadata);
      if (observed.status === 'ready' && policiesEqual(observed.policy, mutation.policy)) {
        return { status: 'satisfied', policy: observed.policy, metadataVersion: observation.metadataVersion };
      }
    }
    return { status: 'outcomeUnknown' };
  }
  return snapshot;
}
