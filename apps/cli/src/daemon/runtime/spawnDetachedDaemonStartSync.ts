import { spawn, type ChildProcess, type SpawnOptions } from 'child_process';

import { resolveDaemonLaunchSpec } from './resolveDaemonLaunchSpec';

export async function spawnDetachedDaemonStartSync(options: Readonly<SpawnOptions> = {}): Promise<ChildProcess> {
  const launchSpec = await resolveDaemonLaunchSpec(['daemon', 'start-sync']);
  return spawn(launchSpec.filePath, launchSpec.args, {
    ...options,
    env: launchSpec.env ? { ...(options.env ?? process.env), ...launchSpec.env } : options.env,
    detached: true,
    stdio: 'ignore',
  });
}
