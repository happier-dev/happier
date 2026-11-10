import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';
import { sameStrictJsonValue } from '../../json/strictJsonValue.js';
import { MachineVitalsAlertsPolicyV1Schema, MachineVitalsAlertsPolicyPatchV1Schema } from '../vitals/machineVitalsAlertsV1.js';
import { MachineStoragePolicyV1Schema, MachineStoragePolicyPatchV1Schema } from '../../storage/storageV1.js';
import { MachineGuardPolicyV1Schema, MachineGuardPolicyPatchV1Schema, mergeMachineGuardPolicyV1 } from '../guard/guardPolicyV1.js';
import { getMachineMetadataFieldV1, readMachineMetadataFieldV1, readMachineMetadataSnapshotV1, mutateMachineMetadataFieldV1,
  type MachineMetadataFieldPortV1 } from '../machineMetadataFieldV1.js';

export const MachineProcessesPolicyV1Schema = lazyZodSchema(() => z.strictObject({
  allProcessesVisible: z._default(z.boolean(), false),
  toolIdleCloseMs: z._default(z.nullable(z.number().check(z.int(), z.minimum(1_000), z.maximum(Number.MAX_SAFE_INTEGER))), 300_000),
  // null uses the launch owner's RAM-derived admission; custom counts have only
  // the numeric representation boundary, not Auto's four-engine maximum.
  browserMaxConcurrent: z._default(z.nullable(z.number().check(z.int(), z.minimum(1), z.maximum(Number.MAX_SAFE_INTEGER))), null),
}));
export type MachineProcessesPolicyV1 = z.infer<typeof MachineProcessesPolicyV1Schema>;
export const MachineProcessesPolicyPatchV1Schema = lazyZodSchema(() => z.strictObject({
  allProcessesVisible: z.optional(MachineProcessesPolicyV1Schema.shape.allProcessesVisible._zod.def.innerType),
  toolIdleCloseMs: z.optional(MachineProcessesPolicyV1Schema.shape.toolIdleCloseMs._zod.def.innerType),
  browserMaxConcurrent: z.optional(MachineProcessesPolicyV1Schema.shape.browserMaxConcurrent._zod.def.innerType),
}));

export const MachineMonitoringPolicyV1Schema = lazyZodSchema(() => z.strictObject({
  mode: z._default(z.enum(['off', 'while_viewing', 'always']), 'always'),
  intervalMs: z._default(z.number().check(z.int(), z.minimum(1), z.maximum(Number.MAX_SAFE_INTEGER)), 2_000),
}));
export type MachineMonitoringPolicyV1 = z.infer<typeof MachineMonitoringPolicyV1Schema>;
export const MachineMonitoringPolicyPatchV1Schema = lazyZodSchema(() => z.strictObject({
  mode: z.optional(MachineMonitoringPolicyV1Schema.shape.mode._zod.def.innerType),
  intervalMs: z.optional(MachineMonitoringPolicyV1Schema.shape.intervalMs._zod.def.innerType),
}));

export const MachineResourcesPolicyV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1), alerts: z._default(MachineVitalsAlertsPolicyV1Schema, () => MachineVitalsAlertsPolicyV1Schema.parse({})),
  monitoring: z._default(MachineMonitoringPolicyV1Schema, () => MachineMonitoringPolicyV1Schema.parse({})),
  processes: z._default(MachineProcessesPolicyV1Schema, () => MachineProcessesPolicyV1Schema.parse({})),
  storage: z._default(MachineStoragePolicyV1Schema, () => MachineStoragePolicyV1Schema.parse({})),
  guard: z._default(MachineGuardPolicyV1Schema, () => MachineGuardPolicyV1Schema.parse({})),
}));
export type MachineResourcesPolicyV1 = z.infer<typeof MachineResourcesPolicyV1Schema>;
export const MachineResourcesPolicyV1StoredSchema = createStoredReadSchema(MachineResourcesPolicyV1Schema);
export const MachineResourcesPolicyPatchV1Schema = lazyZodSchema(() => z.strictObject({ alerts: z.optional(MachineVitalsAlertsPolicyPatchV1Schema),
  monitoring: z.optional(MachineMonitoringPolicyPatchV1Schema),
  processes: z.optional(MachineProcessesPolicyPatchV1Schema),
  storage: z.optional(MachineStoragePolicyPatchV1Schema),
  guard: z.optional(MachineGuardPolicyPatchV1Schema),
}));
export type MachineResourcesPolicyPatchV1 = z.infer<typeof MachineResourcesPolicyPatchV1Schema>;
export const MachineResourcesPolicyMutationV1Schema = lazyZodSchema(() => z.strictObject({
  expectedRevision: z.number().check(z.int(), z.nonnegative(), z.maximum(Number.MAX_SAFE_INTEGER)), patch: MachineResourcesPolicyPatchV1Schema,
}));
export const MachineResourcesPolicyGetResultV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ status: z.literal('ready'), policy: MachineResourcesPolicyV1Schema, revision: z.number().check(z.int(), z.nonnegative()), source: z.enum(['stored', 'default']) }),
  z.strictObject({ status: z.enum(['locked', 'invalid', 'unavailable']) }),
]));
export type MachineResourcesPolicyGetResultV1 = z.infer<typeof MachineResourcesPolicyGetResultV1Schema>;
export const MachineResourcesPolicyMutationResultV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ status: z.enum(['applied', 'unchanged', 'conflict']), policy: MachineResourcesPolicyV1Schema, revision: z.number().check(z.int(), z.nonnegative()) }),
  z.strictObject({ status: z.enum(['unavailable', 'unsupported']), reason: z.string().check(z.minLength(1)) }),
]));
export type MachineResourcesPolicyMutationResultV1 = z.infer<typeof MachineResourcesPolicyMutationResultV1Schema>;
const definition = { field: 'resourcesPolicyV1', storedSchema: MachineResourcesPolicyV1StoredSchema,
  defaultValue: (): MachineResourcesPolicyV1 => MachineResourcesPolicyV1Schema.parse({ v: 1 }), equal: sameStrictJsonValue };
export function readMachineResourcesPolicyV1(metadata: unknown) { return readMachineMetadataFieldV1(metadata, definition); }
export function readMachineResourcesPolicyV1SnapshotFromMetadata(input: Readonly<{ metadata: unknown; metadataVersion: number; hasContentKey: boolean }>): MachineResourcesPolicyGetResultV1 {
  if (!input.hasContentKey) return { status: 'locked' };
  if (!Number.isSafeInteger(input.metadataVersion) || input.metadataVersion < 0) return { status: 'invalid' };
  const result = readMachineResourcesPolicyV1(input.metadata);
  return result.status === 'ready' ? { ...result, revision: input.metadataVersion } : result;
}
export async function getMachineResourcesPolicyV1(port: MachineMetadataFieldPortV1): Promise<MachineResourcesPolicyGetResultV1> {
  const result = await getMachineMetadataFieldV1(port, definition);
  if (result.status !== 'ready') return result;
  const { metadataVersion, ...snapshot } = result;
  return { ...snapshot, revision: metadataVersion };
}
export async function mutateMachineResourcesPolicyV1(input: unknown, port: MachineMetadataFieldPortV1, options?: Readonly<{ signal?: AbortSignal }>): Promise<MachineResourcesPolicyMutationResultV1> {
  const parsed = MachineResourcesPolicyMutationV1Schema.safeParse(input);
  if (!parsed.success) return { status: 'unavailable', reason: 'invalid_policy_patch' };
  const snapshot = await readMachineMetadataSnapshotV1(port);
  if (snapshot.status !== 'ready') return { status: 'unavailable', reason: snapshot.status };
  const current = readMachineResourcesPolicyV1(snapshot.metadata);
  if (current.status !== 'ready') return { status: 'unavailable', reason: current.status };
  const patch = parsed.data.patch.alerts;
  const merged = MachineResourcesPolicyV1Schema.safeParse({ ...current.policy,
    monitoring: { ...current.policy.monitoring, ...parsed.data.patch.monitoring },
    processes: { ...current.policy.processes, ...parsed.data.patch.processes },
    storage: { ...current.policy.storage, ...parsed.data.patch.storage },
    guard: mergeMachineGuardPolicyV1(current.policy.guard, parsed.data.patch.guard), alerts: {
    memory: { ...current.policy.alerts.memory, ...patch?.memory }, cpu: { ...current.policy.alerts.cpu, ...patch?.cpu },
    disk: { ...current.policy.alerts.disk, ...patch?.disk },
  } });
  if (!merged.success) return { status: 'unavailable', reason: 'invalid_policy_patch' };
  const policy = merged.data;
  let initialRead = true;
  const result = await mutateMachineMetadataFieldV1({ expectedMetadataVersion: parsed.data.expectedRevision, expectedPolicy: current.policy, policy, comparison: 'revision' },
    { ...port, read: async () => { if (!initialRead) return port.read(); initialRead = false; return snapshot; } }, definition, options);
  if (result.status === 'applied' || result.status === 'satisfied' || result.status === 'unchanged' || result.status === 'conflict') {
    return { status: result.status === 'satisfied' ? 'applied' : result.status, policy: result.policy, revision: result.metadataVersion };
  }
  return { status: 'unavailable', reason: result.status };
}
