import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

/**
 * The effective Home-governance capabilities of one viewer, resolved by the
 * server from current role, current lifecycle status, and current Home policy.
 *
 * Every member of this object has a real server operation and a real client
 * caller. It is a projection for rendering and precheck only: it never
 * substitutes for the transactional authorization the mutation itself performs,
 * and it is not a feature gate. Account lookup authority is intentionally
 * absent — search is authorized per exact scope, not as an Account-wide
 * boolean derived from managing any Team.
 */
export const HomeCapabilitiesV1Schema = lazyZodSchema(() => z.object({
  viewAdministration: z.boolean(),
  manageAccounts: z.boolean(),
  manageHomeRoles: z.boolean(),
  manageTeamCreationPolicy: z.boolean(),
  manageAuthentication: z.boolean(),
  /** Home settings (server configuration, mail, reachability), claim and runtime actions: owners only. */
  manageHomeSettings: z.boolean(),
  eraseAccounts: z.boolean(),
  createTeam: z.boolean(),
  manageAllTeams: z.boolean(),
}).strict());

export type HomeCapabilitiesV1 = z.infer<typeof HomeCapabilitiesV1Schema>;

/**
 * The denied projection. Inactive Accounts and unknown viewers resolve to this
 * value, so a missing decision can never read as a granted capability.
 */
export const NO_HOME_CAPABILITIES_V1: HomeCapabilitiesV1 = Object.freeze({
  viewAdministration: false,
  manageAccounts: false,
  manageHomeRoles: false,
  manageTeamCreationPolicy: false,
  manageAuthentication: false,
  manageHomeSettings: false,
  eraseAccounts: false,
  createTeam: false,
  manageAllTeams: false,
});
