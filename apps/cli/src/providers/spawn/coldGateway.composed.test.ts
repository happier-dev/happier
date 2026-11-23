import { access } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { resolveAgentCliOverrideEnvKey } from '@happier-dev/cli-common/agents/resolution';
import {
  accountSettingsParse, DEFAULT_PROVIDER_SETTINGS_V1, ProviderConnectionIdSchema, ProviderSettingsV1Schema,
  buildBackendTargetKeyV2,
} from '@happier-dev/protocol';
import { splitProviderSettingsV1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { prepareDaemonProviderLaunch } from '@/daemon/spawn/prepareDaemonProviderLaunch';
import { resolveRunnerAgentSessionDescriptorForLease } from '@/daemon/spawn/prepareAgentRuntimeSessionBridge';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { writeExecutableShim } from '@/testkit/fs/executableShim';
import { createProviderLaunchResourceScope } from '../lifecycle/resourceScope';
import { resolveProviderConnectionForMachine } from '../registry';
import { createProviderRuntimeStateStore } from '../runtimeState';

it('admits the first Claude launch on a granted Session Machine with no Gateway runtime observation', async () => {
  const pluginIds = ['happier.agent.claude', 'happier.agent.muse', 'happier.provider.cliproxyapi'];
  const runtime = await createAdmittedPluginRuntimeFixture({ runtimeOptions: { pluginIds } });
  const scope = createProviderLaunchResourceScope();
  try {
    const machineId = 'fresh-machine';
    const connectionId = ProviderConnectionIdSchema.parse('main-gateway');
    const contributionKey = 'happier.provider.cliproxyapi/cliproxyapi';
    const providersByContributionKey = runtime.registry.contributes.providersByContributionKey ?? new Map();
    const registry = { providersByContributionKey };
    const provider = providersByContributionKey.get(contributionKey);
    if (!provider) throw new Error('Expected bundled Gateway declaration');
    const family = provider.definition.connectedAccounts?.find(candidate => candidate.purpose === 'meta-upstream');
    if (!family || typeof family.service === 'string') throw new Error('Expected qualified Muse family');
    const account = { service: family.service, accountId: 'fixture-muse-account' };
    const settings = ProviderSettingsV1Schema.parse({
      ...DEFAULT_PROVIDER_SETTINGS_V1,
      connections: [{
        v: 1 as const, id: connectionId, role: 'default' as const, displayName: 'Main gateway',
        displayNameMode: 'automatic' as const, revision: 1, createdAt: 1, updatedAt: 1,
        source: { kind: 'contribution' as const, contributionKey },
        deployment: { kind: 'managedLocal' as const },
        gatewayPlacement: { kind: 'sessionMachine' as const },
        purposeBindingDefaults: { [family.purpose]: { kind: 'account' as const, account } },
      }],
    });
    const resolved = resolveProviderConnectionForMachine({
      connectionId, machineId, providerSettings: settings, registry, dnsEvidenceByEndpointUrl: new Map(),
    });
    if (resolved.status !== 'resolved') throw new Error('Expected configured Gateway');
    const { connectionSecurityFingerprint, endpointSetFingerprint } = resolved.record;
    const granted = ProviderSettingsV1Schema.parse({
      ...settings,
      accountGrants: [{ v: 1, connectionId, confirmedAt: 1, connectionSecurityFingerprint }],
      machineGrants: [{ v: 1, connectionId, machineId, confirmedAt: 1, connectionSecurityFingerprint, endpointSetFingerprint }],
    });
    const snapshot = {
      source: 'network' as const, scopeKey: 'account-gateway-fixture',
      settings: accountSettingsParse({ providerSettingsV1: granted }), settingsVersion: 1, loadedAtMs: 1,
      settingsSecretsReadKeys: [], providerConnectionsCatalog: {
        status: 'ready' as const, revision: 1, catalog: splitProviderSettingsV1(granted).catalog,
      },
    };
    const agentId = 'claude';
    const backendTarget = { kind: 'backend', backendId: agentId, sourceKind: 'built_in' } as const;
    const agentTargetKey = buildBackendTargetKeyV2(backendTarget);
    const selection = { v: 1 as const, updatedAt: 1, ref: {
      providerConnectionId: connectionId, agentTargetKey, modelId: 'muse-spark-1.3-contributor',
    } };
    const executable = await writeExecutableShim({
      dir: runtime.happyHomeDir,
      fileName: process.platform === 'win32' ? 'claude.cmd' : 'claude',
      contents: process.platform === 'win32' ? '@echo off\r\necho 2.1.200\r\n' : '#!/bin/sh\necho 2.1.200\n',
    });
    const store = createProviderRuntimeStateStore({ happyHomeDir: runtime.happyHomeDir, machineId });
    await expect(access(store.path)).rejects.toMatchObject({ code: 'ENOENT' });
    const prepared = await prepareDaemonProviderLaunch({
      options: { directory: runtime.happyHomeDir, backendTarget, machineId, sessionConfigOptionOverrides: {
        v: 1, updatedAt: 1, overrides: { reasoning_effort: { value: 'low', updatedAt: 1 } },
      } },
      effectiveBackendTarget: backendTarget, catalogAgentId: agentId, modelSelection: selection,
      profileEnvironmentVariables: {}, daemonSpawnHooks: null, persistedProviderBinding: null,
      normalizedExistingSessionId: '', providerRuntimeHomeDir: runtime.happyHomeDir,
      processEnv: { [resolveAgentCliOverrideEnvKey(agentId)]: executable },
      accountSettingsSnapshot: snapshot, resolveProvidersFeatureEnabled: () => true,
      resolveManagedPurposeBindingIntent: async ({ purpose, target }) => ({ purpose, target }),
      pluginRuntimeLease: { currentRegistry: runtime.registry, acquire: async () => runtime.lease, release: async () => {} },
      launchResourceScope: scope,
    });
    expect(prepared.ok ? prepared.attempt?.authorization.sessionBindingMetadata : prepared.result).toMatchObject({
      connectionId, protocol: 'anthropic', model: { id: selection.ref.modelId },
    });
    await expect(resolveRunnerAgentSessionDescriptorForLease({ lease: runtime.lease, target: backendTarget }))
      .resolves.toMatchObject({ agentId });
  } finally {
    await scope.release();
    await runtime.dispose();
  }
});
