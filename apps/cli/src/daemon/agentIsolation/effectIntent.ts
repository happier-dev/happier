import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import type { AgentIsolationEffectPlanV1, MachineAgentIsolationStatusV1 } from '@happier-dev/protocol';
import { isCanonicalAbsolutePathInsideRoot } from '@/utils/path/expandHomeDirPath';
import { buildUserManagerGroupRefreshStep } from '@/daemon/service/userManagerGroups';
import { buildAgentIsolationProvisioningSteps, type AgentIsolationMemberRequester } from './provisioning';
import { readAgentIsolationMemberBindings } from './memberBindings';
import { buildAgentIsolationBootstrapRetirementObservations, buildUnobservedAgentIsolationBootstrapRetirement } from './bootstrapRetirement';
import type { AgentIsolationEffectDependencies } from './agentIsolationProvisioner';

type UnavailableStatus = Extract<MachineAgentIsolationStatusV1, { kind: 'unavailable' }>;
function unavailable(requiredFact: NonNullable<UnavailableStatus['prerequisite']>['requiredFact'], remedy: string) {
  return { kind: 'unavailable' as const, status: { kind: 'unavailable', code: 'provisioning_unavailable',
    prerequisite: { reason: 'required_fact_unavailable', requiredFact, remedy } } satisfies UnavailableStatus };
}

/** Preparation decides its own missing facts before native CHECK can run. */
export async function resolveAgentIsolationEffectIntentResult(enabled: boolean, effects: AgentIsolationEffectDependencies,
  requesterIdentity?: AgentIsolationMemberRequester, retainedMemberUid?: number) {
  const sessionsToReplace = effects.readSessionsToReplace();
  if (!Number.isSafeInteger(sessionsToReplace) || sessionsToReplace < 0) return unavailable('session_inventory',
    'Restore the daemon Session inventory before reviewing isolation.');
  const bindingScope = !enabled ? effects.readMemberBindingScope?.() : null;
  const memberInventory = bindingScope ? await readAgentIsolationMemberBindings(bindingScope) : null;
  const memberBindings = memberInventory?.bindings ?? [];
  const retirementWarnings: NonNullable<AgentIsolationEffectPlanV1['retirement']> = !enabled && memberInventory?.coverage !== 'complete'
    ? [{ stepId: 'member-runas-inventory', kind: 'file', target: 'Managed member RunAs rules',
      observation: 'unknown', action: 'retain', reasonCode: 'native_check_unavailable',
      remedy: 'Restore the private member binding inventory and retry, or have an administrator inspect retained managed member RunAs rules.' }] : [];
  const daemon = await effects.elevation.observe().catch(() => null);
  if (!daemon || daemon.daemonIdentity !== 'nonRoot' || daemon.daemonUid === null || daemon.daemonUid <= 0 || !daemon.daemonUsername || !daemon.daemonPrimaryGroup) {
    if (!enabled) return { kind: 'ready' as const, intent: { roots: [], ancestorAcls: [], sessionsToReplace, steps: [],
      retirement: [...buildUnobservedAgentIsolationBootstrapRetirement(effects.installedCli, memberBindings), ...retirementWarnings] } };
    return unavailable('daemon_identity', 'Run the daemon as a named non-root OS user with a primary group, then review isolation.');
  }
  if (!enabled) {
    const retirementObservations = buildAgentIsolationBootstrapRetirementObservations({ daemonUsername: daemon.daemonUsername,
      daemonPrimaryGroup: daemon.daemonPrimaryGroup, binaryPath: effects.installedCli, memberBindings });
    return { kind: 'ready' as const, intent: { roots: [], ancestorAcls: [], sessionsToReplace, daemonObservation: daemon,
      steps: retirementObservations.filter(step => step.kind === 'file' && step.state === 'absent'), retirementObservations, retirementWarnings } };
  }
  if (requesterIdentity) return { kind: 'ready' as const, intent: { roots: [], ancestorAcls: [], sessionsToReplace: 0, daemonObservation: daemon,
    steps: buildAgentIsolationProvisioningSteps({ daemonUsername: daemon.daemonUsername, daemonPrimaryGroup: daemon.daemonPrimaryGroup, binaryPath: effects.installedCli, requesterIdentity, retainedMemberUid }) } };
  const admitted = effects.readRoots();
  // A newly created server may have no Workspace yet. Only an unavailable
  // census is unknown; a known empty census still needs account/RunAs setup.
  if (!admitted) return unavailable('workspace_census',
    'Restore the Machine project/workspace subscription on its Home, then review isolation.');
  const workspace = await readWorkspaceAccess(effects, admitted).catch(() => null);
  if (!workspace) return unavailable('workspace_paths',
    'Check that admitted Workspace directories exist, are accessible to the daemon, and are outside protected roots.');
  const { roots, ancestorAcls } = workspace;
  const steps = [
    ...buildAgentIsolationProvisioningSteps({ daemonUsername: daemon.daemonUsername, daemonPrimaryGroup: daemon.daemonPrimaryGroup, binaryPath: effects.installedCli }),
    ...ancestorAcls.map((acl, index) => ({ id: `ancestor-${index}`, kind: 'pathTraversal' as const, path: acl.path, agentUsername: 'happier-agent' })),
    ...roots.map(root => ({ id: `workspace-${root.rootId}`, kind: 'workspaceAccess' as const, path: root.path,
      group: 'happier-workspace', agentUsername: 'happier-agent' })),
    buildUserManagerGroupRefreshStep({ uid: daemon.daemonUid, username: daemon.daemonUsername }),
  ];
  return { kind: 'ready' as const, intent: { roots, ancestorAcls, sessionsToReplace, steps, daemonObservation: daemon } };
}

async function readWorkspaceAccess(effects: AgentIsolationEffectDependencies,
  admitted: NonNullable<ReturnType<AgentIsolationEffectDependencies['readRoots']>>) {
  const protectedRoots = await Promise.all((effects.protectedRoots ?? []).map(async path => {
    try { return await realpath(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return path; throw error; }
  }));
  const roots = await Promise.all(admitted.map(async root => {
    if (!isAbsolute(root.path) || !root.rootId) throw new Error('workspace_not_ready');
    const path = await realpath(root.path);
    if (path === dirname(path) || !(await lstat(path)).isDirectory()
      || protectedRoots.some(protectedRoot => isCanonicalAbsolutePathInsideRoot(protectedRoot, path)
        || isCanonicalAbsolutePathInsideRoot(path, protectedRoot))) throw new Error('workspace_not_ready');
    return { rootId: root.rootId, path };
  }));
  roots.sort((left, right) => left.rootId.localeCompare(right.rootId) || left.path.localeCompare(right.path));
  const ancestors = new Set<string>();
  for (const root of roots) for (let path = dirname(root.path); path !== dirname(path); path = dirname(path)) {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('workspace_not_ready');
    if (!(stat.mode & 0o001)) ancestors.add(path);
  }
  const ancestorAcls = [...ancestors].sort().map(path => ({ path, add: 'x' as const }));
  return { roots, ancestorAcls };
}
