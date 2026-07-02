import type { InstallableDependencyDescriptor } from '@happier-dev/protocol/installables';

import { CapabilityError } from '../errors';
import type { Capability } from '../service';
import type { CapabilitiesInvokeResponse } from '../types';
import type {
  RuntimeInstallableAdapter,
  RuntimeInstallableCapabilityStatusParams,
  RuntimeInstallableInstallResult,
} from '@/packagedRuntime/installables/registry';

const INSTALLABLE_CAPABILITY_METHODS = Object.freeze({
  install: { title: 'Install' },
  upgrade: { title: 'Upgrade' },
});

function readStatusParams(params: Record<string, unknown> | undefined): RuntimeInstallableCapabilityStatusParams {
  return {
    includeLatestVersion: params?.includeLatestVersion === true,
    onlyIfInstalled: params?.onlyIfInstalled === true,
  };
}

function mapInstallResult(result: RuntimeInstallableInstallResult): CapabilitiesInvokeResponse {
  if (result.ok) {
    return { ok: true, result: { logPath: result.logPath } };
  }

  return {
    ok: false,
    error: { message: result.errorMessage, code: 'install-failed' },
    ...(result.logPath ? { logPath: result.logPath } : {}),
  };
}

export function createInstallableCapability(
  descriptor: InstallableDependencyDescriptor,
  adapter: RuntimeInstallableAdapter,
): Capability {
  return {
    descriptor: {
      id: descriptor.capabilityId,
      kind: 'dep',
      title: descriptor.display.name,
      methods: INSTALLABLE_CAPABILITY_METHODS,
    },
    detect: async ({ request }) => {
      const statusParams = readStatusParams(request.params);
      if (adapter.detectCapabilityStatus) {
        return adapter.detectCapabilityStatus(statusParams);
      }

      const launchResolution = await adapter.detectLaunchResolution();
      return {
        installed: launchResolution.availability.ok,
        sourceKind: descriptor.source.kind,
        canAutoInstall: launchResolution.canAutoInstall,
        canBackgroundAutoUpdate: launchResolution.canBackgroundAutoUpdate,
        ...(!launchResolution.availability.ok
          ? { errorMessage: launchResolution.availability.errorMessage }
          : {}),
      };
    },
    invoke: async ({ method }) => {
      if (method !== 'install' && method !== 'upgrade') {
        throw new CapabilityError(`Unsupported method: ${method}`, 'unsupported-method');
      }
      return mapInstallResult(await adapter.installOrUpgrade());
    },
  };
}
