import { resolveDaemonServiceCliRuntimeFromEnv, resolveDaemonServiceInventoryEntries } from '@/daemon/service/cli';

import { getReleaseRingCatalogEntry } from '@happier-dev/release-runtime/releaseRings';
import type { DoctorSnapshot } from '@happier-dev/protocol';

type HappierServices = NonNullable<NonNullable<DoctorSnapshot['services']>['happier']>;
type HappierService = HappierServices['services'][number];

function resolveBackend(params: Readonly<{
  platform: HappierService['platform'];
  scope: HappierService['scope'];
}>): HappierService['backend'] {
  if (params.platform === 'darwin') {
    return 'launchd';
  }
  if (params.platform === 'linux') {
    return params.scope === 'system' ? 'systemd-system' : 'systemd-user';
  }
  return params.scope === 'system' ? 'schtasks-system' : 'schtasks-user';
}

export async function readDoctorServices(): Promise<HappierServices> {
  const runtime = resolveDaemonServiceCliRuntimeFromEnv({
    mode: 'user',
  });
  const services = await resolveDaemonServiceInventoryEntries({
    runtime,
    includeAllModes: runtime.platform === 'linux',
  });

  return {
    services: services.map((service) => {
      const scope = service.mode === 'system' ? 'system' : 'user';
      return {
        id: service.path,
        serviceType: service.serviceType,
        platform: service.platform,
        backend: resolveBackend({
          platform: service.platform,
          scope,
        }),
        label: service.label,
        verification: service.installed ? 'verified' : 'candidate',
        targetMode: service.targetMode,
        ring: getReleaseRingCatalogEntry(service.ring).publicLabel,
        instanceId: String(service.serverId ?? '').trim() || null,
        scope,
        definitionPath: service.path,
        executablePath: null,
        serverUrl: null,
        publicServerUrl: null,
        installed: service.installed,
        running: service.running,
        configuredCliVersion: service.configuredCliVersion,
        runningCliVersion: service.runningCliVersion,
      };
    }),
  };
}
