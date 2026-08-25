import { describe, expect, it, vi } from 'vitest';

import {
  createEmptyProviderRuntimeStateFileV1,
  createProviderProbeRequestFingerprintV1,
  createProviderObservationAuthorizationFingerprintV1,
  createProviderSavedSecretRecordFingerprintV1,
  ProviderConnectionIdSchema,
  type ProviderRuntimeStateFileV1,
} from '@happier-dev/protocol';

import { createProviderCatalogRefreshFingerprint } from '../probe/catalog';
import {
  createProviderModelLoadCatalogPort,
  readProviderModelLoadCatalogObservation,
  selectCurrentProviderCatalogRuntimeRecord,
} from './catalog';

const connectionId = ProviderConnectionIdSchema.parse('connection-a');
const otherAuthorization = createProviderObservationAuthorizationFingerprintV1({
  selectedSecretBindingId: 'secret-a',
  selectedSecretRecordFingerprint: createProviderSavedSecretRecordFingerprintV1({
    secretId: 'secret-a',
    persistedEncryptedEnvelope: { t: 'enc-v1', c: 'encrypted-envelope-a' },
  }),
  credential: {
    transport: {
      id: 'management', protocols: ['openai-responses'], uses: ['management'],
      destination: { kind: 'httpHeader', name: 'authorization', format: 'bearer' },
    },
    selectedProtocol: 'openai-responses',
    selectedUse: 'management',
  },
});

const resolved = {
  connectionId: 'connection-a',
  machineId: 'machine-a',
  endpoints: [{
    endpointTemplateId: 'management',
    protocol: 'openai-responses' as const,
    normalizedUrl: 'http://127.0.0.1:1234/',
    publicHeaders: {},
  }],
  probes: [{
    endpointTemplateId: 'management',
    path: '/api/v1/models',
    parser: 'lmstudio-native-models' as const,
  }],
  observationAuthorizationFingerprints: [createProviderObservationAuthorizationFingerprintV1({
    selectedSecretBindingId: null,
    selectedSecretRecordFingerprint: null,
    credential: null,
  })],
  authorizationGrant: {
    kind: 'account',
    fingerprint: 'account-grant:v1:fixture',
    confirmedAt: 1,
  },
} as const;

const primaryAuthorization = resolved.observationAuthorizationFingerprints[0];

function state(input: Readonly<{
  stale?: boolean;
  authorizationFingerprint?: typeof primaryAuthorization;
  loadObservationId?: string;
}> = {}): ProviderRuntimeStateFileV1 {
  const catalogObservationId = 'observation-a';
  const catalogFingerprint = createProviderCatalogRefreshFingerprint(resolved);
  return {
    ...createEmptyProviderRuntimeStateFileV1('machine-a'),
    catalogs: [{
      key: {
        machineId: 'machine-a',
        connectionId,
        catalogFingerprint,
        observationAuthorizationFingerprint:
          input.authorizationFingerprint ?? primaryAuthorization,
      },
      state: {
        catalogObservationId,
        snapshot: input.stale
          ? { models: [{ id: 'model-a' }], observedAt: 1, stale: true, staleAt: 2 }
          : { models: [{ id: 'model-a' }], observedAt: 1, stale: false },
        staleProbeModels: [],
      },
      lastAccessedAt: 2,
    }],
    modelLoadStates: [{
      key: {
        machineId: 'machine-a',
        connectionId,
        catalogObservationId: input.loadObservationId ?? catalogObservationId,
        modelId: 'model-a',
      },
      loadState: 'loaded',
      observedAt: 1,
      lastAccessedAt: 2,
    }],
  };
}

describe('provider model-load exact catalog observation', () => {
  it('returns load evidence only from the exact fresh authorization-bound generation', () => {
    expect(readProviderModelLoadCatalogObservation({
      state: state(), resolved, modelId: 'model-a',
    })).toEqual({ status: 'listed', catalogObservationId: 'observation-a', loadState: 'loaded' });

    expect(readProviderModelLoadCatalogObservation({
      state: state({ loadObservationId: 'old-observation' }), resolved, modelId: 'model-a',
    })).toEqual({ status: 'listed', catalogObservationId: 'observation-a', loadState: 'unknown' });
  });

  it('distinguishes a fresh missing model from missing, stale, or mismatched catalog evidence', () => {
    expect(readProviderModelLoadCatalogObservation({
      state: state(), resolved, modelId: 'model-b',
    })).toEqual({ status: 'not_found' });

    const empty = createEmptyProviderRuntimeStateFileV1('machine-a');
    expect(readProviderModelLoadCatalogObservation({ state: empty, resolved, modelId: 'model-a' }))
      .toMatchObject({ status: 'error', error: { code: 'provider_endpoint_unavailable' } });
    expect(readProviderModelLoadCatalogObservation({ state: state({ stale: true }), resolved, modelId: 'model-a' }))
      .toMatchObject({ status: 'error', error: { code: 'provider_endpoint_unavailable' } });

    expect(readProviderModelLoadCatalogObservation({
      state: state({ authorizationFingerprint: otherAuthorization }), resolved, modelId: 'model-a',
    })).toMatchObject({ status: 'error', error: { code: 'provider_endpoint_unavailable' } });
  });

  it('selects the newest exact record across the current authorization set with a canonical tie-break', () => {
    const current = state();
    const catalogFingerprint = createProviderCatalogRefreshFingerprint(resolved);
    const later = {
      ...current.catalogs[0]!,
      key: {
        ...current.catalogs[0]!.key,
        observationAuthorizationFingerprint: otherAuthorization,
      },
      state: {
        ...current.catalogs[0]!.state,
        catalogObservationId: 'observation-z',
        snapshot: { models: [{ id: 'model-a' }], observedAt: 3, stale: false as const },
      },
      lastAccessedAt: 3,
    };
    expect(selectCurrentProviderCatalogRuntimeRecord({
      state: { ...current, catalogs: [...current.catalogs, later] },
      machineId: 'machine-a',
      connectionId,
      catalogFingerprint,
      allowedObservationAuthorizationFingerprints: [
        primaryAuthorization,
        otherAuthorization,
      ],
    })?.state).toMatchObject({ catalogObservationId: 'observation-z' });

    const tied = {
      ...later,
      state: { ...later.state, catalogObservationId: 'observation-0', snapshot: { ...later.state.snapshot, observedAt: 1 } },
    };
    expect(selectCurrentProviderCatalogRuntimeRecord({
      state: { ...current, catalogs: [...current.catalogs, tied] },
      machineId: 'machine-a',
      connectionId,
      catalogFingerprint,
      allowedObservationAuthorizationFingerprints: [otherAuthorization, primaryAuthorization],
    })?.state).toMatchObject({ catalogObservationId: 'observation-0' });
  });
});

describe('provider model-load catalog port', () => {
  it('delegates a forced signal-bearing refresh and then reads the exact current key', async () => {
    const refresh = vi.fn(async () => ({
      status: 'success' as const,
      models: [{ id: 'model-a' }],
      requestFingerprint: createProviderProbeRequestFingerprintV1({
        method: 'GET',
        endpointUrl: resolved.endpoints[0].normalizedUrl,
        path: resolved.probes[0].path,
        parser: resolved.probes[0].parser,
        publicHeaders: {},
      }),
    }));
    const port = createProviderModelLoadCatalogPort({
      resolveSaved: async () => resolved,
      runtimeStore: { read: async () => state() },
      refresh,
    });
    const ticket = { revision: 1 };
    const scope = { lifetime: { wallDeadlineAtMs: 60_000 } };
    await expect(port.readCurrentModel({
      connectionId: 'connection-a', machineId: 'machine-a', modelId: 'model-a', ticket, scope,
    })).resolves.toMatchObject({ status: 'listed', loadState: 'loaded' });
    const controller = new AbortController();
    await expect(port.refresh({
      connectionId: 'connection-a', machineId: 'machine-a', modelId: 'model-a',
      refreshFrontier: 'dispatch-a', ticket, signal: controller.signal, scope,
    })).resolves.toMatchObject({ status: 'success' });
    expect(refresh).toHaveBeenCalledWith({
      ...resolved,
      modelId: 'model-a',
      refreshFrontier: 'dispatch-a',
      signal: controller.signal,
      operationScope: { lifetime: scope.lifetime },
    });
  });
});
