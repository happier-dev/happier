import { describe, expect, it, vi } from 'vitest';

import {
  createRecipientContractDigestV1,
  type VoiceProviderContribution,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { HttpService } from '@happier-dev/plugin-sdk/http';
import type { SpeechProviderRuntime } from '@happier-dev/plugin-sdk/voice/speech';

import { readCanonicalPluginManifest } from '../../plugins/manifest/normalize';
import { createPluginManifestV2Fixture } from '../../plugins/testkit/manifestV2Fixture';
import { createVoiceProviderRecipientContract } from '@/plugins/voiceProviderRecipientContract';

const runtimeLeaseMocks = vi.hoisted(() => ({
  acquire: vi.fn(),
  activateContributionsOnDemand: vi.fn(async () => []),
  release: vi.fn(async () => undefined),
}));
const transportMocks = vi.hoisted(() => ({
  request: vi.fn(),
}));

vi.mock('@/plugins/runtime/reload/runtimeLease', () => ({
  acquireAuthoritativePluginRuntimeRegistryLease: runtimeLeaseMocks.acquire,
}));
vi.mock('@/plugins/runtime/fetch/globalFetchRuntime', () => ({
  createGlobalFetchRuntime: () => ({
    request: transportMocks.request,
    openWebSocket: async () => {
      throw new Error('WebSocket is not used by the mediated speech fixture');
    },
  }),
}));

import { registerMachineVoiceSpeechRpcHandlers } from './rpcHandlers.voiceSpeech';

const ORIGIN = 'https://speech.example.test';
const SECRET = 'external-account-speech-secret';
const target = Object.freeze({ pluginId: 'acme.speech', localId: 'external-stt' });

type SpeechContribution = Extract<VoiceProviderContribution, { kind: 'speech' }>;

const listModelsOperation = Object.freeze({
  id: 'list-models',
  purpose: 'voice.catalog.models',
  credentialSlotId: 'api_key',
  effect: 'read',
  request: {
    origin: ORIGIN,
    pathTemplate: '/v1/models',
    queryTemplate: [],
    headerTemplate: [],
    bodyTemplate: { kind: 'none' },
    method: 'GET',
    credential: { kind: 'httpHeader', name: 'authorization', format: 'bearer' },
    redirect: 'error',
    maxBodyBytes: 0,
    contentTypes: [],
  },
  parameters: {
    schema: { type: 'object', properties: {}, additionalProperties: false },
    mapping: [],
  },
  response: { maxBytes: 32 * 1024, contentTypes: ['application/json'] },
});

/**
 * A second declared operation that no credential source projects into any
 * phase. It exists to prove the projection fence, not the operation lookup.
 */
const listVoicesOperation = Object.freeze({
  ...listModelsOperation,
  id: 'list-voices',
  purpose: 'voice.catalog.voices',
  request: Object.freeze({ ...listModelsOperation.request, pathTemplate: '/v1/voices' }),
});

const rawSpeechGrant = Object.freeze({
  realm: 'daemon',
  phase: 'speech',
  request: Object.freeze({
    kind: 'httpHeaders',
    origin: ORIGIN,
    headerNames: Object.freeze(['authorization']),
  }),
});

/**
 * An external speech contribution that declares host mediation and **no** raw
 * grant. It is the C1 parity case: an installed external STT provider whose
 * only credential authority is the mediated operation the host performs.
 */
function mediatedOnlySpeechManifest(options: Readonly<{
  declareProjection?: boolean;
  declareUnprojectedOperation?: boolean;
  declareRawAlternative?: boolean;
}> = {}) {
  const parsed = readCanonicalPluginManifest(createPluginManifestV2Fixture({
    id: target.pluginId,
    contributes: {
      voiceProviders: [{
        id: target.localId,
        title: 'External STT',
        kind: 'speech',
        roles: ['dictation_stt'],
        platforms: ['web'],
        catalogs: [{ kind: 'models', settingFieldId: 'model', allowCustom: true }],
        credentials: {
          slot: { id: 'api_key', purpose: 'voice.speech', title: 'API key' },
          requirement: { kind: 'always' },
          sources: [
            {
              kind: 'savedSecret',
              secretKinds: ['apiKey'],
              ...(options.declareProjection === false
                ? {}
                : {
                  operationProjections: [{
                    kind: 'recipientCredential',
                    operation: 'list-models',
                    phase: 'speech',
                    format: 'bearer',
                  }],
                }),
            },
            ...(options.declareRawAlternative
              ? [{
                kind: 'connectedAccount',
                service: { pluginId: 'acme.identity', localId: 'oauth' },
                rawGrants: [rawSpeechGrant],
              }]
              : []),
          ],
          hostMediated: {
            operations: [
              listModelsOperation,
              ...(options.declareUnprojectedOperation ? [listVoicesOperation] : []),
            ],
          },
        },
        settings: {
          schemaVersion: 2,
          fields: [{
            id: 'model',
            title: 'Model',
            schema: { type: 'string', minLength: 1, maxLength: 256 },
            default: 'external-stt-1',
            presentation: { control: 'select' },
          }],
        },
      }],
    },
  }));
  if (!parsed) throw new Error('mediated speech manifest fixture must be canonical');
  return parsed;
}

function externalDeclaration(contribution: SpeechContribution) {
  return Object.freeze({
    pluginId: target.pluginId,
    identity: Object.freeze({ ...target }),
    definition: contribution,
    provenance: 'external' as const,
    source: Object.freeze({ kind: 'archive' }),
    sourceSpec: Object.freeze({
      kind: 'archive',
      locator: 'https://registry.example.test/acme-speech-1.0.0.tgz',
      trustPolicy: 'committed-registry',
    }),
    manifestPath: '/tmp/acme.speech/plugin.json',
  });
}

function approvedDigestFor(contribution: SpeechContribution): string {
  const contract = createVoiceProviderRecipientContract(externalDeclaration(contribution));
  if (!contract) throw new Error('mediated speech fixture must project a recipient contract');
  return createRecipientContractDigestV1(contract);
}

function accountSnapshot(options: Readonly<{
  contribution: SpeechContribution;
  approvedRecipientContractDigest?: string;
  credentialSource?: 'savedSecret' | 'none';
  settingsVersion?: number;
  includeUnrelatedProvider?: boolean;
  model?: string;
}>) {
  return {
    source: 'network' as const,
    scopeKey: 'account-scope',
    settingsVersion: options.settingsVersion ?? 1,
    loadedAtMs: 1,
    settingsSecretsReadKeys: [],
    settings: {
      secrets: [{
        id: 'external-speech-key',
        name: 'External speech key',
        kind: 'apiKey',
        encryptedValue: { _isSecretValue: true, value: SECRET },
      }],
      voiceSettingsV1: {
        providers: {
          [`${target.pluginId}/${target.localId}`]: {
            schemaVersion: options.contribution.settings.schemaVersion,
            config: { model: options.model ?? 'external-stt-1' },
          },
          ...(options.includeUnrelatedProvider
            ? {
                'other.plugin/unrelated-speech': {
                  schemaVersion: 1,
                  config: { model: 'unrelated-stt' },
                },
              }
            : {}),
        },
        credentialBindings: [{
          contribution: { ...target },
          credentialSlotId: 'api_key',
          credentialSource: { kind: options.credentialSource ?? 'savedSecret' },
          approvedRecipientContractDigest:
            options.approvedRecipientContractDigest ?? approvedDigestFor(options.contribution),
          credentialBindings: { account: { api_key: 'external-speech-key' } },
        }],
      },
    } as never,
  };
}

function manager() {
  const handlers = new Map<string, (raw: unknown) => Promise<unknown>>();
  return {
    handlers,
    registrar: {
      unregisterHandler() {},
      registerHandler(method: string, handler: (raw: unknown) => Promise<unknown>) {
        handlers.set(method, handler);
      },
    },
  };
}

function registerCatalog(options: Readonly<{
  manifest: ReturnType<typeof mediatedOnlySpeechManifest>;
  list: NonNullable<SpeechProviderRuntime['catalog']>['list'];
  isCurrent?: () => boolean;
  snapshot?: ReturnType<typeof accountSnapshot>;
  readSnapshot?: () => ReturnType<typeof accountSnapshot>;
}>) {
  const { handlers, registrar } = manager();
  const contribution = options.manifest.contributes.voiceProviders?.[0];
  if (!contribution || contribution.kind !== 'speech') {
    throw new Error('mediated speech fixture must include its speech contribution');
  }
  const isCurrent = options.isCurrent ?? (() => true);
  const snapshot = options.snapshot ?? accountSnapshot({ contribution });
  const readSnapshot = options.readSnapshot ?? (() => snapshot);
  runtimeLeaseMocks.acquire.mockResolvedValueOnce({
    registry: {
      activateContributionsOnDemand: runtimeLeaseMocks.activateContributionsOnDemand,
      generation: 4,
      contributes: {
        activationTargets: [{ pluginId: target.pluginId, manifest: options.manifest }],
        voiceProviders: [externalDeclaration(contribution)],
      },
      voiceSpeechProviders: {
        read: vi.fn(() => ({
          generation: '4',
          runtime: Object.freeze({ kind: 'speech' as const, catalog: { list: options.list } }),
          contribution,
          isCurrent,
          retirementSignal: new AbortController().signal,
          createHttp: (): Pick<HttpService, 'request'> => ({
            request: async () => {
              throw new Error('the mediated fixture must not use the contributor HTTP service');
            },
          }),
        })),
      },
      resolveVoiceProviderRuntimeLifecycle: () => ({
        generation: 'immutable-generation-4',
        isCurrent,
        retirementSignal: new AbortController().signal,
      }),
    },
    release: runtimeLeaseMocks.release,
  });
  const registration = registerMachineVoiceSpeechRpcHandlers({
    rpcHandlerManager: registrar as never,
    machineId: 'machine-a',
    resolveRawCredentialDependencies: async () => ({
      grants: { list: async () => ({ grants: [], pendingRequests: [] }) },
      getAccountSettingsSnapshot: readSnapshot,
    }),
  });
  return { handlers, registration, contribution };
}

function jsonResponse(body: unknown) {
  return {
    status: 200,
    finalUrl: `${ORIGIN}/v1/models`,
    headers: { 'content-type': 'application/json' },
    body: new TextEncoder().encode(JSON.stringify(body)),
  };
}

describe('daemon speech host-mediated Voice Account operations', () => {
  it('executes a mediated-only external speech provider operation and keeps raw access absent', async () => {
    transportMocks.request.mockReset();
    transportMocks.request.mockResolvedValueOnce(jsonResponse({
      models: [{ id: 'external-stt-1', name: 'External STT v1' }],
    }));
    let observedRaw: unknown = 'unset';
    let observedPhase: unknown = 'unset';
    const { handlers, registration } = registerCatalog({
      manifest: mediatedOnlySpeechManifest(),
      list: async (_request, context) => {
        observedPhase = context.credentials.phase;
        observedRaw = context.credentials.raw;
        if (!context.credentials.mediated) throw new Error('mediated speech credentials required');
        const result = await context.credentials.mediated.request({
          operationId: 'list-models',
          parameters: {},
          signal: context.signal,
        });
        const decoded = JSON.parse(new TextDecoder().decode(result.body)) as Readonly<{
          models: readonly Readonly<{ id: string; name: string }>[];
        }>;
        return decoded.models.map((model) => ({ id: model.id, name: model.name, metadata: {} }));
      },
    });

    const response = await handlers.get(RPC_METHODS.DAEMON_VOICE_SPEECH_CATALOG)?.({
      target,
      catalog: 'models',
    });

    expect(response).toMatchObject({
      ok: true,
      items: [{ id: 'external-stt-1', name: 'External STT v1' }],
    });
    expect(observedPhase).toBe('speech');
    expect(observedRaw).toBeNull();
    expect(transportMocks.request).toHaveBeenCalledOnce();
    expect(transportMocks.request.mock.calls[0]?.[0]).toMatchObject({
      url: `${ORIGIN}/v1/models`,
      method: 'GET',
      redirect: 'error',
      headers: { authorization: `Bearer ${SECRET}` },
    });
    await registration.dispose();
  });

  it('fails closed for an undeclared operation without reaching the provider origin', async () => {
    transportMocks.request.mockReset();
    let observedCode: unknown = null;
    const { handlers, registration } = registerCatalog({
      manifest: mediatedOnlySpeechManifest(),
      list: async (_request, context) => {
        try {
          await context.credentials.mediated!.request({
            operationId: 'delete-models',
            parameters: {},
            signal: context.signal,
          });
        } catch (error) {
          observedCode = (error as Readonly<{ code?: unknown }>).code;
        }
        return [];
      },
    });

    await handlers.get(RPC_METHODS.DAEMON_VOICE_SPEECH_CATALOG)?.({ target, catalog: 'models' });

    expect(observedCode).toBe('plugin_fetch_voice_account_operation_unauthorized');
    expect(transportMocks.request).not.toHaveBeenCalled();
    await registration.dispose();
  });

  it('withholds mediated access when no source projects an operation into the speech phase, leaving declared raw access intact', async () => {
    transportMocks.request.mockReset();
    let observedMediated: unknown = 'unset';
    let observedRaw: unknown = 'unset';
    const { handlers, registration } = registerCatalog({
      manifest: mediatedOnlySpeechManifest({
        declareProjection: false,
        declareRawAlternative: true,
      }),
      list: async (_request, context) => {
        observedMediated = context.credentials.mediated;
        observedRaw = context.credentials.raw;
        return [];
      },
    });

    const response = await handlers.get(RPC_METHODS.DAEMON_VOICE_SPEECH_CATALOG)?.({
      target,
      catalog: 'models',
    });

    expect(response).toMatchObject({ ok: true, items: [] });
    expect(observedMediated).toBeNull();
    expect(observedRaw).not.toBeNull();
    expect(transportMocks.request).not.toHaveBeenCalled();
    await registration.dispose();
  });

  it('fails closed for a declared operation no source projects into the speech phase', async () => {
    transportMocks.request.mockReset();
    let observedCode: unknown = null;
    const { handlers, registration } = registerCatalog({
      manifest: mediatedOnlySpeechManifest({ declareUnprojectedOperation: true }),
      list: async (_request, context) => {
        try {
          await context.credentials.mediated!.request({
            operationId: 'list-voices',
            parameters: {},
            signal: context.signal,
          });
        } catch (error) {
          observedCode = (error as Readonly<{ code?: unknown }>).code;
        }
        return [];
      },
    });

    await handlers.get(RPC_METHODS.DAEMON_VOICE_SPEECH_CATALOG)?.({ target, catalog: 'models' });

    expect(observedCode).toBe('plugin_fetch_voice_account_operation_unauthorized');
    expect(transportMocks.request).not.toHaveBeenCalled();
    await registration.dispose();
  });

  it('refuses the operation after the Account credential selection is replaced mid-invocation', async () => {
    transportMocks.request.mockReset();
    let observedCode: unknown = null;
    const manifest = mediatedOnlySpeechManifest();
    const contribution = manifest.contributes.voiceProviders?.[0];
    if (!contribution || contribution.kind !== 'speech') throw new Error('fixture');
    const selected = accountSnapshot({ contribution });
    const cleared = accountSnapshot({ contribution, credentialSource: 'none' });
    let current = selected;
    const { handlers, registration } = registerCatalog({
      manifest,
      readSnapshot: () => current,
      list: async (_request, context) => {
        current = cleared;
        try {
          await context.credentials.mediated!.request({
            operationId: 'list-models',
            parameters: {},
            signal: context.signal,
          });
        } catch (error) {
          observedCode = (error as Readonly<{ code?: unknown }>).code;
        }
        return [];
      },
    });

    await handlers.get(RPC_METHODS.DAEMON_VOICE_SPEECH_CATALOG)?.({ target, catalog: 'models' });

    expect(observedCode).toBe('plugin_voice_credential_unavailable');
    expect(transportMocks.request).not.toHaveBeenCalled();
    await registration.dispose();
  });

  it('keeps a mediated operation current across an unrelated Account Settings update', async () => {
    transportMocks.request.mockReset();
    transportMocks.request.mockResolvedValueOnce(jsonResponse({
      models: [{ id: 'external-stt-1', name: 'External STT v1' }],
    }));
    const manifest = mediatedOnlySpeechManifest();
    const contribution = manifest.contributes.voiceProviders?.[0];
    if (!contribution || contribution.kind !== 'speech') throw new Error('fixture');
    const selected = accountSnapshot({ contribution });
    const unrelatedUpdate = accountSnapshot({
      contribution,
      settingsVersion: 2,
      includeUnrelatedProvider: true,
    });
    let current = selected;
    const { handlers, registration } = registerCatalog({
      manifest,
      readSnapshot: () => current,
      list: async (_request, context) => {
        current = unrelatedUpdate;
        const result = await context.credentials.mediated!.request({
          operationId: 'list-models',
          parameters: {},
          signal: context.signal,
        });
        const decoded = JSON.parse(new TextDecoder().decode(result.body)) as Readonly<{
          models: readonly Readonly<{ id: string; name: string }>[];
        }>;
        return decoded.models.map((model) => ({ id: model.id, name: model.name, metadata: {} }));
      },
    });

    const response = await handlers.get(RPC_METHODS.DAEMON_VOICE_SPEECH_CATALOG)?.({
      target,
      catalog: 'models',
    });

    expect(response).toMatchObject({
      ok: true,
      items: [{ id: 'external-stt-1', name: 'External STT v1' }],
    });
    expect(transportMocks.request).toHaveBeenCalledOnce();
    await registration.dispose();
  });

  it('refuses a mediated operation after its selected provider settings change mid-invocation', async () => {
    transportMocks.request.mockReset();
    let observedCode: unknown = null;
    const manifest = mediatedOnlySpeechManifest();
    const contribution = manifest.contributes.voiceProviders?.[0];
    if (!contribution || contribution.kind !== 'speech') throw new Error('fixture');
    const selected = accountSnapshot({ contribution });
    const changedProviderSettings = accountSnapshot({
      contribution,
      settingsVersion: 2,
      model: 'external-stt-2',
    });
    let current = selected;
    const { handlers, registration } = registerCatalog({
      manifest,
      readSnapshot: () => current,
      list: async (_request, context) => {
        current = changedProviderSettings;
        try {
          await context.credentials.mediated!.request({
            operationId: 'list-models',
            parameters: {},
            signal: context.signal,
          });
        } catch (error) {
          observedCode = (error as Readonly<{ code?: unknown }>).code;
        }
        return [];
      },
    });

    await handlers.get(RPC_METHODS.DAEMON_VOICE_SPEECH_CATALOG)?.({ target, catalog: 'models' });

    expect(observedCode).toBe('plugin_final_generation_retired');
    expect(transportMocks.request).not.toHaveBeenCalled();
    await registration.dispose();
  });

  it('refuses the operation when the approved recipient contract no longer matches the declaration', async () => {
    transportMocks.request.mockReset();
    let observedCode: unknown = null;
    const manifest = mediatedOnlySpeechManifest();
    const contribution = manifest.contributes.voiceProviders?.[0];
    if (!contribution || contribution.kind !== 'speech') throw new Error('fixture');
    const { handlers, registration } = registerCatalog({
      manifest,
      snapshot: accountSnapshot({
        contribution,
        approvedRecipientContractDigest: `sha256:${'0'.repeat(64)}`,
      }),
      list: async (_request, context) => {
        try {
          await context.credentials.mediated!.request({
            operationId: 'list-models',
            parameters: {},
            signal: context.signal,
          });
        } catch (error) {
          observedCode = (error as Readonly<{ code?: unknown }>).code;
        }
        return [];
      },
    });

    await handlers.get(RPC_METHODS.DAEMON_VOICE_SPEECH_CATALOG)?.({ target, catalog: 'models' });

    expect(observedCode).toBe('plugin_voice_credential_unavailable');
    expect(transportMocks.request).not.toHaveBeenCalled();
    await registration.dispose();
  });

  it('refuses the operation once the contributor generation retires mid-invocation', async () => {
    transportMocks.request.mockReset();
    let current = true;
    let observedCode: unknown = null;
    const { handlers, registration } = registerCatalog({
      manifest: mediatedOnlySpeechManifest(),
      isCurrent: () => current,
      list: async (_request, context) => {
        current = false;
        try {
          await context.credentials.mediated!.request({
            operationId: 'list-models',
            parameters: {},
            signal: context.signal,
          });
        } catch (error) {
          observedCode = (error as Readonly<{ code?: unknown }>).code;
        }
        return [];
      },
    });

    await handlers.get(RPC_METHODS.DAEMON_VOICE_SPEECH_CATALOG)?.({ target, catalog: 'models' });

    expect(observedCode).toBe('plugin_final_generation_retired');
    expect(transportMocks.request).not.toHaveBeenCalled();
    await registration.dispose();
  });
});
