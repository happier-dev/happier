import { ManagedDependencyDescriptorSchema } from '@happier-dev/plugin-sdk/experimental/managedDependencies';

export const ANTIGRAVITY_LOCALHARNESS_INSTALLABLE_KEY = 'dep.antigravity.localharness';
export const ANTIGRAVITY_LOCALHARNESS_COMMAND = 'localharness';

export const ANTIGRAVITY_LOCALHARNESS_INSTALLABLE_DESCRIPTOR = ManagedDependencyDescriptorSchema.parse({
  id: ANTIGRAVITY_LOCALHARNESS_INSTALLABLE_KEY,
  key: ANTIGRAVITY_LOCALHARNESS_INSTALLABLE_KEY,
  kind: 'dep',
  version: '1',
  capabilityId: ANTIGRAVITY_LOCALHARNESS_INSTALLABLE_KEY,
  display: {
    name: 'Antigravity localharness',
    subtitle: 'Structured Antigravity local runtime',
  },
  description: 'Google Antigravity localharness executable extracted from the google-antigravity PyPI wheel.',
  source: {
    kind: 'managed_pypi_wheel_asset',
    distribution: 'google-antigravity',
    versionSpecifier: '>=0.1.4,<0.2.0',
    assetPathByPlatform: {
      'darwin-arm64': 'google/antigravity/bin/localharness',
      'linux-x64': 'google/antigravity/bin/localharness',
      'linux-arm64': 'google/antigravity/bin/localharness',
      'win32-x64': 'google/antigravity/bin/localharness.exe',
      'win32-arm64': 'google/antigravity/bin/localharness.exe',
    },
    executable: true,
    compatibilityProbe: 'antigravity-localharness-v1',
    installConsent: 'host_managed_required',
    autoUpdateMode: 'notify',
    trustedPublisher: 'Google',
  },
  binary: {
    commands: [ANTIGRAVITY_LOCALHARNESS_COMMAND],
    systemFirst: false,
    managedFallback: true,
  },
  defaultPolicy: {
    autoInstallWhenNeeded: true,
    autoUpdateMode: 'notify',
  },
  consent: {
    install: 'required',
    update: 'required',
    commandsPreviewRequired: true,
  },
  stability: {
    experimental: true,
    supported: true,
  },
});
