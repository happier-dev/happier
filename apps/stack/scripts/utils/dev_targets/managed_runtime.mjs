import { createManagedLimaHostExecutor } from '../managed_lima/host_executor.mjs';
import { startManagedLimaInstance } from '../managed_lima/lifecycle.mjs';
import { doctorManagedLimaInstance } from '../managed_lima/manager.mjs';

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

export async function startManagedDevTargetRuntime({ target, env = process.env }) {
  if (!target?.managedRuntime) return { changed: false, status: 'Unmanaged' };
  const executor = createManagedDevTargetRuntimeExecutor(target, env);
  return await startManagedLimaInstance({
    executor,
    instance: target.managedRuntime.instance,
  });
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
