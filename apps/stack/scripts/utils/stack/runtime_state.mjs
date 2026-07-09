import { existsSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { resolveStackEnvPath } from '../paths/paths.mjs';
import { readJsonIfExists, writeJsonAtomic } from '../fs/json.mjs';
import { isPidAlive } from '../proc/pids.mjs';
import { isPidOwnedByStack } from '../proc/ownership.mjs';

export { isPidAlive };

export function getStackRuntimeStatePath(stackName) {
  const { baseDir } = resolveStackEnvPath(stackName);
  return join(baseDir, 'stack.runtime.json');
}

export async function readStackRuntimeStateFile(statePath) {
  const parsed = await readJsonIfExists(statePath, { defaultValue: null });
  return parsed && typeof parsed === 'object' ? parsed : null;
}

export async function writeStackRuntimeStateFile(statePath, state) {
  if (!statePath) {
    throw new Error('[stack] missing runtime state path');
  }
  await writeJsonAtomic(statePath, state);
}

function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(a, b) {
  if (!isPlainObject(a) || !isPlainObject(b)) {
    return b;
  }
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (isPlainObject(out[k]) && isPlainObject(v)) {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function normalizeRuntimePid(pid) {
  const n = Number(pid);
  return Number.isInteger(n) && n > 1 ? n : null;
}

export function createStackServerRuntimeProcessPatch({
  listenerPid,
  wrapperPid,
  serverPort,
  clearProxyState = false,
} = {}) {
  const patch = {
    processes: {
      serverPid: normalizeRuntimePid(listenerPid),
      serverWrapperPid: normalizeRuntimePid(wrapperPid),
    },
  };
  if (clearProxyState) {
    patch.processes.proxyPid = null;
    patch.processes.serverBackendPid = null;
    patch.processes.serverDrainingPid = null;
    patch.ports = {
      ...(Number.isFinite(Number(serverPort)) && Number(serverPort) > 0 ? { server: Number(serverPort) } : {}),
      serverBackend: null,
    };
    patch.serverProxy = {
      enabled: false,
      mode: 'direct',
      restartMode: null,
      fallbackReason: null,
    };
  }
  return patch;
}

export function createStackDevProxyRuntimePatch({
  stablePort,
  backendPort,
  proxyPid,
  backendPid,
  drainingPid,
  mode = 'proxy',
  restartMode = null,
  fallbackReason = null,
} = {}) {
  const normalizedStablePort = Number(stablePort);
  const normalizedBackendPort = Number(backendPort);
  return {
    processes: {
      proxyPid: normalizeRuntimePid(proxyPid),
      serverBackendPid: normalizeRuntimePid(backendPid),
      serverDrainingPid: normalizeRuntimePid(drainingPid),
    },
    ports: {
      ...(Number.isFinite(normalizedStablePort) && normalizedStablePort > 0 ? { server: normalizedStablePort } : {}),
      serverBackend: Number.isFinite(normalizedBackendPort) && normalizedBackendPort > 0 ? normalizedBackendPort : null,
    },
    serverProxy: {
      enabled: mode !== 'direct',
      mode,
      restartMode: restartMode ?? null,
      fallbackReason: fallbackReason ?? null,
    },
  };
}

export function getStackRuntimeProcessEntries(runtimeState) {
  const processes = runtimeState?.processes;
  if (!isPlainObject(processes)) return [];

  const entries = [];
  for (const [rawKey, value] of Object.entries(processes)) {
    const key = String(rawKey);
    if (/Pid$/.test(key)) {
      const pid = Number(value);
      if (Number.isFinite(pid) && pid > 1) {
        entries.push({ key, pid });
      }
      continue;
    }

    if (/Pids$/.test(key) && Array.isArray(value)) {
      const seen = new Set();
      for (const entry of value) {
        const pid = Number(entry);
        if (!Number.isFinite(pid) || pid <= 1 || seen.has(pid)) continue;
        seen.add(pid);
        entries.push({ key, pid });
      }
    }
  }
  return entries;
}

export function hasLiveStackRuntimeProcesses(runtimeState, { isPidAliveImpl = isPidAlive } = {}) {
  return getStackRuntimeProcessEntries(runtimeState).some(({ pid }) => isPidAliveImpl(pid));
}

export function resolveStackRuntimeProcessTrustContext({ stackName = '', envPath = '', cliHomeDir = '' } = {}) {
  const resolvedStackName = String(stackName ?? '').trim();
  const explicitEnvPath = String(envPath ?? '').trim();
  const explicitCliHomeDir = String(cliHomeDir ?? '').trim();
  if (!resolvedStackName) {
    return {
      stackName: '',
      envPath: explicitEnvPath,
      cliHomeDir: explicitCliHomeDir,
    };
  }

  const paths = resolveStackEnvPath(resolvedStackName);
  return {
    stackName: resolvedStackName,
    envPath: explicitEnvPath || paths.envPath,
    cliHomeDir: explicitCliHomeDir || join(paths.baseDir, 'cli'),
  };
}

export async function isStackRuntimeProcessTrusted(
  pid,
  { key = '', stackName = '', envPath = '', cliHomeDir = '' } = {},
  {
    isPidAliveImpl = isPidAlive,
    isPidOwnedByStackImpl = isPidOwnedByStack,
    isRuntimeProcessTrustedImpl = null,
  } = {},
) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 1 || !isPidAliveImpl(n)) return false;

  const context = resolveStackRuntimeProcessTrustContext({ stackName, envPath, cliHomeDir });
  if (typeof isRuntimeProcessTrustedImpl === 'function') {
    return Boolean(await isRuntimeProcessTrustedImpl(n, { key, ...context }));
  }

  if (!context.stackName && !context.envPath && !context.cliHomeDir) {
    return true;
  }

  return await isPidOwnedByStackImpl(n, {
    stackName: context.stackName,
    envPath: context.envPath,
    cliHomeDir: context.cliHomeDir,
  });
}

export async function hasTrustedStackRuntimeProcesses(runtimeState, context = {}, options = {}) {
  for (const { key, pid } of getStackRuntimeProcessEntries(runtimeState)) {
    // eslint-disable-next-line no-await-in-loop
    if (await isStackRuntimeProcessTrusted(pid, { ...context, key }, options)) {
      return true;
    }
  }
  return false;
}

export async function resolveTrustedStackRuntimeServerPort(runtimeState, context = {}, options = {}) {
  const port = Number(runtimeState?.ports?.server);
  if (!Number.isFinite(port) || port <= 0) return null;
  const ownerTrusted = await isStackRuntimeProcessTrusted(
    runtimeState?.ownerPid,
    { ...context, key: 'ownerPid' },
    options,
  );
  if (ownerTrusted) return port;
  return (await hasTrustedStackRuntimeProcesses(runtimeState, context, options)) ? port : null;
}

async function pruneUntrustedRuntimeProcessPids(processes, context = {}, options = {}) {
  if (!isPlainObject(processes)) return {};
  const out = { ...processes };
  for (const [key, value] of Object.entries(out)) {
    if (/Pids$/.test(String(key)) && Array.isArray(value)) {
      const trustedPids = [];
      for (const rawPid of value) {
        const pid = Number(rawPid);
        if (!Number.isFinite(pid) || pid <= 1 || trustedPids.includes(pid)) continue;
        // eslint-disable-next-line no-await-in-loop
        if (await isStackRuntimeProcessTrusted(pid, { ...context, key: String(key) }, options)) {
          trustedPids.push(pid);
        }
      }
      out[key] = trustedPids;
      continue;
    }

    if (!/Pid$/.test(String(key))) continue;
    const pid = Number(value);
    // eslint-disable-next-line no-await-in-loop
    if (!(await isStackRuntimeProcessTrusted(pid, { ...context, key: String(key) }, options))) {
      out[key] = null;
    }
  }
  return out;
}

export async function updateStackRuntimeStateFile(statePath, patch) {
  const existing = (await readStackRuntimeStateFile(statePath)) ?? {};
  const next = deepMerge(existing, patch ?? {});
  await writeStackRuntimeStateFile(statePath, next);
  return next;
}

export async function recordStackRuntimeStart(
  statePath,
  { stackName, script, ephemeral, ownerPid, ports, ...rest } = {},
  options = {},
) {
  const now = new Date().toISOString();
  const existing = (await readStackRuntimeStateFile(statePath)) ?? {};
  const restPatch = rest ?? {};
  const { processes: restProcesses, ...restWithoutProcesses } = restPatch;
  const processTrustContext = resolveStackRuntimeProcessTrustContext({ stackName });
  const processes = deepMerge(
    await pruneUntrustedRuntimeProcessPids(existing.processes, processTrustContext, options),
    isPlainObject(restProcesses) ? restProcesses : {},
  );
  const existingOwnerPid = Number(existing.ownerPid);
  const ownerPidNum = Number(ownerPid);
  const shouldRefreshStartedAt =
    !(
      typeof existing.startedAt === 'string' &&
      existing.startedAt.trim()
    ) ||
    !Number.isFinite(existingOwnerPid) ||
    existingOwnerPid <= 1 ||
    !isPidAlive(existingOwnerPid) ||
    (Number.isFinite(ownerPidNum) && ownerPidNum > 1 && ownerPidNum !== existingOwnerPid);
  const startedAt = shouldRefreshStartedAt ? now : existing.startedAt;
  const next = deepMerge(existing, {
    version: 1,
    stackName,
    script,
    ephemeral: Boolean(ephemeral),
    ownerPid,
    ports: ports ?? {},
    processes,
    startedAt,
    updatedAt: now,
    stopRequest: null,
    ...restWithoutProcesses,
  });
  await writeStackRuntimeStateFile(statePath, next);
  return next;
}

export async function recordStackRuntimeUpdate(statePath, patch = {}) {
  return await updateStackRuntimeStateFile(statePath, {
    ...(patch ?? {}),
    updatedAt: new Date().toISOString(),
  });
}

export async function recordStackRuntimeServerPids(statePath, { listenerPid, wrapperPid } = {}) {
  return await recordStackRuntimeUpdate(
    statePath,
    createStackServerRuntimeProcessPatch({ listenerPid, wrapperPid }),
  );
}

export async function recordStackRuntimeStopRequest(
  statePath,
  { signal = 'SIGTERM', requestedBy = 'unknown', reason = '', preserveDaemon = false } = {},
) {
  return await updateStackRuntimeStateFile(statePath, {
    stopRequest: {
      signal: String(signal ?? 'SIGTERM'),
      requestedBy: String(requestedBy ?? 'unknown'),
      reason: String(reason ?? ''),
      preserveDaemon: preserveDaemon === true,
      requestedAt: new Date().toISOString(),
    },
    updatedAt: new Date().toISOString(),
  });
}

export async function deleteStackRuntimeStateFile(statePath) {
  try {
    if (!statePath || !existsSync(statePath)) return;
    await unlink(statePath);
  } catch {
    // ignore
  }
}
