import {
  CODEX_ACP_DEP_ID,
  GH_INSTALLABLE_DESCRIPTOR,
  INSTALLABLE_KEYS,
  InstallableDependencyDescriptorSchema,
  resolveInstallablesRegistry,
  type InstallableDependencyDescriptor,
} from '@happier-dev/protocol/installables';
import { describe, expect, it, vi } from 'vitest';

import { createCapabilitiesService } from '@/capabilities/service';
import { checklists } from '../checklists';
import type {
  RuntimeInstallableAdapter,
  RuntimeInstallableCapabilityStatusParams,
  RuntimeInstallableInstallResult,
  RuntimeInstallableLaunchResolution,
} from '@/packagedRuntime/installables/registry';

import {
  createInstallableCapabilities,
  createInstallableCapabilityRequests,
  type RuntimeInstallableAdapterResolver,
} from './installables';

const codexAcpInstallableDescriptor = InstallableDependencyDescriptorSchema.parse({
  id: INSTALLABLE_KEYS.CODEX_ACP,
  key: INSTALLABLE_KEYS.CODEX_ACP,
  kind: 'dep',
  version: '1',
  capabilityId: CODEX_ACP_DEP_ID,
  display: {
    name: 'Codex ACP',
  },
  description: 'Codex ACP dependency test fixture',
  source: {
    kind: 'github_release_binary',
    repo: 'zed-industries/codex-acp',
    distTag: 'latest',
  },
  binary: {
    commands: ['codex-acp'],
    systemFirst: true,
    managedFallback: true,
  },
  defaultPolicy: {
    autoInstallWhenNeeded: true,
    autoUpdateMode: 'auto',
  },
  consent: {
    install: 'not_required',
    update: 'not_required',
  },
  stability: {
    experimental: true,
    supported: true,
  },
});

function createRegistry(descriptors: readonly InstallableDependencyDescriptor[]) {
  return resolveInstallablesRegistry({
    builtIns: descriptors.map((descriptor) => ({
      owner: {
        provenance: 'built_in' as const,
        ownerId: 'test',
      },
      descriptor,
    })),
  });
}

const unavailableLaunchResolution: RuntimeInstallableLaunchResolution = {
  availability: { ok: false, errorMessage: 'not installed' },
  canAutoInstall: true,
  canBackgroundAutoUpdate: false,
};

function createAdapter(params: Readonly<{
  descriptor?: InstallableDependencyDescriptor;
  detectCapabilityStatus?: RuntimeInstallableAdapter['detectCapabilityStatus'];
  installOrUpgrade?: RuntimeInstallableAdapter['installOrUpgrade'];
}> = {}): RuntimeInstallableAdapter {
  const descriptor = params.descriptor ?? codexAcpInstallableDescriptor;
  return {
    key: descriptor.key,
    capabilityId: descriptor.capabilityId,
    ...(params.detectCapabilityStatus ? { detectCapabilityStatus: params.detectCapabilityStatus } : {}),
    detectLaunchResolution: async () => unavailableLaunchResolution,
    installOrUpgrade: params.installOrUpgrade ?? (async () => ({ ok: true, logPath: '/tmp/install.log' })),
    runBackgroundAutoUpdateCheck: async () => undefined,
  };
}

describe('installable capability projection', () => {
  it('projects descriptor metadata and routes detect/install/upgrade through the runtime adapter', async () => {
    const registry = createRegistry([codexAcpInstallableDescriptor]);
    const detectedStatus = Object.freeze({ installed: true, sourceKind: 'github_release_binary' });
    const detectCapabilityStatus = vi.fn(
      async (_params?: RuntimeInstallableCapabilityStatusParams) => detectedStatus,
    );
    const installOrUpgrade = vi.fn<() => Promise<RuntimeInstallableInstallResult>>(
      async () => ({ ok: true, logPath: '/tmp/codex-acp.log' }),
    );
    const resolveAdapter: RuntimeInstallableAdapterResolver = async (key, opts) => {
      expect(key).toBe(codexAcpInstallableDescriptor.key);
      expect(opts?.installablesRegistry).toBe(registry);
      return createAdapter({
        detectCapabilityStatus,
        installOrUpgrade,
      });
    };

    const capabilities = await createInstallableCapabilities({
      installablesRegistry: registry,
      getRuntimeInstallableAdapter: resolveAdapter,
    });

    expect(capabilities).toHaveLength(1);
    const capability = capabilities[0]!;
    expect(capability.descriptor).toMatchObject({
      id: 'dep.codex-acp',
      kind: 'dep',
      title: 'Codex ACP',
      methods: {
        install: { title: 'Install' },
        upgrade: { title: 'Upgrade' },
      },
    });

    await expect(capability.detect({
      request: {
        id: 'dep.codex-acp',
        params: {
          includeLatestVersion: true,
          onlyIfInstalled: true,
        },
      },
      context: { cliSnapshot: null },
    })).resolves.toBe(detectedStatus);
    expect(detectCapabilityStatus).toHaveBeenCalledWith({
      includeLatestVersion: true,
      onlyIfInstalled: true,
    });

    await expect(capability.invoke?.({ method: 'install' })).resolves.toEqual({
      ok: true,
      result: { logPath: '/tmp/codex-acp.log' },
    });
    await expect(capability.invoke?.({ method: 'upgrade' })).resolves.toEqual({
      ok: true,
      result: { logPath: '/tmp/codex-acp.log' },
    });
    expect(installOrUpgrade).toHaveBeenCalledTimes(2);
  });

  it('returns the existing unsupported-method public error shape for unknown installable methods', async () => {
    const registry = createRegistry([codexAcpInstallableDescriptor]);
    const capabilities = await createInstallableCapabilities({
      installablesRegistry: registry,
      getRuntimeInstallableAdapter: async () => createAdapter(),
    });
    const service = createCapabilitiesService({
      capabilities,
      checklists,
      buildContext: async () => ({ cliSnapshot: null }),
    });

    await expect(service.invoke({
      id: 'dep.codex-acp',
      method: 'remove',
    })).resolves.toEqual({
      ok: false,
      error: {
        message: 'Unsupported method: remove',
        code: 'unsupported-method',
      },
    });
  });

  it('does not duplicate capabilities already owned by explicit registries', async () => {
    const registry = createRegistry([GH_INSTALLABLE_DESCRIPTOR]);
    const resolveAdapter = vi.fn<RuntimeInstallableAdapterResolver>(
      async () => createAdapter({ descriptor: GH_INSTALLABLE_DESCRIPTOR }),
    );

    const capabilities = await createInstallableCapabilities({
      installablesRegistry: registry,
      existingCapabilityIds: new Set(['dep.gh']),
      getRuntimeInstallableAdapter: resolveAdapter,
    });

    expect(capabilities).toEqual([]);
    expect(resolveAdapter).not.toHaveBeenCalled();
  });

  it('fails closed when the runtime adapter does not match the descriptor capability id', async () => {
    const registry = createRegistry([codexAcpInstallableDescriptor]);
    const mismatchedAdapter: RuntimeInstallableAdapter = {
      ...createAdapter(),
      capabilityId: 'dep.other-tool',
    };

    await expect(createInstallableCapabilities({
      installablesRegistry: registry,
      getRuntimeInstallableAdapter: async () => mismatchedAdapter,
    })).resolves.toEqual([]);
  });

  it('builds detect requests from installable descriptors', () => {
    const registry = createRegistry([codexAcpInstallableDescriptor, GH_INSTALLABLE_DESCRIPTOR]);

    expect(createInstallableCapabilityRequests(registry)).toEqual([
      { id: 'dep.codex-acp' },
      { id: 'dep.gh' },
    ]);
  });
});
