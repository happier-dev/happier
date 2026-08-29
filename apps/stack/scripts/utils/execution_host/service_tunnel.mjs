import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { readProcessInstanceFingerprintSync } from '@happier-dev/cli-common/processInstance';

import { buildSshForwardArgs } from '../dev_targets/remote_commands.mjs';
import { listListenPidsWithStatus, probeTcpPortBinding } from '../net/ports.mjs';
import { getHappyStacksHomeDir } from '../paths/paths.mjs';
import { withJsonOwnerFileLock } from '../proc/jsonOwnerFileLock.mjs';
import { observePsEnvLine, textContainsNeedle } from '../proc/ownership.mjs';
import { terminateProcessPid } from '../proc/terminate.mjs';
import { resolveExecutionHostWorkspaceMount } from './workspace_mount.mjs';

const TUNNEL_STATE_VERSION = 1;
const TUNNEL_PROCESS_KIND = 'execution-host-service-tunnel';
const TUNNEL_HOME_DIR = 'execution-host-tunnels';
const TUNNEL_TRANSITION_REPLACING = 'replacing';
const TUNNEL_TRANSITION_STOPPING = 'stopping';
const PROCESS_OBSERVATION_TIMEOUT_MS = 1_000;
const MAX_READY_ATTEMPTS = 20;
const READY_DELAY_MS = 100;
const MAX_STACK_RUNTIME_READY_ATTEMPTS = 1200;
const STACK_RUNTIME_READY_DELAY_MS = 250;
const SERVICE_TUNNEL_SUPERVISION_DELAY_MS = PROCESS_OBSERVATION_TIMEOUT_MS;
const TUNNEL_STATE_LOCK_TIMEOUT_MS = 30_000;
const TUNNEL_STATE_LOCK_STALE_AFTER_MS = 60_000;
const SAFE_STACK_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_STATE_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

// This runs inside the managed guest. It intentionally projects only the stack
// identity and public service declarations; it never copies an env file (which
// can contain credentials) back to the Mac controller.
const GUEST_STACK_PROJECTION_SCRIPT = [
  'set -eu',
  'workspace=$1',
  'requested_stack=$2',
  'match_env=',
  'for env_path in "$HOME"/.happier/stacks/*/env; do',
  '  [ -r "$env_path" ] || continue',
  '  repo_dir=$(sed -n "s/^HAPPIER_STACK_REPO_DIR=//p" "$env_path" | tail -n 1)',
  '  [ "$repo_dir" = "$workspace" ] || continue',
  '  stack_name=$(basename "$(dirname "$env_path")")',
  '  [ -z "$requested_stack" ] || [ "$stack_name" = "$requested_stack" ] || continue',
  '  [ -z "$match_env" ] || exit 4',
  '  match_env=$env_path',
  'done',
  '[ -n "$match_env" ] || exit 3',
  'stack_name=$(basename "$(dirname "$match_env")")',
  'server_port=$(sed -n "s/^HAPPIER_STACK_SERVER_PORT=//p" "$match_env" | tail -n 1)',
  'expo_port=$(sed -n "s/^HAPPIER_STACK_EXPO_DEV_PORT=//p" "$match_env" | tail -n 1)',
  'runtime_path="${match_env%/env}/stack.runtime.json"',
  'printf "stackName=%s\\nserverPort=%s\\nexpoPort=%s\\n" "$stack_name" "$server_port" "$expo_port"',
  'if [ -r "$runtime_path" ]; then cat "$runtime_path"; else printf "{}\\n"; fi',
].join('\n');

function tunnelError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function requireSafeComponent(value, label) {
  const normalized = String(value ?? '').trim();
  if (!SAFE_STATE_COMPONENT.test(normalized)) {
    throw new Error(`[dev-vm] invalid ${label}`);
  }
  return normalized;
}

function requireWorkspace(profile, rawWorkspaceId) {
  if (profile?.version !== 2) {
    if (String(rawWorkspaceId ?? '').trim()) {
      throw new Error('[dev-vm] --workspace-id requires a named execution-host profile');
    }
    if (!String(profile?.guestWorkspaceDir ?? '').startsWith('/')) {
      throw new Error('[dev-vm] managed guest workspace directory is required');
    }
    return { id: '', guestDir: profile.guestWorkspaceDir };
  }
  const workspaceId = String(rawWorkspaceId ?? '').trim();
  const workspace = (profile.workspaces ?? []).find((candidate) => candidate?.id === workspaceId);
  if (!workspace || !String(workspace.guestDir ?? '').startsWith('/')) {
    throw new Error(`[dev-vm] unknown execution-host workspace: ${workspaceId || '(missing)'}`);
  }
  return workspace;
}

function normalizeStackName(value) {
  const stackName = String(value ?? '').trim();
  if (stackName && !SAFE_STACK_NAME.test(stackName)) {
    throw new Error('[dev-vm] invalid Stack name');
  }
  return stackName;
}

function servicePort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : null;
}

function normalizeRuntimeStartedAt(value) {
  const timestampMs = Date.parse(String(value ?? '').trim());
  return Number.isFinite(timestampMs) ? new Date(timestampMs).toISOString() : '';
}

function parseProjectedStackRuntime(output) {
  const lines = String(output ?? '').replace(/\r/g, '').split('\n');
  const headers = lines.slice(0, 3);
  const values = Object.fromEntries(headers.map((line) => {
    const index = line.indexOf('=');
    return index >= 0 ? [line.slice(0, index), line.slice(index + 1)] : ['', ''];
  }));
  const stackName = normalizeStackName(values.stackName);
  if (!stackName) throw new Error('[dev-vm] managed guest did not declare a Stack name');
  const runtimeText = lines.slice(3).join('\n').trim() || '{}';
  let runtime;
  try {
    runtime = JSON.parse(runtimeText);
  } catch {
    throw new Error('[dev-vm] managed guest Stack runtime declaration is invalid JSON');
  }
  if (!runtime || Array.isArray(runtime) || typeof runtime !== 'object') {
    throw new Error('[dev-vm] managed guest Stack runtime declaration must be an object');
  }
  const runtimeStackName = String(runtime.stackName ?? '').trim();
  if (runtimeStackName && runtimeStackName !== stackName) {
    throw new Error('[dev-vm] managed guest Stack runtime identity does not match its declaration');
  }
  return {
    stackName,
    environment: {
      serverPort: servicePort(values.serverPort),
      expoPort: servicePort(values.expoPort),
    },
    runtime,
  };
}

function buildForwards(projection) {
  const runtimePorts = projection.runtime.ports && typeof projection.runtime.ports === 'object'
    ? projection.runtime.ports
    : {};
  const serverPort = servicePort(runtimePorts.server) ?? projection.environment.serverPort;
  const serverProxy = projection.runtime.serverProxy && typeof projection.runtime.serverProxy === 'object'
    ? projection.runtime.serverProxy
    : {};
  const serverBackend = serverProxy.enabled === true
    ? servicePort(runtimePorts.serverBackend) ?? serverPort
    : serverPort;
  const forwards = [];
  if (serverPort && serverBackend) {
    forwards.push({
      service: 'server',
      listenHost: '0.0.0.0',
      listenPort: serverPort,
      targetHost: '127.0.0.1',
      targetPort: serverBackend,
    });
  }

  const expo = projection.runtime.expo && typeof projection.runtime.expo === 'object'
    ? projection.runtime.expo
    : {};
  const expoPort = servicePort(expo.port) ?? projection.environment.expoPort;
  const webPort = servicePort(expo.webPort) ?? expoPort;
  const mobilePort = servicePort(expo.mobilePort) ?? expoPort;
  const remoteExpoTargetName = String(projection.runtime.placement?.expo ?? '').trim();
  const remoteExpoTarget = remoteExpoTargetName
    ? projection.runtime.remoteTargets?.[remoteExpoTargetName]
    : null;
  const remoteExpoReady = remoteExpoTarget?.services?.expo === true
    && remoteExpoTarget?.serviceStatus?.expo === 'running'
    && remoteExpoTarget?.status === 'running';
  if (remoteExpoReady && expoPort) {
    forwards.push({
      service: 'expo',
      listenHost: '0.0.0.0',
      listenPort: expoPort,
      targetHost: '127.0.0.1',
      targetPort: expoPort,
    });
  }
  if (expo.webEnabled === true && webPort) {
    forwards.push({
      service: 'expo-web',
      listenHost: '0.0.0.0',
      listenPort: webPort,
      targetHost: '127.0.0.1',
      targetPort: webPort,
    });
  }
  if (expo.devClientEnabled === true && mobilePort) {
    forwards.push({
      service: 'expo-mobile',
      listenHost: '0.0.0.0',
      listenPort: mobilePort,
      targetHost: '127.0.0.1',
      targetPort: mobilePort,
    });
  }

  const byListenPort = new Map();
  for (const forward of forwards) {
    const existing = byListenPort.get(forward.listenPort);
    if (!existing) {
      byListenPort.set(forward.listenPort, forward);
      continue;
    }
    if (existing.targetHost !== forward.targetHost || existing.targetPort !== forward.targetPort) {
      throw tunnelError(
        'EXECUTION_HOST_SERVICE_TUNNEL_PORT_COLLISION',
        `[dev-vm] Stack declares incompatible public services on TCP port ${forward.listenPort}`,
        { port: forward.listenPort },
      );
    }
  }
  return [...byListenPort.values()];
}

function pendingProjectedServices(projection) {
  const expoTargetName = String(projection.runtime.placement?.expo ?? '').trim();
  if (!expoTargetName) return [];
  const expoTarget = projection.runtime.remoteTargets?.[expoTargetName];
  return expoTarget?.services?.expo === true
    && expoTarget?.serviceStatus?.expo === 'starting'
    ? ['expo']
    : [];
}

function workspaceStatePath(profile, env, workspaceId) {
  const instance = requireSafeComponent(profile?.instance, 'managed Lima instance name');
  const workspace = String(workspaceId ?? '').trim() || 'default';
  const safeWorkspace = requireSafeComponent(workspace, 'execution-host workspace');
  return join(getHappyStacksHomeDir(env), TUNNEL_HOME_DIR, `${instance}-${safeWorkspace}.json`);
}

function tunnelStateLockPath(statePath) {
  return `${statePath}.lock`;
}

async function withTunnelStateMutationLock(statePath, fn) {
  return await withJsonOwnerFileLock(fn, {
    lockPath: tunnelStateLockPath(statePath),
    timeoutMs: TUNNEL_STATE_LOCK_TIMEOUT_MS,
    pollIntervalMs: 5,
    staleAfterMs: TUNNEL_STATE_LOCK_STALE_AFTER_MS,
    errorLabel: 'execution-host service tunnel state lock',
  });
}

function tunnelMarker({ profile, workspaceId, stackName }) {
  return `${requireSafeComponent(profile?.instance, 'managed Lima instance name')}:${String(workspaceId ?? '').trim() || 'default'}:${normalizeStackName(stackName)}`;
}

function sameForwards(left, right) {
  return JSON.stringify(left ?? []) === JSON.stringify(right ?? []);
}

function validTunnelState(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  if (raw.version !== TUNNEL_STATE_VERSION) return false;
  if (raw.transition != null
    && raw.transition !== TUNNEL_TRANSITION_REPLACING
    && raw.transition !== TUNNEL_TRANSITION_STOPPING) return false;
  if (!Number.isInteger(raw.pid) || raw.pid <= 1) return false;
  if (!String(raw.processInstanceFingerprint ?? '').trim()) return false;
  if (!SAFE_STATE_COMPONENT.test(String(raw.instance ?? ''))) return false;
  if (!SAFE_STATE_COMPONENT.test(String(raw.workspaceId ?? '') || 'default')) return false;
  if (!SAFE_STACK_NAME.test(String(raw.stackName ?? ''))) return false;
  if (!String(raw.marker ?? '').trim()) return false;
  if (!Array.isArray(raw.forwards) || raw.forwards.length === 0) return false;
  return raw.forwards.every((forward) => (
    forward?.listenHost === '0.0.0.0'
    && forward?.targetHost === '127.0.0.1'
    && servicePort(forward.listenPort) != null
    && servicePort(forward.targetPort) != null
  ));
}

function tunnelTransition(state) {
  return state?.transition ?? '';
}

async function readTunnelState(statePath) {
  try {
    const parsed = JSON.parse(await readFile(statePath, 'utf8'));
    return validTunnelState(parsed)
      ? { state: parsed, status: 'ok' }
      : { state: null, status: 'invalid' };
  } catch (error) {
    if (error?.code === 'ENOENT') return { state: null, status: 'absent' };
    return { state: null, status: 'invalid' };
  }
}

async function writeTunnelState(statePath, state) {
  const parent = dirname(statePath);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const temporary = `${statePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(state)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporary, statePath);
  } finally {
    await rm(temporary, { force: true });
  }
}

function defaultBoundary() {
  return {
    spawn(command, args, options) {
      return spawn(command, args, options);
    },
    async listListeners(port, { candidatePids, signal } = {}) {
      return await listListenPidsWithStatus(port, {
        timeoutMs: PROCESS_OBSERVATION_TIMEOUT_MS,
        candidatePids,
        signal,
      });
    },
    async probePortBinding(port, { host, signal } = {}) {
      return await probeTcpPortBinding(port, {
        host,
        timeoutMs: PROCESS_OBSERVATION_TIMEOUT_MS,
        signal,
      });
    },
    readFingerprint(pid, expectedFingerprint) {
      return readProcessInstanceFingerprintSync(pid, { expectedFingerprint });
    },
    async observeProcess(pid) {
      return await observePsEnvLine(pid, { timeoutMs: PROCESS_OBSERVATION_TIMEOUT_MS });
    },
    async terminate(pid, options) {
      return await terminateProcessPid(pid, options);
    },
    async delay(ms, options) {
      await delay(ms, undefined, options);
    },
    reportWarning(message) {
      process.stderr.write(`${message}\n`);
    },
  };
}

async function inspectSavedTunnel(state, boundary) {
  const observed = await boundary.observeProcess(state.pid);
  if (observed?.status === 'not_found') {
    return { ok: false, ownerVerified: false, reason: 'process_missing' };
  }
  if (observed?.status !== 'ok') {
    return { ok: false, ownerVerified: false, reason: 'process_identity_unavailable' };
  }
  const fingerprint = String(boundary.readFingerprint(state.pid, state.processInstanceFingerprint) ?? '').trim();
  if (fingerprint !== state.processInstanceFingerprint) {
    return { ok: false, ownerVerified: false, reason: fingerprint ? 'process_instance_changed' : 'process_identity_unavailable' };
  }
  const ownsThroughEnvironment = (
    textContainsNeedle(observed.line, `HAPPIER_STACK_PROCESS_KIND=${TUNNEL_PROCESS_KIND}`)
    && textContainsNeedle(observed.line, `HAPPIER_STACK_EXECUTION_HOST_TUNNEL=${state.marker}`)
  );
  const ownsThroughSshMarker = textContainsNeedle(
    observed.line,
    `SetEnv=HAPPIER_STACK_EXECUTION_HOST_TUNNEL=${state.marker}`,
  );
  // Pre-marker tunnel states were already protected by a 0600 state file, PID
  // incarnation fingerprint, and bound-listener checks. macOS hides the SSH
  // child's environment, so adopt only the exact saved forwarding plan once;
  // every newly spawned tunnel carries the visible SetEnv marker above.
  const paddedCommand = ` ${String(observed.line ?? '').trim()} `;
  const ownsLegacyExactSshPlan = [
    ' ssh -T ',
    ` -F ${state.sshConfigFile} `,
    ' -o ControlMaster=no ',
    ' -o ControlPath=none ',
    ...state.forwards.map((forward) => (
      ` -L *:${forward.listenPort}:${forward.targetHost}:${forward.targetPort} `
    )),
    ` -N ${state.sshHost} `,
  ].every((needle) => paddedCommand.includes(needle));
  if (!ownsThroughEnvironment && !ownsThroughSshMarker && !ownsLegacyExactSshPlan) {
    return { ok: false, ownerVerified: false, reason: 'process_ownership_unverified' };
  }
  for (const forward of state.forwards) {
    // eslint-disable-next-line no-await-in-loop
    const listeners = await boundary.listListeners(forward.listenPort, { candidatePids: [state.pid] });
    if (listeners?.status !== 'ok') {
      return { ok: false, ownerVerified: true, reason: 'listener_discovery_unavailable', port: forward.listenPort };
    }
    if (!listeners.pids.includes(state.pid)) {
      return { ok: false, ownerVerified: true, reason: 'listener_missing', port: forward.listenPort };
    }
  }
  return { ok: true, ownerVerified: true, reason: 'running' };
}

async function removeState(statePath) {
  await rm(statePath, { force: true });
}

async function removeReplacingTunnelState(statePath) {
  const loaded = await readTunnelState(statePath);
  if (loaded.status === 'ok' && tunnelTransition(loaded.state) === TUNNEL_TRANSITION_REPLACING) {
    await removeState(statePath);
  }
}

async function stopSavedTunnel({ statePath, state, boundary, removeStateAfterStop = true }) {
  const inspection = await inspectSavedTunnel(state, boundary);
  if (inspection.reason === 'process_missing') {
    if (removeStateAfterStop) await removeState(statePath);
    return { changed: false, reason: 'process_missing', statePath };
  }
  if (!inspection.ownerVerified) {
    return { changed: false, reason: inspection.reason, statePath };
  }
  const terminated = await boundary.terminate(state.pid, {
    signal: 'SIGTERM',
    graceMs: 800,
    processInstanceFingerprint: state.processInstanceFingerprint,
  });
  if (terminated?.ok !== true) {
    return { changed: false, reason: terminated?.reason ?? 'termination_failed', statePath };
  }
  if (removeStateAfterStop) await removeState(statePath);
  return { changed: true, reason: 'stopped', statePath, terminated };
}

async function assertPortsUnclaimed(forwards, boundary) {
  for (const forward of forwards) {
    // eslint-disable-next-line no-await-in-loop
    const binding = await boundary.probePortBinding(forward.listenPort, { host: forward.listenHost });
    if (binding?.status !== 'free' && binding?.status !== 'in_use') {
      throw tunnelError(
        'EXECUTION_HOST_SERVICE_TUNNEL_PORT_UNAVAILABLE',
        `[dev-vm] unable to verify whether TCP port ${forward.listenPort} is available`,
        { port: forward.listenPort, bindingStatus: binding?.status ?? 'unknown' },
      );
    }
    if (binding.status === 'in_use') {
      throw tunnelError(
        'EXECUTION_HOST_SERVICE_TUNNEL_PORT_CONFLICT',
        `[dev-vm] refusing to replace the existing listener on TCP port ${forward.listenPort}`,
        { port: forward.listenPort, reason: binding.reason ?? 'address-in-use' },
      );
    }
  }
}

async function waitForTunnelListeners({ pid, forwards, boundary }) {
  for (let attempt = 0; attempt <= MAX_READY_ATTEMPTS; attempt += 1) {
    let ready = true;
    for (const forward of forwards) {
      // eslint-disable-next-line no-await-in-loop
      const listeners = await boundary.listListeners(forward.listenPort, { candidatePids: [pid] });
      if (listeners?.status !== 'ok') {
        throw tunnelError(
          'EXECUTION_HOST_SERVICE_TUNNEL_PORT_UNAVAILABLE',
          `[dev-vm] unable to verify SSH forwarding on TCP port ${forward.listenPort}`,
          { port: forward.listenPort, listenerStatus: listeners?.status ?? 'unknown' },
        );
      }
      if (!listeners.pids.includes(pid)) ready = false;
    }
    if (ready) return;
    if (attempt < MAX_READY_ATTEMPTS) {
      // eslint-disable-next-line no-await-in-loop
      await boundary.delay(READY_DELAY_MS);
    }
  }
  throw tunnelError(
    'EXECUTION_HOST_SERVICE_TUNNEL_START_FAILED',
    '[dev-vm] SSH forwarding did not bind every declared Stack service port',
  );
}

export async function inspectExecutionHostStackRuntime({
  profile,
  workspaceId = '',
  stackName = '',
  executor,
} = {}) {
  if (!executor?.capture) throw new Error('[dev-vm] managed Lima executor is required');
  const workspace = requireWorkspace(profile, workspaceId);
  const expectedStack = normalizeStackName(stackName);
  const result = await executor.capture('limactl', [
    'shell', '--workdir', workspace.guestDir, profile.instance, '--',
    'sh', '-lc', GUEST_STACK_PROJECTION_SCRIPT, 'sh', workspace.guestDir, expectedStack,
  ]);
  if (result.exitCode === 3) {
    return { status: 'missing', workspaceId: workspace.id, forwards: [] };
  }
  if (result.exitCode === 4) {
    throw tunnelError(
      'EXECUTION_HOST_SERVICE_TUNNEL_AMBIGUOUS_STACK',
      `[dev-vm] more than one Stack declaration matches workspace ${workspace.id || 'default'}; pass --stack=NAME`,
    );
  }
  if (result.exitCode !== 0) {
    throw tunnelError(
      'EXECUTION_HOST_SERVICE_TUNNEL_STACK_DISCOVERY_FAILED',
      `[dev-vm] unable to inspect Stack service declarations${String(result.err ?? '').trim() ? `: ${String(result.err).trim()}` : ''}`,
    );
  }
  const projection = parseProjectedStackRuntime(result.out);
  if (expectedStack && projection.stackName !== expectedStack) {
    throw new Error('[dev-vm] managed guest returned an unexpected Stack declaration');
  }
  const runtimeStartedAt = normalizeRuntimeStartedAt(projection.runtime.startedAt);
  return {
    status: 'ready',
    workspaceId: workspace.id,
    stackName: projection.stackName,
    forwards: buildForwards(projection),
    pendingServices: pendingProjectedServices(projection),
    ...(runtimeStartedAt ? { runtimeStartedAt } : {}),
  };
}

export async function inspectExecutionHostServiceTunnel({
  profile,
  workspaceId = '',
  env = process.env,
  boundary,
} = {}) {
  const workspace = requireWorkspace(profile, workspaceId);
  const statePath = workspaceStatePath(profile, env, workspace.id);
  const loaded = await readTunnelState(statePath);
  if (loaded.status === 'absent') {
    return { status: 'absent', healthy: true, workspaceId: workspace.id, statePath };
  }
  if (loaded.status !== 'ok') {
    return { status: 'invalid_state', healthy: false, workspaceId: workspace.id, statePath };
  }
  const transition = tunnelTransition(loaded.state);
  if (transition === TUNNEL_TRANSITION_REPLACING) {
    return {
      status: TUNNEL_TRANSITION_REPLACING,
      healthy: false,
      workspaceId: workspace.id,
      statePath,
      stackName: loaded.state.stackName,
      forwards: loaded.state.forwards,
    };
  }
  const inspection = await inspectSavedTunnel(loaded.state, boundary ?? defaultBoundary());
  const status = transition === TUNNEL_TRANSITION_STOPPING
    ? inspection.reason === 'process_missing' ? 'stopped' : TUNNEL_TRANSITION_STOPPING
    : inspection.ok ? 'running' : inspection.reason;
  return {
    status,
    healthy: inspection.ok && !transition,
    workspaceId: workspace.id,
    statePath,
    stackName: loaded.state.stackName,
    forwards: loaded.state.forwards,
    ...(inspection.port ? { port: inspection.port } : {}),
  };
}

export async function inspectExecutionHostServiceTunnels({ profile, env = process.env, boundary } = {}) {
  const workspaceIds = profile?.version === 2
    ? (profile.workspaces ?? []).map((workspace) => workspace.id)
    : [''];
  const tunnels = [];
  for (const workspaceId of workspaceIds) {
    // eslint-disable-next-line no-await-in-loop
    tunnels.push(await inspectExecutionHostServiceTunnel({ profile, workspaceId, env, boundary }));
  }
  return tunnels;
}

async function ensureExecutionHostServiceTunnelUnlocked({
  profile,
  workspace,
  stackName = '',
  executor,
  env = process.env,
  boundary,
  statePath,
} = {}) {
  const processBoundary = boundary ?? defaultBoundary();
  const projection = await inspectExecutionHostStackRuntime({ profile, workspaceId: workspace.id, stackName, executor });
  if (projection.status !== 'ready' || projection.forwards.length === 0) {
    return {
      changed: false,
      status: projection.status === 'ready' ? 'no_services' : projection.status,
      workspaceId: workspace.id,
      statePath,
      pendingServices: projection.pendingServices,
      ...(projection.runtimeStartedAt ? { runtimeStartedAt: projection.runtimeStartedAt } : {}),
    };
  }
  const marker = tunnelMarker({ profile, workspaceId: workspace.id, stackName: projection.stackName });
  const loaded = await readTunnelState(statePath);
  if (loaded.status === 'invalid') {
    throw tunnelError('EXECUTION_HOST_SERVICE_TUNNEL_STATE_INVALID', '[dev-vm] refusing to replace an invalid SSH tunnel state record');
  }
  let replacementInProgress = false;
  try {
    if (loaded.state) {
      const transition = tunnelTransition(loaded.state);
      if (transition === TUNNEL_TRANSITION_REPLACING) {
        return { changed: false, status: TUNNEL_TRANSITION_REPLACING, workspaceId: workspace.id, statePath };
      }
      if (transition === TUNNEL_TRANSITION_STOPPING) {
        const stopInspection = await inspectSavedTunnel(loaded.state, processBoundary);
        if (stopInspection.reason !== 'process_missing') {
          return { changed: false, status: TUNNEL_TRANSITION_STOPPING, workspaceId: workspace.id, statePath };
        }
      } else {
        const samePlan = loaded.state.instance === profile.instance
          && loaded.state.workspaceId === workspace.id
          && loaded.state.stackName === projection.stackName
          && loaded.state.marker === marker
          && sameForwards(loaded.state.forwards, projection.forwards);
        const inspection = await inspectSavedTunnel(loaded.state, processBoundary);
        if (samePlan && inspection.ok) {
          return {
            changed: false,
            status: 'running',
            workspaceId: workspace.id,
            statePath,
            stackName: projection.stackName,
            forwards: projection.forwards,
            pendingServices: projection.pendingServices,
            ...(projection.runtimeStartedAt ? { runtimeStartedAt: projection.runtimeStartedAt } : {}),
          };
        }
        if (inspection.reason !== 'process_missing' && !inspection.ownerVerified) {
          throw tunnelError(
            'EXECUTION_HOST_SERVICE_TUNNEL_OWNERSHIP_UNVERIFIED',
            `[dev-vm] refusing to replace SSH tunnel process ${loaded.state.pid}: ${inspection.reason}`,
            { pid: loaded.state.pid, reason: inspection.reason },
          );
        }
        // Keep the owned state record visible while the old transport releases
        // its ports and the replacement binds. A concurrent supervisor must not
        // mistake that handoff for an operator-requested stop.
        await writeTunnelState(statePath, { ...loaded.state, transition: TUNNEL_TRANSITION_REPLACING });
        replacementInProgress = true;
        if (inspection.reason !== 'process_missing') {
          const stopped = await stopSavedTunnel({
            statePath,
            state: loaded.state,
            boundary: processBoundary,
            removeStateAfterStop: false,
          });
          if (stopped.changed !== true && stopped.reason !== 'process_missing') {
            await writeTunnelState(statePath, loaded.state);
            replacementInProgress = false;
            throw tunnelError(
              'EXECUTION_HOST_SERVICE_TUNNEL_STOP_FAILED',
              `[dev-vm] unable to replace its SSH tunnel: ${stopped.reason}`,
              { reason: stopped.reason },
            );
          }
        }
      }
    }
    await assertPortsUnclaimed(projection.forwards, processBoundary);
    const resolvedSsh = resolveExecutionHostWorkspaceMount(profile, env);
    const args = buildSshForwardArgs(
      { ssh: resolvedSsh.sshHost },
      {
        forwards: projection.forwards.map(({ listenHost, listenPort, targetHost, targetPort }) => ({
          direction: 'local', listenHost, listenPort, targetHost, targetPort,
        })),
        sshArgs: [
          '-F', resolvedSsh.sshConfigFile,
          '-o', 'ControlMaster=no',
          '-o', 'ControlPath=none',
          '-o', `SetEnv=HAPPIER_STACK_EXECUTION_HOST_TUNNEL=${marker}`,
        ],
      },
    );
    const child = processBoundary.spawn('ssh', args, {
      detached: true,
      stdio: 'ignore',
      shell: false,
      env: {
        ...process.env,
        ...env,
        HAPPIER_STACK_PROCESS_KIND: TUNNEL_PROCESS_KIND,
        HAPPIER_STACK_EXECUTION_HOST_TUNNEL: marker,
      },
    });
    child.unref?.();
    const pid = Number(child?.pid);
    if (!Number.isInteger(pid) || pid <= 1) {
      throw tunnelError('EXECUTION_HOST_SERVICE_TUNNEL_START_FAILED', '[dev-vm] SSH forwarding process did not report a PID');
    }
    const fingerprint = String(processBoundary.readFingerprint(pid) ?? '').trim();
    if (!fingerprint) {
      try { child.kill?.('SIGTERM'); } catch {}
      throw tunnelError('EXECUTION_HOST_SERVICE_TUNNEL_PROCESS_IDENTITY_UNAVAILABLE', '[dev-vm] SSH forwarding process identity could not be verified');
    }
    try {
      await waitForTunnelListeners({ pid, forwards: projection.forwards, boundary: processBoundary });
    } catch (error) {
      await processBoundary.terminate(pid, {
        signal: 'SIGTERM',
        graceMs: 800,
        processInstanceFingerprint: fingerprint,
      });
      throw error;
    }
    const state = {
      version: TUNNEL_STATE_VERSION,
      instance: profile.instance,
      workspaceId: workspace.id,
      stackName: projection.stackName,
      marker,
      pid,
      processInstanceFingerprint: fingerprint,
      sshConfigFile: resolvedSsh.sshConfigFile,
      sshHost: resolvedSsh.sshHost,
      forwards: projection.forwards,
    };
    await writeTunnelState(statePath, state);
    return {
      changed: true,
      status: 'running',
      workspaceId: workspace.id,
      stackName: projection.stackName,
      forwards: projection.forwards,
      statePath,
      pendingServices: projection.pendingServices,
      ...(projection.runtimeStartedAt ? { runtimeStartedAt: projection.runtimeStartedAt } : {}),
    };
  } catch (error) {
    if (replacementInProgress) await removeReplacingTunnelState(statePath);
    throw error;
  }
}

export async function ensureExecutionHostServiceTunnel({
  profile,
  workspaceId = '',
  stackName = '',
  executor,
  env = process.env,
  boundary,
  signal,
} = {}) {
  const workspace = requireWorkspace(profile, workspaceId);
  const statePath = workspaceStatePath(profile, env, workspace.id);
  const cancelled = () => ({ changed: false, status: 'cancelled', workspaceId: workspace.id, statePath });
  if (signal?.aborted) return cancelled();
  return await withTunnelStateMutationLock(statePath, async () => {
    // A controller can be superseded while its reconcile request waits for an
    // incumbent mutation. Do not let that cancelled request act on the newer
    // transport after it finally acquires the canonical state lock.
    if (signal?.aborted) return cancelled();
    return await ensureExecutionHostServiceTunnelUnlocked({
      profile,
      workspace,
      stackName,
      executor,
      env,
      boundary,
      statePath,
    });
  });
}

export async function waitForExecutionHostServiceTunnel({
  profile,
  workspaceId = '',
  stackName = '',
  executor,
  env = process.env,
  boundary,
  signal,
  previousRuntimeStartedAt = '',
} = {}) {
  const processBoundary = boundary ?? defaultBoundary();
  const predecessorRuntimeStartedAt = normalizeRuntimeStartedAt(previousRuntimeStartedAt);
  for (let attempt = 0; attempt <= MAX_STACK_RUNTIME_READY_ATTEMPTS; attempt += 1) {
    if (signal?.aborted) return { changed: false, status: 'cancelled', workspaceId };
    // eslint-disable-next-line no-await-in-loop
    const result = await ensureExecutionHostServiceTunnel({
      profile,
      workspaceId,
      stackName,
      executor,
      env,
      boundary: processBoundary,
      signal,
    });
    const awaitingSuccessorRuntime = predecessorRuntimeStartedAt
      && result.status === 'running'
      && (
        !result.runtimeStartedAt
        || result.runtimeStartedAt === predecessorRuntimeStartedAt
      );
    const awaitingPendingServices = result.status === 'running'
      && Array.isArray(result.pendingServices)
      && result.pendingServices.length > 0;
    if (result.status === 'running' && !awaitingSuccessorRuntime && !awaitingPendingServices) return result;
    if (!awaitingSuccessorRuntime && !awaitingPendingServices && ![
      'missing',
      'no_services',
      TUNNEL_TRANSITION_REPLACING,
      TUNNEL_TRANSITION_STOPPING,
    ].includes(result.status)) return result;
    if (attempt < MAX_STACK_RUNTIME_READY_ATTEMPTS) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await processBoundary.delay(STACK_RUNTIME_READY_DELAY_MS, { signal });
      } catch (error) {
        if (signal?.aborted || error?.name === 'AbortError') {
          return { changed: false, status: 'cancelled', workspaceId };
        }
        throw error;
      }
    }
  }
  throw tunnelError(
    'EXECUTION_HOST_SERVICE_TUNNEL_RUNTIME_TIMEOUT',
    '[dev-vm] timed out waiting for the delegated Stack to publish its service ports',
  );
}

export async function superviseExecutionHostServiceTunnel({
  profile,
  workspaceId = '',
  stackName = '',
  executor,
  env = process.env,
  boundary,
  signal,
  previousRuntimeStartedAt = '',
} = {}) {
  const processBoundary = boundary ?? defaultBoundary();
  const workspace = requireWorkspace(profile, workspaceId);
  const cancelled = () => ({ changed: false, status: 'cancelled', workspaceId: workspace.id });
  let result = await waitForExecutionHostServiceTunnel({
    profile,
    workspaceId: workspace.id,
    stackName,
    executor,
    env,
    boundary: processBoundary,
    signal,
    previousRuntimeStartedAt,
  });
  if (result.status !== 'running') return result;
  let recoveryErrorMessage = '';

  while (!signal?.aborted) {
    try {
      await processBoundary.delay(SERVICE_TUNNEL_SUPERVISION_DELAY_MS, { signal });
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError') return cancelled();
      throw error;
    }
    if (signal?.aborted) return cancelled();

    const inspection = await inspectExecutionHostServiceTunnel({
      profile,
      workspaceId: workspace.id,
      env,
      boundary: processBoundary,
    });
    if (inspection.status === 'stopped') {
      return { changed: false, status: 'stopped', workspaceId: workspace.id, statePath: inspection.statePath };
    }
    if (inspection.status === TUNNEL_TRANSITION_REPLACING || inspection.status === TUNNEL_TRANSITION_STOPPING) continue;
    if (inspection.healthy && inspection.status !== 'absent') continue;

    try {
      result = await waitForExecutionHostServiceTunnel({
        profile,
        workspaceId: workspace.id,
        stackName,
        executor,
        env,
        boundary: processBoundary,
        signal,
      });
      if (recoveryErrorMessage) {
        processBoundary.reportWarning?.('[dev-vm] host service tunnel recovered after a transient replacement failure');
        recoveryErrorMessage = '';
      }
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError') return cancelled();
      const message = String(error?.message ?? error);
      if (message !== recoveryErrorMessage) {
        processBoundary.reportWarning?.(`[dev-vm] host service tunnel replacement failed; retrying: ${message}`);
        recoveryErrorMessage = message;
      }
      continue;
    }
    if (result.status !== 'running') return result;
  }
  return cancelled();
}

async function stopExecutionHostServiceTunnelUnlocked({ statePath, boundary } = {}) {
  const loaded = await readTunnelState(statePath);
  if (loaded.status === 'absent') return { changed: false, reason: 'not_found', statePath };
  if (loaded.status !== 'ok') return { changed: false, reason: 'state_invalid', statePath };
  const processBoundary = boundary ?? defaultBoundary();
  // Unlike a replacement, this transition is terminal for the current
  // delegated lifetime and must remain visible after the SSH child exits.
  await writeTunnelState(statePath, { ...loaded.state, transition: TUNNEL_TRANSITION_STOPPING });
  try {
    const stopped = await stopSavedTunnel({
      statePath,
      state: loaded.state,
      boundary: processBoundary,
      removeStateAfterStop: false,
    });
    if (stopped.changed === true || stopped.reason === 'process_missing') return stopped;
    await writeTunnelState(statePath, loaded.state);
    return stopped;
  } catch (error) {
    await writeTunnelState(statePath, loaded.state);
    throw error;
  }
}

export async function stopExecutionHostServiceTunnel({
  profile,
  workspaceId = '',
  env = process.env,
  boundary,
} = {}) {
  const workspace = requireWorkspace(profile, workspaceId);
  const statePath = workspaceStatePath(profile, env, workspace.id);
  return await withTunnelStateMutationLock(statePath, async () => {
    return await stopExecutionHostServiceTunnelUnlocked({ statePath, boundary });
  });
}
