import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { PluginError } from '@happier-dev/plugin-sdk';
import { DaemonProviderProbeResponseV1Schema } from '@happier-dev/protocol/rpc/providers';
import { withConfiguredDaemonTestHome } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { createDaemonConnectedAccountPurposeBindingRuntime } from '@/daemon/connectedServices/purposeBindings/createDaemonConnectedAccountPurposeBindingRuntime';
import { createPluginReloadController } from '@/plugins/runtime/reload/controller';
import { createManagedRunLaunchFixture } from '@/providers/lifecycle/managedRunLaunch.testkit';
import { createRuntimeProviderServices } from './runtimeServices';
import { createProviderManagedCatalogRuntimePort } from './managedRuntime';
import { createMachineSharedProviderGatewayResolver } from '@/daemon/machine/bootstrapMachineSyncRuntime';

it.each(['registry', 'gateway'] as const)('retains the %s acquisition cause through a managed catalog probe and cleanup', async boundary => {
  await withConfiguredDaemonTestHome({ prefix: 'managed-probe-acquisition-cause-' }, async ({ homeDir }) => {
    const controller = createPluginReloadController();
    const fixture = await createManagedRunLaunchFixture({ directory: join(homeDir, 'fixture'), happyHomeDir: homeDir,
      controller, probeCatalog: true });
    const failureCause = { phase: 'providers.gateway.acquire', errorClass: 'Error' as const,
      errorCode: 'provider_contribution_unavailable', httpStatus: null };
    const fail = (): never => { throw new PluginError({ code: 'plugin_service_unavailable',
      message: 'private-acquisition-diagnostic', failureCause }); };
    try {
      const unavailable = async (): Promise<never> => { throw new Error('Probe must not acquire Account material'); };
      const purposeRuntime = createDaemonConnectedAccountPurposeBindingRuntime({ reloadController: controller,
        resolveQualifiedConnectedAccountV4Support: () => 'advertised',
        establishedRuntimeOwner: { invokeWithReceipt: unavailable, invokeDirectMaterial: unavailable },
      });
      const services = createRuntimeProviderServices({ machineId: fixture.machineId, happyHomeDir: homeDir,
        registry: fixture.contributes, featureGate: { isEnabled: () => true }, getAccountSettingsSnapshot: () => fixture.snapshot,
        resolveManagedPurposeBindingIntent: purposeRuntime.resolveBindingIntent,
        managedCatalogRuntime: createProviderManagedCatalogRuntimePort({ happyHomeDir: homeDir,
          resolveSharedGateway: async () => fail(),
          acquireRegistryLease: async () => {
            if (boundary === 'registry') fail();
            const lease = controller.tryAcquireRuntimeRegistry();
            if (!lease) throw new Error('Expected installed Provider registry');
            return { ...lease, release: async () => { await lease.release(); throw new Error('secondary-cleanup-diagnostic'); } };
          },
        }),
      });
      const result = DaemonProviderProbeResponseV1Schema.parse(await services.probe({
        connectionId: fixture.record.connectionId, machineId: fixture.machineId,
      }));
      expect(result).toMatchObject({ status: 'error', error: { code: 'provider_endpoint_unavailable', failureCause } });
      expect(JSON.stringify(result)).not.toMatch(/private-acquisition-diagnostic|secondary-cleanup-diagnostic/);
    } finally { await fixture.cleanup(); }
  });
});

it('retains request-auth filesystem failure through the real registry activation', async () => {
  await withConfiguredDaemonTestHome({ prefix: 'managed-probe-request-auth-cause-' }, async ({ homeDir }) => {
    const directory = join(homeDir, 'fixture');
    const fixture = await createManagedRunLaunchFixture({ directory, happyHomeDir: homeDir,
      controller: createPluginReloadController(), physicalGateway: true, probeCatalog: true });
    try {
      await writeFile(join(directory, 'request-auth'), 'The required directory is occupied by a file.');
      const resolveSharedGateway = createMachineSharedProviderGatewayResolver({ machineId: fixture.machineId,
        readAccountId: () => 'account', readOrigin: async () => ({ serverIdentityId: 'home', machineId: fixture.machineId }) });
      const services = createRuntimeProviderServices({ machineId: fixture.machineId, happyHomeDir: homeDir,
        registry: fixture.contributes, featureGate: { isEnabled: () => true }, getAccountSettingsSnapshot: () => fixture.snapshot,
        resolveManagedPurposeBindingIntent: fixture.gateway!.purposeBindingOwner.resolveBindingIntent,
        resolveSharedGateway,
        managedCatalogRuntime: createProviderManagedCatalogRuntimePort({ happyHomeDir: homeDir, resolveSharedGateway,
          acquireRegistryLease: async () => {
            const lease = fixture.gateway!.controller.tryAcquireRuntimeRegistry();
            if (!lease) throw new Error('Expected Gateway registry');
            return lease;
          } }),
      });
      const result = DaemonProviderProbeResponseV1Schema.parse(await services.probe({
        connectionId: fixture.record.connectionId, machineId: fixture.machineId,
      }));
      expect(result).toMatchObject({ status: 'error', error: { code: 'provider_endpoint_unavailable', failureCause: {
        phase: 'providers.catalog.acquire_services', errorClass: 'Error', errorCode: 'EEXIST', httpStatus: null,
      } } });
      expect(JSON.stringify(result)).not.toContain(directory);
    } finally { await fixture.cleanup(); }
  });
});
