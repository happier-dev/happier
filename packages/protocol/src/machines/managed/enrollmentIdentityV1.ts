import * as z from 'zod/mini';
import { lazyDefinition } from '../../lazyZodSchema.js';
import { MachineAdministratorUsernameV1Schema, MachineAdminAccessFieldV1, type MachineAdminAccessV1, type MachineAdminAccessMutationV1 } from '../adminAccessV1.js';
import { agentIsolationMetadataFieldV1, type MachineAgentIsolationPolicyV1, type MachineAgentIsolationPreviewInputV1, type MachineAgentIsolationSetInputV1 } from '../agentIsolationV1.js';

/** Exact child Actions of the retained creation, never a general guest grant. */
export const MANAGED_MACHINE_CREATION_CHILD_ACTION_IDS_V1 = [
  'session.spawn_new', 'machines.setup.plan', 'machines.setup.apply', 'machines.setup.adminAccess.set',
  'machines.agentIsolation.preview', 'machines.agentIsolation.set',
] as const;

/** Reviewed creation intent; credentials never belong to this retained value. */
export const ManagedMachineEnrollmentIdentityV1Schema = lazyDefinition(() => z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('dedicatedDaemonUser'), username: z.literal('happier'), serviceMode: z.literal('user'),
    role: z.enum(['server', 'deployTarget']), adminAccessAtCreation: z.enum(['preauthorized', 'ask', 'none']),
    administrator: z.optional(z.strictObject({ username: MachineAdministratorUsernameV1Schema })),
  }).check(z.superRefine((value, context) => {
    if (value.adminAccessAtCreation === 'ask' && !value.administrator) {
      context.addIssue({ code: 'custom', path: ['administrator'], message: 'Ask requires a named administrator.' });
    }
  })),
  z.strictObject({ kind: z.literal('existingUser'), role: z.enum(['personal', 'adopted']) }),
  z.strictObject({ kind: z.literal('guestProcess'), role: z.literal('sandbox') }),
]));
export type ManagedMachineEnrollmentIdentityV1 = z.infer<typeof ManagedMachineEnrollmentIdentityV1Schema>;

/** Personal/adopted enrollment leaves the incumbent missing-field/off policy alone. */
export function resolveManagedMachineEnrollmentAgentIsolationV1(identity: ManagedMachineEnrollmentIdentityV1 | undefined): MachineAgentIsolationPolicyV1 | null {
  return identity?.kind === 'dedicatedDaemonUser' ? { enabled: true, memberProvisioning: 'linuxUsersV1' } : null;
}

/** Creation can only request its reviewed enablement; the field owner preserves stored off. */
export function matchesManagedMachineEnrollmentAgentIsolationV1(target: Readonly<{
  homeId: string; machineId: string; enrollmentIdentity?: ManagedMachineEnrollmentIdentityV1;
}>, request: MachineAgentIsolationPreviewInputV1 | MachineAgentIsolationSetInputV1): boolean {
  const policy = resolveManagedMachineEnrollmentAgentIsolationV1(target.enrollmentIdentity);
  return policy !== null && request.machineId === target.machineId
    && (request.serverId === undefined || request.serverId === target.homeId)
    && agentIsolationMetadataFieldV1.equal(request, policy);
}

/** Creation policy comes from the immutable reviewed intent, never the carrier. */
export function resolveManagedMachineEnrollmentAdminAccessV1(identity: ManagedMachineEnrollmentIdentityV1 | undefined): MachineAdminAccessV1 | null {
  if (identity?.kind !== 'dedicatedDaemonUser') return null;
  return identity.adminAccessAtCreation === 'ask'
    ? { version: 1, mode: 'ask', administratorUsername: identity.administrator!.username }
    : { version: 1, mode: identity.adminAccessAtCreation };
}

/** The creation child can only record its reviewed policy over the initial None. */
export function matchesManagedMachineEnrollmentAdminAccessV1(target: Readonly<{
  homeId: string; machineId: string; enrollmentIdentity?: ManagedMachineEnrollmentIdentityV1;
}>, request: MachineAdminAccessMutationV1 & Readonly<{ serverId?: string; machineId: string }>): boolean {
  const policy = resolveManagedMachineEnrollmentAdminAccessV1(target.enrollmentIdentity);
  return policy !== null && request.machineId === target.machineId
    && (request.serverId === undefined || request.serverId === target.homeId)
    && request.comparison === 'field' && request.expectedAdminAccess.mode === 'none'
    && MachineAdminAccessFieldV1.equal(policy, request.adminAccess);
}
