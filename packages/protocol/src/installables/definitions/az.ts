import type { CapabilityId } from '../../capabilities/index.js';
import { InstallableDependencyDescriptorSchema } from '../descriptor.js';

export const AZ_INSTALLABLE_KEY = 'az' as const;
export const AZ_DEP_ID = 'dep.az' as const satisfies CapabilityId;
export const AZ_BINARY_NAME = 'az' as const;
export const AZ_CLI_SETUP_URL = 'https://learn.microsoft.com/cli/azure/install-azure-cli' as const;

export const AZ_INSTALLABLE_DESCRIPTOR = InstallableDependencyDescriptorSchema.parse({
  id: AZ_INSTALLABLE_KEY,
  key: AZ_INSTALLABLE_KEY,
  kind: 'dep',
  version: '1',
  capabilityId: AZ_DEP_ID,
  display: {
    name: 'Azure CLI',
    subtitle: 'Optional dependency for Azure DevOps source-control workflows',
  },
  description: 'Azure CLI dependency used by Azure DevOps source-control provider adapters.',
  source: {
    kind: 'manual_only',
    setupUrl: AZ_CLI_SETUP_URL,
  },
  binary: {
    commands: [AZ_BINARY_NAME],
    systemFirst: true,
    managedFallback: false,
  },
  defaultPolicy: {
    autoInstallWhenNeeded: false,
    autoUpdateMode: 'notify',
  },
  consent: {
    install: 'required',
    update: 'required',
  },
  ui: {
    setupUrl: AZ_CLI_SETUP_URL,
    iconName: 'cloud-outline',
  },
  stability: {
    experimental: false,
    supported: true,
  },
});
