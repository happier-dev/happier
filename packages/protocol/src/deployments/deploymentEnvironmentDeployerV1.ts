import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { PrincipalRefV1Schema, type PrincipalRefV1 } from '../teams/principal.js';

/** Who may act on an Environment: its managers, every deploying member, or the chosen principals.
 * Deployers and database editors share this one mode, its member predicate and its copy. */
const PEOPLE_MODES = ['managers', 'members', 'chosen'] as const;
export const DeploymentEnvironmentPeopleModeV1Schema = lazyZodSchema(() => z.enum(PEOPLE_MODES));
export type DeploymentEnvironmentPeopleModeV1 = z.infer<typeof DeploymentEnvironmentPeopleModeV1Schema>;
/** Database editing on an Environment: off (the default), or the same people choice as deployers. */
export const DeploymentEnvironmentDataEditorModeV1Schema = lazyZodSchema(() => z.enum(['off', ...PEOPLE_MODES]));
export type DeploymentEnvironmentDataEditorModeV1 = z.infer<typeof DeploymentEnvironmentDataEditorModeV1Schema>;

/** The D13 agent level vocabulary a database owner chooses from. The approval applier consumes it as an
 * Action-time target input; admission and storage accept only `DatabaseAgentAccessV1` until the write
 * levels are enabled together with that applier input. Owned here because the Environment record stores it;
 * `@happier-dev/database-protocol` re-exports it for every other database consumer. */
export const DatabaseAgentLevelV1Schema = lazyZodSchema(() => z.enum(['none', 'read', 'readWriteAsk', 'readWriteNoApproval']));
export type DatabaseAgentLevelV1 = z.infer<typeof DatabaseAgentLevelV1Schema>;
/** Agent levels a database can be set to and admitted at today (P3 U1–U2: none and read). */
export const DatabaseAgentAccessV1Schema = lazyZodSchema(() => z.enum(['none', 'read'] satisfies readonly DatabaseAgentLevelV1[]));
export type DatabaseAgentAccessV1 = z.infer<typeof DatabaseAgentAccessV1Schema>;

/** One stable identity per principal, shared by uniqueness, deltas and the admission matcher. */
export function deploymentEnvironmentPrincipalKeyV1(principal: PrincipalRefV1): string {
  return principal.kind === 'account' ? `account:${principal.accountId}`
    : principal.kind === 'team' ? `team:${principal.teamId}` : `group:${principal.teamId}:${principal.groupId}`;
}

/** Exact chosen identities; membership and Source access are always resolved at admission. */
export const DeploymentEnvironmentPrincipalsV1Schema = lazyZodSchema(() => z.array(PrincipalRefV1Schema).check(
  z.refine(principals => new Set(principals.map(deploymentEnvironmentPrincipalKeyV1)).size === principals.length,
    { message: 'Chosen principals must be unique.' })));
