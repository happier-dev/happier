import { createHash } from 'node:crypto';
import { assertAgentIsolationLaunchPrincipal as assertLaunchPrincipal, buildAgentIsolationBootstrapSteps, buildAgentIsolationToolsRootStep } from '@happier-dev/cli-common/systemTasks/nativeRemoteSshBootstrap';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { MachineRecipeStepV1Schema, type MachineRecipeStepV1 } from '@happier-dev/protocol/machines/setup/machineRecipeV1';
import type { MachineAdminAccessObservationV1 } from '@happier-dev/protocol';
import { resolveManagedToolsRoot } from '@happier-dev/cli-common/agents';
import type { HostRequesterExecutionIdentity } from './agentIsolationLaunchPolicy';

export type AgentIsolationMemberRequester = Extract<HostRequesterExecutionIdentity, { kind: 'isolated' }>
  & Readonly<{ homeServerIdentityId: string }>;
export type AgentIsolationDaemonObservation = Pick<MachineAdminAccessObservationV1,
  'daemonIdentity' | 'daemonUid' | 'daemonUsername' | 'daemonPrimaryGroup'>;
export type AgentIsolationMemberIdentity = Readonly<{
  requester: AgentIsolationMemberRequester['requester'];
  homeServerIdentityId: string;
  digest: string;
  username: string;
  primaryGroup: string;
  home: string;
  workspaceRoot: string;
  ownershipMarker: string;
}>;

/** Deterministic OS projection, never an authorization or a replacement selector. */
export function deriveAgentIsolationMemberIdentity(identity: Pick<AgentIsolationMemberRequester, 'requester' | 'homeServerIdentityId'>): AgentIsolationMemberIdentity {
  const { requester, homeServerIdentityId } = identity;
  if (!homeServerIdentityId || !requester.machineId || !requester.installationId || !requester.accountId) {
    throw new PluginError({ code: 'agent_isolation_unavailable', message: 'Requester execution identity is unavailable', retryable: false,
      details: { reason: 'requester_authority_unavailable', phase: 'native_execution_preparation' } });
  }
  // Persistent tuple encoding. Session requester.serverId remains a saved-profile
  // handle and must not replace the independently verified canonical Home.
  const digest = createHash('sha256').update(JSON.stringify([
    homeServerIdentityId, requester.machineId, requester.installationId, requester.accountId,
  ]), 'utf8').digest('hex');
  const username = `hpm-${digest.slice(0, 24)}`;
  return { requester, homeServerIdentityId, digest, username, primaryGroup: username,
    home: `/var/lib/happier/members/${digest}`, workspaceRoot: `/srv/happier/members/${digest}`,
    ownershipMarker: `happier-member-${digest}` };
}

export function buildAgentIsolationMemberAccountStep(identity: AgentIsolationMemberIdentity, uid?: number): Extract<MachineRecipeStepV1, { kind: 'user' }> & { home: string } {
  return { id: 'agent-account', kind: 'user', username: identity.username, home: identity.home,
    ...(uid !== undefined ? { uid } : {}),
    shell: '/usr/sbin/nologin', system: true, locked: true,
    ownershipMarker: identity.ownershipMarker, supplementaryGroups: [] };
}

export function buildAgentIsolationMemberWorkspaceStep(identity: AgentIsolationMemberIdentity, daemonPrimaryGroup: string): Extract<MachineRecipeStepV1, { kind: 'directory' }> {
  return { id: 'member-workspace', kind: 'directory', path: identity.workspaceRoot, owner: identity.username,
    group: daemonPrimaryGroup, mode: 0o2770, ownershipMarker: identity.ownershipMarker };
}

function buildMemberRunAsStep(input: Readonly<{ daemonUsername: string; binaryPath: string }>, member: AgentIsolationMemberIdentity): Extract<MachineRecipeStepV1, { kind: 'file' }> {
  assertLaunchPrincipal(input);
  const alias = `HAPPIER_MEMBER_${member.digest.toUpperCase()}`;
  const policy = [
    `# Happier managed member launch ${member.digest}`,
    `Cmnd_Alias ${alias} = ${input.binaryPath} agent-launch`,
    `Defaults!${alias} umask=0002,umask_override`,
    `${input.daemonUsername} ALL=(${member.username}) NOPASSWD:NOSETENV: ${alias}`,
    '',
  ].join('\n');
  return { id: 'agent-runas', kind: 'file', path: `/etc/sudoers.d/91-happier-${member.username}`,
    owner: 'root', group: 'root', mode: 0o440, content: { kind: 'literal', value: policy }, validate: 'sudoers' };
}

/** Shared bootstrap/enablement plan; execution belongs to the typed setup interpreter. */
export function buildAgentIsolationProvisioningSteps(input: Readonly<{
  daemonUsername: string; daemonPrimaryGroup: string | null; binaryPath: string; requesterIdentity?: AgentIsolationMemberRequester;
  retainedMemberUid?: number;
}>): MachineRecipeStepV1[] {
  if (!input.requesterIdentity && input.daemonPrimaryGroup) {
    return buildAgentIsolationBootstrapSteps({ ...input, daemonPrimaryGroup: input.daemonPrimaryGroup, toolsRoot: resolveManagedToolsRoot() });
  }
  // The install owner selects the managed payload; the shared owner validates
  // its representation as one literal sudoers command.
  assertLaunchPrincipal(input);
  if (!input.daemonPrimaryGroup) throw new PluginError({ code: 'agent_isolation_unavailable',
    message: 'The observed daemon group is unavailable', retryable: false,
    details: { reason: 'requester_authority_unavailable', phase: 'native_execution_preparation' } });
  MachineRecipeStepV1Schema.parse({ id: 'daemon-group', kind: 'group', name: input.daemonPrimaryGroup, members: [] });
  const member = deriveAgentIsolationMemberIdentity(input.requesterIdentity!);
  return [
    buildAgentIsolationMemberAccountStep(member, input.retainedMemberUid),
    { id: 'member-home-root', kind: 'directory', path: '/var/lib/happier', owner: 'root', group: 'root',
      mode: 0o711, preserveExistingOwnership: true },
    { id: 'member-homes', kind: 'directory', path: '/var/lib/happier/members', owner: 'root', group: 'root',
      mode: 0o711, preserveExistingOwnership: true },
    { id: 'member-home-traversal', kind: 'pathTraversal', path: '/var/lib/happier', agentUsername: member.username },
    { id: 'agent-home', kind: 'directory', path: member.home, owner: member.username, group: member.primaryGroup,
      mode: 0o700, ownershipMarker: member.ownershipMarker },
    { id: 'member-workspaces', kind: 'directory', path: '/srv/happier/members', owner: input.daemonUsername, group: input.daemonPrimaryGroup,
      mode: 0o711, preserveExistingOwnership: true },
    { id: 'member-workspace-traversal', kind: 'pathTraversal', path: '/srv/happier', agentUsername: member.username },
    buildAgentIsolationMemberWorkspaceStep(member, input.daemonPrimaryGroup),
    buildAgentIsolationToolsRootStep({ daemonUsername: input.daemonUsername, daemonPrimaryGroup: input.daemonPrimaryGroup, toolsRoot: resolveManagedToolsRoot() }),
    buildMemberRunAsStep(input, member),
  ];
}

/** Removing RunAs never creates/deletes a user or discards retained authored data. */
export function buildAgentIsolationMemberRetirementSteps(input: Readonly<{
  daemonUsername: string; binaryPath: string; requesterIdentity: AgentIsolationMemberRequester;
}>): MachineRecipeStepV1[] {
  const rule = buildMemberRunAsStep(input, deriveAgentIsolationMemberIdentity(input.requesterIdentity));
  if (rule.content?.kind !== 'literal') throw new PluginError({
    code: 'agent_isolation_unavailable', message: 'Requester execution setup is unavailable', retryable: false,
    details: { reason: 'requester_authority_unavailable', phase: 'native_execution_preparation' } });
  return [{ id: 'agent-runas-retire', kind: 'file', path: rule.path, owner: 'root', group: 'root', mode: 0o440,
    state: 'absent', expectedContentDigest: createHash('sha256').update(rule.content.value, 'utf8').digest('hex') }];
}
