import { describe, expect, it, vi } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import {
  PluginInstallReviewPrincipalDigestSchema,
  type VoiceProviderContribution,
} from '@happier-dev/protocol';
import type { VoiceCredentialAccess } from '@happier-dev/plugin-sdk/voice';
import type { SpeechProviderRuntime } from '@happier-dev/plugin-sdk/voice/speech';
import type { HttpService } from '@happier-dev/plugin-sdk/http';

import { readCanonicalPluginManifest } from '../../plugins/manifest/normalize';
import { createPluginManifestV2Fixture } from '../../plugins/testkit/manifestV2Fixture';

import {
  createEncryptedTransferChunkEnvelope,
  createTransferRecipientKeyPair,
  decryptEncryptedTransferChunkEnvelope,
} from '@/machines/transfer/transferChunkEncryption';

const runtimeLeaseMocks = vi.hoisted(() => ({
  acquire: vi.fn(),
  activateContributionsOnDemand: vi.fn(async () => []),
  release: vi.fn(async () => undefined),
}));

vi.mock('@/plugins/runtime/reload/runtimeLease', () => ({
  acquireAuthoritativePluginRuntimeRegistryLease: runtimeLeaseMocks.acquire,
}));

import {
  registerMachineVoiceSpeechRpcHandlers,
  type VoiceSpeechRuntimeLease,
} from './rpcHandlers.voiceSpeech';

const daemonGrantAuthority = Object.freeze({
  kind: 'machine_installation' as const,
  machineId: 'machine-1',
  installationId: 'installation-1',
});

const target = Object.freeze({ pluginId: 'happier.voice.google', localId: 'gemini-stt' });
const credentials: VoiceCredentialAccess<'speech'> = Object.freeze({
  phase: 'speech', mediated: null, raw: null,
});
const http: HttpService = Object.freeze({
  request: vi.fn(async () => ({
    status: 200,
    finalUrl: 'https://speech.example.test',
    headers: Object.freeze({}),
    body: new Uint8Array(),
  })),
  openWebSocket: async () => {
    throw new Error('WebSocket is not used by the voice speech fixture');
  },
});
const settings = Object.freeze({ model: 'gemini-2.5-flash' });
const rawRequest = Object.freeze({
  kind: 'httpHeaders' as const,
  origin: 'https://speech.example.test',
  headerNames: Object.freeze(['authorization']),
});
type SpeechContribution = Extract<VoiceProviderContribution, { kind: 'speech' }>;
type SpeechCredentialRequirement = NonNullable<SpeechContribution['credentials']>['requirement'];

function speechManifest(options: Readonly<{
  requirement?: SpeechCredentialRequirement;
  credentialModeDefault?: boolean;
  rawGrantPhases?: readonly ('settings' | 'speech')[];
  settingsActions?: NonNullable<SpeechContribution['settings']>['actions'];
}> = {}) {
  const requirement = options.requirement ?? { kind: 'always' as const };
  const parsed = readCanonicalPluginManifest(createPluginManifestV2Fixture({
    id: target.pluginId,
    contributes: {
      voiceProviders: [{
        id: target.localId,
        title: 'Google Speech',
        kind: 'speech',
        roles: ['dictation_stt'],
        platforms: ['web'],
        catalogs: [{ kind: 'models', settingFieldId: 'model', allowCustom: true }],
        credentials: {
          slot: { id: 'api_key', purpose: 'voice.speech', title: 'API key' },
          requirement,
          sources: [{
            kind: 'connectedAccount',
            service: { pluginId: 'happier.google', localId: 'oauth' },
            rawGrants: (options.rawGrantPhases ?? ['speech']).map((phase) => ({
              realm: 'daemon' as const,
              phase,
              request: rawRequest,
            })),
          }],
        },
        settings: {
          schemaVersion: 2,
          fields: [{
            id: 'model',
            title: 'Model',
            schema: { type: 'string', minLength: 1, maxLength: 256 },
            default: 'gemini-2.5-flash',
            presentation: { control: 'select' },
          }, ...(requirement.kind === 'when_setting_equals' ? [{
            id: requirement.settingId,
            title: 'Credential mode',
            schema: { type: 'boolean' as const },
            default: options.credentialModeDefault ?? true,
            presentation: { control: 'switch' as const },
          }] : [])],
          ...(options.settingsActions ? { actions: options.settingsActions } : {}),
        },
      }],
    },
  }));
  if (!parsed) throw new Error('speech manifest fixture must be canonical');
  return parsed;
}

function contribution(overrides: Partial<SpeechContribution> = {}): SpeechContribution {
  const roles = overrides.roles ?? ['dictation_stt'];
  const defaultSettings: SpeechContribution['settings'] = roles.includes('conversation_tts')
    ? {
        schemaVersion: 2,
        fields: [{
          id: 'voiceName',
          title: 'Voice',
          schema: { type: 'string', minLength: 1, maxLength: 256 },
          default: 'en-US-A',
          presentation: { control: overrides.catalogs?.some((catalog) => catalog.kind === 'voices')
            ? 'select'
            : 'text' },
        }],
      }
    : {
        schemaVersion: 2,
        fields: [{
          id: 'model',
          title: 'Model',
          schema: { type: 'string', minLength: 1, maxLength: 256 },
          default: 'gemini-2.5-flash',
          presentation: { control: overrides.catalogs?.some((catalog) => catalog.kind === 'models')
            ? 'select'
            : 'text' },
        }],
      };
  return {
    id: target.localId,
    title: 'Google Speech',
    kind: 'speech' as const,
    roles,
    platforms: ['web'],
    settings: defaultSettings,
    ...overrides,
  };
}

function resolveRuntime(
  runtime: SpeechProviderRuntime,
  definition: SpeechContribution = contribution(),
  current: () => boolean = () => true,
): (_target: Readonly<{ pluginId: string; localId: string }>) => Promise<VoiceSpeechRuntimeLease> {
  const operationSettings = Object.freeze(Object.fromEntries(
    definition.settings.fields.map((field) => [field.id, field.default]),
  ));
  return vi.fn(async (): Promise<VoiceSpeechRuntimeLease> => ({
    runtime,
    contribution: definition,
    readSettings: () => Object.freeze({
      settings: operationSettings,
      resolveCredentials: () => credentials,
      isCurrent: current,
    }),
    createHttp: () => http,
    isCurrent: current,
    retirementSignal: new AbortController().signal,
    release: vi.fn(async () => undefined),
  }));
}

function manager() {
  const handlers = new Map<string, (raw: unknown, context?: Readonly<{ signal: AbortSignal }>) => Promise<unknown>>();
  return {
    handlers,
    registrar: {
      registerHandler(method: string, handler: (raw: unknown, context?: Readonly<{ signal: AbortSignal }>) => Promise<unknown>) {
        handlers.set(method, handler);
      },
    },
  };
}

function registerDefaultCatalogWithNoCredentialSource(options: Readonly<{
  requirement: SpeechCredentialRequirement;
  credentialModeDefault?: boolean;
  list: NonNullable<SpeechProviderRuntime['catalog']>['list'];
}>) {
  const { handlers, registrar } = manager();
  const manifest = speechManifest({
    requirement: options.requirement,
    credentialModeDefault: options.credentialModeDefault,
  });
  const declaredContribution = manifest.contributes.voiceProviders?.[0];
  if (!declaredContribution || declaredContribution.kind !== 'speech') {
    throw new Error('speech manifest fixture must include its speech contribution');
  }
  const operationSettings = Object.freeze(Object.fromEntries(
    declaredContribution.settings.fields.map((field) => [field.id, field.default]),
  ));
  const currentInstallReviewPrincipal = Object.freeze({
    digest: PluginInstallReviewPrincipalDigestSchema.parse('b'.repeat(64)),
    presentation: null,
  });
  const connectedMaterialize = vi.fn();
  runtimeLeaseMocks.acquire.mockResolvedValueOnce({
    registry: {
      activateContributionsOnDemand: runtimeLeaseMocks.activateContributionsOnDemand,
      generation: 8,
      contributes: { activationTargets: [{ pluginId: target.pluginId, manifest }] },
      voiceSpeechProviders: {
        read: vi.fn(() => ({
          generation: '8',
          runtime: Object.freeze({ kind: 'speech' as const, catalog: { list: options.list } }),
          contribution: declaredContribution,
          isCurrent: () => true,
          retirementSignal: new AbortController().signal,
          createHttp: () => http,
        })),
      },
      resolveConnectedAccountPurposeBindingOwner: () => ({ materialize: connectedMaterialize }),
    },
    release: runtimeLeaseMocks.release,
  });
  const snapshot = {
    source: 'network' as const,
    scopeKey: 'account-scope',
    settingsVersion: 1,
    loadedAtMs: 1,
    settingsSecretsReadKeys: [],
    settings: {
      voiceSettingsV1: {
        providers: {
          [`${target.pluginId}/${target.localId}`]: {
            schemaVersion: declaredContribution.settings.schemaVersion,
            config: operationSettings,
          },
        },
        credentialBindings: [],
      },
    } as never,
  };
  const registration = registerMachineVoiceSpeechRpcHandlers({
    rpcHandlerManager: registrar as never,
    machineId: 'machine-a',
    resolveRawCredentialDependencies: async () => ({
      currentInstallReviewPrincipal: { readCurrent: async () => currentInstallReviewPrincipal },
      readCurrentGrantAuthoritySource: async () => daemonGrantAuthority,
      grants: { list: async () => ({ grants: [], pendingRequests: [] }) },
      getAccountSettingsSnapshot: () => snapshot,
    }),
  });
  return { handlers, registration, connectedMaterialize };
}

async function upload(
  handlers: Map<string, (raw: unknown) => Promise<unknown>>,
  bytes: Uint8Array,
) {
  const init = await handlers.get(RPC_METHODS.DAEMON_VOICE_SPEECH_TRANSCRIBE_UPLOAD_INIT)?.({
    target,
    sizeBytes: bytes.byteLength,
    mimeType: 'audio/wav',
    fileName: 'recording.wav',
  }) as Readonly<{ success: true; uploadId: string; recipientPublicKeyBase64: string }>;
  const encrypted = createEncryptedTransferChunkEnvelope({
    transferId: init.uploadId,
    sequence: 0,
    payload: Buffer.from(bytes),
    recipientPublicKeyBase64: init.recipientPublicKeyBase64,
  });
  await handlers.get(RPC_METHODS.DAEMON_VOICE_SPEECH_TRANSCRIBE_UPLOAD_CHUNK)?.({
    uploadId: init.uploadId, index: 0, ...encrypted,
  });
  await handlers.get(RPC_METHODS.DAEMON_VOICE_SPEECH_TRANSCRIBE_UPLOAD_FINALIZE)?.({ uploadId: init.uploadId });
  return init.uploadId;
}

describe('unified Voice speech machine RPC', () => {
  it('pins a selected Connected Account revision for one speech callback and admits it for the next', async () => {
    const { handlers, registrar } = manager();
    const principal = PluginInstallReviewPrincipalDigestSchema.parse('a'.repeat(64));
    const manifest = speechManifest({ requirement: { kind: 'optional' } });
    const isCurrent = vi.fn(() => true);
    let retainedRaw: NonNullable<VoiceCredentialAccess<'speech'>['raw']> | null = null;
    const revisionA = 'csr_0123456789ABCDEFGHJKMNPQRS';
    const revisionB = 'csr_ZYXWVUTSRQPONMLKJHGFEDCBA1';
    let credentialRevision = revisionA;
    let callbackCount = 0;
    const materialize = vi.fn(async (input: Readonly<{
      credentialRevisionBasis?: Readonly<{
        expectedCredentialRevision: string | null;
        captureCredentialRevision(credentialRevision: string): void;
      }>;
    }>) => {
      input.credentialRevisionBasis?.captureCredentialRevision(credentialRevision);
      return {
        kind: 'httpHeaders' as const,
        headers: { authorization: `Bearer ${credentialRevision}` },
      };
    });
    const catalogList: NonNullable<SpeechProviderRuntime['catalog']>['list'] = async (
      _request,
      context,
    ) => {
      expect(context.credentials.phase).toBe('speech');
      expect(context.credentials.mediated).toBeNull();
      retainedRaw = context.credentials.raw;
      expect(retainedRaw).not.toBeNull();
      expect.soft(Object.keys(retainedRaw!)).toEqual(['materialize']);
      expect.soft(Reflect.get(retainedRaw!, 'inspectAuthorization')).toBeUndefined();
      callbackCount += 1;
      if (callbackCount === 1) {
        await expect(context.credentials.raw?.materialize(rawRequest)).resolves.toEqual({
          kind: 'httpHeaders',
          headers: { authorization: `Bearer ${revisionA}` },
        });
        credentialRevision = revisionB;
        await expect(context.credentials.raw?.materialize(rawRequest)).rejects.toMatchObject({
          code: 'plugin_voice_credential_access_unavailable',
        });
      } else {
        await expect(context.credentials.raw?.materialize(rawRequest)).resolves.toEqual({
          kind: 'httpHeaders',
          headers: { authorization: `Bearer ${revisionB}` },
        });
      }
      return Object.freeze([]);
    };
    const runtime: SpeechProviderRuntime = Object.freeze({
      kind: 'speech',
      catalog: Object.freeze({ list: catalogList }),
      async transcribe(request) { return { requestId: request.requestId, text: '' }; },
    });
    const registryLease = {
      registry: {
        activateContributionsOnDemand: runtimeLeaseMocks.activateContributionsOnDemand,
        generation: 7,
        contributes: {
          activationTargets: [{ pluginId: target.pluginId, manifest }],
        },
        voiceSpeechProviders: {
          read: vi.fn(() => ({
            generation: '7',
            runtime,
            contribution: manifest.contributes.voiceProviders?.[0],
            isCurrent,
            retirementSignal: new AbortController().signal,
            createHttp: () => http,
          })),
        },
        resolveVoiceProviderRuntimeLifecycle: () => ({
          generation: 'immutable-generation-7',
          isCurrent,
          retirementSignal: new AbortController().signal,
        }),
        resolveConnectedAccountPurposeBindingOwner: () => ({
          getBinding: async () => ({
            purpose: 'voice.speech',
            service: { pluginId: 'happier.google', localId: 'oauth' },
            account: {
              service: { pluginId: 'happier.google', localId: 'oauth' },
              accountId: 'google-a',
            },
            target: { kind: 'account' as const, displayName: 'Google A' },
          }),
          materialize,
        }),
      },
      release: runtimeLeaseMocks.release,
    };
    runtimeLeaseMocks.acquire.mockResolvedValueOnce(registryLease).mockResolvedValueOnce(registryLease);
    const registration = registerMachineVoiceSpeechRpcHandlers({
      rpcHandlerManager: registrar as never,
      machineId: 'machine-a',
      resolveRawCredentialDependencies: async () => ({
        currentInstallReviewPrincipal: { readCurrent: async () => ({ digest: principal, presentation: null }) },
        readCurrentGrantAuthoritySource: async () => daemonGrantAuthority,
        grants: {
          list: async (input) => ({
            grants: [{
              v: 1,
              id: 'grant-1',
              accountId: 'account-scope',
              pluginId: target.pluginId,
              capability: 'credentials.materialize.raw',
              targetScope: { kind: 'account' },
              subject: input.subject!,
              authoritySource: daemonGrantAuthority,
              status: 'active',
              grantedByUserId: 'user-1',
              grantedAt: 1,
              createdAt: 1,
              updatedAt: 1,
            }],
            pendingRequests: [],
          }),
        },
        getAccountSettingsSnapshot: (() => {
          const snapshot = {
            source: 'network' as const,
            scopeKey: 'account-scope',
            settingsVersion: 1,
            loadedAtMs: 1,
            settingsSecretsReadKeys: [],
            settings: {
              voiceSettingsV1: {
                providers: {
                  'happier.voice.google/gemini-stt': {
                    schemaVersion: 2,
                    config: { model: 'gemini-2.5-flash' },
                  },
                },
                credentialBindings: [{
                  contribution: target,
                  credentialSlotId: 'api_key',
                  credentialSource: { kind: 'connectedAccount' },
                  credentialBindings: { account: {} },
                }],
              },
              connectedAccountPurposeBindingsV1: {
                v: 1,
                bindings: [{
                  purpose: { consumer: target, purpose: 'voice.speech' },
                  target: {
                    kind: 'account',
                    account: {
                      service: { pluginId: 'happier.google', localId: 'oauth' },
                      accountId: 'google-a',
                    },
                  },
                }],
              },
            } as never,
          };
          return () => snapshot;
        })(),
      }),
    });

    await expect(handlers.get(RPC_METHODS.DAEMON_VOICE_SPEECH_CATALOG)?.({
      target,
      catalog: 'models',
    })).resolves.toEqual({ ok: true, items: [] });
    await expect(handlers.get(RPC_METHODS.DAEMON_VOICE_SPEECH_CATALOG)?.({
      target,
      catalog: 'models',
    })).resolves.toEqual({ ok: true, items: [] });

    await expect(retainedRaw!.materialize(rawRequest)).rejects.toMatchObject({
      code: 'plugin_voice_credential_access_unavailable',
    });

    expect(runtimeLeaseMocks.activateContributionsOnDemand).toHaveBeenCalledWith([{
      pluginId: target.pluginId,
      family: 'voiceProviders',
      localId: target.localId,
    }]);
    expect(materialize).toHaveBeenNthCalledWith(1, expect.objectContaining({
      purpose: { consumer: target, purpose: 'voice.speech' },
      serviceRefs: [{ pluginId: 'happier.google', localId: 'oauth' }],
      credentialRevisionBasis: {
        expectedCredentialRevision: null,
        captureCredentialRevision: expect.any(Function),
      },
      request: rawRequest,
      signal: expect.any(AbortSignal),
    }));
    expect(materialize).toHaveBeenNthCalledWith(2, expect.objectContaining({
      credentialRevisionBasis: expect.objectContaining({
        expectedCredentialRevision: revisionA,
      }),
    }));
    expect(materialize).toHaveBeenNthCalledWith(3, expect.objectContaining({
      credentialRevisionBasis: expect.objectContaining({
        expectedCredentialRevision: null,
      }),
    }));
    expect(materialize).toHaveBeenCalledTimes(3);
    expect(isCurrent).toHaveBeenCalled();
    await registration.dispose();
  });

  it('does not materialize or publish through a newly selected Connected Account mid-invocation', async () => {
    const { handlers, registrar } = manager();
    const principal = PluginInstallReviewPrincipalDigestSchema.parse('c'.repeat(64));
    const manifest = speechManifest({ requirement: { kind: 'optional' } });
    const runtimeIsCurrent = vi.fn(() => true);
    const snapshotFor = (accountId: string) => Object.freeze({
      source: 'network' as const,
      scopeKey: 'account-scope',
      settingsVersion: 1,
      loadedAtMs: 1,
      settingsSecretsReadKeys: [],
      settings: {
        voiceSettingsV1: {
          providers: {
            'happier.voice.google/gemini-stt': {
              schemaVersion: 2,
              config: { model: 'gemini-2.5-flash' },
            },
          },
          credentialBindings: [{
            contribution: target,
            credentialSlotId: 'api_key',
            credentialSource: { kind: 'connectedAccount' },
            credentialBindings: { account: {} },
          }],
        },
        connectedAccountPurposeBindingsV1: {
          v: 1,
          bindings: [{
            purpose: { consumer: target, purpose: 'voice.speech' },
            target: {
              kind: 'account',
              account: {
                service: { pluginId: 'happier.google', localId: 'oauth' },
                accountId,
              },
            },
          }],
        },
      } as never,
    });
    let currentSnapshot = snapshotFor('google-a');
    const credentialRevision = 'csr_0123456789ABCDEFGHJKMNPQRS';
    const materialize = vi.fn(async (input: Readonly<{
      expectedAccount?: Readonly<{ accountId?: string }>;
      credentialRevisionBasis?: Readonly<{
        captureCredentialRevision(credentialRevision: string): void;
      }>;
    }>) => {
      input.credentialRevisionBasis?.captureCredentialRevision(credentialRevision);
      return Object.freeze({
        kind: 'httpHeaders' as const,
        headers: { authorization: `Bearer ${input.expectedAccount?.accountId ?? 'missing'}` },
      });
    });
    let secondMaterializationError: unknown = null;
    const runtime: SpeechProviderRuntime = Object.freeze({
      kind: 'speech',
      catalog: Object.freeze({
        list: async (_request, context) => {
          if (!context.credentials.raw) throw new Error('raw credential access must be available');
          await expect(context.credentials.raw.materialize(rawRequest)).resolves.toEqual({
            kind: 'httpHeaders',
            headers: { authorization: 'Bearer google-a' },
          });
          currentSnapshot = snapshotFor('google-b');
          try {
            await context.credentials.raw.materialize(rawRequest);
          } catch (error) {
            secondMaterializationError = error;
          }
          return [];
        },
      }),
      async transcribe(request) { return { requestId: request.requestId, text: '' }; },
    });
    const registryLease = {
      registry: {
        activateContributionsOnDemand: runtimeLeaseMocks.activateContributionsOnDemand,
        generation: 9,
        contributes: {
          activationTargets: [{ pluginId: target.pluginId, manifest }],
        },
        voiceSpeechProviders: {
          read: vi.fn(() => ({
            generation: '9',
            runtime,
            contribution: manifest.contributes.voiceProviders?.[0],
            isCurrent: runtimeIsCurrent,
            retirementSignal: new AbortController().signal,
            createHttp: () => http,
          })),
        },
        resolveVoiceProviderRuntimeLifecycle: () => ({
          generation: 'immutable-generation-9',
          isCurrent: runtimeIsCurrent,
          retirementSignal: new AbortController().signal,
        }),
        resolveConnectedAccountPurposeBindingOwner: () => ({
          getBinding: async () => ({
            purpose: 'voice.speech',
            service: { pluginId: 'happier.google', localId: 'oauth' },
            account: {
              service: { pluginId: 'happier.google', localId: 'oauth' },
              accountId: currentSnapshot.settings.connectedAccountPurposeBindingsV1.bindings[0]!.target.account.accountId,
            },
            target: { kind: 'account' as const, displayName: 'Selected Google account' },
          }),
          materialize,
        }),
      },
      release: runtimeLeaseMocks.release,
    };
    runtimeLeaseMocks.acquire.mockResolvedValueOnce(registryLease);
    const registration = registerMachineVoiceSpeechRpcHandlers({
      rpcHandlerManager: registrar as never,
      machineId: 'machine-a',
      resolveRawCredentialDependencies: async () => ({
        currentInstallReviewPrincipal: { readCurrent: async () => ({ digest: principal, presentation: null }) },
        readCurrentGrantAuthoritySource: async () => daemonGrantAuthority,
        grants: {
          list: async (input) => ({
            grants: [{
              v: 1,
              id: 'grant-1',
              accountId: 'account-scope',
              pluginId: target.pluginId,
              capability: 'credentials.materialize.raw',
              targetScope: { kind: 'account' },
              // Both selections have a valid grant. Only the invocation's
              // captured selection may disclose material during this call.
              subject: input.subject!,
              authoritySource: daemonGrantAuthority,
              status: 'active',
              grantedByUserId: 'user-1',
              grantedAt: 1,
              createdAt: 1,
              updatedAt: 1,
            }],
            pendingRequests: [],
          }),
        },
        getAccountSettingsSnapshot: () => currentSnapshot,
      }),
    });

    const response = await handlers.get(RPC_METHODS.DAEMON_VOICE_SPEECH_CATALOG)?.({
      target,
      catalog: 'models',
    });

    expect(secondMaterializationError).toMatchObject({
      code: 'plugin_voice_credential_access_unavailable',
    });
    expect(materialize).toHaveBeenCalledTimes(1);
    expect(materialize).toHaveBeenCalledWith(expect.objectContaining({
      expectedAccount: expect.objectContaining({ accountId: 'google-a' }),
    }));
    expect(response).toMatchObject({ ok: false, errorCode: 'provider_unavailable' });
    await registration.dispose();
  });

  it.each([
    {
      label: 'optional',
      requirement: { kind: 'optional' } as const,
    },
    {
      label: 'inactive conditional',
      requirement: {
        kind: 'when_setting_equals',
        settingId: 'credentialMode',
        value: true,
      } as const,
      credentialModeDefault: false,
    },
  ])('invokes credential-less speech for $label credentials without exposing a raw materializer', async ({
    requirement,
    credentialModeDefault,
  }) => {
    const list = vi.fn(async (_request, context) => {
      expect(context.credentials).toEqual({ phase: 'speech', mediated: null, raw: null });
      return [];
    });
    const { handlers, registration, connectedMaterialize } = registerDefaultCatalogWithNoCredentialSource({
      requirement,
      credentialModeDefault,
      list,
    });

    await expect(handlers.get(RPC_METHODS.DAEMON_VOICE_SPEECH_CATALOG)?.({
      target,
      catalog: 'models',
    })).resolves.toEqual({ ok: true, items: [] });
    expect(list).toHaveBeenCalledTimes(1);
    expect(connectedMaterialize).not.toHaveBeenCalled();
    await registration.dispose();
  });

  it.each([
    {
      label: 'always required',
      requirement: { kind: 'always' } as const,
    },
    {
      label: 'active conditional',
      requirement: {
        kind: 'when_setting_equals',
        settingId: 'credentialMode',
        value: true,
      } as const,
      credentialModeDefault: true,
    },
  ])('fails $label credentials closed before invoking speech when no source is selected', async ({
    requirement,
    credentialModeDefault,
  }) => {
    const list = vi.fn(async () => []);
    const { handlers, registration, connectedMaterialize } = registerDefaultCatalogWithNoCredentialSource({
      requirement,
      credentialModeDefault,
      list,
    });

    await expect(handlers.get(RPC_METHODS.DAEMON_VOICE_SPEECH_CATALOG)?.({
      target,
      catalog: 'models',
    })).resolves.toEqual({
      ok: false,
      errorCode: 'credential_unavailable',
      error: 'credential_unavailable',
      retryable: false,
    });
    expect(list).not.toHaveBeenCalled();
    expect(connectedMaterialize).not.toHaveBeenCalled();
    await registration.dispose();
  });

  it('calls the final catalog ABI with declaration-bound catalog and credentials', async () => {
    const { handlers, registrar } = manager();
    const list = vi.fn(async (_request, context) => {
      expect(context.credentials).toBe(credentials);
      expect(context.settings).toEqual(settings);
      expect(Object.isFrozen(context.settings)).toBe(true);
      expect(context.http).toBe(http);
      expect(context.signal.aborted).toBe(false);
      return [{ id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', metadata: {} }];
    });
    const registration = registerMachineVoiceSpeechRpcHandlers({
      rpcHandlerManager: registrar as never,
      resolveSpeechRuntime: resolveRuntime(
        { kind: 'speech', catalog: { list }, transcribe: vi.fn() },
        contribution({ catalogs: [{ kind: 'models', settingFieldId: 'model', allowCustom: true }] }),
      ),
    });

    const response = await handlers.get(RPC_METHODS.DAEMON_VOICE_SPEECH_CATALOG)?.({
      target, catalog: 'models',
    });
    expect(list).toHaveBeenCalledTimes(1);
    expect(response).toEqual({
      ok: true,
      items: [{ id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', metadata: {} }],
    });
    expect(list).toHaveBeenCalledWith({ catalog: 'models' }, expect.objectContaining({ credentials }));
    await registration.dispose();
  });

  it('snapshots nested settings before provider effects and exposes the existing bounded HTTP instance', async () => {
    const { handlers, registrar } = manager();
    const mutableSettings = { model: 'gemini-2.5-flash', options: { language: 'en' } };
    const nestedContribution = contribution({
      catalogs: [{ kind: 'models', settingFieldId: 'model', allowCustom: true }],
      settings: {
        schemaVersion: 2,
        fields: [{
          id: 'model', title: 'Model',
          schema: { type: 'string', minLength: 1, maxLength: 256 },
          default: 'gemini-2.5-flash',
          presentation: { control: 'select' },
        }, {
          id: 'options', title: 'Options',
          schema: {
            type: 'object',
            properties: { language: { type: 'string' } },
            required: ['language'],
            additionalProperties: false,
          },
          default: { language: 'en' },
          presentation: { control: 'json' },
        }],
      },
    });
    const list = vi.fn(async (_request, context) => {
      mutableSettings.model = 'changed-after-dispatch';
      mutableSettings.options.language = 'fr';
      expect(context.settings).toEqual({ model: 'gemini-2.5-flash', options: { language: 'en' } });
      expect(Object.isFrozen(context.settings)).toBe(true);
      expect(Object.isFrozen(context.settings.options)).toBe(true);
      expect(context.http).toBe(http);
      return [];
    });
    const registration = registerMachineVoiceSpeechRpcHandlers({
      rpcHandlerManager: registrar as never,
      resolveSpeechRuntime: vi.fn(async () => ({
        runtime: { kind: 'speech' as const, catalog: { list } },
        contribution: nestedContribution,
        readSettings: () => ({
          settings: mutableSettings,
          resolveCredentials: () => credentials,
          isCurrent: () => true,
        }),
        createHttp: () => http,
        isCurrent: () => true,
        retirementSignal: new AbortController().signal,
        release: vi.fn(async () => undefined),
      })),
    });

    await expect(handlers.get(RPC_METHODS.DAEMON_VOICE_SPEECH_CATALOG)?.({
      target, catalog: 'models',
    })).resolves.toEqual({ ok: true, items: [] });
    expect(list).toHaveBeenCalledTimes(1);
    await registration.dispose();
  });

  it('rejects undeclared settings before HTTP binding or provider effects', async () => {
    const { handlers, registrar } = manager();
    const list = vi.fn(async () => []);
    const createHttp = vi.fn(() => http);
    const registration = registerMachineVoiceSpeechRpcHandlers({
      rpcHandlerManager: registrar as never,
      resolveSpeechRuntime: vi.fn(async () => ({
        runtime: { kind: 'speech' as const, catalog: { list } },
        contribution: contribution({ catalogs: [{ kind: 'models', settingFieldId: 'model', allowCustom: true }] }),
        readSettings: () => ({
          settings: { model: 'gemini-2.5-flash', apiKey: 'must-not-project' },
          resolveCredentials: () => credentials,
          isCurrent: () => true,
        }),
        createHttp,
        isCurrent: () => true,
        retirementSignal: new AbortController().signal,
        release: vi.fn(async () => undefined),
      })),
    });

    await expect(handlers.get(RPC_METHODS.DAEMON_VOICE_SPEECH_CATALOG)?.({
      target, catalog: 'models',
    })).resolves.toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    expect(createHttp).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
    await registration.dispose();
  });

  it('retires publication and the bound HTTP service when the settings snapshot changes', async () => {
    const { handlers, registrar } = manager();
    let settingsCurrent = true;
    let boundCurrentness: (() => boolean) | undefined;
    const createHttp = vi.fn((_signal: AbortSignal, isCurrent?: () => boolean) => {
      boundCurrentness = isCurrent;
      return http;
    });
    const list = vi.fn(async () => {
      settingsCurrent = false;
      return [];
    });
    const registration = registerMachineVoiceSpeechRpcHandlers({
      rpcHandlerManager: registrar as never,
      resolveSpeechRuntime: vi.fn(async () => ({
        runtime: { kind: 'speech' as const, catalog: { list } },
        contribution: contribution({ catalogs: [{ kind: 'models', settingFieldId: 'model', allowCustom: true }] }),
        readSettings: () => ({
          settings,
          resolveCredentials: () => credentials,
          isCurrent: () => settingsCurrent,
        }),
        createHttp,
        isCurrent: () => true,
        retirementSignal: new AbortController().signal,
        release: vi.fn(async () => undefined),
      })),
    });

    await expect(handlers.get(RPC_METHODS.DAEMON_VOICE_SPEECH_CATALOG)?.({
      target, catalog: 'models',
    })).resolves.toMatchObject({ ok: false, errorCode: 'provider_unavailable' });
    expect(boundCurrentness?.()).toBe(false);
    await registration.dispose();
  });

  it('preserves caller cancellation as the public cancelled error code', async () => {
    const { handlers, registrar } = manager();
    let markStarted: (() => void) | null = null;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const list = vi.fn(async (_request, context) => await new Promise<never>((_resolve, reject) => {
      markStarted?.();
      const rejectAbort = () => reject(Object.assign(new Error('catalog aborted'), { name: 'AbortError' }));
      if (context.signal.aborted) rejectAbort();
      else context.signal.addEventListener('abort', rejectAbort, { once: true });
    }));
    const registration = registerMachineVoiceSpeechRpcHandlers({
      rpcHandlerManager: registrar as never,
      resolveSpeechRuntime: resolveRuntime(
        { kind: 'speech', catalog: { list } },
        contribution({ catalogs: [{ kind: 'models', settingFieldId: 'model', allowCustom: true }] }),
      ),
    });
    const controller = new AbortController();
    const pending = handlers.get(RPC_METHODS.DAEMON_VOICE_SPEECH_CATALOG)?.(
      { target, catalog: 'models' },
      { signal: controller.signal },
    );
    await started;
    controller.abort();

    await expect(pending).resolves.toEqual({
      ok: false,
      errorCode: 'cancelled',
      error: 'cancelled',
      retryable: false,
    });
    await registration.dispose();
  });

  it('cancels provider work when the admitted generation retires', async () => {
    const { handlers, registrar } = manager();
    const retirement = new AbortController();
    let markStarted: (() => void) | null = null;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const list = vi.fn(async (_request, context) => await new Promise<never>((_resolve, reject) => {
      markStarted?.();
      const rejectAbort = () => reject(Object.assign(new Error('catalog retired'), { name: 'AbortError' }));
      if (context.signal.aborted) rejectAbort();
      else context.signal.addEventListener('abort', rejectAbort, { once: true });
    }));
    const release = vi.fn(async () => undefined);
    const registration = registerMachineVoiceSpeechRpcHandlers({
      rpcHandlerManager: registrar as never,
      resolveSpeechRuntime: vi.fn(async () => ({
        runtime: { kind: 'speech' as const, catalog: { list } },
        contribution: contribution({ catalogs: [{ kind: 'models', settingFieldId: 'model', allowCustom: true }] }),
        readSettings: () => Object.freeze({
          settings,
          resolveCredentials: () => credentials,
          isCurrent: () => !retirement.signal.aborted,
        }),
        createHttp: () => http,
        isCurrent: () => !retirement.signal.aborted,
        retirementSignal: retirement.signal,
        release,
      })),
    });
    const pending = handlers.get(RPC_METHODS.DAEMON_VOICE_SPEECH_CATALOG)?.({
      target, catalog: 'models',
    });
    await started;
    retirement.abort();

    await expect(pending).resolves.toEqual({
      ok: false,
      errorCode: 'provider_unavailable',
      error: 'provider_unavailable',
      retryable: false,
    });
    expect(release).toHaveBeenCalledTimes(1);
    await registration.dispose();
  });

  it('cancels provider work at the host operation deadline', async () => {
    vi.useFakeTimers();
    try {
      const { handlers, registrar } = manager();
      let markStarted: (() => void) | null = null;
      const started = new Promise<void>((resolve) => { markStarted = resolve; });
      const list = vi.fn(async (_request, context) => await new Promise<never>((_resolve, reject) => {
        markStarted?.();
        const rejectAbort = () => reject(Object.assign(new Error('catalog timed out'), { name: 'AbortError' }));
        if (context.signal.aborted) rejectAbort();
        else context.signal.addEventListener('abort', rejectAbort, { once: true });
      }));
      const registration = registerMachineVoiceSpeechRpcHandlers({
        rpcHandlerManager: registrar as never,
        resolveSpeechRuntime: resolveRuntime(
          { kind: 'speech', catalog: { list } },
          contribution({ catalogs: [{ kind: 'models', settingFieldId: 'model', allowCustom: true }] }),
        ),
      });
      const pending = handlers.get(RPC_METHODS.DAEMON_VOICE_SPEECH_CATALOG)?.({
        target, catalog: 'models',
      });
      await started;
      await vi.advanceTimersByTimeAsync(30_000);

      await expect(pending).resolves.toEqual({
        ok: false,
        errorCode: 'request_timeout',
        error: 'request_timeout',
        retryable: true,
      });
      await registration.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects retired nested selectors and targetless predecessor upload-init requests', async () => {
    const { handlers, registrar } = manager();
    const resolveSpeechRuntime = vi.fn();
    const registration = registerMachineVoiceSpeechRpcHandlers({
      rpcHandlerManager: registrar as never,
      resolveSpeechRuntime,
    });

    await expect(handlers.get(RPC_METHODS.DAEMON_VOICE_SPEECH_CATALOG)?.({
      target,
      catalog: 'models',
      providerId: 'google_gemini',
    })).resolves.toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
      retryable: false,
    });
    await expect(handlers.get(RPC_METHODS.DAEMON_VOICE_SPEECH_CATALOG)?.({
      target: { ...target, providerId: 'google_gemini' },
      catalog: 'models',
    })).resolves.toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
      retryable: false,
    });
    await expect(handlers.get(RPC_METHODS.DAEMON_VOICE_SPEECH_TRANSCRIBE_UPLOAD_INIT)?.({
      target,
      providerId: 'google_gemini',
      sizeBytes: 3,
      mimeType: 'audio/wav',
      fileName: 'recording.wav',
    })).resolves.toEqual({
      success: false,
      error: 'invalid_parameters',
      errorCode: 'invalid_parameters',
    });
    await expect(handlers.get(RPC_METHODS.DAEMON_VOICE_SPEECH_TRANSCRIBE_UPLOAD_INIT)?.({
      sizeBytes: 3,
      mimeType: 'audio/wav',
      fileName: 'recording.wav',
    })).resolves.toEqual({
      success: false,
      error: 'invalid_parameters',
      errorCode: 'invalid_parameters',
    });
    expect(resolveSpeechRuntime).not.toHaveBeenCalled();
    await registration.dispose();
  });

  it('passes host-owned bytes through the final transcribe ABI and enforces provider input limits', async () => {
    const { handlers, registrar } = manager();
    const transcribe = vi.fn(async (request, context) => {
      expect([...request.bytes]).toEqual([1, 2, 3]);
      expect(context.credentials).toBe(credentials);
      return { requestId: request.requestId, text: 'hello' };
    });
    const registration = registerMachineVoiceSpeechRpcHandlers({
      rpcHandlerManager: registrar as never,
      resolveSpeechRuntime: resolveRuntime(
        { kind: 'speech', transcribe },
        contribution({ limits: { transcribe: { maxInputBytes: 3 } } }),
      ),
    });
    const uploadId = await upload(handlers, new Uint8Array([1, 2, 3]));

    await expect(handlers.get(RPC_METHODS.DAEMON_VOICE_SPEECH_TRANSCRIBE)?.({
      target, requestId: 'stt-1', model: 'gemini-2.5-flash', language: null,
      mimeType: 'audio/wav', uploadId,
    })).resolves.toEqual({ ok: true, requestId: 'stt-1', text: 'hello' });
    const oversizedUploadId = await upload(handlers, new Uint8Array([1, 2, 3, 4]));
    await expect(handlers.get(RPC_METHODS.DAEMON_VOICE_SPEECH_TRANSCRIBE)?.({
      target, requestId: 'stt-2', model: 'gemini-2.5-flash', language: null,
      mimeType: 'audio/wav', uploadId: oversizedUploadId,
    })).resolves.toEqual({ ok: false, errorCode: 'invalid_parameters' });
    expect(transcribe).toHaveBeenCalledTimes(1);
    await registration.dispose();
  });

  it('rejects the first provider output byte over the effective host cap', async () => {
    const { handlers, registrar } = manager();
    const synthesize = vi.fn(async (request) => ({
      requestId: request.requestId,
      bytes: new Uint8Array([1, 2, 3, 4]),
      mimeType: 'audio/wav' as const,
    }));
    const registration = registerMachineVoiceSpeechRpcHandlers({
      rpcHandlerManager: registrar as never,
      resolveSpeechRuntime: resolveRuntime(
        { kind: 'speech', synthesize },
        contribution({ roles: ['conversation_tts'], limits: { synthesize: { maxOutputBytes: 3 } } }),
      ),
    });
    const recipient = createTransferRecipientKeyPair();

    await expect(handlers.get(RPC_METHODS.DAEMON_VOICE_SPEECH_SYNTHESIZE)?.({
      target, requestId: 'tts-over', input: 'Hello', model: null, voiceName: 'en-US-A',
      languageCode: null, format: 'wav', speakingRate: null, pitch: null,
      recipientPublicKeyBase64: recipient.recipientPublicKeyBase64,
    })).resolves.toEqual({ ok: false, errorCode: 'provider_response_invalid' });
    await registration.dispose();
  });

  it('rejects an invalid transfer key before runtime or credential access', async () => {
    const { handlers, registrar } = manager();
    const resolveSpeechRuntime = vi.fn();
    const registration = registerMachineVoiceSpeechRpcHandlers({
      rpcHandlerManager: registrar as never,
      resolveSpeechRuntime,
    });

    await expect(handlers.get(RPC_METHODS.DAEMON_VOICE_SPEECH_SYNTHESIZE)?.({
      target, requestId: 'tts-invalid-key', input: 'Hello', model: null, voiceName: 'en-US-A',
      languageCode: null, format: 'wav', speakingRate: null, pitch: null,
      recipientPublicKeyBase64: Buffer.alloc(31).toString('base64'),
    })).resolves.toEqual({ ok: false, errorCode: 'invalid_parameters' });
    expect(resolveSpeechRuntime).not.toHaveBeenCalled();
    await registration.dispose();
  });

  it('rejects a provider result with another request id before publication', async () => {
    const { handlers, registrar } = manager();
    const synthesize = vi.fn(async () => ({
      requestId: 'another-request',
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: 'audio/wav' as const,
    }));
    const registration = registerMachineVoiceSpeechRpcHandlers({
      rpcHandlerManager: registrar as never,
      resolveSpeechRuntime: resolveRuntime(
        { kind: 'speech', synthesize },
        contribution({ roles: ['conversation_tts'] }),
      ),
    });
    const recipient = createTransferRecipientKeyPair();

    await expect(handlers.get(RPC_METHODS.DAEMON_VOICE_SPEECH_SYNTHESIZE)?.({
      target, requestId: 'tts-request-id', input: 'Hello', model: null, voiceName: 'en-US-A',
      languageCode: null, format: 'wav', speakingRate: null, pitch: null,
      recipientPublicKeyBase64: recipient.recipientPublicKeyBase64,
    })).resolves.toEqual({ ok: false, errorCode: 'provider_response_invalid' });
    await registration.dispose();
  });

  it('never passes the transfer recipient key to synthesize and copies a shared subarray before publication', async () => {
    const { handlers, registrar } = manager();
    const backing = new Uint8Array(new SharedArrayBuffer(5));
    backing.set([9, 1, 2, 3, 9]);
    const providerBytes = backing.subarray(1, 4);
    const synthesize = vi.fn(async (request, context) => {
      expect(request).toEqual({
        requestId: 'tts-1', input: 'Hello', model: null, voiceName: 'en-US-A',
        languageCode: 'en-US', format: 'wav', speakingRate: null, pitch: null,
      });
      expect(request).not.toHaveProperty('recipientPublicKeyBase64');
      expect(context.credentials).toBe(credentials);
      return { requestId: request.requestId, bytes: providerBytes, mimeType: 'audio/wav' as const };
    });
    const registration = registerMachineVoiceSpeechRpcHandlers({
      rpcHandlerManager: registrar as never,
      resolveSpeechRuntime: resolveRuntime(
        { kind: 'speech', synthesize },
        contribution({ roles: ['conversation_tts'], limits: { synthesize: { maxOutputBytes: 3 } } }),
      ),
    });
    const recipient = createTransferRecipientKeyPair();
    const response = await handlers.get(RPC_METHODS.DAEMON_VOICE_SPEECH_SYNTHESIZE)?.({
      target, requestId: 'tts-1', input: 'Hello', model: null, voiceName: 'en-US-A',
      languageCode: 'en-US', format: 'wav', speakingRate: null, pitch: null,
      recipientPublicKeyBase64: recipient.recipientPublicKeyBase64,
    }) as Readonly<{ ok: true; downloadId: string }>;
    providerBytes.fill(8);
    const chunk = await handlers.get(RPC_METHODS.DAEMON_VOICE_SPEECH_DOWNLOAD_CHUNK)?.({
      downloadId: response.downloadId, index: 0,
    }) as Readonly<{ payloadBase64: string; encryptedDataKeyEnvelopeBase64: string }>;

    expect([...decryptEncryptedTransferChunkEnvelope({
      transferId: response.downloadId,
      sequence: 0,
      payloadBase64: chunk.payloadBase64,
      encryptedDataKeyEnvelopeBase64: chunk.encryptedDataKeyEnvelopeBase64,
      recipientSecretKeySeed: recipient.recipientSecretKeySeed,
    })]).toEqual([1, 2, 3]);
    await registration.dispose();
  });

  it('rejects stale or malformed provider output before publishing a download', async () => {
    const { handlers, registrar } = manager();
    let current = true;
    const synthesize = vi.fn(async () => {
      current = false;
      return { requestId: 'tts-2', bytes: new Uint8Array([1]), mimeType: 'audio/wav' as const };
    });
    const registration = registerMachineVoiceSpeechRpcHandlers({
      rpcHandlerManager: registrar as never,
      resolveSpeechRuntime: resolveRuntime(
        { kind: 'speech', synthesize },
        contribution({ roles: ['conversation_tts'] }),
        () => current,
      ),
    });
    const recipient = createTransferRecipientKeyPair();
    const response = await handlers.get(RPC_METHODS.DAEMON_VOICE_SPEECH_SYNTHESIZE)?.({
      target, requestId: 'tts-2', input: 'Hello', model: null, voiceName: 'en-US-A',
      languageCode: null, format: 'wav', speakingRate: null, pitch: null,
      recipientPublicKeyBase64: recipient.recipientPublicKeyBase64,
    });

    expect(response).toEqual({ ok: false, errorCode: 'provider_unavailable' });
    expect(response).not.toHaveProperty('downloadId');
    await registration.dispose();
  });

  it('fences an optional no-source settings action when Account Settings selects a source during execution', async () => {
    const { handlers, registrar } = manager();
    const settingsAction = {
      id: 'refresh-voice',
      title: 'Refresh voice',
      placement: { kind: 'contributionFooter' as const },
      confirmation: { kind: 'none' as const },
      patchFieldIds: ['model'],
    };
    const manifest = speechManifest({
      requirement: { kind: 'optional' },
      settingsActions: [settingsAction],
    });
    const declaredContribution = manifest.contributes.voiceProviders?.[0];
    if (!declaredContribution || declaredContribution.kind !== 'speech') {
      throw new Error('speech manifest fixture must include its speech contribution');
    }
    const providerId = `${target.pluginId}/${target.localId}`;
    const providerConfig = Object.freeze({ model: 'gemini-2.5-flash' });
    let snapshot = {
      source: 'network' as const,
      scopeKey: 'account-scope',
      settingsVersion: 1,
      loadedAtMs: 1,
      settingsSecretsReadKeys: [],
      settings: {
        voiceSettingsV1: {
          providers: {
            [providerId]: {
              schemaVersion: declaredContribution.settings.schemaVersion,
              config: providerConfig,
            },
          },
          credentialBindings: [],
        },
      } as never,
    };
    const execute = vi.fn(async () => {
      snapshot = {
        ...snapshot,
        settingsVersion: 2,
        settings: {
          voiceSettingsV1: {
            providers: {
              [providerId]: {
                schemaVersion: declaredContribution.settings.schemaVersion,
                config: providerConfig,
              },
            },
            credentialBindings: [{
              contribution: target,
              credentialSlotId: 'api_key',
              credentialSource: { kind: 'connectedAccount' },
              credentialBindings: { account: {} },
            }],
          },
          connectedAccountPurposeBindingsV1: {
            v: 1,
            bindings: [{
              purpose: { consumer: target, purpose: 'voice.speech' },
              target: {
                kind: 'account',
                account: {
                  service: { pluginId: 'happier.google', localId: 'oauth' },
                  accountId: 'google-a',
                },
              },
            }],
          },
        } as never,
      };
      return { patch: { model: 'refreshed-model' } };
    });
    const runtime: SpeechProviderRuntime & Readonly<{
      settingsActions: Readonly<{ execute: typeof execute }>;
    }> = Object.freeze({
      kind: 'speech',
      settingsActions: Object.freeze({ execute }),
    });
    const current = () => true;
    const currentInstallReviewPrincipal = Object.freeze({
      digest: PluginInstallReviewPrincipalDigestSchema.parse('d'.repeat(64)),
      presentation: null,
    });
    const connectedMaterialize = vi.fn();
    runtimeLeaseMocks.acquire.mockResolvedValueOnce({
      registry: {
        activateContributionsOnDemand: runtimeLeaseMocks.activateContributionsOnDemand,
        generation: 8,
        contributes: {
          activationTargets: [{ pluginId: target.pluginId, manifest }],
        },
        voiceSpeechProviders: {
          read: vi.fn(() => ({
            generation: '8',
            runtime,
            contribution: declaredContribution,
            isCurrent: current,
            retirementSignal: new AbortController().signal,
            createHttp: () => http,
          })),
        },
        resolveVoiceProviderRuntimeLifecycle: () => ({
          generation: 'immutable-generation-8',
          isCurrent: current,
          retirementSignal: new AbortController().signal,
        }),
        resolveConnectedAccountPurposeBindingOwner: () => ({
          materialize: connectedMaterialize,
        }),
      },
      release: runtimeLeaseMocks.release,
    });
    const registration = registerMachineVoiceSpeechRpcHandlers({
      rpcHandlerManager: registrar as never,
      machineId: 'machine-a',
      resolveRawCredentialDependencies: async () => ({
        currentInstallReviewPrincipal: { readCurrent: async () => currentInstallReviewPrincipal },
        readCurrentGrantAuthoritySource: async () => daemonGrantAuthority,
        grants: { list: async () => ({ grants: [], pendingRequests: [] }) },
        getAccountSettingsSnapshot: () => snapshot,
      }),
    });
    const executeSettingsAction = handlers.get(
      RPC_METHODS.DAEMON_VOICE_SPEECH_SETTINGS_ACTION_EXECUTE,
    );
    if (!executeSettingsAction) throw new Error('speech settings action RPC must be registered');

    const response = await executeSettingsAction({ target, actionId: settingsAction.id });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(response).toEqual({
      ok: false,
      errorCode: 'provider_unavailable',
    });
    await registration.dispose();
  });

  it('executes only a declared speech settings action with fresh daemon settings and settings credentials', async () => {
    const { handlers, registrar } = manager();
    const settingsActionCredentials: VoiceCredentialAccess<'settings'> = Object.freeze({
      phase: 'settings', mediated: null, raw: null,
    });
    let current = true;
    let retireAfterExecution = false;
    const execute = vi.fn(async (input, context) => {
      expect(input).toEqual({ actionId: 'refresh-voice', settings: { voiceName: 'en-US-A' } });
      expect(context.credentials).toBe(settingsActionCredentials);
      expect(context.credentials.phase).toBe('settings');
      expect(context.signal.aborted).toBe(false);
      expect(context.tools).toEqual([]);
      if (retireAfterExecution) current = false;
      return { patch: { voiceName: 'refreshed-voice' } };
    });
    const definition = contribution({
      roles: ['conversation_tts'],
      settings: {
        schemaVersion: 2,
        fields: [{
          id: 'voiceName',
          title: 'Voice',
          schema: { type: 'string', minLength: 1, maxLength: 256 },
          default: 'en-US-A',
          presentation: { control: 'text' },
        }],
        actions: [{
          id: 'refresh-voice',
          title: 'Refresh voice',
          placement: { kind: 'contributionFooter' },
          confirmation: { kind: 'none' },
          patchFieldIds: ['voiceName'],
        }],
      },
    });
    const runtime: SpeechProviderRuntime & Readonly<{
      settingsActions: Readonly<{ execute: typeof execute }>;
    }> = { kind: 'speech', settingsActions: { execute } };
    const registration = registerMachineVoiceSpeechRpcHandlers({
      rpcHandlerManager: registrar as never,
      resolveSpeechRuntime: vi.fn(async (): Promise<VoiceSpeechRuntimeLease> => ({
        runtime,
        contribution: definition,
        readSettings: () => Object.freeze({
          settings: Object.freeze({ voiceName: 'en-US-A' }),
          resolveCredentials: (_settings, _signal, phase = 'speech') => (
            phase === 'settings' ? settingsActionCredentials : credentials
          ),
          isCurrent: () => current,
        }),
        createHttp: () => http,
        isCurrent: () => current,
        retirementSignal: new AbortController().signal,
        release: vi.fn(async () => undefined),
      })),
    });
    const executeSettingsAction = handlers.get('daemon.voice.speech.settingsAction.execute');
    if (!executeSettingsAction) {
      throw new Error('speech settings action RPC must be registered');
    }

    await expect(executeSettingsAction({ target, actionId: 'refresh-voice' })).resolves.toEqual({
      ok: true,
      patch: { voiceName: 'refreshed-voice' },
    });
    expect(execute).toHaveBeenCalledTimes(1);

    await expect(executeSettingsAction({
      target,
      actionId: 'refresh-voice',
      settings: { voiceName: 'caller-controlled' },
    })).resolves.toMatchObject({ ok: false, errorCode: 'invalid_parameters' });

    retireAfterExecution = true;
    await expect(executeSettingsAction({ target, actionId: 'refresh-voice' })).resolves.toMatchObject({
      ok: false,
      errorCode: 'provider_unavailable',
    });
    await registration.dispose();
  });
});
