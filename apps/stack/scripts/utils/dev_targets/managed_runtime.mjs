import { runManagedWslOperation } from './managed_wsl.mjs';
import { readFile } from 'node:fs/promises';

import { createManagedLimaHostExecutor } from '../managed_lima/host_executor.mjs';
import { getManagedLimaStatus, startManagedLimaInstance } from '../managed_lima/lifecycle.mjs';
import { doctorManagedLimaInstance, setupManagedLimaRuntime } from '../managed_lima/manager.mjs';
import { ensureManagedLimaGuestLoginManager } from '../managed_lima/provisioner.mjs';
import { resolveManagedRuntimeCapacityResources } from './config.mjs';
import {
  installManagedLimaDevTargetControllerKey,
  reconcileManagedLimaDevTargetSshPublication,
} from './managed_worker.mjs';

export function createManagedDevTargetRuntimeExecutor(target, env = process.env) {
  const runtime = target?.managedRuntime;
  if (runtime?.kind !== 'lima') {
    throw new Error(`[dev-targets] target ${String(target?.name ?? 'unknown')} has no managed Lima runtime`);
  }
  const hostEnvironment = {
    LIMA_HOME: runtime.limaHome,
    ...(runtime.host.remotePath?.length ? { PATH: runtime.host.remotePath.join(':') } : {}),
  };
  return createManagedLimaHostExecutor(
    runtime.host,
    undefined,
    env,
    { hostEnvironment },
  );
}

function normalizeRuntimeTarget(target) {
  if (target?.managedRuntime) return { target, reconcileSshPublication: true };
  if (!target?.limaInstance || !target?.limaHome) return null;
  return {
    target: {
      ...target,
      managedRuntime: {
        kind: 'lima',
        instance: target.limaInstance,
        limaHome: target.limaHome,
        host: { kind: 'local' },
      },
    },
    reconcileSshPublication: false,
  };
}

export async function startManagedDevTargetRuntime(
  { target, env = process.env },
  {
    createExecutor = createManagedDevTargetRuntimeExecutor,
    startRuntime = startManagedLimaInstance,
    getRuntimeStatus = getManagedLimaStatus,
    ensureGuestLoginManager = ensureManagedLimaGuestLoginManager,
    reconcileSshPublication = reconcileManagedLimaDevTargetSshPublication,
    runCaptureResult,
  } = {},
) {
  if (target?.managedRuntime?.kind === 'wsl') {
    return await runManagedWslOperation({ target, action: 'Start', env }, { runCaptureResult });
  }
  if (!target?.managedRuntime) return { changed: false, status: 'Unmanaged' };
  const executor = createExecutor(target, env);
  const lifecycle = await startRuntime({
    executor,
    instance: target.managedRuntime.instance,
  });
  const current = await getRuntimeStatus({ executor, instance: target.managedRuntime.instance });
  if (!current.exists || String(current.status).toLowerCase() !== 'running') {
    throw new Error(`[dev-targets] managed Lima guest is not running: ${String(current.status)}`);
  }
  const guestLoginManager = await ensureGuestLoginManager({
    executor,
    instance: target.managedRuntime.instance,
  });
  const sshPublication = await reconcileSshPublication({
    target,
    sshLocalPort: current.instance?.sshLocalPort ?? current.instance?.SSHLocalPort,
    guestVerified: true,
    env,
  });
  return { ...lifecycle, guestLoginManager, sshPublication };
}

export async function startDevTargetRuntime(
  { target, env = process.env },
  dependencies = {},
) {
  const normalized = normalizeRuntimeTarget(target);
  if (!normalized) return { changed: false, status: 'Unmanaged' };
  return await startManagedDevTargetRuntime(
    { target: normalized.target, env },
    normalized.reconcileSshPublication
      ? dependencies
      : { ...dependencies, reconcileSshPublication: async () => null },
  );
}

export async function doctorManagedDevTargetRuntime({ target, env = process.env }) {
  if (!target?.managedRuntime) return null;
  if (target.managedRuntime.kind === 'wsl') return await runManagedWslOperation({ target, action: 'Doctor', env });
  const executor = createManagedDevTargetRuntimeExecutor(target, env);
  return await doctorManagedLimaInstance({
    executor,
    instance: target.managedRuntime.instance,
    profileName: target.managedRuntime.profile,
    architecture: target.managedRuntime.architecture,
    resources: resolveManagedRuntimeCapacityResources(target.managedRuntime),
  });
}

export async function applyManagedDevTargetCapacity(
  { target, force = false, env = process.env },
  {
    createExecutor = createManagedDevTargetRuntimeExecutor,
    doctorRuntime = doctorManagedLimaInstance,
    setupRuntime = setupManagedLimaRuntime,
    getRuntimeStatus = getManagedLimaStatus,
    ensureGuestLoginManager = ensureManagedLimaGuestLoginManager,
    installControllerKey = installManagedLimaDevTargetControllerKey,
    reconcileSshPublication = reconcileManagedLimaDevTargetSshPublication,
  } = {},
) {
  const runtime = target?.managedRuntime;
  const resources = resolveManagedRuntimeCapacityResources(runtime);
  if (runtime?.kind === 'wsl') {
    const diagnosis = await runManagedWslOperation({ target, action: 'Doctor', env });
    if (diagnosis.ok) return { changed: false, status: diagnosis.status };
    if (!force) throw new Error('[dev-targets] WSL capacity changes require --force; applying them restarts its Linux guest');
    return { ...await runManagedWslOperation({ target, action: 'Capacity', env }), changed: true };
  }
  if (!runtime || !resources) {
    throw new Error(
      `[dev-targets] target ${String(target?.name ?? 'unknown')} has no configured managed Lima capacity`,
    );
  }
  const executor = createExecutor(target, env);
  const desired = {
    executor,
    instance: runtime.instance,
    profileName: runtime.profile,
    architecture: runtime.architecture,
    resources,
  };
  const diagnosis = await doctorRuntime(desired);
  const requiresReconciliation = diagnosis.exists !== true
    || (diagnosis.drift?.creation?.length ?? 0) > 0
    || (diagnosis.drift?.resources?.length ?? 0) > 0
    || diagnosis.guestToolchain?.ok === false;
  if (!requiresReconciliation) {
    return { changed: false, status: diagnosis.status };
  }
  if (!force) {
    const error = new Error(
      `[dev-targets] target ${target.name} managed Lima VM requires reconciliation; rerun with --force to apply it`,
    );
    error.code = 'MANAGED_LIMA_CAPACITY_FORCE_REQUIRED';
    throw error;
  }
  const [guestProvisionScriptSource, guestPressureScriptSource] = await Promise.all([
    readFile(new URL('../../provision/linux-ubuntu-provision.sh', import.meta.url), 'utf8'),
    readFile(new URL('../../provision/linux-guest-pressure.sh', import.meta.url), 'utf8'),
  ]);
  const lifecycle = await setupRuntime({
    ...desired,
    allowInstall: false,
    guestProvisionScriptSource,
    guestPressureScriptSource,
  });
  const current = await getRuntimeStatus({ executor, instance: runtime.instance });
  if (!current.exists || String(current.status).toLowerCase() !== 'running') {
    throw new Error(`[dev-targets] managed Lima guest is not running after capacity apply: ${String(current.status)}`);
  }
  if (lifecycle.created && runtime.host.kind === 'ssh') {
    await installControllerKey({
      executor,
      instance: runtime.instance,
      guestSshConfigFile: target.sshConfigFile,
    });
  }
  const guestLoginManager = await ensureGuestLoginManager({ executor, instance: runtime.instance });
  const sshPublication = await reconcileSshPublication({
    target,
    sshLocalPort: current.instance?.sshLocalPort ?? current.instance?.SSHLocalPort,
    guestVerified: true,
    env,
  });
  return {
    ...lifecycle,
    changed: true,
    guestLoginManager,
    sshPublication,
  };
}
