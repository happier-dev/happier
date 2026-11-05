import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as undici from 'undici';

import {
  accountSettingsParse,
  SavedSecretSchema,
  createRecipientContractDigestV1,
  type VoiceProviderContribution,
} from '@happier-dev/protocol';
import { ConnectedPurposeCatalogV1Schema } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { VoiceCredentialBindingV1Schema } from '@happier-dev/protocol/voice/realtime/providerSettings';
import { clearActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshot, setActiveAccountSettingsSnapshot, type ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { PluginApi } from '@happier-dev/plugin-sdk';
import type { SpeechProviderRuntime } from '@happier-dev/plugin-sdk/voice/speech';

import { readCanonicalPluginManifest } from '../../plugins/manifest/normalize';
import { createPluginManifestV2Fixture } from '../../plugins/testkit/manifestV2Fixture';
import { createVoiceProviderRecipientContract } from '@/plugins/voiceProviderRecipientContract';
import { createConnectedAccountPurposeBindingOwner, type ConnectedAccountPurposeBindingOwnerDependencies } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
// Genuine network boundary; retain Undici's real Agent and TLS adapters.
vi.mock('undici', async importOriginal => {
  const runtime = await importOriginal<typeof import('undici')>();
  return { ...runtime, fetch: vi.fn(runtime.fetch) };
});

const transportMocks = { request: vi.fn<typeof globalThis.fetch>() };
beforeEach(() => {
  vi.stubGlobal('fetch', transportMocks.request);
  // Node uses Undici fetch; the global stub covers Bun.
  vi.mocked(undici.fetch).mockImplementation(transportMocks.request as unknown as typeof undici.fetch);
});

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
  connectedAccountMediation?: boolean;
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
            ...(options.connectedAccountMediation ? [] : [{
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
            }]),
            ...(options.connectedAccountMediation ? [{
              kind: 'connectedAccount',
              service: { pluginId: 'acme.identity', localId: 'oauth' },
              operationProjections: [{
                kind: 'materializedHttpHeaders',
                operation: 'list-models',
                phase: 'speech',
                request: {
                  kind: 'httpHeaders',
                  origin: ORIGIN,
                  headerNames: ['authorization', 'x-workspace-id'],
                },
                requiredHeaderNames: ['authorization'],
                allowedHeaderNames: ['authorization', 'x-workspace-id'],
              }],
            }] : []),
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

function accountSnapshot(options: Readonly<{
  contribution: SpeechContribution;
  approvedRecipientContractDigest?: string;
  credentialSource?: 'savedSecret' | 'connectedAccount' | 'none';
  settingsVersion?: number;
  includeUnrelatedProvider?: boolean;
  model?: string;
}>): ActiveAccountSettingsSnapshot {
  return {
    source: 'network' as const,
    scopeKey: 'account-scope',
    settingsVersion: options.settingsVersion ?? 1,
    loadedAtMs: 1,
    settingsSecretsReadKeys: [],
    settings: accountSettingsParse({
      secrets: [SavedSecretSchema.parse({
        id: 'external-speech-key',
        name: 'External speech key',
        kind: 'apiKey',
        encryptedValue: { _isSecretValue: true, value: SECRET },
        createdAt: 1,
        updatedAt: 1,
      })],
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
          ...(options.approvedRecipientContractDigest ? { approvedRecipientContractDigest: options.approvedRecipientContractDigest } : {}),
          credentialBindings: { account: { api_key: 'external-speech-key' } },
        }],
      },
    }),
    connectedPurposeCatalog: { status: 'ready', revision: 1, record: {
      key: 'purposes', value: ConnectedPurposeCatalogV1Schema.parse({
          v: 1,
          bindings: options.credentialSource === 'connectedAccount' ? [{
            purpose: { consumer: target, purpose: 'voice.speech' },
            target: {
              kind: 'account',
              account: {
                service: { pluginId: 'acme.identity', localId: 'oauth' },
                accountId: 'speech-account',
              },
            },
          }] : [],
      }),
    } },
  };
}

function manager() {
  const registrar = new RpcHandlerManager({ scopePrefix: 'machine-a', encryptionMode: 'plain', logger() {} });
  return {
    handlers: { get: (method: string) => (raw: unknown) => registrar.invokeLocal(method, raw) },
    registrar,
  };
}

const admittedFixtures: Awaited<ReturnType<typeof createAuthoredAdmittedPluginRuntimeFixture>>[] = [];
afterAll(async () => {
  const fixtures = admittedFixtures.splice(0).reverse();
  await Promise.all(fixtures.map((fixture) => fixture.lease.release()));
  for (const fixture of fixtures) await fixture.dispose();
});
afterEach(() => {
  clearActiveAccountSettingsSnapshot();
  vi.unstubAllGlobals();
});

async function registerCatalog(options: Readonly<{
  manifest: ReturnType<typeof mediatedOnlySpeechManifest>;
  list: NonNullable<SpeechProviderRuntime['catalog']>['list'];
  snapshot?: ReturnType<typeof accountSnapshot>;
  readSnapshot?: () => ReturnType<typeof accountSnapshot>;
  materializeAccount?: ConnectedAccountPurposeBindingOwnerDependencies['materializeAccount'];
}>) {
  const { handlers, registrar } = manager();
  const contribution = options.manifest.contributes.voiceProviders?.[0];
  if (!contribution || contribution.kind !== 'speech') {
    throw new Error('mediated speech fixture must include its speech contribution');
  }
  const snapshot = options.snapshot ?? accountSnapshot({ contribution });
  const readUnapprovedSnapshot = options.readSnapshot ?? (() => snapshot);
  let approvedRecipientContractDigest: string;
  const readSnapshot = () => {
    const current = readUnapprovedSnapshot();
    const voice = current.settings.voiceSettingsV1;
    if (!voice || typeof voice !== 'object' || Array.isArray(voice) || !('credentialBindings' in voice)
      || !Array.isArray(voice.credentialBindings)) throw new Error('Expected fixture Voice credential bindings');
    setActiveAccountSettingsSnapshot({ ...current, settings: accountSettingsParse({ ...current.settings,
      voiceSettingsV1: { ...voice,
        credentialBindings: voice.credentialBindings.map((rawBinding) => {
          const binding = VoiceCredentialBindingV1Schema.parse(rawBinding);
          return { ...binding, approvedRecipientContractDigest: binding.approvedRecipientContractDigest ?? approvedRecipientContractDigest };
        }),
      },
    }) });
    const admitted = getActiveAccountSettingsSnapshot();
    if (!admitted) throw new Error('Expected admitted Account snapshot');
    return admitted;
  };
  const unexpected = async (): Promise<never> => { throw new Error('Unexpected Account selection or listing'); };
  const connectedAccounts = createConnectedAccountPurposeBindingOwner({
    store: {
      read: async () => {
        const catalog = readSnapshot().connectedPurposeCatalog;
        if (catalog?.status !== 'ready' || catalog.record.key !== 'purposes') throw new Error('Purpose catalog unavailable');
        return catalog.record.value;
      },
      update: unexpected,
      subscribe: () => ({ dispose() {} }),
    },
    selectTarget: unexpected,
    resolveTarget: async (selection) => selection.kind === 'account'
      ? { account: selection.account, displayName: 'Speech Account' } : null,
    // Only the remote credential producer is doubled; selection/currentness are real.
    materializeAccount: options.materializeAccount ?? unexpected,
    projectTargetAccounts: unexpected,
    assertTargetAccountMaterializable: unexpected,
  });
  const fixture = await createAuthoredAdmittedPluginRuntimeFixture({
    controller: pluginReloadController,
    runtimeOptions: { connectedAccounts, resolveCurrentMachineId: () => 'machine-a' },
    plugins: [{
      manifest: options.manifest,
      files: { 'daemon.mjs': `export function activate(api) { api.voiceProviders.register('${target.localId}', {kind:'speech',catalog:{list:async()=>[]}}); }` },
      instantiateCommittedModule: () => ({
        activate(api: PluginApi) { api.voiceProviders.register(target.localId, {
          kind: 'speech', catalog: { list: options.list },
          async transcribe() { throw new Error('Catalog fixture must not invoke native transcription'); },
        }); },
      }),
    }],
  });
  admittedFixtures.push(fixture);
  const admittedProvider = fixture.registry.contributes.voiceProviders?.find((provider) => provider.pluginId === target.pluginId && provider.identity.localId === target.localId);
  if (!admittedProvider) throw new Error('Expected admitted speech declaration');
  const contract = createVoiceProviderRecipientContract(admittedProvider);
  if (!contract) throw new Error('Expected declared recipient contract');
  approvedRecipientContractDigest = createRecipientContractDigestV1(contract);
  readSnapshot();
  const registration = registerMachineVoiceSpeechRpcHandlers({
    rpcHandlerManager: registrar,
    machineId: 'machine-a',
    resolveRawCredentialDependencies: async () => ({
      grants: { list: async () => ({ grants: [], pendingRequests: [] }) },
      getAccountSettingsSnapshot: readSnapshot,
    }),
  });
  return { handlers, registration, contribution, fixture };
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('daemon speech host-mediated Voice Account operations', () => {
  it('selects a Connected Account by slot purpose and materializes it for the distinct operation purpose', async () => {
    transportMocks.request.mockReset();
    transportMocks.request.mockResolvedValueOnce(jsonResponse({
      models: [{ id: 'connected-stt-1', name: 'Connected STT' }],
    }));
    const manifest = mediatedOnlySpeechManifest({ connectedAccountMediation: true });
    const contribution = manifest.contributes.voiceProviders?.[0];
    if (!contribution || contribution.kind !== 'speech') throw new Error('fixture');
    const materialize = vi.fn(async () => ({
      kind: 'httpHeaders' as const,
      headers: {
        Authorization: 'Bearer connected-token',
        'X-Workspace-Id': 'workspace-a',
      },
    }));
    const { handlers, registration, fixture } = await registerCatalog({
      manifest,
      snapshot: accountSnapshot({ contribution, credentialSource: 'connectedAccount' }),
      materializeAccount: materialize,
      list: async (_request, context) => {
        const result = await context.credentials.mediated!.request({
          operationId: 'list-models',
          parameters: {},
          signal: context.signal,
        });
        return (JSON.parse(new TextDecoder().decode(result.body)) as { models: readonly { id: string; name: string }[] }).models.map(model => ({ ...model, metadata: {} }));
      },
    });

    const response = await handlers.get(RPC_METHODS.DAEMON_VOICE_SPEECH_CATALOG)?.({
      target,
      catalog: 'models',
    });
    expect(response, JSON.stringify(fixture.registry.pluginDiagnosticsByPluginId[target.pluginId])).toEqual({
      ok: true, items: [{ id: 'connected-stt-1', name: 'Connected STT', metadata: {} }],
    });
    expect(materialize).toHaveBeenCalledWith(expect.objectContaining({
      account: { service: { pluginId: 'acme.identity', localId: 'oauth' }, accountId: 'speech-account' },
      request: expect.objectContaining({ kind: 'httpHeaders', origin: ORIGIN }),
    }));
    expect(transportMocks.request).toHaveBeenCalledWith(
      `${ORIGIN}/v1/models`,
      expect.objectContaining({
        headers: {
          authorization: 'Bearer connected-token',
          'x-workspace-id': 'workspace-a',
        },
      }),
    );
    await registration.dispose();
  });
  it.each([
    ['undeclared', { authorization: 'Bearer token', 'x-extra': 'nope' }],
    ['missing required', { 'x-workspace-id': 'workspace-a' }],
    ['empty', { authorization: '' }],
    ['newline', { authorization: 'Bearer token\r\nInjected: yes' }],
    ['case conflict', { authorization: 'Bearer token', Authorization: 'Bearer other' }],
  ])('rejects %s Connected Account speech headers before transport', async (_label, headers) => {
    transportMocks.request.mockReset();
    const manifest = mediatedOnlySpeechManifest({ connectedAccountMediation: true });
    const contribution = manifest.contributes.voiceProviders?.[0];
    if (!contribution || contribution.kind !== 'speech') throw new Error('fixture');
    const { handlers, registration } = await registerCatalog({
      manifest,
      snapshot: accountSnapshot({ contribution, credentialSource: 'connectedAccount' }),
      materializeAccount: vi.fn(async () => ({ kind: 'httpHeaders' as const, headers })),
      list: async (_request, context) => {
        await context.credentials.mediated!.request({
          operationId: 'list-models', parameters: {}, signal: context.signal,
        });
        return [];
      },
    });

    await expect(handlers.get(RPC_METHODS.DAEMON_VOICE_SPEECH_CATALOG)?.({
      target,
      catalog: 'models',
    })).resolves.toMatchObject({ ok: false });
    expect(transportMocks.request).not.toHaveBeenCalled();
    await registration.dispose();
  });
  it('executes a mediated-only external speech provider operation and keeps raw access absent', async () => {
    transportMocks.request.mockReset();
    transportMocks.request.mockResolvedValueOnce(jsonResponse({
      models: [{ id: 'external-stt-1', name: 'External STT v1' }],
    }));
    let observedRaw: unknown = 'unset';
    let observedPhase: unknown = 'unset';
    const { handlers, registration } = await registerCatalog({
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

    expect(response, JSON.stringify(response)).toMatchObject({
      ok: true,
      items: [{ id: 'external-stt-1', name: 'External STT v1' }],
    });
    expect(observedPhase).toBe('speech');
    expect(observedRaw).toBeNull();
    expect(transportMocks.request).toHaveBeenCalledOnce();
    expect(transportMocks.request.mock.calls[0]?.[0]).toBe(`${ORIGIN}/v1/models`);
    expect(transportMocks.request.mock.calls[0]?.[1]).toMatchObject({
      method: 'GET',
      redirect: 'error',
      headers: { authorization: `Bearer ${SECRET}` },
    });
    await registration.dispose();
  });

  it('fails closed for an undeclared operation without reaching the provider origin', async () => {
    transportMocks.request.mockReset();
    let observedCode: unknown = null;
    const { handlers, registration } = await registerCatalog({
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
    const { handlers, registration } = await registerCatalog({
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
    const { handlers, registration } = await registerCatalog({
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
    const cleared = accountSnapshot({ contribution, credentialSource: 'none', settingsVersion: 2 });
    let current = selected;
    const { handlers, registration } = await registerCatalog({
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

  it('publishes an admitted mediated catalog receipt after source withdrawal and refuses fresh acquisition', async () => {
    transportMocks.request.mockReset();
    const manifest = mediatedOnlySpeechManifest();
    const contribution = manifest.contributes.voiceProviders?.[0];
    if (!contribution || contribution.kind !== 'speech') throw new Error('fixture');
    const selected = accountSnapshot({ contribution });
    const cleared = accountSnapshot({ contribution, credentialSource: 'none', settingsVersion: 2 });
    let current = selected;
    transportMocks.request.mockImplementationOnce(async () => {
      current = cleared;
      return jsonResponse({ models: [{ id: 'retained-model', name: 'Retained model' }] });
    });
    let nextAcquisitionCode: unknown;
    const { handlers, registration } = await registerCatalog({
      manifest,
      readSnapshot: () => current,
      list: async (_request, context) => {
        const result = await context.credentials.mediated!.request({
          operationId: 'list-models', parameters: {}, signal: context.signal,
        });
        try {
          await context.credentials.mediated!.request({
            operationId: 'list-models', parameters: {}, signal: context.signal,
          });
        } catch (error) {
          nextAcquisitionCode = (error as Readonly<{ code?: unknown }>).code;
        }
        const decoded = JSON.parse(new TextDecoder().decode(result.body)) as Readonly<{
          models: readonly Readonly<{ id: string; name: string }>[];
        }>;
        return decoded.models.map(model => ({ ...model, metadata: {} }));
      },
    });
    try {
      const response = await handlers.get(RPC_METHODS.DAEMON_VOICE_SPEECH_CATALOG)?.({
        target, catalog: 'models',
      });
      expect(transportMocks.request).toHaveBeenCalledOnce();
      expect(response, JSON.stringify(response)).toMatchObject({ ok: true, items: [{ id: 'retained-model', name: 'Retained model' }] });
      expect(nextAcquisitionCode).toBe('plugin_voice_credential_unavailable');
      await expect(handlers.get(RPC_METHODS.DAEMON_VOICE_SPEECH_CATALOG)?.({
        target, catalog: 'models',
      })).resolves.toMatchObject({ ok: false, errorCode: 'credential_unavailable' });
    } finally {
      await registration.dispose();
    }
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
    const { handlers, registration } = await registerCatalog({
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
    const { handlers, registration } = await registerCatalog({
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
    const { handlers, registration } = await registerCatalog({
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
    let observedCode: unknown = null;
    const { handlers, registration } = await registerCatalog({
      manifest: mediatedOnlySpeechManifest(),
      list: async (_request, context) => {
        const successor = await createAuthoredAdmittedPluginRuntimeFixture({
          controller: pluginReloadController,
          plugins: [{
            manifest: createPluginManifestV2Fixture({ id: target.pluginId }),
            files: { 'daemon.mjs': 'export function activate() {}' },
          }],
        });
        admittedFixtures.push(successor);
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
