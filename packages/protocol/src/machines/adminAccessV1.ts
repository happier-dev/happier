import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { createStoredReadSchema } from '../json/storedReadSchema.js';
import { getMachineMetadataFieldV1, mutateMachineMetadataFieldV1, readMachineMetadataFieldV1,
  type MachineMetadataFieldDefinitionV1, type MachineMetadataFieldPortV1 } from './machineMetadataFieldV1.js';

/** The separately authenticated administrator, never root or the locked daemon. */
export const MachineAdministratorUsernameV1Schema = lazyZodSchema(() => z.string().check(
  z.minLength(1), z.regex(/^[a-zA-Z_][a-zA-Z0-9_.-]*[$]?$/),
  z.refine(value => !['root', 'happier'].includes(value.toLowerCase()), 'Use a non-root administrator account'),
));

export const MachineAdminAccessV1Schema = lazyZodSchema(() => z.discriminatedUnion('mode', [
  z.strictObject({ version: z.literal(1), mode: z.literal('none') }),
  z.strictObject({ version: z.literal(1), mode: z.literal('ask'), administratorUsername: MachineAdministratorUsernameV1Schema }),
  z.strictObject({ version: z.literal(1), mode: z.literal('preauthorized') }),
]));
export type MachineAdminAccessV1 = z.infer<typeof MachineAdminAccessV1Schema>;

/** Nonsecret current attendance question; the response never enters an Action operand. */
export const MachineSudoPasswordPromptV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('sudo.password'), adminUsername: MachineAdministratorUsernameV1Schema,
}));
export type MachineSudoPasswordPromptV1 = z.infer<typeof MachineSudoPasswordPromptV1Schema>;

export const MachineTailscaledOperatorObservationV1Schema = lazyZodSchema(() => z.strictObject({
  authorization: z.enum(['allowed', 'denied', 'unavailable', 'unknown']),
}));
const MachineGroupMembershipObservationV1Schema = lazyZodSchema(() => z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('current') }),
  z.strictObject({ state: z.literal('pendingRestart'),
    addedGroups: z.array(z.string().check(z.minLength(1))),
    removedGroups: z.array(z.string().check(z.minLength(1))),
  }),
  z.strictObject({ state: z.literal('unknown') }),
]));
export const MachineAdminAccessObservationV1Schema = lazyZodSchema(() => z.strictObject({
  version: z.literal(1), observedAt: z.number().check(z.int(), z.nonnegative()),
  daemonUid: z.nullable(z.number().check(z.int(), z.nonnegative())),
  daemonUsername: z.nullable(z.string().check(z.minLength(1))),
  /** Absent historical evidence and null observations both mean unknown. */
  daemonPrimaryGroup: z.optional(z.nullable(z.string().check(z.regex(/^[a-z_][a-z0-9_.-]*[$]?$/i)))),
  daemonIdentity: z.enum(['root', 'nonRoot', 'unknown']),
  rootEquivalentGroups: z.nullable(z.array(z.string().check(z.minLength(1)))),
  /** AM-8: account-only additions and still-held process-only removals await restart. */
  groupMembership: z.optional(MachineGroupMembershipObservationV1Schema),
  passwordlessSudoToRoot: z.enum(['allowed', 'denied', 'unavailable', 'unknown']),
  managedDropIn: z.enum(['absent', 'valid', 'invalid', 'unknown']),
  tailscaledOperator: MachineTailscaledOperatorObservationV1Schema,
  reasonCode: z.optional(z.enum(['sudoUnavailable', 'dropInInvalid', 'needs_admin_to_check',
    'platformUnsupported', 'daemonRunningAsRoot', 'observationFailed'])),
}));
export type MachineAdminAccessObservationV1 = z.infer<typeof MachineAdminAccessObservationV1Schema>;

/** Missing historical operator evidence is unknown, never a denial or a grant. */
export const StoredMachineAdminAccessObservationV1Schema = lazyZodSchema(() => z.extend(
  createStoredReadSchema(MachineAdminAccessObservationV1Schema), {
    tailscaledOperator: z._default(createStoredReadSchema(MachineTailscaledOperatorObservationV1Schema),
      { authorization: 'unknown' }),
    groupMembership: z._default(createStoredReadSchema(MachineGroupMembershipObservationV1Schema),
      { state: 'unknown' }),
  },
));

/** Nonsecret native recovery material captured by the firewall owner before its first mutation. */
const MachineFirewallRecoveryFileV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('absent') }),
  z.strictObject({ kind: z.literal('file'), content: z.string() }),
]));
export const MachineFirewallRecoveryV1Schema = lazyZodSchema(() => z.strictObject({
  rules: MachineFirewallRecoveryFileV1Schema,
  unit: MachineFirewallRecoveryFileV1Schema,
  table: z.nullable(z.string()),
  boot: z.strictObject({ present: z.boolean(), enabled: z.boolean(), running: z.boolean() }),
}));
export type MachineFirewallRecoveryV1 = z.infer<typeof MachineFirewallRecoveryV1Schema>;

/** Present only when the same native owner has verified restoration of its captured state. */
export const MachineFirewallRestorationV1Schema = lazyZodSchema(() => z.strictObject({
  status: z.literal('verified'), recovery: MachineFirewallRecoveryV1Schema,
}));
export type MachineFirewallRestorationV1 = z.infer<typeof MachineFirewallRestorationV1Schema>;

export const MachineElevatedResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('outcome', [
  z.strictObject({ outcome: z.literal('applied'), observation: MachineAdminAccessObservationV1Schema }),
  z.strictObject({ outcome: z.literal('not_applied'), reasonCode: z.enum(['mode_none', 'not_preauthorized',
    'denied', 'platform_unsupported', 'plan_stale', 'cancelled']),
    restoration: z.optional(MachineFirewallRestorationV1Schema) }),
  z.strictObject({ outcome: z.literal('needs_attendance'), operationId: z.string().check(z.minLength(1)),
    prompt: MachineSudoPasswordPromptV1Schema }),
  z.strictObject({ outcome: z.literal('outcome_unknown'), restoration: z.optional(MachineFirewallRestorationV1Schema) }),
]));
export type MachineElevatedResultV1 = z.infer<typeof MachineElevatedResultV1Schema>;

export const MachineAdminAccessInspectResultV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ observation: MachineAdminAccessObservationV1Schema,
    checkedAt: z.number().check(z.int(), z.nonnegative()) }),
  z.strictObject({ status: z.enum(['locked', 'invalid', 'unavailable']) }),
]));
export type MachineAdminAccessInspectResultV1 = z.infer<typeof MachineAdminAccessInspectResultV1Schema>;

export const MachineAdminAccessMutationResultV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ status: z.enum(['applied', 'satisfied', 'unchanged']), policy: MachineAdminAccessV1Schema,
    metadataVersion: z.number().check(z.int(), z.nonnegative()), effect: z.optional(MachineElevatedResultV1Schema),
    observation: z.optional(MachineAdminAccessObservationV1Schema) }),
  z.strictObject({ status: z.literal('conflict'), policy: MachineAdminAccessV1Schema,
    metadataVersion: z.number().check(z.int(), z.nonnegative()) }),
  z.strictObject({ status: z.enum(['outcomeUnknown', 'cancelled', 'locked', 'invalid', 'unavailable']) }),
]));
export type MachineAdminAccessMutationResultV1 = z.infer<typeof MachineAdminAccessMutationResultV1Schema>;

export const MachineAdminAccessMutationV1Schema = lazyZodSchema(() => z.strictObject({
  expectedMetadataVersion: z.number().check(z.int(), z.nonnegative()),
  expectedAdminAccess: MachineAdminAccessV1Schema, adminAccess: MachineAdminAccessV1Schema,
  comparison: z.enum(['field', 'revision']),
}));
export type MachineAdminAccessMutationV1 = z.infer<typeof MachineAdminAccessMutationV1Schema>;

export const MachineAdminAccessFieldV1: MachineMetadataFieldDefinitionV1<MachineAdminAccessV1> = {
  field: 'adminAccess', storedSchema: MachineAdminAccessV1Schema,
  defaultValue: () => ({ version: 1, mode: 'none' }),
  equal: (left, right) => left.mode === right.mode
    && (left.mode !== 'ask' || right.mode === 'ask' && left.administratorUsername === right.administratorUsername),
};
export function readMachineAdminAccessV1(metadata: unknown) {
  return readMachineMetadataFieldV1(metadata, MachineAdminAccessFieldV1);
}
export function getMachineAdminAccessV1(port: MachineMetadataFieldPortV1) {
  return getMachineMetadataFieldV1(port, MachineAdminAccessFieldV1);
}
export async function mutateMachineAdminAccessV1(input: unknown, port: MachineMetadataFieldPortV1,
  options?: Readonly<{ signal?: AbortSignal }>) {
  const parsed = MachineAdminAccessMutationV1Schema.safeParse(input);
  if (!parsed.success) return { status: 'invalid' as const };
  const { expectedAdminAccess, adminAccess, ...comparison } = parsed.data;
  return mutateMachineMetadataFieldV1({ ...comparison, expectedPolicy: expectedAdminAccess, policy: adminAccess },
    port, MachineAdminAccessFieldV1, options);
}
