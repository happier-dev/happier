import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AccountSettingsSchema,
  DEFAULT_PROVIDER_SETTINGS_V1,
  ProviderConnectionIdSchema,
  ProviderSettingsV1Schema,
  createEmptyProviderRuntimeStateFileV1,
  createProviderErrorV1,
} from '@happier-dev/protocol';

import type { AccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import type { ProviderModelSettingsMutationIntent } from '@/providers/connections';
import {
  type ActiveAccountSettingsSnapshot,
  resetActiveAccountSettingsSnapshotForTests,
  setActiveAccountSettingsSnapshot,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import type { ProviderRuntimeStateStore } from '@/providers/runtimeState';
import { resolveProviderConnectionForMachine } from '@/providers/registry';
import { createProviderProbeHttpClient } from '@/providers/probe/client';
import { createRuntimeProviderServices } from '@/providers/probe/runtimeServices';
import { ProviderCliError } from './types';
import {
  createProviderCliModelManagementServices,
  readProviderCliActiveSnapshot,
  unwrapProviderSavedModelsRpcResult,
} from './deps';

const connectionId = ProviderConnectionIdSchema.parse('pc_cli_refresh');
const machineId = 'machine-a';
const endpointUrl = 'http://provider.internal:1234/';
const registry = { providersByContributionKey: new Map() };

function providerCliAccountContext(
  marker: number,
  granted = true,
  scopeKey = 'account-scope-a',
): AccountSettingsContext & Readonly<{ scopeKey: string }> {
  const base = ProviderSettingsV1Schema.parse({
    ...DEFAULT_PROVIDER_SETTINGS_V1,
    connections: [{
      v: 1,
      id: connectionId,
      source: {
        kind: 'custom',
        template: {
          v: 1,
          name: 'CLI refresh fixture',
          endpointTemplates: [{
            id: 'chat',
            protocol: 'openai-chat',
            baseUrl: endpointUrl,
            capabilities: {
              streaming: 'unknown',
              toolRoundTrips: 'unknown',
              statefulResponses: 'unknown',
              reasoningControls: 'unknown',
            },
          }],
          catalog: {
            source: 'probe',
            manualModelPolicy: 'allowed',
            probes: [{ endpointTemplateId: 'chat', path: '/models', parser: 'openai-models' }],
          },
        },
      },
      role: 'named',
      displayName: 'CLI refresh fixture',
      displayNameMode: 'custom',
      revision: 0,
      createdAt: 1,
      updatedAt: 1,
    }],
  });
  const resolution = resolveProviderConnectionForMachine({
    connectionId,
    machineId,
    accountSettings: { providerSettingsV1: base },
    registry,
    dnsEvidenceByEndpointUrl: new Map([[endpointUrl, ['10.0.0.1']]]),
  });
  if (resolution.status !== 'resolved') throw new Error('Expected Provider CLI fixture resolution');
  const providerSettings = ProviderSettingsV1Schema.parse({
    ...base,
    machineGrants: granted ? [{
      v: 1,
      machineId,
      connectionId,
      endpointSetFingerprint: resolution.record.endpointSetFingerprint,
      connectionSecurityFingerprint: resolution.record.connectionSecurityFingerprint,
      confirmedAt: 1,
    }] : [],
  });
  return {
    source: 'network',
    settings: AccountSettingsSchema.parse({ providerSettingsV1: providerSettings, marker }),
    settingsVersion: marker,
    loadedAtMs: marker,
    settingsSecretsReadKeys: [],
    scopeKey,
    whenRefreshed: null,
  };
}

function publishProviderCliAccountContext(context: ReturnType<typeof providerCliAccountContext>) {
  setActiveAccountSettingsSnapshot({
    source: context.source,
    settings: context.settings,
    settingsVersion: context.settingsVersion,
    loadedAtMs: context.loadedAtMs,
    settingsSecretsReadKeys: context.settingsSecretsReadKeys,
    scopeKey: context.scopeKey,
  });
  return readProviderCliActiveSnapshot(context);
}

function createProviderCliProbeRuntime(initialSnapshot: ActiveAccountSettingsSnapshot) {
  let runtimeState = createEmptyProviderRuntimeStateFileV1(machineId);
  const runtimeStore: ProviderRuntimeStateStore = {
    path: '/virtual/provider-cli-composition-runtime.json',
    read: vi.fn(async () => runtimeState),
    update: vi.fn(async (transform) => {
      runtimeState = await transform(runtimeState);
      return runtimeState;
    }),
    touch: vi.fn(),
    flushTouches: vi.fn(async () => runtimeState),
  };
  const transport = vi.fn(async () => ({
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify({ data: [{ id: 'enabled-model' }] }), 'utf8'),
  }));
  const modelSettingsMutation = vi.fn(async (
    intent: ProviderModelSettingsMutationIntent,
  ) => ({
    status: 'success' as const,
    action: intent.action,
  }));
  const services = createProviderCliModelManagementServices({
    machineId,
    registry,
    runtimeStore,
    initialSnapshot,
    resolveAddresses: async () => ['10.0.0.1'],
    client: createProviderProbeHttpClient({
      resolveAddresses: async () => ['10.0.0.1'],
      transport,
    }),
    featureGate: { isEnabled: () => true },
    modelSettingsMutation,
  });
  return { services, transport };
}

afterEach(() => resetActiveAccountSettingsSnapshotForTests());

describe('Provider CLI active account snapshot', () => {
  it('keeps direct CLI probes valid after a forced same-account settings refresh', async () => {
    let current = publishProviderCliAccountContext(providerCliAccountContext(1));
    let runtimeState = createEmptyProviderRuntimeStateFileV1(machineId);
    const runtimeStore: ProviderRuntimeStateStore = {
      path: '/virtual/provider-cli-refresh-runtime.json',
      read: vi.fn(async () => runtimeState),
      update: vi.fn(async (transform) => {
        runtimeState = await transform(runtimeState);
        return runtimeState;
      }),
      touch: vi.fn(),
      flushTouches: vi.fn(async () => runtimeState),
    };
    const transport = vi.fn(async () => ({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ data: [{ id: 'fixture-model' }] }), 'utf8'),
    }));
    const services = createRuntimeProviderServices({
      machineId,
      registry,
      runtimeStore,
      getAccountSettingsSnapshot: () => current,
      resolveAddresses: async () => ['10.0.0.1'],
      client: createProviderProbeHttpClient({
        resolveAddresses: async () => ['10.0.0.1'],
        transport,
      }),
      featureGate: { isEnabled: () => true },
    });

    await expect(services.probe({ connectionId, machineId })).resolves.toMatchObject({ status: 'success' });
    current = publishProviderCliAccountContext(providerCliAccountContext(2));
    await expect(services.probe({ connectionId, machineId })).resolves.toMatchObject({ status: 'success' });
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it('uses the canonical post-enable settings snapshot for the automatic refresh probe', async () => {
    const initialContext = providerCliAccountContext(1, false);
    const initialSnapshot = publishProviderCliAccountContext(initialContext);
    const { services, transport } = createProviderCliProbeRuntime(initialSnapshot);

    await expect(services.probe({ connectionId, machineId })).resolves.toMatchObject({ status: 'error' });
    publishProviderCliAccountContext(providerCliAccountContext(2, true));

    await expect(services.probe({ connectionId, machineId })).resolves.toMatchObject({ status: 'success' });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('refuses a different account scope before the first direct CLI runtime probe', async () => {
    const initialSnapshot = publishProviderCliAccountContext(
      providerCliAccountContext(1, true, 'account-scope-a'),
    );
    const { services, transport } = createProviderCliProbeRuntime(initialSnapshot);
    publishProviderCliAccountContext(providerCliAccountContext(2, true, 'account-scope-b'));

    await expect(services.probe({ connectionId, machineId })).resolves.toMatchObject({ status: 'error' });
    expect(transport).not.toHaveBeenCalled();
  });
});

describe('unwrapProviderSavedModelsRpcResult', () => {
  it('returns models from a successful provider catalog result', () => {
    const models = [{
      id: 'model-a',
      source: 'probe' as const,
      stale: false,
      loadState: 'loaded' as const,
      visibility: 'visible' as const,
    }];

    expect(unwrapProviderSavedModelsRpcResult({
      status: 'success',
      connectionId: 'pc_1',
      connectionRevision: 1,
      manualModelPolicy: 'allowed',
      modelLoadAction: 'descriptor_absent',
      models,
    })).toEqual(models);
  });

  it('preserves the canonical provider error on a failed catalog result', () => {
    const error = createProviderErrorV1('provider_connection_not_found', {
      connectionId: 'pc_missing',
      machineId: 'machine-a',
    });

    expect(() => unwrapProviderSavedModelsRpcResult({ status: 'error', error })).toThrowError(
      expect.objectContaining<Partial<ProviderCliError>>({
        code: error.code,
        details: error,
      }),
    );
  });
});
