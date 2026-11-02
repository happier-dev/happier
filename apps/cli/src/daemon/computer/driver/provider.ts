import {
  COMPUTER_PROVIDER_INSTALLABLE_KEYS, DEFAULT_COMPUTER_USE_SETTINGS_V1,
  type ComputerProviderIdV1, type ComputerUseSettingsV1,
} from '@happier-dev/protocol/computer/v1';
import { BUILT_IN_INSTALLABLES_REGISTRY } from '@happier-dev/protocol/installables';

import { getArchiveDownloadInstallableAdapter } from '../../../packagedRuntime/installables/registry';
import { ComputerDriverError } from './nativeTransport';

export class ComputerProviderUnavailableError extends ComputerDriverError {
  readonly installableKey;
  readonly capabilityId;
  constructor(readonly provider: ComputerProviderIdV1) {
    super('computer_provider_unavailable', `Enable and install ${provider} on this Machine through machines.capabilities.install (${COMPUTER_PROVIDER_INSTALLABLE_KEYS[provider]}).`);
    this.installableKey = COMPUTER_PROVIDER_INSTALLABLE_KEYS[provider];
    this.capabilityId = BUILT_IN_INSTALLABLES_REGISTRY.descriptorsByKey[this.installableKey].descriptor.capabilityId;
  }
}

/** One admission owner; an explicitly unavailable provider never silently changes executor. */
export function resolveComputerProviderId(params: Readonly<{
  provider?: ComputerProviderIdV1; settings?: ComputerUseSettingsV1;
}> = {}): ComputerProviderIdV1 {
  return params.provider ?? params.settings?.defaultProvider ?? DEFAULT_COMPUTER_USE_SETTINGS_V1.defaultProvider;
}

export async function resolveComputerProvider(params: Readonly<{
  provider?: ComputerProviderIdV1; settings?: ComputerUseSettingsV1; executablePath?: string;
}> = {}): Promise<Readonly<{ provider: ComputerProviderIdV1; executablePath: string }>> {
  const settings = params.settings ?? DEFAULT_COMPUTER_USE_SETTINGS_V1;
  const provider = resolveComputerProviderId(params);
  if (!settings.enabledProviders.includes(provider)) throw new ComputerProviderUnavailableError(provider);
  const executablePath = params.executablePath
    ?? await getArchiveDownloadInstallableAdapter(COMPUTER_PROVIDER_INSTALLABLE_KEYS[provider])?.resolveInstalledExecutable();
  if (!executablePath) throw new ComputerProviderUnavailableError(provider);
  return { provider, executablePath };
}
