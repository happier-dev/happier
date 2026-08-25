import { describe, expect, it, vi } from 'vitest';

import {
  createProviderErrorV1,
  createProviderObservationAuthorizationFingerprintV1,
} from '@happier-dev/protocol';

import {
  createProviderProbeRpcHandler,
  ProviderProbeRpcResolutionError,
  createProviderSavedModelsRpcHandler,
  createProviderSavedProbeRpcHandler,
} from './rpc';

describe('provider probe RPC boundary', () => {
  const authorizationGrant = {
    kind: 'account',
    fingerprint: 'account-grant:v1:fixture',
    confirmedAt: 1,
  } as const;
  const observationAuthorizationFingerprint = createProviderObservationAuthorizationFingerprintV1({
    selectedSecretBindingId: null,
    selectedSecretRecordFingerprint: null,
    credential: null,
  });
  it('rejects raw credentials and keys scheduled work by connection and machine', async () => {
    const refresh = vi.fn(async () => ({ status: 'not_supported' as const }));
    const handler = createProviderProbeRpcHandler({
      resolveSaved: async () => ({
        connectionId: 'connection-a',
        machineId: 'machine-a',
        endpoints: [],
        probes: [],
        observationAuthorizationFingerprints: [],
        authorizationGrant,
      }),
      refresh,
      schedule: async (_key, _trigger, operation) => operation(),
    });
    await expect(handler({
      kind: 'saved', connectionId: 'connection-a', machineId: 'machine-a', trigger: 'manual_refresh', rawKey: 'secret',
    })).rejects.toThrow();
    await expect(handler({
      kind: 'saved', connectionId: 'connection-a', machineId: 'machine-a', trigger: 'manual_refresh',
    })).resolves.toEqual({ status: 'not_supported' });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('opens one wall budget before resolution and spends it through refresh', async () => {
    let currentMs = 1_000;
    const seen: Array<{ resolveDeadline: number; refreshDeadline: number | undefined }> = [];
    const handler = createProviderProbeRpcHandler({
      resolveSaved: async (identity, lifetime) => {
        // Resolution — registry and DNS — is inside the budget, not before it.
        currentMs += 5_000;
        seen.push({ resolveDeadline: lifetime.wallDeadlineAtMs, refreshDeadline: undefined });
        return {
          connectionId: identity.connectionId,
          machineId: identity.machineId,
          endpoints: [],
          probes: [],
          observationAuthorizationFingerprints: [],
          authorizationGrant,
        };
      },
      refresh: async (_request, lifetime) => {
        seen.push({ resolveDeadline: 0, refreshDeadline: lifetime?.wallDeadlineAtMs });
        return { status: 'not_supported' as const };
      },
      schedule: async (_key, _trigger, operation) => operation(),
    });

    await expect(handler(
      { kind: 'saved', connectionId: 'connection-a', machineId: 'machine-a', trigger: 'manual_refresh' },
      {},
      () => currentMs,
    )).resolves.toEqual({ status: 'not_supported' });

    // 30_000 is the declared Provider wall budget; the deadline is anchored at
    // the operation's start, so the 5s spent resolving is not refunded.
    expect(seen[0]?.resolveDeadline).toBe(31_000);
    expect(seen[1]?.refreshDeadline).toBe(31_000);
  });

  it('admits exactly the reachable demand and explicit refresh triggers', async () => {
    const triggers: string[] = [];
    const handler = createProviderProbeRpcHandler({
      resolveSaved: async () => ({
        connectionId: 'connection-a', machineId: 'machine-a', endpoints: [], probes: [],
        observationAuthorizationFingerprints: [],
        authorizationGrant,
      }),
      refresh: async () => ({ status: 'not_supported' }),
      schedule: async (_key, trigger, operation) => {
        triggers.push(trigger);
        return operation();
      },
    });
    const identity = { kind: 'saved', connectionId: 'connection-a', machineId: 'machine-a' };
    for (const trigger of ['enable', 'detail_open', 'picker_open', 'manual_refresh'] as const) {
      await expect(handler({ ...identity, trigger })).resolves.toEqual({ status: 'not_supported' });
    }
    await expect(handler({ ...identity, trigger: 'background_ttl' })).rejects.toThrow();
    await expect(handler({ ...identity, trigger: 'cache_expired_on_read' })).rejects.toThrow();
    expect(triggers).toEqual(['enable', 'detail_open', 'picker_open', 'manual_refresh']);
  });

  it('separates saved scheduler identity by request shape, authorization provenance, and grant event', async () => {
    const keys: string[] = [];
    const savedFingerprint = createProviderObservationAuthorizationFingerprintV1({
      selectedSecretBindingId: 'secret-a',
      selectedSecretRecordFingerprint: 'saved-secret-record:v1:a',
      credential: {
        selectedProtocol: 'openai-chat',
        selectedUse: 'probe',
        transport: {
          id: 'catalog-key',
          protocols: ['openai-chat'],
          uses: ['probe'],
          destination: { kind: 'httpHeader', name: 'authorization', format: 'bearer' },
        },
      },
    });
    const rotatedFingerprint = createProviderObservationAuthorizationFingerprintV1({
      selectedSecretBindingId: 'secret-a',
      selectedSecretRecordFingerprint: 'saved-secret-record:v1:b',
      credential: {
        selectedProtocol: 'openai-chat',
        selectedUse: 'probe',
        transport: {
          id: 'catalog-key',
          protocols: ['openai-chat'],
          uses: ['probe'],
          destination: { kind: 'httpHeader', name: 'authorization', format: 'bearer' },
        },
      },
    });
    let currentFingerprint = savedFingerprint;
    let grantConfirmedAt: number = authorizationGrant.confirmedAt;
    let path = '/models';
    const handler = createProviderProbeRpcHandler({
      resolveSaved: async () => ({
        connectionId: 'connection-a', machineId: 'machine-a',
        endpoints: [{ endpointTemplateId: 'openai', protocol: 'openai-chat', normalizedUrl: 'https://models.example/v1', publicHeaders: {} }],
        probes: [{ endpointTemplateId: 'openai', path, parser: 'openai-models' }],
        observationAuthorizationFingerprints: [currentFingerprint],
        authorizationGrant: { ...authorizationGrant, confirmedAt: grantConfirmedAt },
      }),
      refresh: async () => ({ status: 'not_supported' }),
      schedule: async (key, _trigger, operation) => { keys.push(key); return operation(); },
    });
    const saved = { kind: 'saved' as const, connectionId: 'connection-a', machineId: 'machine-a', trigger: 'manual_refresh' as const };
    await handler(saved);
    path = '/v1/models';
    await handler(saved);
    currentFingerprint = rotatedFingerprint;
    await handler(saved);
    grantConfirmedAt = 2;
    await handler(saved);
    expect(new Set(keys)).toHaveLength(4);
  });

  it('keys fallback work by the canonical set of every authorization fingerprint', async () => {
    const keys: string[] = [];
    const secondFingerprint = createProviderObservationAuthorizationFingerprintV1({
      selectedSecretBindingId: 'secret-b',
      selectedSecretRecordFingerprint: 'saved-secret-record:v1:b',
      credential: {
        selectedProtocol: 'openai-chat',
        selectedUse: 'probe',
        transport: {
          id: 'catalog-key',
          protocols: ['openai-chat'],
          uses: ['probe'],
          destination: { kind: 'httpHeader', name: 'authorization', format: 'bearer' },
        },
      },
    });
    let authorizationFingerprints = [secondFingerprint, observationAuthorizationFingerprint];
    const handler = createProviderProbeRpcHandler({
      resolveSaved: async () => ({
        connectionId: 'connection-a', machineId: 'machine-a',
        endpoints: [{ endpointTemplateId: 'openai', protocol: 'openai-chat', normalizedUrl: 'https://models.example/v1', publicHeaders: {} }],
        probes: [{ endpointTemplateId: 'openai', path: '/models', parser: 'openai-models' }],
        observationAuthorizationFingerprints: authorizationFingerprints,
        authorizationGrant,
      }),
      refresh: async () => ({ status: 'not_supported' }),
      schedule: async (key, _trigger, operation) => { keys.push(key); return operation(); },
    });
    await handler({ kind: 'saved', connectionId: 'connection-a', machineId: 'machine-a', trigger: 'manual_refresh' });
    authorizationFingerprints = [observationAuthorizationFingerprint, secondFingerprint];
    await handler({ kind: 'saved', connectionId: 'connection-a', machineId: 'machine-a', trigger: 'manual_refresh' });
    expect(keys[0]).toMatch(/^probe-observation:v1:/u);
    expect(keys[1]).toBe(keys[0]);
  });

  it('exposes strict connection-and-machine handlers and refuses another daemon machine', async () => {
    const probe = vi.fn(async () => ({ status: 'not_supported' as const }));
    const models = vi.fn(async () => ({
      status: 'success' as const, connectionId: 'connection-a', connectionRevision: 1,
      manualModelPolicy: 'allowed' as const,
      modelLoadAction: 'descriptor_absent' as const,
      models: [{
        id: 'model-a', name: 'Model A', source: 'probe' as const, stale: false,
        loadState: 'loaded' as const, visibility: 'visible' as const,
      }],
    }));
    const probeHandler = createProviderSavedProbeRpcHandler({ machineId: 'machine-a', probe });
    const modelsHandler = createProviderSavedModelsRpcHandler({ machineId: 'machine-a', models });
    const request = { connectionId: 'connection-a', machineId: 'machine-a' };

    await expect(probeHandler({ ...request, rawKey: 'secret' })).rejects.toThrow();
    await expect(modelsHandler({ ...request, endpointUrl: 'https://evil.example' })).rejects.toThrow();
    await expect(probeHandler(request)).resolves.toEqual({ status: 'not_supported' });
    await expect(modelsHandler(request)).resolves.toMatchObject({
      status: 'success', models: [expect.objectContaining({ id: 'model-a' })],
    });
    await expect(probeHandler({ ...request, machineId: 'machine-b' })).resolves.toMatchObject({
      status: 'error', error: { code: 'provider_not_enabled_on_machine', machineId: 'machine-b' },
    });
    await expect(modelsHandler({ ...request, machineId: 'machine-b' })).resolves.toMatchObject({
      status: 'error', error: { code: 'provider_not_enabled_on_machine', machineId: 'machine-b' },
    });
    expect(probe).toHaveBeenCalledWith(request);
    expect(models).toHaveBeenCalledWith(request);
  });

  it('preserves a stable provider refusal when saved state changes during resolution', async () => {
    const handler = createProviderProbeRpcHandler({
      resolveSaved: async () => {
        throw new ProviderProbeRpcResolutionError(createProviderErrorV1('provider_authorization_changed', {
          connectionId: 'connection-a',
          machineId: 'machine-a',
        }));
      },
      refresh: async () => ({ status: 'not_supported' }),
      schedule: async (_key, _trigger, operation) => operation(),
    });
    await expect(handler({
      kind: 'saved', connectionId: 'connection-a', machineId: 'machine-a', trigger: 'manual_refresh',
    })).resolves.toMatchObject({ status: 'error', error: { code: 'provider_authorization_changed' } });
  });
});
