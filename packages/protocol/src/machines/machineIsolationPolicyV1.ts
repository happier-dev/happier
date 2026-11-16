import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { createStoredReadSchema } from '../json/storedReadSchema.js';
import { sameStrictJsonValue } from '../json/strictJsonValue.js';
import { MachineIsolationPolicyV1Schema, type MachineIsolationPolicyV1 } from './machineIsolationV1.js';
import { getMachineMetadataFieldV1, mutateMachineMetadataFieldV1, readMachineMetadataFieldV1,
  type MachineMetadataFieldPortV1 } from './machineMetadataFieldV1.js';

export const MachineIsolationMutationV1Schema = lazyZodSchema(() => z.strictObject({
  expectedMetadataVersion: z.number().check(z.int(), z.nonnegative()),
  expectedPolicy: MachineIsolationPolicyV1Schema,
  policy: MachineIsolationPolicyV1Schema,
}));
export type MachineIsolationMutationV1 = z.infer<typeof MachineIsolationMutationV1Schema>;
export const MachineIsolationGetResultV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ status: z.literal('ready'), policy: MachineIsolationPolicyV1Schema,
    source: z.enum(['default', 'stored']), metadataVersion: z.number().check(z.int(), z.nonnegative()) }),
  z.strictObject({ status: z.enum(['locked', 'invalid', 'unavailable']) }),
]));
export type MachineIsolationGetResultV1 = z.infer<typeof MachineIsolationGetResultV1Schema>;
export const MachineIsolationMutationResultV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ status: z.enum(['applied', 'satisfied', 'unchanged', 'conflict']),
    policy: MachineIsolationPolicyV1Schema, metadataVersion: z.number().check(z.int(), z.nonnegative()) }),
  z.strictObject({ status: z.enum(['outcomeUnknown', 'cancelled', 'locked', 'invalid', 'unavailable']) }),
]));
export type MachineIsolationMutationResultV1 = z.infer<typeof MachineIsolationMutationResultV1Schema>;
export type MachineIsolationConfiguredSandboxV1 = MachineIsolationPolicyV1['configuredSandboxes'][string];
export type MachineIsolationReferenceValidationV1 = 'valid' | 'invalid' | 'locked' | 'unavailable';

export type MachineIsolationWorkSelectionV1 = Readonly<{
  status: 'selected';
  workKind: keyof MachineIsolationPolicyV1['workKinds'];
  choice: MachineIsolationPolicyV1['workKinds']['sessions'];
  configuredSandbox?: MachineIsolationConfiguredSandboxV1;
}> | Readonly<{ status: 'unavailable'; reason: 'machine_isolation_sandbox_unavailable' }>;

/** Pure policy selection only. A proposed choice grants no permission or target availability. */
export function selectMachineIsolationWorkChoiceV1(policy: MachineIsolationPolicyV1, input: Readonly<{
  workKind: keyof MachineIsolationPolicyV1['workKinds'];
  choice?: MachineIsolationPolicyV1['workKinds']['sessions'];
}>): MachineIsolationWorkSelectionV1 {
  const choice = input.choice ?? policy.workKinds[input.workKind];
  if (choice.kind === 'directly') return { status: 'selected', workKind: input.workKind, choice };
  const configuredSandbox = policy.configuredSandboxes[choice.configuredSandboxId];
  return configuredSandbox
    ? { status: 'selected', workKind: input.workKind, choice, configuredSandbox }
    : { status: 'unavailable', reason: 'machine_isolation_sandbox_unavailable' };
}

export const machineIsolationMetadataFieldV1 = {
  field: 'isolationPolicyV1', storedSchema: createStoredReadSchema(MachineIsolationPolicyV1Schema),
  defaultValue: (): MachineIsolationPolicyV1 => ({ configuredSandboxes: {}, workKinds: {
    sessions: { kind: 'directly' }, botsChannels: { kind: 'directly' }, automationsWorkflows: { kind: 'directly' },
  } }),
  equal: sameStrictJsonValue,
};
export async function getMachineIsolationV1(port: MachineMetadataFieldPortV1): Promise<MachineIsolationGetResultV1> {
  return getMachineMetadataFieldV1(port, machineIsolationMetadataFieldV1);
}
export function readMachineIsolationSnapshotFromMetadataV1(input: Readonly<{
  metadata: unknown; metadataVersion: number;
}>): MachineIsolationGetResultV1 {
  if (!Number.isSafeInteger(input.metadataVersion) || input.metadataVersion < 0) return { status: 'invalid' };
  const result = readMachineMetadataFieldV1(input.metadata, machineIsolationMetadataFieldV1);
  return result.status === 'ready' ? { ...result, metadataVersion: input.metadataVersion } : result;
}

/** Reference validation is performed once at the admitted save, before the incumbent field CAS. */
export async function mutateMachineIsolationV1(input: unknown, port: MachineMetadataFieldPortV1,
  options: Readonly<{ signal?: AbortSignal;
    validateConfiguredSandboxes: (entries: MachineIsolationPolicyV1['configuredSandboxes']) => Promise<MachineIsolationReferenceValidationV1>;
  }>): Promise<MachineIsolationMutationResultV1> {
  const parsed = MachineIsolationMutationV1Schema.safeParse(input);
  if (!parsed.success) return { status: 'invalid' };
  const { policy } = parsed.data;
  if (Object.values(policy.workKinds).some(choice => choice.kind === 'sandbox'
    && !Object.hasOwn(policy.configuredSandboxes, choice.configuredSandboxId))) return { status: 'invalid' };
  if (options.signal?.aborted) return { status: 'cancelled' };
  if (Object.keys(policy.configuredSandboxes).length > 0) {
    const status = await options.validateConfiguredSandboxes(policy.configuredSandboxes);
    if (status !== 'valid') return { status };
  }
  return mutateMachineMetadataFieldV1({ ...parsed.data, comparison: 'field' }, port, machineIsolationMetadataFieldV1, options);
}
