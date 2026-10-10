import { loadDevTargetsConfig, resolveDevTargetExecutionPolicy } from '../dev_targets/config.mjs';
import { loadExecutionHostGuestDevTargetsConfig } from './workspace_mount.mjs';
import { dirname, posix } from 'node:path';
import { ensurePrimaryStandbySync, inspectPrimaryStandbySync } from '../dev_targets/sync_project.mjs';
import { configureExecutionHostPrimary, readExecutionHostProfile } from './config.mjs';
import { resolveDevTargetSshConfigFile } from '../dev_targets/mutagen_runtime.mjs';

export async function resolveSshPrimaryTarget({ profile, env = process.env }) {
  const selection = profile.sshPrimary;
  const loaded = await loadDevTargetsConfig({ stackName: selection.stackName, env, allowMissing: false });
  const target = loaded.config.targets.find(entry => entry.name === selection.targetName);
  if (!target) throw new Error(`[execution-host] SSH primary target not enrolled: ${selection.targetName}`);
  if (target.platform !== 'posix') throw new Error('[execution-host] SSH primary requires an enrolled POSIX target');
  // The target names an existing authoritative checkout, not a worker mirror
  // to synchronize. Other named checkouts retain their declared identical paths.
  if (!profile.workspaces.some(workspace => workspace.guestDir === target.repoDir)) {
    throw new Error('[execution-host] SSH primary requires enrolled repository path parity with a named workspace');
  }
  const sshConfigFile = resolveDevTargetSshConfigFile(target, { stackBaseDir: dirname(loaded.path), env });
  return { target, sshConfigFile, loaded };
}

export async function assignExecutionHostPrimary({ targetName, stackName, env = process.env }) {
  const current = readExecutionHostProfile(env);
  if (current?.version !== 2 || current.activation !== 'active') {
    throw new Error('[execution-host] primary assignment requires a named active profile');
  }
  const name = String(targetName ?? '').trim().toLowerCase();
  if (!name || name.startsWith('-')) throw new Error('[execution-host] primary assign requires TARGET or lima');
  const selection = name === 'lima' ? null : { targetName: name, stackName };
  if (selection) await resolveSshPrimaryTarget({ profile: { ...current, sshPrimary: selection }, env });
  const profile = await configureExecutionHostPrimary(selection, env);
  return { primary: { mode: profile.mode, ...(selection ? { targetName: name } : { instance: profile.instance }) },
    workloadMoved: false };
}

async function resolvePrimaryWorkloadPeers({ sourceName, targetName, homeDir, stackName, env = process.env }) {
  const loaded = await loadDevTargetsConfig({ stackName, env, allowMissing: false });
  const source = loaded.config.targets.find(target => target.name === sourceName);
  const target = loaded.config.targets.find(target => target.name === targetName);
  if (!source || !target || source.name === target.name || source.platform !== 'posix' || target.platform !== 'posix') {
    throw new Error('[dev-vm] primary sync requires two distinct enrolled POSIX targets');
  }
  const home = String(homeDir ?? '').trim();
  if (!home.startsWith('/') || home === '/' || posix.normalize(home) !== home || /[\0\r\n]/.test(home)) {
    throw new Error('[dev-vm] primary sync requires --home with the identical authenticated absolute home');
  }
  if (source.repoDir !== target.repoDir || source.cliHomeDir !== target.cliHomeDir
    || !source.repoDir.startsWith(`${home}/`) || !source.cliHomeDir.startsWith(`${home}/`)) {
    throw new Error('[dev-vm] STANDBY_PATH_PARITY: workspace and CLI home paths must match inside the declared home');
  }
  return { loaded, source, target, home };
}

export async function syncPrimaryWorkload(input, dependencies = {}) {
  const { loaded, source, target, home } = await resolvePrimaryWorkloadPeers(input);
  const { env = process.env } = input;
  // Explicit operator-selected endpoints are a replication declaration, not a
  // primary assignment. Never infer execution authority from worker placement.
  return await ensurePrimaryStandbySync({ stackBaseDir: dirname(loaded.path), sourceDir: source.repoDir, env,
    profile: { ...source, homeDir: home, standby: { ...target, homeDir: home } } }, dependencies);
}

function primaryExecutionBlockers() {
  return [
    { code: 'PRIMARY_API_MOVE_UNAVAILABLE', description: 'Both host daemons must reach the restored owning Stack API before session handoff. The existing controller/worker forwarding owners are not yet composed into a primary cutover.' },
    { code: 'PRIMARY_SWITCH_NOT_READY', description: 'Source quiescence, both Stack server/database moves, execution-host assignment, worker reversal and Tailscale role movement are not an executable composed lifecycle.' },
    { code: 'NATIVE_RESTORE_PROOF_UNAVAILABLE', description: 'Real authenticated Claude and Codex sessions, unchanged target transcripts/native index, restored databases, server boot, follow-up turns and reverse handoff have not been proven. Fixture files cannot certify restore.' },
  ];
}

export async function verifyPrimaryWorkload({ restoreTest = false, workStackName, workRepoDir,
  workStackStorageDir, env = process.env, ...input }, dependencies = {}) {
  if (restoreTest) {
    throw new Error('[dev-vm] RESTORE_TEST_UNAVAILABLE: primary verify only inspects prerequisites; native session/database restore certification is not implemented');
  }
  const { loaded, source, target, home } = await resolvePrimaryWorkloadPeers({ ...input, env });
  const { createPrimarySessionControlAdapter } = await import('./primary_session_control.mjs');
  const adapter = createPrimarySessionControlAdapter({ source, target, homeDir: home, workStackName, workRepoDir,
    workStackStorageDir, stackBaseDir: dirname(loaded.path), env }, { capture: dependencies.capture });
  // This public consumer is deliberately read-only. A valid inventory/capability
  // observation neither pauses sessions nor admits the later cutover lifecycle.
  const sessions = await adapter.preflight();
  const standby = await inspectPrimaryStandbySync({ stackBaseDir: dirname(loaded.path), sourceDir: source.repoDir,
    target: source, env }, dependencies);
  return {
    state: 'prerequisites-inspected', executable: false, restoreVerified: false,
    source: { name: source.name }, target: { name: target.name }, stackName: input.stackName,
    pathParity: { state: 'declared-only' },
    standby: { ...standby, endpointMatch: 'unverified' },
    database: { state: 'unverified', lastReplicaAt: null },
    sessionControl: { state: 'public-cli-contract-inspected', daemonIdentity: 'observed',
      existingStateCapability: 'unverified', stackName: workStackName, adapter: '0.2-public-cli',
      sourceMachineId: sessions.sourceMachineId, targetMachineId: sessions.targetMachineId,
      sessionCount: sessions.sessions.length, permissionMode: 'explicit-authoritative-mode' },
    blockers: [
      ...(standby.state !== 'ready' ? [{ code: 'STANDBY_UNVERIFIED', description: 'Both standby sessions must be ready before a final cutover flush.' }] : []),
      { code: 'STANDBY_ENDPOINTS_UNVERIFIED', description: 'Named Mutagen session readiness does not certify that the selected peers are their current source and target endpoints.' },
      { code: 'WORK_SESSION_HANDOFF_UNVERIFIED', description: 'Public CLI contracts and daemon identities were inspected read-only; actual two-peer existing-state capability negotiation belongs to canonical handoff and was not invoked.' },
      { code: 'DATABASE_REPLICA_UNVERIFIED', description: 'Neither owning development database has a proven target restore and running-server check.' },
      ...primaryExecutionBlockers(),
    ],
  };
}

// This is an inspection of the existing authorities, not another primary
// assignment. A worker/server placement does not establish workload ownership.
export async function inspectPrimaryWorkload({ profile, stackName, sourceName = '', env = process.env }, dependencies = {}) {
  const active = profile?.activation === 'active';
  const sshPrimary = active && profile.mode === 'ssh-dev-target';
  const primary = active
    ? { authority: 'execution-host-profile', mode: profile.mode,
      ...(sshPrimary ? { targetName: profile.sshPrimary.targetName } : { instance: profile.instance }) }
    : { authority: 'unresolved', mode: null, instance: null };
  let loaded;
  let configurationState = 'available';
  if (active) {
    try {
      loaded = sshPrimary ? (await resolveSshPrimaryTarget({ profile, env })).loaded
        : await loadExecutionHostGuestDevTargetsConfig({ profile, stackName, env });
    } catch {
      // A stale controller copy cannot replace the active host's config.
      // Transport diagnostics can contain private paths; project only state.
      configurationState = 'unavailable';
    }
  } else {
    loaded = await loadDevTargetsConfig({ stackName, env, allowMissing: true });
  }
  const policy = loaded ? resolveDevTargetExecutionPolicy(loaded.config) : null;
  let standby = { state: 'unverified', syncLag: null };
  if (sourceName && loaded) {
    const source = loaded.config.targets.find(target => target.name === sourceName);
    if (!source) throw new Error('[dev-vm] standby status requires an enrolled --source target');
    standby = await inspectPrimaryStandbySync({ stackBaseDir: dirname(loaded.path), sourceDir: source.repoDir, target: source, env }, dependencies);
  }
  return {
    stackName,
    primary,
    configuration: { authority: active && !sshPrimary ? 'guest-config' : 'controller-config', state: configurationState },
    serverPlacement: policy?.server ?? null,
    targets: loaded?.config.targets.map(target => ({ name: target.name, platform: target.platform, repoDir: target.repoDir })) ?? [],
    standby,
    database: { state: 'unverified', lastReplicaAt: null },
    executable: false,
  };
}

export function describePrimarySwitch(status, targetName, { force = false, pauseAgents = false, pauseTimeoutSeconds = '' } = {}) {
  const name = String(targetName ?? '').trim().toLowerCase();
  if (!name) throw new Error('[dev-vm] primary switch requires an enrolled target name');
  if (status.configuration.state !== 'available') {
    throw new Error('[dev-vm] authoritative primary target configuration is unavailable');
  }
  const target = status.targets.find(entry => entry.name === name);
  if (!target) throw new Error(`[dev-vm] primary target not found: ${name}`);
  if (target.platform !== 'posix') {
    throw new Error('[dev-vm] primary workload transfer requires a POSIX target with matching user and home');
  }
  // The current 0.2 public idle-wait owner supplies this budget (default 300,
  // max 3600), not a shorter competing cutover phase deadline.
  const timeout = pauseTimeoutSeconds === '' ? 300 : Number(pauseTimeoutSeconds);
  if (pauseTimeoutSeconds !== '' && !pauseAgents) throw new Error('[dev-vm] --pause-timeout requires --pause-agents');
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 3600) {
    throw new Error('[dev-vm] --pause-timeout must use the 0.2 session wait contract: integer seconds 1..3600');
  }
  return {
    ...status,
    dryRun: true,
    target,
    sessionControl: { stackName: 'repo-remote-dev-d72117acdb', adapter: '0.2-public-cli', pauseAgents,
      timeoutSeconds: pauseAgents ? timeout : null, permissionMode: 'require-explicit-authoritative-mode',
      handoff: 'canonical-existing-state-reachability-required' },
    steps: [
      { id: 'preflight', description: 'Verify fresh key-only SSH access, identical user/home and workspace paths, required tools, and disk capacity for the workload and database.' },
      { id: 'quiesce', description: `${pauseAgents ? `Through 0.2 public surfaces, paginate sessions on the source Machine, checkpoint parents and execution runs with their current permissions, observe idle for up to ${timeout} seconds and report timeout before stopping the remainder. ` : ''}Refuse in-flight turns unless forced. Stop only the enumerated 0.2 work-stack and 0.3 dev/QA server/database writers; keep each host daemon and its distinct Machine identity.`, refuseMidTurnUnlessForce: !force },
      { id: 'final-sync', description: 'Online-backup live Agent SQLite files; flush the existing one-way standby Mutagen sessions to zero pending changes, including dirty/untracked repositories and Git metadata.', requireZeroPending: true },
      { id: 'database-replica', description: 'Take the database owner’s consistent final replica from its actual server placement; restore and verify on the target while writers remain stopped.' },
      { id: 'start-primary', description: 'With source database writers stopped, start both restored target Stack servers and establish their canonical public API reachability for both distinct daemons. Then verify target provider-session reachability and move sessions through their owning Stack canonical handoff (no redundant workspace/provider transfer); transfer the execution-host assignment before resumed target checkout writes.', requireSingleWriter: true },
      { id: 'reverse-sync', description: 'Reverse primary-to-standby replication through the existing Mutagen project owner; keep the previous primary read-only.' },
      { id: 'worker-sync', description: 'Recreate worker mirror sessions from the new primary through the same Mutagen daemon; use the VM standby path as its worker mirror.' },
      { id: 'move-role', description: 'Move the happier-dev Tailscale role from the quiesced source to the new primary.' },
      { id: 'post-verify', description: 'Verify one checkout/database writer, both Stack servers, distinct host Machine identities, moved session binding and follow-up turn on the target, source daemon accepting new work, replica freshness and dirty work; send resume messages with preserved permissions and relaunch instructions for ephemeral execution runs.', verifyMachineIdentity: true, verifySessionHandoff: true },
    ],
    blockers: [
      ...(status.primary.authority === 'unresolved' ? [{ code: 'PRIMARY_AUTHORITY_UNRESOLVED', description: 'The current controller has no active execution-host profile; do not infer a primary from service placement.' }] : []),
      ...(status.standby.state !== 'ready' ? [{ code: 'STANDBY_UNVERIFIED', description: 'Whole-home standby synchronization and its freshness have not been established.' }] : []),
      { code: 'WORK_SESSION_CONTRACT_UNVERIFIED', description: 'The authorized 0.2 existing-state handoff and Machine/permission projections must be observed from both loaded peers. Use primary verify with an explicit work Stack/repository; source edits alone are not runtime admission.' },
      { code: 'DATABASE_REPLICA_UNVERIFIED', description: 'A retained database replica and its restore contract have not been established.' },
      ...primaryExecutionBlockers(),
    ],
  };
}

export function formatPrimaryWorkload(status) {
  if (status.state === 'prerequisites-inspected') {
    return [
      `[dev-vm] primary prerequisites inspected: ${status.source.name} → ${status.target.name}`,
      `[dev-vm] public CLI contract: inspected; daemon identities observed; source Machine sessions: ${status.sessionControl.sessionCount}; two-peer existing-state support UNVERIFIED`,
      `[dev-vm] named standby session readiness: ${status.standby.state.toUpperCase()}; endpoint match and fresh path parity UNVERIFIED`,
      '[dev-vm] switch execution: unavailable; native session/database restore: NOT VERIFIED',
      ...status.blockers.map(blocker => `[blocked] ${blocker.code}: ${blocker.description}`),
    ].join('\n');
  }
  return [
    `[dev-vm] primary: ${status.primary.authority === 'unresolved' ? 'UNRESOLVED (no active controller profile)' : `${status.primary.mode}:${status.primary.targetName ?? status.primary.instance}`}`,
    `[dev-vm] configuration: ${status.configuration.authority} (${status.configuration.state})`,
    `[dev-vm] server placement: ${status.serverPlacement ? (status.serverPlacement.target ?? status.serverPlacement.mode) : 'unknown'}`,
    `[dev-vm] standby freshness: ${status.standby.state.toUpperCase()}; sync lag unknown${status.standby.agentSqliteCapturedAt ? `; Agent SQLite captured ${status.standby.agentSqliteCapturedAt}` : ''}`,
    '[dev-vm] database replica: UNVERIFIED; last replica time unknown',
    ...(status.dryRun ? [
      `[dev-vm] DRY RUN → ${status.target.name}; no switch will execute`,
      ...status.steps.map((step, index) => `${index + 1}. ${step.description}`),
      ...status.blockers.map(blocker => `[blocked] ${blocker.code}: ${blocker.description}`),
    ] : []),
  ].join('\n');
}
