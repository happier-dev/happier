import { describe, expect, it } from 'vitest';

import type { Credentials } from '@/persistence';
import { resolveBuiltInContributions } from '../../../plugins/projection/registry/resolveBuiltInContributions';
import type { ResolvedContributionRegistry } from '../../../plugins/projection/registry/types';
import { resolveBackendEngineAdapterResolution } from './engineRegistry';

const PI_BACKEND_ID = 'pi';
const PI_PLUGIN_ID = 'happier.agent.pi';

type RuntimeCapabilitiesCarrier = Readonly<{
  runtimeCapabilities?: unknown;
}>;

function createPiOnlyContributionRegistry(): ResolvedContributionRegistry {
  const builtInContributions = resolveBuiltInContributions();
  const provider = builtInContributions.providers.find((entry) => entry.id === PI_BACKEND_ID);
  const backend = builtInContributions.backends.find((entry) => entry.id === PI_BACKEND_ID);
  const activationTargets = builtInContributions.activationTargets?.filter((target) => target.pluginId === PI_PLUGIN_ID) ?? [];

  if (!provider || !backend || activationTargets.length !== 1) {
    throw new Error('Expected generated Pi provider, backend, and activation target contributions');
  }

  return {
    providers: Object.freeze([provider]),
    backends: Object.freeze([backend]),
    actions: Object.freeze([]),
    resources: Object.freeze([]),
    uiDescriptors: Object.freeze([]),
    notifications: Object.freeze([]),
    notificationChannels: Object.freeze([]),
    events: Object.freeze([]),
    executionRunProfiles: Object.freeze([]),
    installables: Object.freeze([]),
    requestInterceptors: Object.freeze([]),
    scmHostingProviders: Object.freeze([]),
    scmBackends: Object.freeze([]),
    connectedAccountDescriptors: Object.freeze([]),
    activationTargets: Object.freeze(activationTargets),
    hookRegistrations: Object.freeze([]),
    surfaceHandlersByBackendId: new Map(),
    catalogEntriesById: Object.freeze(provider.catalogEntry ? { [provider.catalogEntry.id]: provider.catalogEntry } : {}),
    providerDefinitionsById: new Map([[provider.id, provider]]),
    backendDefinitionsById: new Map([[backend.id, backend]]),
    pluginDiagnosticsByPluginId: Object.freeze({}),
  };
}

function createTestCredentials(): Credentials {
  return {
    token: 'test-token',
    encryption: {
      type: 'legacy',
      secret: new Uint8Array(32).fill(1),
    },
  };
}

describe('engineRegistry (pi runtimeCore)', () => {
  it('resolves the bundled Pi strict-LF plugin runtimeCore through production dispatch', async () => {
    const contributes = createPiOnlyContributionRegistry();
    const resolution = await resolveBackendEngineAdapterResolution(PI_BACKEND_ID, {
      contributes,
    });

    expect(resolution).toMatchObject({
      backendId: PI_BACKEND_ID,
      providerId: PI_BACKEND_ID,
      selectedSource: 'plugin',
      backend: {
        pluginId: PI_PLUGIN_ID,
        daemonEntryPath: '@happier-dev/plugins-pi',
      },
    });

    const plan = await resolution!.engineAdapter.runtimeCore.createSessionRuntime({
      credentials: createTestCredentials(),
      directory: '/tmp/pi',
      permissionMode: 'safe-yolo',
      isolation: { env: { HAPPIER_PI_THINKING_LEVEL: 'high' } },
    });

    expect(plan).toMatchObject({
      kind: 'hostSessionRuntimePlan',
      providerId: PI_BACKEND_ID,
      config: {
        backendDisplayName: 'Pi',
        providerName: PI_BACKEND_ID,
        agentMessageType: PI_BACKEND_ID,
        supportsMcpServers: false,
      },
    });
    expect(plan.config.createSessionRuntime).toEqual(expect.any(Function));
    expect((plan.config as RuntimeCapabilitiesCarrier).runtimeCapabilities).toMatchObject({
      mcp: { policy: 'unsupported' },
      strictLfJsonStream: { supported: true },
    });
  });
});
