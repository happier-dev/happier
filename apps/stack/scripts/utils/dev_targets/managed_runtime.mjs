import { createManagedLimaHostExecutor } from '../managed_lima/host_executor.mjs';
import { getManagedLimaStatus, startManagedLimaInstance } from '../managed_lima/lifecycle.mjs';
import { doctorManagedLimaInstance } from '../managed_lima/manager.mjs';
import { ensureManagedLimaGuestLoginManager } from '../managed_lima/provisioner.mjs';
import { reconcileManagedLimaDevTargetSshPublication } from './managed_worker.mjs';

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
  } = {},
) {
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
  const executor = createManagedDevTargetRuntimeExecutor(target, env);
  return await doctorManagedLimaInstance({
    executor,
    instance: target.managedRuntime.instance,
    profileName: target.managedRuntime.profile,
    architecture: target.managedRuntime.architecture,
  });
}
