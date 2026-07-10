import { describe, expect, it } from 'vitest';

import { InstallableDependencyDescriptorSchema } from './descriptor.js';
import { resolveEffectiveInstallablePolicy } from './policy.js';

function managedPypiDescriptor(overrides: Readonly<{
  source?: Partial<Extract<ReturnType<typeof InstallableDependencyDescriptorSchema.parse>['source'], { kind: 'managed_pypi_wheel_asset' }>>;
  defaultPolicy?: Partial<ReturnType<typeof InstallableDependencyDescriptorSchema.parse>['defaultPolicy']>;
  consent?: Partial<ReturnType<typeof InstallableDependencyDescriptorSchema.parse>['consent']>;
}> = {}) {
  return InstallableDependencyDescriptorSchema.parse({
    id: 'pypi-wheel-tool',
    key: 'pypi-wheel-tool',
    kind: 'dep',
    version: '1',
    capabilityId: 'dep.pypi-wheel-tool',
    display: {
      name: 'PyPI Wheel Tool',
    },
    description: 'Runtime tool contributed through a PyPI wheel asset',
    source: {
      kind: 'managed_pypi_wheel_asset',
      distribution: 'google-antigravity',
      versionSpecifier: '>=0.1.3,<0.2.0',
      assetPathByPlatform: {
        'darwin-arm64': 'google/antigravity/bin/localharness',
      },
      executable: true,
      installConsent: 'host_managed_required',
      autoUpdateMode: 'auto',
      ...overrides.source,
    },
    binary: {
      commands: ['localharness'],
      systemFirst: false,
      managedFallback: true,
    },
    defaultPolicy: {
      autoInstallWhenNeeded: true,
      autoUpdateMode: 'auto',
      ...overrides.defaultPolicy,
    },
    consent: {
      install: 'not_required',
      update: 'not_required',
      ...overrides.consent,
    },
  });
}

describe('resolveEffectiveInstallablePolicy', () => {
  it('requires host-managed first-install consent for managed PyPI wheel assets even when descriptor consent is not_required', () => {
    expect(resolveEffectiveInstallablePolicy({
      settings: {},
      machineId: 'machine-1',
      descriptor: managedPypiDescriptor(),
    })).toEqual({
      autoInstallWhenNeeded: false,
      autoUpdateMode: 'auto',
    });
  });

  it('caps managed PyPI wheel asset background updates at source autoUpdateMode', () => {
    expect(resolveEffectiveInstallablePolicy({
      settings: {
        installablesPolicyByMachineId: {
          'machine-1': {
            'pypi-wheel-tool': { autoUpdateMode: 'auto' },
          },
        },
      },
      machineId: 'machine-1',
      descriptor: managedPypiDescriptor({
        source: { autoUpdateMode: 'off' },
        defaultPolicy: { autoUpdateMode: 'auto' },
      }),
    })).toEqual({
      autoInstallWhenNeeded: false,
      autoUpdateMode: 'off',
    });
  });
});
