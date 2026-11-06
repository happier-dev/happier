
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import {
  PluginInstallReviewPrincipalDigestSchema,
  accountSettingsParse,
  resolveVoiceSpeechSettingsCorrespondence,
  type VoiceProviderContribution,
} from '@happier-dev/protocol';
import type { VoiceCredentialAccess } from '@happier-dev/plugin-sdk/voice';
import type { SpeechProviderRuntime } from '@happier-dev/plugin-sdk/voice/speech';
import type { HttpService } from '@happier-dev/plugin-sdk/http';
import type { PluginApi } from '@happier-dev/plugin-sdk';

import { readCanonicalPluginManifest } from '../../plugins/manifest/normalize';
import { createPluginManifestV2Fixture } from '../../plugins/testkit/manifestV2Fixture';
import { clearActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshot, setActiveAccountSettingsSnapshot, type ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { createConnectedAccountPurposeBindingOwner, type ConnectedAccountPurposeBindingOwnerDependencies } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { ConnectedPurposeCatalogV1Schema } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';

import {
  createEncryptedTransferChunkEnvelope,
  createTransferRecipientKeyPair,
  decryptEncryptedTransferChunkEnvelope,
} from '@happier-dev/transfers/node';

import {
  registerMachineVoiceSpeechRpcHandlers,
  type VoiceSpeechRuntimeLease,
} from './rpcHandlers.voiceSpeech';

const daemonGrantAuthority = Object.freeze({
  kind: 'machine_installation' as const,
  machineId: 'machine-1',
  installationId: 'installation-1',
});

const target = Object.freeze({ pluginId: 'acme.speech', localId: 'gemini-stt' });
const credentials: VoiceCredentialAccess<'speech'> = Object.freeze({
  phase: 'speech', mediated: null, raw: null,
});
const settings = Object.freeze({ model: 'gemini-2.5-flash' });
// The public SDK requires the operation matching each declared speech role.
// Unused provider-native boundaries refuse effects instead of returning data.
const unexpectedTranscribe: NonNullable<SpeechProviderRuntime['transcribe']> = async () => {
  throw new Error('Fixture must not invoke native transcription');
};
const unexpectedSynthesize: NonNullable<SpeechProviderRuntime['synthesize']> = async () => {
  throw new Error('Fixture must not invoke native synthesis');
};
const unexpectedCatalog: NonNullable<SpeechProviderRuntime['catalog']> = {
  async list() { throw new Error('Fixture must not invoke native catalog access'); },
};
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
        }, {
          id: 'format',
          title: 'Format',
          schema: { type: 'string', enum: ['mp3', 'wav'] },
          default: 'wav',
          presentation: {
            control: 'select',
            options: [{ value: 'mp3', title: 'MP3' }, { value: 'wav', title: 'WAV' }],
          },
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

const admittedFixtures: Awaited<ReturnType<typeof createAuthoredAdmittedPluginRuntimeFixture>>[] = [];
afterAll(async () => {
  const fixtures = admittedFixtures.splice(0).reverse();
  await Promise.all(fixtures.map((fixture) => fixture.lease.release()));
  for (const fixture of fixtures) await fixture.dispose();
});
afterEach(() => {
  clearActiveAccountSettingsSnapshot();
});

async function admitSpeech(
  runtime: SpeechProviderRuntime,
  definition: SpeechContribution = contribution(),
  options: Readonly<{
    snapshot?: ActiveAccountSettingsSnapshot;
    readSnapshot?: () => ActiveAccountSettingsSnapshot | null;
    settings?: Readonly<Record<string, unknown>>;
    settingsVersion?: number;
    materializeAccount?: ConnectedAccountPurposeBindingOwnerDependencies['materializeAccount'];
    manifest?: ReturnType<typeof speechManifest>;
    target?: typeof target | Readonly<{ pluginId: string; localId: string }>;
  }> = {},
) {
  const providerTarget = options.target ?? target;
  const operationSettings = options.settings ?? Object.freeze(Object.fromEntries(
    definition.settings.fields.map((field) => [field.id, field.default]),
  ));
  const snapshot = options.snapshot ?? {
    source: 'network', scopeKey: 'account-scope', settingsVersion: options.settingsVersion ?? 1, loadedAtMs: 1, settingsSecretsReadKeys: [],
    settings: accountSettingsParse({ voiceSettingsV1: { providers: {
      [`${providerTarget.pluginId}/${providerTarget.localId}`]: { schemaVersion: definition.settings.schemaVersion, config: operationSettings },
    } } }),
  } satisfies ActiveAccountSettingsSnapshot;
  setActiveAccountSettingsSnapshot(snapshot);
  const readSnapshot = options.readSnapshot ?? (() => getActiveAccountSettingsSnapshot());
  const unexpected = async (): Promise<never> => { throw new Error('Unexpected Account selection or listing'); };
  const connectedAccounts = createConnectedAccountPurposeBindingOwner({
    store: {
      read: async () => {
        const catalog = readSnapshot()?.connectedPurposeCatalog;
        if (catalog?.status !== 'ready' || catalog.record.key !== 'purposes') throw new Error('Purpose catalog unavailable');
        return catalog.record.value;
      }, update: unexpected, subscribe: () => ({ dispose() {} }),
    },
    selectTarget: unexpected,
    resolveTarget: async (selection) => selection.kind === 'account' ? { account: selection.account, displayName: 'Google Account' } : null,
    materializeAccount: options.materializeAccount ?? unexpected,
    projectTargetAccounts: unexpected, assertTargetAccountMaterializable: unexpected,
  });
  const fixture = await createAuthoredAdmittedPluginRuntimeFixture({
    controller: pluginReloadController,
    runtimeOptions: { connectedAccounts, resolveCurrentMachineId: () => 'machine-a' },
    plugins: [{
      manifest: options.manifest ?? createPluginManifestV2Fixture({ id: providerTarget.pluginId, contributes: { voiceProviders: [definition] } }),
      files: { 'daemon.mjs': `export function activate(api) { api.voiceProviders.register('${providerTarget.localId}', {kind:'speech'}); }` },
      instantiateCommittedModule: () => ({ activate(api: PluginApi) { api.voiceProviders.register(providerTarget.localId, runtime); } }),
    }],
  });
  admittedFixtures.push(fixture);
  return fixture;
}

async function retireSpeech() {
  const fixture = await createAuthoredAdmittedPluginRuntimeFixture({
    controller: pluginReloadController,
    plugins: [{ manifest: createPluginManifestV2Fixture({ id: target.pluginId }), files: { 'daemon.mjs': 'export function activate() {}' } }],
  });
  admittedFixtures.push(fixture);
}

function manager() {
  const registrar = new RpcHandlerManager({ scopePrefix: 'machine-a', encryptionMode: 'plain', logger() {} });
  return {
    handlers: { get: (method: string) => (raw: unknown, context?: Readonly<{ signal: AbortSignal }>) => registrar.invokeLocal(method, raw, context) },
    registrar,
  };
}

async function registerDefaultCatalogWithNoCredentialSource(options: Readonly<{
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

  const snapshot = {
    source: 'network' as const,
    scopeKey: 'account-scope',
    settingsVersion: 1,
    loadedAtMs: 1,
    settingsSecretsReadKeys: [],
    connectedPurposeCatalog: { status: 'ready', revision: 1,
      record: { key: 'purposes', value: ConnectedPurposeCatalogV1Schema.parse({ v: 1, bindings: [] }) } },
    settings: accountSettingsParse({
      voiceSettingsV1: {
        providers: {
          [`${target.pluginId}/${target.localId}`]: {
            schemaVersion: declaredContribution.settings.schemaVersion,
            config: operationSettings,
          },
        },
        credentialBindings: [],
      },
    }),
  } satisfies ActiveAccountSettingsSnapshot;
  await admitSpeech({kind: 'speech', catalog: {list: options.list}, transcribe: unexpectedTranscribe}, declaredContribution, {snapshot, manifest, materializeAccount: connectedMaterialize});
  const registration = registerMachineVoiceSpeechRpcHandlers({
    rpcHandlerManager: registrar,
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
  handlers: ReturnType<typeof manager>['handlers'],
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
  it('applies an admitted declared voice without replacing Account credentials or other speech settings', async () => {
    const { handlers, registrar } = manager();
    const preference = { providerContributionId: `${target.pluginId}/${target.localId}`,
      settingFieldPath: 'voiceName', value: ' session-custom-voice ' };
    const actualVoice = { ...preference, value: 'session-custom-voice' };
    const synthesize = vi.fn<NonNullable<SpeechProviderRuntime['synthesize']>>(async (request, context) => {
      expect(request).toMatchObject({ voiceName: 'session-custom-voice', format: 'wav' });
      expect(context.settings).toEqual({ voiceName: preference.value, format: 'wav' });
      expect(context.credentials).toEqual(credentials);
      return { requestId: request.requestId, bytes: new Uint8Array([1]), mimeType: 'audio/wav' };
    });
    await admitSpeech({ kind: 'speech', synthesize, catalog: unexpectedCatalog }, contribution({
        roles: ['conversation_tts'], catalogs: [{ kind: 'voices', settingFieldId: 'voiceName', allowCustom: true }],
      }));
    const registration = registerMachineVoiceSpeechRpcHandlers({
      rpcHandlerManager: registrar,
    });
    const recipient = createTransferRecipientKeyPair();
    try {
      await expect(handlers.get(RPC_METHODS.DAEMON_VOICE_SPEECH_SYNTHESIZE)?.({
        target, requestId: 'bound-voice', input: 'Hello', voicePreference: preference,
        recipientPublicKeyBase64: recipient.recipientPublicKeyBase64,
      })).resolves.toMatchObject({ ok: true, appliedVoice: actualVoice });
      await expect(handlers.get(RPC_METHODS.DAEMON_VOICE_SPEECH_SYNTHESIZE)?.({
        target, requestId: 'wrong-field', input: 'Hello',
        voicePreference: { ...preference, settingFieldPath: 'format', value: 'mp3' },
        recipientPublicKeyBase64: recipient.recipientPublicKeyBase64,
      })).resolves.toEqual({ ok: false, errorCode: 'invalid_parameters' });
      expect(synthesize).toHaveBeenCalledOnce();
    } finally { await registration.dispose(); }
  });
  it('pins a selected Connected Account revision for one speech callback and admits it for the next', async () => {
    const { handlers, registrar } = manager();
    const principal = PluginInstallReviewPrincipalDigestSchema.parse('a'.repeat(64));
    const manifest = speechManifest({ requirement: { kind: 'optional' } });
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

    const readSnapshot = (() => {
          const snapshot = {
            source: 'network' as const,
            scopeKey: 'account-scope',
            settingsVersion: 1,
            loadedAtMs: 1,
            settingsSecretsReadKeys: [],
            connectedPurposeCatalog: { status: 'ready', revision: 1, record: { key: 'purposes', value: ConnectedPurposeCatalogV1Schema.parse({ v: 1, bindings: [{
              purpose: { consumer: target, purpose: 'voice.speech' }, target: { kind: 'account',
                account: { service: { pluginId: 'happier.google', localId: 'oauth' }, accountId: 'google-a' } },
            }] }) } },
            settings: accountSettingsParse({
              voiceSettingsV1: {
                providers: {
                  [`${target.pluginId}/${target.localId}`]: {
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
            }),
          } satisfies ActiveAccountSettingsSnapshot;
          return () => snapshot;
        })();
    const fixture = await admitSpeech(runtime, manifest.contributes.voiceProviders!.find((candidate): candidate is SpeechContribution => candidate.kind === 'speech')!, { snapshot: readSnapshot(), readSnapshot, manifest, materializeAccount: materialize });
    const registration = registerMachineVoiceSpeechRpcHandlers({
      rpcHandlerManager: registrar,
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
        getAccountSettingsSnapshot: readSnapshot,
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

    expect(fixture.registry.voiceSpeechProviders?.read(target)?.isCurrent()).toBe(true);
    expect(materialize).toHaveBeenNthCalledWith(1, expect.objectContaining({
      account: { service: { pluginId: 'happier.google', localId: 'oauth' }, accountId: 'google-a' },
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
    await registration.dispose();
  });

  it('keeps an admitted catalog receipt while refusing fresh materialization through a newly selected Connected Account', async () => {
    const { handlers, registrar } = manager();
    const principal = PluginInstallReviewPrincipalDigestSchema.parse('c'.repeat(64));
    const manifest = speechManifest({ requirement: { kind: 'optional' } });
    const snapshotFor = (accountId: string, revision = 1): ActiveAccountSettingsSnapshot => Object.freeze({
      source: 'network' as const,
      scopeKey: 'account-scope',
      settingsVersion: revision,
      loadedAtMs: 1,
      settingsSecretsReadKeys: [],
      connectedPurposeCatalog: { status: 'ready' as const, revision, record: { key: 'purposes' as const, value: ConnectedPurposeCatalogV1Schema.parse({ v: 1, bindings: [{
        purpose: { consumer: target, purpose: 'voice.speech' }, target: { kind: 'account',
          account: { service: { pluginId: 'happier.google', localId: 'oauth' }, accountId } },
      }] }) } },
      settings: accountSettingsParse({
        voiceSettingsV1: {
          providers: {
            [`${target.pluginId}/${target.localId}`]: {
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
      }),
    });
    let currentSnapshot = snapshotFor('google-a');
    const credentialRevision = 'csr_0123456789ABCDEFGHJKMNPQRS';
    const materialize = vi.fn<ConnectedAccountPurposeBindingOwnerDependencies['materializeAccount']>(async (input) => {
      input.credentialRevisionBasis?.captureCredentialRevision(credentialRevision);
      return Object.freeze({
        kind: 'httpHeaders' as const,
        headers: { authorization: `Bearer ${input.account.accountId}` },
      });
    });
    let secondMaterializationError: unknown = null;
    const listCatalog: NonNullable<SpeechProviderRuntime['catalog']>['list'] = async (_request, context) => {
      if (!context.credentials.raw) throw new Error('raw credential access must be available');
      await expect(context.credentials.raw.materialize(rawRequest)).resolves.toEqual({
        kind: 'httpHeaders',
        headers: { authorization: 'Bearer google-a' },
      });
      currentSnapshot = snapshotFor('google-b', 2);
      setActiveAccountSettingsSnapshot(currentSnapshot);
      try {
        await context.credentials.raw.materialize(rawRequest);
      } catch (error) {
        secondMaterializationError = error;
      }
      return [];
    };
    const runtime: SpeechProviderRuntime = Object.freeze({
      kind: 'speech',
      catalog: Object.freeze({ list: listCatalog }),
      async transcribe(request) { return { requestId: request.requestId, text: '' }; },
    });

    await admitSpeech(runtime, manifest.contributes.voiceProviders!.find((candidate): candidate is SpeechContribution => candidate.kind === 'speech')!, { snapshot: currentSnapshot, readSnapshot: () => currentSnapshot, manifest, materializeAccount: materialize });
    const registration = registerMachineVoiceSpeechRpcHandlers({
      rpcHandlerManager: registrar,
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
      account: expect.objectContaining({ accountId: 'google-a' }),
    }));
    expect(response).toEqual({ ok: true, items: [] });
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
    const list = vi.fn<NonNullable<SpeechProviderRuntime['catalog']>['list']>(async (_request, context) => {
      expect(context.credentials).toEqual({ phase: 'speech', mediated: null, raw: null });
      return [];
    });
    const { handlers, registration, connectedMaterialize } = await registerDefaultCatalogWithNoCredentialSource({
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
    const list = vi.fn<NonNullable<SpeechProviderRuntime['catalog']>['list']>(async () => []);
    const { handlers, registration, connectedMaterialize } = await registerDefaultCatalogWithNoCredentialSource({
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
    const list = vi.fn<NonNullable<SpeechProviderRuntime['catalog']>['list']>(async (_request, context) => {
      expect(context.credentials).toEqual(credentials);
      expect(context.settings).toEqual(settings);
      expect(Object.isFrozen(context.settings)).toBe(true);
      expect(context.http.request).toEqual(expect.any(Function));
      expect(context.signal.aborted).toBe(false);
      return [{ id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', metadata: {} }];
    });
    await admitSpeech({ kind: 'speech', catalog: { list }, transcribe: vi.fn() }, contribution({ catalogs: [{ kind: 'models', settingFieldId: 'model', allowCustom: true }] }));
    const registration = registerMachineVoiceSpeechRpcHandlers({
      rpcHandlerManager: registrar,
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
    const list = vi.fn<NonNullable<SpeechProviderRuntime['catalog']>['list']>(async (_request, context) => {
      mutableSettings.model = 'changed-after-dispatch';
      mutableSettings.options.language = 'fr';
      expect(context.settings).toEqual({ model: 'gemini-2.5-flash', options: { language: 'en' } });
      expect(Object.isFrozen(context.settings)).toBe(true);
      expect(Object.isFrozen(context.settings.options)).toBe(true);
      expect(context.http.request).toEqual(expect.any(Function));
      return [];
    });
    await admitSpeech({ kind: 'speech' as const, catalog: { list }, transcribe: unexpectedTranscribe }, nestedContribution, { settings: mutableSettings });
    const registration = registerMachineVoiceSpeechRpcHandlers({
      rpcHandlerManager: registrar,
    });

    await expect(handlers.get(RPC_METHODS.DAEMON_VOICE_SPEECH_CATALOG)?.({
      target, catalog: 'models',
    })).resolves.toEqual({ ok: true, items: [] });
    expect(list).toHaveBeenCalledTimes(1);
    await registration.dispose();
  });

  it('rejects undeclared settings before HTTP binding or provider effects', async () => {
    const { handlers, registrar } = manager();
    const list = vi.fn<NonNullable<SpeechProviderRuntime['catalog']>['list']>(async () => []);
    await admitSpeech({ kind: 'speech' as const, catalog: { list }, transcribe: unexpectedTranscribe }, contribution({ catalogs: [{ kind: 'models', settingFieldId: 'model', allowCustom: true }] }), { settings: { model: 'gemini-2.5-flash', apiKey: 'must-not-project' } });
    const registration = registerMachineVoiceSpeechRpcHandlers({
      rpcHandlerManager: registrar,
    });

    await expect(handlers.get(RPC_METHODS.DAEMON_VOICE_SPEECH_CATALOG)?.({
      target, catalog: 'models',
    })).resolves.toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    expect(list).not.toHaveBeenCalled();
    await registration.dispose();
  });

  it('keeps an admitted catalog receipt after settings change and closes its settled HTTP scope', async () => {
    const { handlers, registrar } = manager();
    let boundHttp: Pick<HttpService, 'request'> | undefined;
    const list = vi.fn<NonNullable<SpeechProviderRuntime['catalog']>['list']>(async (_request, context) => {
      boundHttp = context.http;
      const snapshot = getActiveAccountSettingsSnapshot();
      if (!snapshot) throw new Error('Expected admitted speech settings');
      setActiveAccountSettingsSnapshot({ ...snapshot, settingsVersion: 2,
        settings: accountSettingsParse({ voiceSettingsV1: { providers: {
          [`${target.pluginId}/${target.localId}`]: { schemaVersion: 2, config: { model: 'changed-model' } },
        } } }),
      });
      return [];
    });
    await admitSpeech({ kind: 'speech' as const, catalog: { list }, transcribe: unexpectedTranscribe }, contribution({ catalogs: [{ kind: 'models', settingFieldId: 'model', allowCustom: true }] }), { settings: settings });
    const registration = registerMachineVoiceSpeechRpcHandlers({
      rpcHandlerManager: registrar,
    });

    await expect(handlers.get(RPC_METHODS.DAEMON_VOICE_SPEECH_CATALOG)?.({
      target, catalog: 'models',
    })).resolves.toEqual({ ok: true, items: [] });
    await expect(boundHttp?.request({ method: 'GET', url: 'https://speech.example.test', redirect: 'error' })).rejects.toMatchObject({ name: 'AbortError' });
    await registration.dispose();
  });

  it('preserves caller cancellation as the public cancelled error code', async () => {
    const { handlers, registrar } = manager();
    let markStarted: (() => void) | null = null;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const list = vi.fn<NonNullable<SpeechProviderRuntime['catalog']>['list']>(async (_request, context) => await new Promise<never>((_resolve, reject) => {
      markStarted?.();
      const rejectAbort = () => reject(Object.assign(new Error('catalog aborted'), { name: 'AbortError' }));
      if (context.signal.aborted) rejectAbort();
      else context.signal.addEventListener('abort', rejectAbort, { once: true });
    }));
    await admitSpeech({ kind: 'speech', catalog: { list }, transcribe: unexpectedTranscribe }, contribution({ catalogs: [{ kind: 'models', settingFieldId: 'model', allowCustom: true }] }));
    const registration = registerMachineVoiceSpeechRpcHandlers({
      rpcHandlerManager: registrar,
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

  it('keeps an admitted finite catalog pending across retirement and refuses the next acquisition', async () => {
    const { handlers, registrar } = manager();
    let markStarted: (() => void) | null = null;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let complete: (() => void) | undefined;
    const completed = new Promise<void>((resolve) => { complete = resolve; });
    let providerSignal: AbortSignal | undefined;
    const list = vi.fn<NonNullable<SpeechProviderRuntime['catalog']>['list']>(async (_request, context) => {
      providerSignal = context.signal;
      markStarted?.();
      await completed;
      return [];
    });
    await admitSpeech({ kind: 'speech' as const, catalog: { list }, transcribe: unexpectedTranscribe }, contribution({ catalogs: [{ kind: 'models', settingFieldId: 'model', allowCustom: true }] }), { settings: settings });
    const registration = registerMachineVoiceSpeechRpcHandlers({
      rpcHandlerManager: registrar,
    });
    const pending = handlers.get(RPC_METHODS.DAEMON_VOICE_SPEECH_CATALOG)?.({
      target, catalog: 'models',
    });
    try {
      await started;
      await retireSpeech();
      expect(providerSignal?.aborted).toBe(false);
      complete?.();
      await expect(pending).resolves.toEqual({ ok: true, items: [] });
      expect(pluginReloadController.getState().activeRegistry?.voiceSpeechProviders?.read(target)).toBeNull();
      await expect(handlers.get(RPC_METHODS.DAEMON_VOICE_SPEECH_CATALOG)?.({
        target, catalog: 'models',
      })).resolves.toMatchObject({ ok: false, errorCode: 'provider_unavailable' });
    } finally {
      complete?.();
      await pending;
      await registration.dispose();
    }
  });

  it.each(['transcribe', 'synthesize'] as const)('keeps admitted finite %s alive through retirement and returns its receipt', async (kind) => {
    const { handlers, registrar } = manager();
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    let complete: (() => void) | undefined;
    const completed = new Promise<void>(resolve => { complete = resolve; });
    let providerSignal: AbortSignal | undefined;
    const awaitProvider = async (signal: AbortSignal) => {
      providerSignal = signal;
      markStarted?.();
      await completed;
    };
    const runtime: SpeechProviderRuntime = kind === 'transcribe'
      ? { kind: 'speech', async transcribe(request, context) {
          await awaitProvider(context.signal);
          return { requestId: request.requestId, text: 'retained editable transcript' };
        } }
      : { kind: 'speech', async synthesize(request, context) {
          await awaitProvider(context.signal);
          return { requestId: request.requestId, bytes: new Uint8Array([1, 2, 3]), mimeType: 'audio/wav' };
        } };
    await admitSpeech(runtime, contribution({ roles: [kind === 'transcribe' ? 'dictation_stt' : 'conversation_tts'] }));
    const registration = registerMachineVoiceSpeechRpcHandlers({ rpcHandlerManager: registrar });
    const recipient = createTransferRecipientKeyPair();
    const pending = kind === 'transcribe'
      ? handlers.get(RPC_METHODS.DAEMON_VOICE_SPEECH_TRANSCRIBE)?.({
          target, requestId: 'finite-receipt', mimeType: 'audio/wav',
          uploadId: await upload(handlers, new Uint8Array([1, 2, 3])),
        })
      : handlers.get(RPC_METHODS.DAEMON_VOICE_SPEECH_SYNTHESIZE)?.({
          target, requestId: 'finite-receipt', input: 'Hello',
          recipientPublicKeyBase64: recipient.recipientPublicKeyBase64,
        });
    try {
      await started;
      await retireSpeech();
      expect(providerSignal?.aborted).toBe(false);
      complete?.();
      await expect(pending).resolves.toMatchObject(kind === 'transcribe'
        ? { ok: true, requestId: 'finite-receipt', text: 'retained editable transcript' }
        : { ok: true, requestId: 'finite-receipt', mimeType: 'audio/wav', sizeBytes: 3 });
    } finally {
      complete?.();
      await pending;
      await registration.dispose();
    }
  });

  it('keeps finite synthesis pending without a host deadline and releases it on caller cancellation', async () => {
    try {
      const { handlers, registrar } = manager();
      let markStarted: (() => void) | null = null;
      const started = new Promise<void>((resolve) => { markStarted = resolve; });
      let providerSignal: AbortSignal | undefined;
      const synthesize = vi.fn<NonNullable<SpeechProviderRuntime['synthesize']>>(async (_request, context) => await new Promise<never>((_resolve, reject) => {
        providerSignal = context.signal;
        markStarted?.();
        const rejectAbort = () => reject(Object.assign(new Error('catalog timed out'), { name: 'AbortError' }));
        if (context.signal.aborted) rejectAbort();
        else context.signal.addEventListener('abort', rejectAbort, { once: true });
      }));
      await admitSpeech({ kind: 'speech', synthesize }, contribution({ roles: ['conversation_tts'] }));
      vi.useFakeTimers();
      const registration = registerMachineVoiceSpeechRpcHandlers({
        rpcHandlerManager: registrar,
      });
      const controller = new AbortController();
      const recipient = createTransferRecipientKeyPair();
      let settled = false;
      const pending = handlers.get(RPC_METHODS.DAEMON_VOICE_SPEECH_SYNTHESIZE)?.({
        target, requestId: 'tts-pending', input: 'Hello',
        recipientPublicKeyBase64: recipient.recipientPublicKeyBase64,
      }, { signal: controller.signal });
      void pending?.then(() => { settled = true; });
      await started;
      try {
        await vi.advanceTimersByTimeAsync(60_001);
        expect(settled).toBe(false);
        expect(providerSignal?.aborted).toBe(false);
      } finally {
        controller.abort();
        await pending;
        await registration.dispose();
      }
      expect(providerSignal?.aborted).toBe(true);
      await expect(pending).resolves.toMatchObject({ ok: false, errorCode: 'cancelled' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects retired nested selectors and targetless predecessor upload-init requests', async () => {
    const { handlers, registrar } = manager();
    const list = vi.fn<NonNullable<SpeechProviderRuntime['catalog']>['list']>(async () => []);
    await admitSpeech({ kind: 'speech', catalog: { list }, transcribe: unexpectedTranscribe }, contribution({ catalogs: [{ kind: 'models', settingFieldId: 'model', allowCustom: true }] }));
    const registration = registerMachineVoiceSpeechRpcHandlers({
      rpcHandlerManager: registrar,
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
    expect(list).not.toHaveBeenCalled();
    await registration.dispose();
  });

  it('passes host-owned bytes through the final transcribe ABI and enforces provider input limits', async () => {
    const { handlers, registrar } = manager();
    const transcribe = vi.fn<NonNullable<SpeechProviderRuntime['transcribe']>>(async (request, context) => {
      expect([...request.bytes]).toEqual([1, 2, 3]);
      expect(context.credentials).toEqual(credentials);
      return { requestId: request.requestId, text: 'hello' };
    });
    await admitSpeech({ kind: 'speech', transcribe }, contribution({ limits: { transcribe: { maxInputBytes: 3 } } }));
    const registration = registerMachineVoiceSpeechRpcHandlers({
      rpcHandlerManager: registrar,
    });
    const uploadId = await upload(handlers, new Uint8Array([1, 2, 3]));

    await expect(handlers.get(RPC_METHODS.DAEMON_VOICE_SPEECH_TRANSCRIBE)?.({
      target, requestId: 'stt-1', mimeType: 'audio/wav', uploadId,
    })).resolves.toEqual({ ok: true, requestId: 'stt-1', text: 'hello' });
    const oversizedUploadId = await upload(handlers, new Uint8Array([1, 2, 3, 4]));
    await expect(handlers.get(RPC_METHODS.DAEMON_VOICE_SPEECH_TRANSCRIBE)?.({
      target, requestId: 'stt-2', mimeType: 'audio/wav', uploadId: oversizedUploadId,
    })).resolves.toEqual({ ok: false, errorCode: 'invalid_parameters' });
    expect(transcribe).toHaveBeenCalledTimes(1);
    await registration.dispose();
  });

  it.each([
    { limits: { maxInputUtf8Bytes: 6 }, input: '界界a', valid: '界界' },
    { limits: { maxInputCharacters: 100, maxInputCharactersSettingId: 'inputCap' }, input: 'abcdef', valid: 'abcde' },
  ])('enforces declared input units and selected settings before synthesis: $limits', async ({ limits, input, valid }) => {
    const { handlers, registrar } = manager();
    const base = contribution({ roles: ['conversation_tts'] });
    const synthesize = vi.fn<NonNullable<SpeechProviderRuntime['synthesize']>>(async (request) => ({
      requestId: request.requestId, bytes: new Uint8Array([1]), mimeType: 'audio/wav' as const,
    }));
    const definition = contribution({
      roles: ['conversation_tts'], limits: { synthesize: limits },
      settings: { ...base.settings, fields: [...base.settings.fields, {
        id: 'inputCap', title: 'Endpoint input cap', schema: { type: 'integer', minimum: 1, maximum: 100 },
        default: 5, presentation: { control: 'number', step: 1 },
      }] },
    });
    await admitSpeech({ kind: 'speech', synthesize }, definition);
    const registration = registerMachineVoiceSpeechRpcHandlers({
      rpcHandlerManager: registrar,
    });
    const recipient = createTransferRecipientKeyPair();
    const invoke = (text: string) => handlers.get(RPC_METHODS.DAEMON_VOICE_SPEECH_SYNTHESIZE)?.({
      target, requestId: 'tts-input-cap', input: text, recipientPublicKeyBase64: recipient.recipientPublicKeyBase64,
    });
    try {
      await expect(invoke(input)).resolves.toEqual({ ok: false, errorCode: 'invalid_parameters' });
      expect(synthesize).not.toHaveBeenCalled();
      await expect(invoke(valid)).resolves.toMatchObject({ ok: true });
    } finally { await registration.dispose(); }
  });

  it('rejects the first provider output byte over the effective host cap', async () => {
    const { handlers, registrar } = manager();
    const synthesize = vi.fn<NonNullable<SpeechProviderRuntime['synthesize']>>(async (request) => ({
      requestId: request.requestId,
      bytes: new Uint8Array([1, 2, 3, 4]),
      mimeType: 'audio/wav' as const,
    }));
    await admitSpeech({ kind: 'speech', synthesize }, contribution({ roles: ['conversation_tts'], limits: { synthesize: { maxOutputBytes: 3 } } }));
    const registration = registerMachineVoiceSpeechRpcHandlers({
      rpcHandlerManager: registrar,
    });
    const recipient = createTransferRecipientKeyPair();

    await expect(handlers.get(RPC_METHODS.DAEMON_VOICE_SPEECH_SYNTHESIZE)?.({
      target, requestId: 'tts-over', input: 'Hello',
      recipientPublicKeyBase64: recipient.recipientPublicKeyBase64,
    })).resolves.toEqual({ ok: false, errorCode: 'provider_response_invalid' });
    await registration.dispose();
  });

  it('rejects an invalid transfer key before runtime or credential access', async () => {
    const { handlers, registrar } = manager();
    // A misordered runtime lookup would return provider_unavailable from this
    // real admitted registry instead of the required key-validation refusal.
    await retireSpeech();
    const registration = registerMachineVoiceSpeechRpcHandlers({
      rpcHandlerManager: registrar,
    });

    await expect(handlers.get(RPC_METHODS.DAEMON_VOICE_SPEECH_SYNTHESIZE)?.({
      target, requestId: 'tts-invalid-key', input: 'Hello',
      recipientPublicKeyBase64: Buffer.alloc(31).toString('base64'),
    })).resolves.toEqual({ ok: false, errorCode: 'invalid_parameters' });
    expect(pluginReloadController.getState().activeRegistry?.voiceSpeechProviders?.read(target)).toBeNull();
    await registration.dispose();
  });

  it('rejects a provider result with another request id before publication', async () => {
    const { handlers, registrar } = manager();
    const synthesize = vi.fn<NonNullable<SpeechProviderRuntime['synthesize']>>(async () => ({
      requestId: 'another-request',
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: 'audio/wav' as const,
    }));
    await admitSpeech({ kind: 'speech', synthesize }, contribution({ roles: ['conversation_tts'] }));
    const registration = registerMachineVoiceSpeechRpcHandlers({
      rpcHandlerManager: registrar,
    });
    const recipient = createTransferRecipientKeyPair();

    await expect(handlers.get(RPC_METHODS.DAEMON_VOICE_SPEECH_SYNTHESIZE)?.({
      target, requestId: 'tts-request-id', input: 'Hello',
      recipientPublicKeyBase64: recipient.recipientPublicKeyBase64,
    })).resolves.toEqual({ ok: false, errorCode: 'provider_response_invalid' });
    await registration.dispose();
  });

  it('never passes the transfer recipient key to synthesize and copies a shared subarray before publication', async () => {
    const { handlers, registrar } = manager();
    const backing = new Uint8Array(new SharedArrayBuffer(5));
    backing.set([9, 1, 2, 3, 9]);
    const providerBytes = backing.subarray(1, 4);
    const synthesize = vi.fn<NonNullable<SpeechProviderRuntime['synthesize']>>(async (request, context) => {
      expect(request).toEqual({
        requestId: 'tts-1', input: 'Hello', model: null, voiceName: 'en-US-A',
        languageCode: null, format: 'wav', speakingRate: null, pitch: null,
      });
      expect(request).not.toHaveProperty('recipientPublicKeyBase64');
      expect(context.credentials).toEqual(credentials);
      return { requestId: request.requestId, bytes: providerBytes, mimeType: 'audio/wav' as const };
    });
    await admitSpeech({ kind: 'speech', synthesize }, contribution({ roles: ['conversation_tts'], limits: { synthesize: { maxOutputBytes: 3 } } }));
    const registration = registerMachineVoiceSpeechRpcHandlers({
      rpcHandlerManager: registrar,
    });
    const recipient = createTransferRecipientKeyPair();
    const response = await handlers.get(RPC_METHODS.DAEMON_VOICE_SPEECH_SYNTHESIZE)?.({
      target, requestId: 'tts-1', input: 'Hello',
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

  it('executes the canonical public-authoring TTS declaration through the daemon correspondence boundary', async () => {
    // The public-authoring example is a plugin-authoring fixture, not CLI
    // source: a literal module specifier resolves the example .ts files into
    // this program and violates the CLI rootDir invariant (see the tsconfig
    // exclude note), so load the fixture through its file URL like the other
    // public-authoring consumers do. The asserted shapes are the only fields
    // this fixture reads.
    const [{ manifest }, { textToSpeechRuntime }] = await Promise.all([
      import(new URL(
        '../../../../../packages/plugin-sdk/examples/public-authoring/index.ts',
        import.meta.url,
      ).href) as Promise<Readonly<{
        manifest: Readonly<{
          contributes: Readonly<{
            voiceProviders?: readonly VoiceProviderContribution[];
          }>;
        }>;
      }>>,
      import(new URL(
        '../../../../../packages/plugin-sdk/examples/public-authoring/voiceSpeechProvider.ts',
        import.meta.url,
      ).href) as Promise<Readonly<{
        textToSpeechRuntime: SpeechProviderRuntime;
      }>>,
    ]);
    const authored = manifest.contributes.voiceProviders?.find((entry) => entry.id === 'speech-tts');
    if (!authored || authored.kind !== 'speech') {
      throw new Error('public_authoring_tts_declaration_required');
    }
    const authoredSettings = Object.freeze(Object.fromEntries(
      authored.settings.fields.map((field) => [field.id, field.default]),
    ));
    expect(resolveVoiceSpeechSettingsCorrespondence({
      contribution: authored,
      settings: authoredSettings,
    }).synthesize).toMatchObject({ voiceName: 'synthetic-voice', format: 'wav' });
    const { handlers, registrar } = manager();
    await admitSpeech(textToSpeechRuntime, authored, { target: { pluginId: 'examples.public-sdk-review-assistant', localId: 'speech-tts' } });
    const registration = registerMachineVoiceSpeechRpcHandlers({
      rpcHandlerManager: registrar,
    });
    const recipient = createTransferRecipientKeyPair();
    const response = await handlers.get(RPC_METHODS.DAEMON_VOICE_SPEECH_SYNTHESIZE)?.({
      target: { pluginId: 'examples.public-sdk-review-assistant', localId: 'speech-tts' },
      requestId: 'public-authoring-tts',
      input: 'Hello from the public SDK',
      recipientPublicKeyBase64: recipient.recipientPublicKeyBase64,
    }) as Readonly<{ ok: boolean; downloadId?: string; mimeType?: string; errorCode?: string }>;
    if (!response.ok || !response.downloadId) {
      throw new Error(`public_authoring_tts_failed:${response.errorCode ?? 'unknown'}`);
    }
    const chunk = await handlers.get(RPC_METHODS.DAEMON_VOICE_SPEECH_DOWNLOAD_CHUNK)?.({
      downloadId: response.downloadId,
      index: 0,
    }) as Readonly<{ payloadBase64: string; encryptedDataKeyEnvelopeBase64: string }>;

    expect(response).toEqual(expect.objectContaining({ ok: true, mimeType: 'audio/wav' }));
    expect([...decryptEncryptedTransferChunkEnvelope({
      transferId: response.downloadId,
      sequence: 0,
      payloadBase64: chunk.payloadBase64,
      encryptedDataKeyEnvelopeBase64: chunk.encryptedDataKeyEnvelopeBase64,
      recipientSecretKeySeed: recipient.recipientSecretKeySeed,
    })]).toEqual([82, 73, 70, 70]);
    await registration.dispose();
  });

  it('derives every ordinary synthesis setting from the admitted immutable daemon snapshot', async () => {
    const { handlers, registrar } = manager();
    const snapshotSettings = Object.freeze({
      voiceName: 'snapshot-voice',
      languageCode: 'fr-FR',
      format: 'wav',
      speakingRate: 1.25,
      pitch: -2,
    });
    const definition = contribution({
      roles: ['conversation_tts'],
      settings: {
        schemaVersion: 2,
        fields: [
          { id: 'voiceName', title: 'Voice', schema: { type: 'string', minLength: 1, maxLength: 256 }, default: 'default-voice', presentation: { control: 'text' } },
          { id: 'languageCode', title: 'Language', schema: { type: 'string', maxLength: 64 }, default: '', presentation: { control: 'text' } },
          { id: 'format', title: 'Format', schema: { type: 'string', enum: ['mp3', 'wav'] }, default: 'mp3', presentation: { control: 'select', options: [{ value: 'mp3', title: 'MP3' }, { value: 'wav', title: 'WAV' }] } },
          { id: 'speakingRate', title: 'Rate', schema: { type: 'number', minimum: 0.25, maximum: 4 }, default: 1, presentation: { control: 'number' } },
          { id: 'pitch', title: 'Pitch', schema: { type: 'number', minimum: -20, maximum: 20 }, default: 0, presentation: { control: 'number' } },
        ],
      },
    });
    const synthesize = vi.fn<NonNullable<SpeechProviderRuntime['synthesize']>>(async (request) => {
      expect(request).toEqual({
        requestId: 'tts-snapshot',
        input: 'Hello',
        model: null,
        ...snapshotSettings,
      });
      return { requestId: request.requestId, bytes: new Uint8Array([1]), mimeType: 'audio/wav' as const };
    });
    await admitSpeech({ kind: 'speech', synthesize }, definition, { settings: snapshotSettings });
    const registration = registerMachineVoiceSpeechRpcHandlers({
      rpcHandlerManager: registrar,
    });
    const recipient = createTransferRecipientKeyPair();

    const response = await handlers.get(RPC_METHODS.DAEMON_VOICE_SPEECH_SYNTHESIZE)?.({
      target,
      requestId: 'tts-snapshot',
      input: 'Hello',
      recipientPublicKeyBase64: recipient.recipientPublicKeyBase64,
    });

    expect(response).toMatchObject({ ok: true, requestId: 'tts-snapshot', mimeType: 'audio/wav' });
    expect(synthesize).toHaveBeenCalledOnce();
    await registration.dispose();
  });

  it('returns an admitted settings patch when Account Settings selects a source during execution', async () => {
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
    let snapshot: ActiveAccountSettingsSnapshot = {
      source: 'network' as const,
      scopeKey: 'account-scope',
      settingsVersion: 1,
      loadedAtMs: 1,
      settingsSecretsReadKeys: [],
      connectedPurposeCatalog: { status: 'ready', revision: 1,
        record: { key: 'purposes', value: ConnectedPurposeCatalogV1Schema.parse({ v: 1, bindings: [] }) } },
      settings: accountSettingsParse({
        voiceSettingsV1: {
          providers: {
            [providerId]: {
              schemaVersion: declaredContribution.settings.schemaVersion,
              config: providerConfig,
            },
          },
          credentialBindings: [],
        },
      }),
    };
    const execute = vi.fn(async () => {
      snapshot = {
        ...snapshot,
        settingsVersion: 2,
        connectedPurposeCatalog: { status: 'ready', revision: 2, record: { key: 'purposes', value: ConnectedPurposeCatalogV1Schema.parse({ v: 1, bindings: [{
          purpose: { consumer: target, purpose: 'voice.speech' }, target: { kind: 'account',
            account: { service: { pluginId: 'happier.google', localId: 'oauth' }, accountId: 'google-a' } },
        }] }) } },
        settings: accountSettingsParse({
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
        }),
      };
      setActiveAccountSettingsSnapshot(snapshot);
      return { patch: { model: 'refreshed-model' } };
    });
    const runtime: SpeechProviderRuntime & Readonly<{
      settingsActions: Readonly<{ execute: typeof execute }>;
    }> = Object.freeze({
      kind: 'speech',
      settingsActions: Object.freeze({ execute }),
      transcribe: unexpectedTranscribe,
      catalog: unexpectedCatalog,
    });
    const currentInstallReviewPrincipal = Object.freeze({
      digest: PluginInstallReviewPrincipalDigestSchema.parse('d'.repeat(64)),
      presentation: null,
    });
    const connectedMaterialize = vi.fn();

    await admitSpeech(runtime, declaredContribution, { snapshot, readSnapshot: () => snapshot, manifest, materializeAccount: connectedMaterialize });
    const registration = registerMachineVoiceSpeechRpcHandlers({
      rpcHandlerManager: registrar,
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

    const response = await executeSettingsAction({
      target,
      actionId: settingsAction.id,
      expectedSettingsVersion: 1,
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(response).toEqual({
      ok: true,
      patch: { model: 'refreshed-model' },
    });
    await registration.dispose();
  });

  it('refuses a lagging settings revision before execution and returns an admitted patch through retirement', async () => {
    const { handlers, registrar } = manager();
    const settingsActionCredentials: VoiceCredentialAccess<'settings'> = Object.freeze({
      phase: 'settings', mediated: null, raw: null,
    });
    let retireAfterExecution = false;
    let cancelAfterExecution: AbortController | null = null;
    const execute: NonNullable<VoiceSpeechRuntimeLease['runtime']['settingsActions']>['execute'] = vi.fn(async (input, context) => {
      expect(input).toEqual({
        actionId: 'refresh-voice',
        settings: { voiceName: 'lagging-daemon-voice', format: 'wav' },
      });
      expect(context.credentials).toEqual(settingsActionCredentials);
      expect(context.credentials.phase).toBe('settings');
      expect(context.signal.aborted).toBe(false);
      expect(context.tools).toEqual([]);
      if (retireAfterExecution) await retireSpeech();
      cancelAfterExecution?.abort();
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
        }, {
          id: 'format',
          title: 'Format',
          schema: { type: 'string', enum: ['wav'] },
          default: 'wav',
          presentation: { control: 'select', options: [{ value: 'wav', title: 'WAV' }] },
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
    }> = { kind: 'speech', settingsActions: { execute }, synthesize: unexpectedSynthesize };
    await admitSpeech(runtime, definition, { settings: Object.freeze({ voiceName: 'lagging-daemon-voice', format: 'wav' }), settingsVersion: 7 });
    const registration = registerMachineVoiceSpeechRpcHandlers({
      rpcHandlerManager: registrar,
    });
    const executeSettingsAction = handlers.get('daemon.voice.speech.settingsAction.execute');
    if (!executeSettingsAction) {
      throw new Error('speech settings action RPC must be registered');
    }

    await expect(executeSettingsAction({
      target,
      actionId: 'refresh-voice',
      expectedSettingsVersion: 6,
    })).resolves.toEqual({
      ok: false,
      errorCode: 'provider_unavailable',
    });
    expect(execute).not.toHaveBeenCalled();

    await expect(executeSettingsAction({
      target,
      actionId: 'refresh-voice',
      expectedSettingsVersion: 7,
    })).resolves.toEqual({
      ok: true,
      patch: { voiceName: 'refreshed-voice' },
    });
    expect(execute).toHaveBeenCalledTimes(1);

    cancelAfterExecution = new AbortController();
    await expect(executeSettingsAction({
      target,
      actionId: 'refresh-voice',
      expectedSettingsVersion: 7,
    }, { signal: cancelAfterExecution.signal })).resolves.toMatchObject({
      ok: false,
      errorCode: 'cancelled',
    });
    cancelAfterExecution = null;

    retireAfterExecution = true;
    await expect(executeSettingsAction({
      target,
      actionId: 'refresh-voice',
      expectedSettingsVersion: 7,
    })).resolves.toMatchObject({
      ok: true,
      patch: { voiceName: 'refreshed-voice' },
    });
    await registration.dispose();
  });
});
