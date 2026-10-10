import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

/**
 * The effective Team capabilities of one viewer for one Team, resolved by the
 * server from current Team membership, current Account lifecycle status,
 * current Home authority, and the Team's archived state.
 *
 * Clients render these; they never reconstruct them from a role. Role alone
 * never makes every boolean true — an archived Team, a suspended membership, or
 * an inactive Account each withdraw capabilities the role would otherwise
 * imply. Like the Home projection this is for rendering and precheck only and
 * never substitutes for the transactional authorization the mutation performs.
 *
 * `viewRoster` is whether the Team's roster and Groups are readable: a current
 * membership, or a Home administrator recovering an ownerless Team. `viewTeam`
 * alone (which Home administration also confers) does not admit those reads.
 *
 * `manageSettings` covers Team metadata and branding through one decision.
 * `manageAuthentication` is projected for the Lane 03 Authentication
 * destination; this child does not yet admit its mutation (see `team.ts`).
 */
export const TeamCapabilitiesV1Schema = lazyZodSchema(() => z.object({
  viewTeam: z.boolean(),
  viewRoster: z.boolean(),
  manageSettings: z.boolean(),
  managePolicy: z.boolean(),
  manageMembers: z.boolean(),
  manageGroups: z.boolean(),
  manageInvitations: z.boolean(),
  manageOwners: z.boolean(),
  manageAuthentication: z.boolean(),
  archiveTeam: z.boolean(),
  restoreTeam: z.boolean(),
  /** Self-removal is separate from Team administration, including suspended membership. */
  leave: z.boolean().default(false),
}).strict());

export type TeamCapabilitiesV1 = z.infer<typeof TeamCapabilitiesV1Schema>;

/**
 * The denied projection. An unknown viewer, an inactive Account, a removed
 * membership, and an unresolved decision all resolve here, so a missing
 * decision can never read as a granted capability.
 */
export const NO_TEAM_CAPABILITIES_V1: TeamCapabilitiesV1 = Object.freeze({
  viewTeam: false,
  viewRoster: false,
  manageSettings: false,
  managePolicy: false,
  manageMembers: false,
  manageGroups: false,
  manageInvitations: false,
  manageOwners: false,
  manageAuthentication: false,
  archiveTeam: false,
  restoreTeam: false,
  leave: false,
});
