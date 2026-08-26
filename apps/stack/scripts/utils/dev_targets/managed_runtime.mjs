import { createManagedLimaHostExecutor } from '../managed_lima/host_executor.mjs';
import { getManagedLimaStatus, startManagedLimaInstance } from '../managed_lima/lifecycle.mjs';
import { doctorManagedLimaInstance } from '../managed_lima/manager.mjs';
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

export async function startManagedDevTargetRuntime(
  { target, env = process.env },
  {
    createExecutor = createManagedDevTargetRuntimeExecutor,
    startRuntime = startManagedLimaInstance,
    getRuntimeStatus = getManagedLimaStatus,
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
  const sshPublication = await reconcileSshPublication({
    target,
    sshLocalPort: current.instance?.sshLocalPort ?? current.instance?.SSHLocalPort,
    env,
  });
  return { ...lifecycle, sshPublication };
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
