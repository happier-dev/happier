import { isAbsolute } from 'node:path';
import type { MachineRecipeStepV1 } from '@happier-dev/protocol/machines/setup/machineRecipeV1';
import { execFileWithDeadline } from '@happier-dev/cli-common/process';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { lstat, realpath } from 'node:fs/promises';
import { createMachineSetupNativeBackend, type MachineSetupBackend } from '@happier-dev/cli-common/machineSetup';
import { buildAgentIsolationMemberAccountStep, buildAgentIsolationMemberWorkspaceStep, deriveAgentIsolationMemberIdentity,
  type AgentIsolationDaemonObservation, type AgentIsolationMemberIdentity, type AgentIsolationMemberRequester } from './provisioning';

export type AgentIsolationMemberNativeIdentity = AgentIsolationMemberIdentity & Readonly<{ agentUid: number; agentGid: number }>;
export type AgentIsolationMemberNativeIdentityInput = Readonly<{
  requesterIdentity: AgentIsolationMemberRequester;
  expectedUid?: number;
  signal?: AbortSignal;
}>;

const memberUnavailable = (cause?: unknown) => new PluginError({ code: 'agent_isolation_unavailable',
  message: 'The private requester identity is unavailable', retryable: false,
  details: { reason: 'agent_user_missing', phase: 'native_execution_preparation' } }, { cause });

/** A single exact P10 identity observation. No setup, mutation, scan or implicit adoption. */
export async function observeAgentIsolationMemberNativeIdentity(identity: AgentIsolationMemberIdentity,
  input: Readonly<{ expectedUid?: number; signal?: AbortSignal }>,
  backend: Pick<MachineSetupBackend, 'observe'> = createMachineSetupNativeBackend({ signal: input.signal }),
): Promise<AgentIsolationMemberNativeIdentity> {
  if (process.platform !== 'linux') throw memberUnavailable();
  try {
    const native = await observeNativeLaunchAccount(buildAgentIsolationMemberAccountStep(identity), input, backend);
    if (native.agentUid === process.getuid?.()) throw memberUnavailable();
    return { ...identity, ...native };
  } catch (cause) {
    if (input.signal?.aborted) throw cause;
    throw memberUnavailable(cause);
  }
}

async function observeNativeLaunchAccount(account: Extract<MachineRecipeStepV1, { kind: 'user' }> & { home: string },
  input: Readonly<{ expectedUid?: number; expectedGid?: number; signal?: AbortSignal }>,
  backend: Pick<MachineSetupBackend, 'observe'>,
): Promise<Readonly<{ agentUid: number; agentGid: number; home: string }>> {
  input.signal?.throwIfAborted();
  // Root setup validates the password lock. Warm daemon/shim lookup reads public
  // root-owned provenance/groups without requiring passwd --status as root.
  const { locked: _locked, ...publicAccount } = account;
  const observation = await backend.observe(publicAccount);
  const uid = observation.facts.uid, gid = observation.facts.gid;
  if (observation.status !== 'satisfied' || typeof uid !== 'number' || typeof gid !== 'number'
    || !Number.isSafeInteger(uid) || !Number.isSafeInteger(gid) || uid <= 0 || gid <= 0
    || input.expectedUid !== undefined && uid !== input.expectedUid || input.expectedGid !== undefined && gid !== input.expectedGid) throw memberUnavailable();
  const home = await lstat(account.home);
  if (!home.isDirectory() || home.isSymbolicLink() || home.uid !== uid || home.gid !== gid
    || (home.mode & 0o7777) !== 0o700 || await realpath(account.home) !== account.home) throw memberUnavailable();
  input.signal?.throwIfAborted();
  return { agentUid: uid, agentGid: gid, home: account.home };
}

/** The parent observes OS provenance once. The shim compares its actual user
 * with that qualified projection; it does not select an Account or re-observe it. */
export async function observeCurrentAgentIsolationLaunchIdentity(current: Readonly<{
  username: string; uid: number; gid: number; homedir: string;
}>, expected?: Readonly<{ username: string; agentUid: number; agentGid: number; home: string }>, signal?: AbortSignal,
): Promise<Readonly<{ agentUid: number; agentGid: number; home: string }>> {
  try {
    signal?.throwIfAborted();
    if (process.platform !== 'linux' || !Number.isSafeInteger(current.uid) || current.uid <= 0
      || !Number.isSafeInteger(current.gid) || current.gid <= 0 || process.getuid?.() !== current.uid) throw memberUnavailable();
    if (current.username === 'happier-agent' && !expected) {
      if (!isAbsolute(current.homedir) || current.homedir.includes('\0')) throw memberUnavailable();
      return { agentUid: current.uid, agentGid: current.gid, home: current.homedir };
    }
    const digest = /^\/var\/lib\/happier\/members\/([a-f0-9]{64})$/u.exec(current.homedir)?.[1];
    if (!expected || !digest || current.username !== `hpm-${digest.slice(0, 24)}`
      || current.username !== expected.username || current.uid !== expected.agentUid
      || current.gid !== expected.agentGid || current.homedir !== expected.home) throw memberUnavailable();
    return { agentUid: current.uid, agentGid: current.gid, home: current.homedir };
  } catch (cause) {
    if (signal?.aborted) throw cause;
    throw memberUnavailable(cause);
  }
}

/** Explicit Workspace demand verifies its root through the same native directory owner. */
export async function readAgentIsolationMemberWorkspaceRoot(identity: AgentIsolationMemberNativeIdentity,
  backend: Pick<MachineSetupBackend, 'observe'> = createMachineSetupNativeBackend(),
  options: Readonly<{ signal?: AbortSignal; daemonObservation?: AgentIsolationDaemonObservation | null }> = {},
): Promise<Readonly<{ identity: AgentIsolationMemberNativeIdentity; workspaceRoot: string; daemonGid: number }>> {
  try {
    options.signal?.throwIfAborted();
    const daemon = options.daemonObservation;
    if (!daemon || daemon.daemonIdentity !== 'nonRoot' || daemon.daemonUid === null || daemon.daemonUid <= 0
      || !daemon.daemonUsername || !daemon.daemonPrimaryGroup) throw memberUnavailable();
    // Setup verifies its private ownership marker while elevated. Runtime reads
    // only exact OS ownership/mode; the marker itself is member-private 0600.
    const { ownershipMarker: _marker, ...step } = buildAgentIsolationMemberWorkspaceStep(identity, daemon.daemonPrimaryGroup);
    const observed = await backend.observe(step);
    options.signal?.throwIfAborted();
    const gid = observed.facts.gid;
    if (observed.status !== 'satisfied' || observed.facts.uid !== identity.agentUid
      || typeof gid !== 'number' || !Number.isSafeInteger(gid) || gid <= 0 || gid === identity.agentGid) throw memberUnavailable();
    return { identity, workspaceRoot: identity.workspaceRoot, daemonGid: gid };
  } catch (cause) { if (options.signal?.aborted) throw cause; throw memberUnavailable(cause); }
}

/** Resolved at materialization/socket/native-launch preparation, never per MCP request. */
export function readAgentIsolationNativeIdentity(input: AgentIsolationMemberNativeIdentityInput,
  backend?: Pick<MachineSetupBackend, 'observe'>): Promise<AgentIsolationMemberNativeIdentity>;
export function readAgentIsolationNativeIdentity(signal?: AbortSignal,
  execute?: typeof execFileWithDeadline, daemonPrimaryGroup?: string): Promise<Readonly<{ agentUid: number; agentGid: number; home: string; groups?: Readonly<{ agentGroupIds: readonly number[]; daemonGroupId: number }> }>>;
export async function readAgentIsolationNativeIdentity(input?: AbortSignal | AgentIsolationMemberNativeIdentityInput,
  boundary?: typeof execFileWithDeadline | Pick<MachineSetupBackend, 'observe'>, daemonPrimaryGroup?: string): Promise<Readonly<{ agentUid: number; agentGid: number; home: string; groups?: Readonly<{ agentGroupIds: readonly number[]; daemonGroupId: number }> }>> {
  if (input && 'requesterIdentity' in input) return observeAgentIsolationMemberNativeIdentity(
    deriveAgentIsolationMemberIdentity(input.requesterIdentity), input, typeof boundary === 'object' ? boundary : undefined);
  const signal = input;
  const execute = typeof boundary === 'function' ? boundary : execFileWithDeadline;
  if (process.platform !== 'linux') throw new PluginError({ code: 'agent_isolation_unavailable', message: 'Agent isolation requires Linux', retryable: false });
  let reason = 'agent_user_missing';
  try {
    const result = await execute('getent', ['--service=files', 'passwd', 'happier-agent'], { encoding: 'utf8', ...(signal ? { signal } : {}) });
    const row = String(result.stdout).trim().split(':');
    const agentUid = Number(row[2]), home = row[5] ?? '';
    if (row.length !== 7 || row[0] !== 'happier-agent' || !Number.isSafeInteger(agentUid) || agentUid <= 0
      || agentUid === process.getuid?.() || !isAbsolute(home) || home.includes('\0')) throw new Error('agent_user_missing');
    if (daemonPrimaryGroup === undefined) return { agentUid, agentGid: Number(row[3]), home };
    // Only native API containment needs group membership. Existing Session
    // preparation keeps its single UID/home read and its original failure boundary.
    reason = 'agent_group_facts_unavailable';
    if (!daemonPrimaryGroup || /[\0\r\n:]/.test(daemonPrimaryGroup)) throw new Error(reason);
    const [membership, daemonGroup] = await Promise.all([
      execute('id', ['-G', 'happier-agent'], { encoding: 'utf8', ...(signal ? { signal } : {}) }),
      execute('getent', ['--', 'group', daemonPrimaryGroup], { encoding: 'utf8', ...(signal ? { signal } : {}) }),
    ]);
    const ids = String(membership.stdout).trim().split(/\s+/);
    const groupLine = String(daemonGroup.stdout).trim();
    const groupRow = groupLine.split(':');
    if (ids.some(id => !/^\d+$/.test(id) || !Number.isSafeInteger(Number(id)))
      || !/^\d+$/.test(row[3] ?? '') || !Number.isSafeInteger(Number(row[3]))
      || /[\r\n]/.test(groupLine) || groupRow.length !== 4 || groupRow[0] !== daemonPrimaryGroup
      || !/^\d+$/.test(groupRow[2] ?? '') || !Number.isSafeInteger(Number(groupRow[2]))) throw new Error(reason);
    const agentGroupIds = [...new Set(ids.map(Number))].sort((left, right) => left - right);
    if (!agentGroupIds.includes(Number(row[3]))) throw new Error(reason);
    return { agentUid, agentGid: Number(row[3]), home, groups: { agentGroupIds, daemonGroupId: Number(groupRow[2]) } };
  } catch (cause) {
    throw new PluginError({ code: 'agent_isolation_unavailable', message: 'The separate Agent identity is unavailable', retryable: false,
      details: { reason } }, { cause });
  }
}
