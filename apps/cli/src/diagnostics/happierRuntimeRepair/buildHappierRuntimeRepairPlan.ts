import type { DoctorSnapshot } from '@/ui/doctorSnapshot';
import { isHappierRuntimePathWithinRoot, normalizeHappierRuntimePath } from '@happier-dev/cli-common/happierRuntime';

import type { HappierRuntimeRepairAction, HappierRuntimeRepairPlan } from './types';

function buildUninstallDaemonServicesCommand(params: Readonly<{
  services: Array<{
    ring: string | null;
    instanceId: string | null;
  }>;
}>): string {
  if (params.services.length !== 1) {
    return 'happier doctor repair --yes';
  }

  const service = params.services[0];
  if (!service) return 'happier doctor repair --yes';
  if (!service.ring || !service.instanceId) {
    return 'happier doctor repair --yes';
  }

  return `happier daemon service uninstall --ring ${service.ring} --instance ${service.instanceId} --yes`;
}

export function buildHappierRuntimeRepairPlan(snapshot: DoctorSnapshot): HappierRuntimeRepairPlan {
  const actions: HappierRuntimeRepairAction[] = [];
  const installations = snapshot.installations?.happier?.installations ?? [];
  const services = snapshot.services?.happier?.services ?? [];
  const warnings = snapshot.warnings ?? [];

  const daemonStartedWithVersion = String(snapshot.daemonStatus?.daemon?.startedWithCliVersion ?? '').trim();
  const activeVersion = String(snapshot.installations?.happier?.activeInvocation?.version ?? '').trim();
  if (daemonStartedWithVersion && activeVersion && daemonStartedWithVersion !== activeVersion) {
    actions.push({
      kind: 'restart-daemon',
      command: 'happier daemon restart',
    });
  }

  const installationRoots = installations
    .filter((entry) => entry.components.includes('happier-cli') || entry.components.includes('happier-daemon'))
    .flatMap((entry) => [entry.path, entry.realPath].map(normalizeHappierRuntimePath).filter(Boolean));

  const orphanServices = services
    .filter((service) => service.serviceType === 'daemon' && service.verification === 'verified')
    .filter((service) => {
      const executablePath = normalizeHappierRuntimePath(service.executablePath);
      if (!executablePath) return false;
      return !installationRoots.some((root) => isHappierRuntimePathWithinRoot(executablePath, root));
    })
    .map((service) => ({
      id: service.id,
      label: service.label,
      platform: service.platform,
      backend: service.backend,
      scope: service.scope,
      ring: service.ring ?? null,
      instanceId: service.instanceId ?? null,
    }));

  if (orphanServices.length > 0) {
    actions.push({
      kind: 'uninstall-daemon-services',
      command: buildUninstallDaemonServicesCommand({ services: orphanServices }),
      services: orphanServices,
    });
  }

  return {
    actions,
    manualWarnings: warnings.filter((warning) => warning.code !== 'DAEMON_STARTED_WITH_DIFFERENT_CLI' && warning.code !== 'ORPHAN_DAEMON_SERVICE'),
  };
}
