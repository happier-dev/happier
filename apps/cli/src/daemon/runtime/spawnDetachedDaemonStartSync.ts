import { spawn, type ChildProcess, type SpawnOptions } from 'child_process';

import { getReleaseRingCatalogEntry } from '@happier-dev/release-runtime/releaseRings';
import { configuration } from '@/configuration';
import { resolveDaemonLaunchSpec } from './resolveDaemonLaunchSpec';

export async function spawnDetachedDaemonStartSync(options: Readonly<SpawnOptions> = {}): Promise<ChildProcess> {
  const launchSpec = await resolveDaemonLaunchSpec(['daemon', 'start-sync']);
  const env = {
    ...(options.env ?? process.env),
    ...(launchSpec.env ?? {}),
  };

  // Detached daemon is typically spawned via `node <entry> daemon start-sync`, so argv no longer encodes
  // the shim name (`hprev`/`hdev`). Force the lane into the child environment so daemon state files are
  // scoped per public release channel.
  if (!String(env.HAPPIER_PUBLIC_RELEASE_CHANNEL ?? '').trim()) {
    env.HAPPIER_PUBLIC_RELEASE_CHANNEL = getReleaseRingCatalogEntry(configuration.publicReleaseRing).publicLabel;
  }
  return spawn(launchSpec.filePath, launchSpec.args, {
    ...options,
    env,
    detached: true,
    stdio: 'ignore',
  });
}
