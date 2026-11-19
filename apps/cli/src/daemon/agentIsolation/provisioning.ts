import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { assertAgentIsolationLaunchPrincipal as assertLaunchPrincipal, buildAgentIsolationBootstrapSteps, buildAgentIsolationToolsRootStep } from '@happier-dev/cli-common/systemTasks/nativeRemoteSshBootstrap';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { MachineRecipeStepV1Schema, type MachineRecipeStepV1 } from '@happier-dev/protocol/machines/setup/machineRecipeV1';
import type { MachineAdminAccessObservationV1 } from '@happier-dev/protocol';
import { MACHINE_MEMBER_HOMES_ROOT_V1, MACHINE_MEMBER_WORKSPACES_ROOT_V1 } from '@happier-dev/protocol/machines/agentIsolationV1';
import { resolveSeparateUserToolsLayout } from '@happier-dev/cli-common/firstPartyRuntime';
import { machineStateRootStep } from '@happier-dev/cli-common/machineSetup';
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
    home: `${MACHINE_MEMBER_HOMES_ROOT_V1}/${digest}`, workspaceRoot: `${MACHINE_MEMBER_WORKSPACES_ROOT_V1}/${digest}`,
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

function buildMemberRunAsStep(input: Readonly<{ daemonUsername: string; binaryPath: string; memberBinaryPath?: string }>,
  member: AgentIsolationMemberIdentity): Extract<MachineRecipeStepV1, { kind: 'file' }> {
  const binaryPath = input.memberBinaryPath ?? input.binaryPath;
  assertLaunchPrincipal({ ...input, binaryPath });
  const alias = `HAPPIER_MEMBER_${member.digest.toUpperCase()}`;
  const policy = [
    `# Happier managed member launch ${member.digest}`,
    `Cmnd_Alias ${alias} = ${binaryPath} agent-launch`,
    `Defaults!${alias} umask=0002,umask_override`,
    `${input.daemonUsername} ALL=(${member.username}) NOPASSWD:NOSETENV: ${alias}`,
    '',
  ].join('\n');
  const priority = input.memberBinaryPath ? 92 : 91;
  return { id: 'agent-runas', kind: 'file', path: `/etc/sudoers.d/${priority}-happier-${member.username}`,
    owner: 'root', group: 'root', mode: 0o440, content: { kind: 'literal', value: policy }, validate: 'sudoers' };
}

/** Shared bootstrap/enablement plan; execution belongs to the typed setup interpreter. */
export function buildAgentIsolationProvisioningSteps(input: Readonly<{
  daemonUsername: string; daemonPrimaryGroup: string | null; binaryPath: string; requesterIdentity?: AgentIsolationMemberRequester;
  memberBinaryPath?: string;
  retainedMemberUid?: number;
  /** Retire named-user ancestry grants left by the former private plugin code root. */
  legacyPluginCodeRoot?: string;
}>): MachineRecipeStepV1[] {
  const tools = resolveSeparateUserToolsLayout({ machineStateRoot: machineStateRootStep.path });
  const toolsParent: MachineRecipeStepV1[] = tools.persistence ? [{ id: 'tools-parent', kind: 'directory',
    path: dirname(tools.toolsRoot), owner: 'root', group: 'root', mode: 0o711, preserveExistingOwnership: true }] : [];
  const toolsLayout: MachineRecipeStepV1[] = tools.persistence && input.daemonPrimaryGroup ? [{ id: 'tools-layout', kind: 'file',
    path: tools.persistence.path, owner: input.daemonUsername, group: input.daemonPrimaryGroup, mode: 0o600,
    content: { kind: 'literal', value: tools.persistence.content } }] : [];
  const retirePluginTraversal = (agentUsername: string): MachineRecipeStepV1[] => {
    const steps: MachineRecipeStepV1[] = [];
    if (input.legacyPluginCodeRoot) for (let path = dirname(input.legacyPluginCodeRoot); path !== dirname(path); path = dirname(path)) {
      steps.push({ id: `plugin-code-ancestor-${steps.length}`, kind: 'pathTraversal', path, agentUsername, state: 'absent' });
    }
    return steps;
  };
  if (!input.requesterIdentity && input.daemonPrimaryGroup) {
    return [...(tools.persistence ? [machineStateRootStep, ...toolsParent] : []),
      ...buildAgentIsolationBootstrapSteps({ ...input, daemonPrimaryGroup: input.daemonPrimaryGroup, toolsRoot: tools.toolsRoot }),
      ...toolsLayout,
      ...retirePluginTraversal('happier-agent')];
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
    machineStateRootStep,
    ...toolsParent,
    { id: 'member-homes', kind: 'directory', path: MACHINE_MEMBER_HOMES_ROOT_V1, owner: 'root', group: 'root',
      mode: 0o711, preserveExistingOwnership: true },
    { id: 'member-home-traversal', kind: 'pathTraversal', path: '/var/lib/happier', agentUsername: member.username },
    { id: 'agent-home', kind: 'directory', path: member.home, owner: member.username, group: member.primaryGroup,
      mode: 0o700, ownershipMarker: member.ownershipMarker },
    { id: 'member-workspaces', kind: 'directory', path: MACHINE_MEMBER_WORKSPACES_ROOT_V1, owner: input.daemonUsername, group: input.daemonPrimaryGroup,
      mode: 0o711, preserveExistingOwnership: true },
    { id: 'member-workspace-traversal', kind: 'pathTraversal', path: '/srv/happier', agentUsername: member.username },
    buildAgentIsolationMemberWorkspaceStep(member, input.daemonPrimaryGroup),
    buildAgentIsolationToolsRootStep({ daemonUsername: input.daemonUsername, daemonPrimaryGroup: input.daemonPrimaryGroup, toolsRoot: tools.toolsRoot }),
    ...(input.memberBinaryPath ? [retireMemberRule('agent-runas-retire',
      buildMemberRunAsStep({ daemonUsername: input.daemonUsername, binaryPath: input.binaryPath }, member))] : []),
    buildMemberRunAsStep(input, member),
    ...toolsLayout,
    ...retirePluginTraversal(member.username),
  ];
}

/** Removing RunAs never creates/deletes a user or discards retained authored data. */
export function buildAgentIsolationMemberRetirementSteps(input: Readonly<{
  daemonUsername: string; binaryPath: string; memberBinaryPath?: string; requesterIdentity: AgentIsolationMemberRequester;
}>): MachineRecipeStepV1[] {
  const member = deriveAgentIsolationMemberIdentity(input.requesterIdentity);
  return [retireMemberRule('agent-runas-retire',
    buildMemberRunAsStep({ daemonUsername: input.daemonUsername, binaryPath: input.binaryPath }, member)),
  ...(input.memberBinaryPath ? [retireMemberRule('agent-runas-runtime-retire', buildMemberRunAsStep(input, member))] : [])];
}

function retireMemberRule(id: string, rule: ReturnType<typeof buildMemberRunAsStep>): MachineRecipeStepV1 {
  if (rule.content?.kind !== 'literal') throw new PluginError({
    code: 'agent_isolation_unavailable', message: 'Requester execution setup is unavailable', retryable: false,
    details: { reason: 'requester_authority_unavailable', phase: 'native_execution_preparation' } });
  return { id, kind: 'file', path: rule.path, owner: rule.owner, group: rule.group, mode: rule.mode,
    state: 'absent', expectedContentDigest: createHash('sha256').update(rule.content.value, 'utf8').digest('hex') };
}
