/** Opened metadata and the incumbent transport's one-attempt compare-and-swap. */
export type MachineMetadataFieldReadV1 =
  | Readonly<{ status: 'ready'; metadata: Record<string, unknown>; metadataVersion: number }>
  | Readonly<{ status: 'locked' | 'invalid' | 'unavailable' }>;
export type MachineMetadataFieldPortV1 = Readonly<{
  read: () => Promise<MachineMetadataFieldReadV1>;
  compareAndSwap: (input: Readonly<{ metadata: Record<string, unknown>; expectedMetadataVersion: number }>) => Promise<
    | Readonly<{ status: 'applied' | 'conflict'; metadata: Record<string, unknown>; metadataVersion: number }>
    | Readonly<{ status: 'outcomeUnknown' | 'locked' | 'invalid' | 'unavailable' }>
  >;
}>;
export type MachineMetadataFieldDefinitionV1<T> = Readonly<{
  field: string;
  storedSchema: { safeParse(value: unknown): { success: true; data: T } | { success: false } };
  defaultValue: () => T;
  equal: (left: T, right: T) => boolean;
}>;
export type MachineMetadataFieldValueV1<T> =
  | Readonly<{ status: 'ready'; policy: T; source: 'default' | 'stored' }>
  | Readonly<{ status: 'invalid' | 'unavailable' }>;
export function readMachineMetadataFieldV1<T>(metadata: unknown, definition: MachineMetadataFieldDefinitionV1<T>): MachineMetadataFieldValueV1<T> {
  if (metadata === null || metadata === undefined) return { status: 'unavailable' };
  if (typeof metadata !== 'object' || Array.isArray(metadata)) return { status: 'invalid' };
  const value = Reflect.get(metadata, definition.field);
  if (value === undefined) return { status: 'ready', policy: definition.defaultValue(), source: 'default' };
  const parsed = definition.storedSchema.safeParse(value);
  return parsed.success ? { status: 'ready', policy: parsed.data, source: 'stored' } : { status: 'invalid' };
}
export async function readMachineMetadataSnapshotV1(port: MachineMetadataFieldPortV1): Promise<MachineMetadataFieldReadV1> {
  try { return await port.read(); } catch { return { status: 'unavailable' }; }
}
export async function getMachineMetadataFieldV1<T>(port: MachineMetadataFieldPortV1, definition: MachineMetadataFieldDefinitionV1<T>) {
  const snapshot = await readMachineMetadataSnapshotV1(port);
  if (snapshot.status !== 'ready') return snapshot;
  const result = readMachineMetadataFieldV1(snapshot.metadata, definition);
  return result.status === 'ready' ? { ...result, metadataVersion: snapshot.metadataVersion } : result;
}
/** Field-semantic clients rebase unrelated edits; revision clients return the first contention. */
export type MachineMetadataFieldMutationResultV1<T> =
  | Readonly<{ status: 'conflict' | 'applied' | 'unchanged' | 'satisfied'; policy: T; metadataVersion: number }>
  | Readonly<{ status: 'cancelled' | 'invalid' | 'unavailable' | 'locked' | 'outcomeUnknown' }>;
export async function mutateMachineMetadataFieldV1<T>(
  mutation: Readonly<{ expectedMetadataVersion: number; expectedPolicy: T; policy: T; comparison: 'field' | 'revision' }>,
  port: MachineMetadataFieldPortV1,
  definition: MachineMetadataFieldDefinitionV1<T>,
  options?: Readonly<{ signal?: AbortSignal }>,
): Promise<MachineMetadataFieldMutationResultV1<T>> {
  if (options?.signal?.aborted) return { status: 'cancelled' as const };
  let snapshot = await readMachineMetadataSnapshotV1(port);
  while (snapshot.status === 'ready') {
    const current = readMachineMetadataFieldV1(snapshot.metadata, definition);
    if (current.status !== 'ready') return current;
    if (mutation.comparison === 'revision' && snapshot.metadataVersion !== mutation.expectedMetadataVersion) {
      return { status: 'conflict' as const, policy: current.policy, metadataVersion: snapshot.metadataVersion };
    }
    if (definition.equal(current.policy, mutation.policy)) return {
      status: definition.equal(current.policy, mutation.expectedPolicy) ? 'unchanged' as const : 'satisfied' as const,
      policy: current.policy, metadataVersion: snapshot.metadataVersion,
    };
    if (!definition.equal(current.policy, mutation.expectedPolicy) || snapshot.metadataVersion < mutation.expectedMetadataVersion) {
      return { status: 'conflict' as const, policy: current.policy, metadataVersion: snapshot.metadataVersion };
    }
    if (options?.signal?.aborted) return { status: 'cancelled' as const };
    let answer: Awaited<ReturnType<MachineMetadataFieldPortV1['compareAndSwap']>>;
    try {
      answer = await port.compareAndSwap({ metadata: { ...snapshot.metadata, [definition.field]: mutation.policy }, expectedMetadataVersion: snapshot.metadataVersion });
    } catch { answer = { status: 'outcomeUnknown' }; }
    if (answer.status === 'conflict') {
      snapshot = { ...answer, status: 'ready' };
      if (mutation.comparison === 'field') continue;
      const observed = readMachineMetadataFieldV1(answer.metadata, definition);
      return observed.status === 'ready' ? { status: 'conflict' as const, policy: observed.policy, metadataVersion: answer.metadataVersion } : observed;
    }
    if (answer.status === 'applied') {
      const observed = readMachineMetadataFieldV1(answer.metadata, definition);
      return observed.status === 'ready' && definition.equal(observed.policy, mutation.policy)
        ? { status: 'applied' as const, policy: observed.policy, metadataVersion: answer.metadataVersion }
        : { status: 'outcomeUnknown' as const };
    }
    if (answer.status !== 'outcomeUnknown') return { status: answer.status };
    // An accepted write can lose its ACK. Observe once, never replay it.
    const observation = await readMachineMetadataSnapshotV1(port);
    if (observation.status === 'ready') {
      const observed = readMachineMetadataFieldV1(observation.metadata, definition);
      if (observed.status === 'ready' && definition.equal(observed.policy, mutation.policy)) {
        return { status: 'satisfied' as const, policy: observed.policy, metadataVersion: observation.metadataVersion };
      }
    }
    return { status: 'outcomeUnknown' as const };
  }
  return snapshot;
}
