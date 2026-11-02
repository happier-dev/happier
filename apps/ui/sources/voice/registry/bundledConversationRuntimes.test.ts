import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginApi } from '@happier-dev/plugin-sdk';
import { createRecipientContractDigestV1 } from '@happier-dev/protocol';
import { PluginProjectionV2Schema } from '@happier-dev/protocol';
import { normalizePluginUiProjection } from '@/sync/domains/plugins/ui/projection';
import { reconcileAppShellProjectedClientExecutables, unloadAppShellProjectedClientExecutables } from '@/components/appShell/plugins/appShellClientExecutableActivation';
import { createPluginUiExecutableModuleHost } from '@/components/plugins/reactNative/executableModuleHost';
import { createDefaultVoiceProviderRegistry } from './defaultRegistry';
import { projectVoiceProviderSelectionRows } from './providerSelection';

import { log } from '@/log';
import { storage } from '@/sync/domains/state/storage';
import { voiceSettingsParse } from '@/sync/domains/settings/voiceSettings';
import '@/sync/syncEngine';
import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { createConnectedPurposeCatalogHttpBoundary } from '@/dev/testkit/harness/connectedAccountCatalogBoundary';
import { answerVoiceRealtimePreparationHttpRequest } from '@/dev/testkit/harness/voiceRealtimePreparationHttpBoundary';
import { createBundledVoiceRecipientContract } from '@/voice/credentials/voiceRecipientContract';
import {
  createBundledConversationRuntimeHostLease,
  type BundledConversationRuntimeHost,
} from './bundledConversationRuntimeHost';
import {
  getExternalVoiceProviderRegistration,
  subscribeExternalVoiceProviderRegistrations,
} from './externalVoiceProviderRegistrations';
import {
  BUNDLED_FIRST_PARTY_VOICE_CONVERSATION_RUNTIME_ENTRIES,
} from './generatedBundledVoiceRuntimeEntries';
import {
  type BundledConversationRuntimeEntry,
  createBundledConversationRuntimes,
  isBundledHostedConversationEntryAuthorized,
} from './bundledConversationRuntimes';

/** Let a swallowed commit rejection and its teardown settle before asserting. */
async function flushPendingActivationWork(): Promise<void> {
  await new Promise((resolve) => { setTimeout(resolve, 0); });
}

function createPublicEntry(input: Readonly<{
  providerId: string;
  activateError?: Error;
  resumption?: 'none' | 'resume';
  dispose?: () => Promise<void>;
}>): BundledConversationRuntimeEntry {
  const localId = input.providerId.replaceAll('_', '-');
  const declaration = Object.freeze({
    id: localId,
    title: input.providerId,
    kind: 'conversation' as const,
    roles: ['realtime_conversation' as const],
    platforms: ['web' as const],
    capabilities: Object.freeze({
      turn: Object.freeze({
        cancelResponse: false,
        bargeIn: false,
        ...(input.resumption ? { resumption: input.resumption } : {}),
      }),
      tools: Object.freeze({ effectCalls: 'none' as const }),
    }),
    client: Object.freeze({
      artifactId: 'voice-runtime',
      exportName: 'activate' as const,
    }),
  });
  return Object.freeze({
    pluginId: 'test.voice',
    providerId: `test.voice/${localId}`,
    declaration,
    activate(api: Pick<PluginApi, 'voiceProviders'>) {
      if (input.activateError) throw input.activateError;
      api.voiceProviders.register(localId, Object.freeze({
        kind: 'conversation' as const,
        protocol: Object.freeze({
          prepare: async () => Object.freeze({ kind: 'declined' as const, code: 'test' }),
          decodeControl: () => [],
          encodeTurnControl: () => null,
        }),
        createConnection: async () => { throw new Error('not_used'); },
        encodeToolResults: () => [],
        encodeToolContinuation: () => Object.freeze({}),
        encodeContextUpdate: () => [],
        encodeTextTurn: () => [],
        microphoneMode: 'provider_managed' as const,
        setInputMuted: () => {},
        ...(input.dispose ? { dispose: input.dispose } : {}),
      }));
    },
  });
}

function createCredentialSettingsEntry(): BundledConversationRuntimeEntry {
  const xaiEntry = BUNDLED_FIRST_PARTY_VOICE_CONVERSATION_RUNTIME_ENTRIES.find(
    (candidate) => candidate.declaration.id === 'realtime-grok',
  );
  if (!xaiEntry) throw new Error('realtime_grok bundled entry missing');
  return xaiEntry;
}

function installCredentialSettings(
  approvedRecipientContractDigest: string | undefined,
): Readonly<{ restore(): void }> {
  const previousVoiceSettings = storage.getState().settings.voiceSettingsV1;
  const previousSecrets = storage.getState().settings.secrets;
  const xaiDeclaration = BUNDLED_FIRST_PARTY_VOICE_CONVERSATION_RUNTIME_ENTRIES.find(
    (entry) => entry.providerId === 'happier.voice.xai/realtime-grok',
  )?.declaration;
  if (!xaiDeclaration?.settings) throw new Error('realtime_grok settings missing');
  const providerConfig = Object.fromEntries(
    xaiDeclaration.settings.fields.map((field) => [field.id, field.default]),
  );
  const voice = voiceSettingsParse({
    providerId: 'happier.voice.xai/realtime-grok',
    providers: {
      'happier.voice.xai/realtime-grok': {
        schemaVersion: 1,
        config: providerConfig,
      },
    },
  });
  storage.setState((current) => ({
    ...current,
    settings: {
      ...current.settings,
      voiceSettingsV1: {
        ...voice,
        credentialBindings: [Object.freeze({
          contribution: Object.freeze({
            pluginId: 'happier.voice.xai',
            localId: 'realtime-grok',
          }),
          credentialSlotId: 'api_key',
          credentialSource: Object.freeze({ kind: 'savedSecret' as const }),
          credentialBindings: Object.freeze({
            account: Object.freeze({ api_key: 'bundled-approval-secret' }),
          }),
          ...(approvedRecipientContractDigest
            ? { approvedRecipientContractDigest }
            : {}),
        })],
      },
      secrets: [Object.freeze({
        id: 'bundled-approval-secret',
        name: 'Bundled approval test',
        kind: 'apiKey' as const,
        encryptedValue: Object.freeze({
          _isSecretValue: true as const,
          value: 'bundled-account-secret',
        }),
        createdAt: 1,
        updatedAt: 1,
      })],
    },
  }) as never);
  return Object.freeze({
    restore() {
      storage.setState((current) => ({
        ...current,
        settings: {
          ...current.settings,
          voiceSettingsV1: previousVoiceSettings,
          secrets: previousSecrets,
        },
      }) as never);
    },
  });
}

describe('createBundledConversationRuntimes', () => {
  let account: Awaited<ReturnType<typeof createPlainArtifactHomeFixture>>;
  beforeEach(async () => {
    const purposes = createConnectedPurposeCatalogHttpBoundary();
    account = await createPlainArtifactHomeFixture('https://bundled-credentials.example.test', {
      handleRequest: async (path, init) => await purposes.handle(new URL(path, 'https://bundled-credentials.example.test'), init)
        ?? answerVoiceRealtimePreparationHttpRequest(new URL(path, 'https://bundled-credentials.example.test'), storage.getState().settings),
    });
    await purposes.hydrate({ serverId: account.home.id, accountId: 'artifact-account' });
  });
  afterEach(async () => {
    await account?.dispose();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('keeps activated bundled services when the daemon catalog settles, and removes withdrawn services', async () => {
    const lease = createBundledConversationRuntimeHostLease();
    const host = createPluginUiExecutableModuleHost();
    const runtimes = (await createBundledConversationRuntimes({
      bundledEntries: BUNDLED_FIRST_PARTY_VOICE_CONVERSATION_RUNTIME_ENTRIES,
      host: lease.host,
    }));
    const registry = createDefaultVoiceProviderRegistry();
    const settings = voiceSettingsParse({ providerId: 'local_direct' });
    const rows = () => projectVoiceProviderSelectionRows(settings, registry).map(({ entry, ...row }) => row);
    const initialRows = rows();
    expect(initialRows).toHaveLength(6);
    const builtInRows = initialRows.filter(row => registry.get(row.providerId)?.source.kind === 'built_in');
    const project = (withdrawn: boolean) => normalizePluginUiProjection(
      PluginProjectionV2Schema.parse({
        v: 2, generation: withdrawn ? 32 : 31,
        installedPackagesById: {}, agentsById: {}, actionsById: {}, toolsById: {},
        commandsById: {}, resourcesById: {}, settingsById: {}, diagnostics: [],
        familiesById: { voiceProviders: { family: 'voiceProviders', entriesById: withdrawn ? {} : Object.fromEntries(
          BUNDLED_FIRST_PARTY_VOICE_CONVERSATION_RUNTIME_ENTRIES.map(entry => [entry.providerId, {
            id: entry.providerId, pluginId: entry.pluginId, generation: 31,
            occurrenceId: `daemon-${entry.providerId}`, contributionKey: entry.providerId,
            definition: entry.declaration,
          }]),
        ) } },
      }));
    try {
      await reconcileAppShellProjectedClientExecutables({ projection: null, platform: 'web',
        voice: null, voiceProviderProjection: project(false), executableHost: host });
      expect(rows()).toEqual(initialRows);
      // Navigation/reconciliation uses the same admitted catalog; it must not retire the client bridge.
      await reconcileAppShellProjectedClientExecutables({ projection: null, platform: 'web',
        voice: null, voiceProviderProjection: project(false), executableHost: host });
      expect(rows()).toEqual(initialRows);
      await reconcileAppShellProjectedClientExecutables({ projection: null, platform: 'web',
        voice: null, voiceProviderProjection: project(true), executableHost: host });
      expect(rows()).toEqual(builtInRows);
    } finally {
      await unloadAppShellProjectedClientExecutables(host);
      await Promise.all(runtimes.map(runtime => runtime.dispose()));
      lease.revoke();
    }
  });

  /**
   * The re-approval fence is scoped to publishers Happier does not author:
   * `resolveRequiredRecipientContractApprovalDigestV1` returns `null` for a
   * `bundled` publisher, so a first-party release that changes its mediated
   * operations must not revoke an approval Happier itself wrote. This proves
   * the bundled COMPOSITION reaches the credential with that trust: it goes red
   * if the fence is reinstated for bundled, and red if the composition ever
   * stamps a non-bundled publisher on a first-party recipient contract. The
   * external-publisher fence stays proven at the account operation owner.
   */
  it.each([
    ['no stored', undefined],
    ['superseded', `sha256:${'0'.repeat(64)}`],
  ])(
    'keeps a bundled SavedSecret operation usable with a %s recipient approval',
    async (_approvalState, approvedRecipientContractDigest) => {
      const entry = createCredentialSettingsEntry();
      const settings = installCredentialSettings(approvedRecipientContractDigest);
      const fetch = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
        expect(new Headers(init?.headers).get('authorization'))
          .toBe('Bearer bundled-account-secret');
        return new Response(JSON.stringify({
          voices: [{ id: 'first-party-voice', name: 'First party voice' }],
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      });
      vi.stubGlobal('fetch', fetch);
      const hostLease = createBundledConversationRuntimeHostLease();
      const runtimes = (await createBundledConversationRuntimes({
        bundledEntries: [entry],
        host: hostLease.host,
      }));

      try {
        const registration = getExternalVoiceProviderRegistration('happier.voice.xai/realtime-grok');
        await expect(registration?.settingsOperations?.listCatalog?.({
          catalog: 'voices',
          providerConfig: {},
          signal: new AbortController().signal,
        })).resolves.toEqual([{ id: 'first-party-voice', name: 'First party voice', metadata: {} }]);
        expect(fetch).toHaveBeenCalledTimes(1);
      } finally {
        await Promise.all(runtimes.map((runtime) => runtime.dispose()));
        hostLease.revoke();
        settings.restore();
      }
    },
  );

  it('allows a bundled SavedSecret operation with the exact approved recipient digest', async () => {
    const entry = createCredentialSettingsEntry();
    const recipientContract = createBundledVoiceRecipientContract({
      pluginId: entry.pluginId,
      declaration: entry.declaration,
    });
    if (!recipientContract) throw new Error('realtime_grok recipient contract missing');
    const settings = installCredentialSettings(
      createRecipientContractDigestV1(recipientContract),
    );
    const fetch = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('authorization'))
        .toBe('Bearer bundled-account-secret');
      return new Response(JSON.stringify({
        voices: [{ id: 'approved-voice', name: 'Approved voice' }],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetch);
    const hostLease = createBundledConversationRuntimeHostLease();
    const runtimes = (await createBundledConversationRuntimes({
      bundledEntries: [entry],
      host: hostLease.host,
    }));

    try {
      const registration = getExternalVoiceProviderRegistration('happier.voice.xai/realtime-grok');
      await expect(registration?.settingsOperations?.listCatalog?.({
        catalog: 'voices',
        providerConfig: {},
        signal: new AbortController().signal,
      })).resolves.toEqual([{ id: 'approved-voice', name: 'Approved voice', metadata: {} }]);
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      await Promise.all(runtimes.map((runtime) => runtime.dispose()));
      hostLease.revoke();
      settings.restore();
    }
  });

  it('preserves composition for a valid bundled runtime with no recipient contract', async () => {
    const entry = createPublicEntry({ providerId: 'contract_free_provider' });
    const hostLease = createBundledConversationRuntimeHostLease();
    const runtimes = (await createBundledConversationRuntimes({
      bundledEntries: [entry],
      host: hostLease.host,
    }));

    try {
      expect(runtimes).toHaveLength(1);
      expect(runtimes[0]?.adapter.id).toBe('test.voice/contract-free-provider');
    } finally {
      await Promise.all(runtimes.map((runtime) => runtime.dispose()));
      hostLease.revoke();
    }
  });

  it('classifies a missing global Agent account binding as authentication-required', async () => {
    const hostLease = createBundledConversationRuntimeHostLease();

    await expect(hostLease.host.resolveAgentRealtimeVoiceConversationBinding!({
      provider: { pluginId: 'happier.agent.codex', localId: 'realtime-codex' },
      agent: { pluginId: 'happier.agent.codex', localId: 'codex' },
      controlSessionId: hostLease.host.globalVoiceSessionId,
      requestedTargetSessionAddress: null,
      settings: {},
    })).rejects.toMatchObject({
      code: 'authentication_required',
      message: 'voice_global_connected_service_binding_required',
    });

    hostLease.revoke();
  });

  it('excludes only the leaf that throws while composing and names it once', async () => {
    const logSpy = vi.spyOn(log, 'log');
    const hostLease = createBundledConversationRuntimeHostLease();
    const firstEntry = createPublicEntry({ providerId: 'first_provider' });
    const throwingEntry = createPublicEntry({
      providerId: 'second_provider',
      activateError: new Error('factory_failed'),
    });
    const thirdEntry = createPublicEntry({ providerId: 'third_provider' });

    const runtimes = (await createBundledConversationRuntimes({
      bundledEntries: [firstEntry, throwingEntry, thirdEntry],
      host: hostLease.host,
    }));

    try {
      // One plugin leaf cannot disable Voice for every other provider.
      expect(runtimes.map((runtime) => runtime.adapter.id)).toEqual([
        'test.voice/first-provider',
        'test.voice/third-provider',
      ]);
      expect(getExternalVoiceProviderRegistration('test.voice/second-provider')).toBeNull();

      const records = logSpy.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.includes('[voiceRuntimeFailure]'));
      expect(records).toHaveLength(1);
      expect(records[0]).toContain('test.voice/second-provider');
    } finally {
      await Promise.all(runtimes.map((runtime) => runtime.dispose()));
      hostLease.revoke();
    }
  });

  it('keeps the healthy leaf when a later leaf claims an already-composed identity', async () => {
    const logSpy = vi.spyOn(log, 'log');
    const hostLease = createBundledConversationRuntimeHostLease();
    const entry = createPublicEntry({ providerId: 'only_provider' });
    const duplicate = createPublicEntry({ providerId: 'only_provider' });

    const runtimes = (await createBundledConversationRuntimes({
      bundledEntries: [entry, duplicate],
      host: hostLease.host,
    }));

    try {
      // Denial of the second claim, never a takeover of the first registration.
      expect(runtimes.map((runtime) => runtime.adapter.id)).toEqual(['test.voice/only-provider']);
      const records = logSpy.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.includes('[voiceRuntimeFailure]'));
      expect(records).toHaveLength(1);
      expect(records[0]).toContain('voice_bundled_runtime_duplicate_identity');
    } finally {
      await Promise.all(runtimes.map((runtime) => runtime.dispose()));
      hostLease.revoke();
    }
  });

  it('never publishes a leaf whose activation commit rejects after composition returns', async () => {
    const logSpy = vi.spyOn(log, 'log');
    const hostLease = createBundledConversationRuntimeHostLease();
    const healthyDispose = vi.fn(async () => {});
    const lateDispose = vi.fn(async () => {});
    const firstEntry = createPublicEntry({
      providerId: 'first_provider',
      dispose: healthyDispose,
    });
    // A declared resumption capability that its registered runtime does not
    // implement fails inside commit(), after the composer already owns the
    // scope, so the failure can only surface through the commit promise.
    const lateFailingEntry = createPublicEntry({
      providerId: 'late_provider',
      resumption: 'resume',
      dispose: lateDispose,
    });
    const thirdEntry = createPublicEntry({ providerId: 'third_provider' });

    const runtimes = (await createBundledConversationRuntimes({
      bundledEntries: [firstEntry, lateFailingEntry, thirdEntry],
      host: hostLease.host,
    }));

    try {
      expect(runtimes.map((runtime) => runtime.adapter.id)).toEqual([
        'test.voice/first-provider',
        'test.voice/third-provider',
      ]);
      expect(getExternalVoiceProviderRegistration('test.voice/late-provider')).toBeNull();

      await flushPendingActivationWork();

      // The commit rejection is swallowed by design; it stays safe only while
      // every published runtime is still the registry's own live registration.
      // A registration withdrawn after the composer read it would strand a
      // stale adapter in the assembly this composition returns.
      expect(getExternalVoiceProviderRegistration('test.voice/late-provider')).toBeNull();
      for (const runtime of runtimes) {
        expect(getExternalVoiceProviderRegistration(runtime.adapter.id)?.adapter)
          .toBe(runtime.adapter);
      }
      expect(lateDispose).toHaveBeenCalledTimes(1);
      expect(healthyDispose).not.toHaveBeenCalled();

      const records = logSpy.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.includes('[voiceRuntimeFailure]'));
      expect(records).toHaveLength(1);
      expect(records[0]).toContain('test.voice/late-provider');
    } finally {
      await Promise.all(runtimes.map((runtime) => runtime.dispose()));
      hostLease.revoke();
    }
  });

  it('keeps healthy leaves composed when a registration observer rejects one leaf', async () => {
    const hostLease = createBundledConversationRuntimeHostLease();
    const observedProviderId = 'test.voice/observed-provider';
    const unsubscribe = subscribeExternalVoiceProviderRegistrations(() => {
      if (getExternalVoiceProviderRegistration(observedProviderId)) {
        throw new Error('registration_observer_failed');
      }
    });
    const healthyDispose = vi.fn(async () => {});
    const observedDispose = vi.fn(async () => {});
    const firstEntry = createPublicEntry({
      providerId: 'first_provider',
      dispose: healthyDispose,
    });
    const observedEntry = createPublicEntry({
      providerId: 'observed_provider',
      dispose: observedDispose,
    });
    const thirdEntry = createPublicEntry({ providerId: 'third_provider' });

    const runtimes = (await createBundledConversationRuntimes({
      bundledEntries: [firstEntry, observedEntry, thirdEntry],
      host: hostLease.host,
    }));

    try {
      // One broken observer withdraws only the leaf it rejected.
      expect(runtimes.map((runtime) => runtime.adapter.id)).toEqual([
        'test.voice/first-provider',
        'test.voice/third-provider',
      ]);
      await flushPendingActivationWork();
      expect(getExternalVoiceProviderRegistration(observedProviderId)).toBeNull();
      for (const runtime of runtimes) {
        expect(getExternalVoiceProviderRegistration(runtime.adapter.id)?.adapter)
          .toBe(runtime.adapter);
      }
      // The published-then-withdrawn leaf releases its plugin runtime; the
      // leaves the observer never rejected keep theirs.
      expect(observedDispose).toHaveBeenCalledTimes(1);
      expect(healthyDispose).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
      await Promise.all(runtimes.map((runtime) => runtime.dispose()));
      hostLease.revoke();
    }
  });

  it('withdraws a composed generation from the registry when a replacement host takes over', async () => {
    const retiredDispose = vi.fn(async () => {});
    const retiredLease = createBundledConversationRuntimeHostLease();
    const retired = (await createBundledConversationRuntimes({
      bundledEntries: [createPublicEntry({
        providerId: 'replaced_provider',
        dispose: retiredDispose,
      })],
      host: retiredLease.host,
    }));
    expect(getExternalVoiceProviderRegistration('test.voice/replaced-provider')?.adapter)
      .toBe(retired[0]?.adapter);

    const replacementLease = createBundledConversationRuntimeHostLease();
    const replacement = (await createBundledConversationRuntimes({
      bundledEntries: [createPublicEntry({ providerId: 'replacement_provider' })],
      host: replacementLease.host,
    }));

    try {
      await flushPendingActivationWork();
      // The retired generation stops resolving before its teardown settles, so
      // no consumer can reach a runtime whose host authority is gone.
      expect(getExternalVoiceProviderRegistration('test.voice/replaced-provider')).toBeNull();
      expect(retiredDispose).toHaveBeenCalledTimes(1);
      expect(getExternalVoiceProviderRegistration('test.voice/replacement-provider')?.adapter)
        .toBe(replacement[0]?.adapter);
    } finally {
      await Promise.all([...retired, ...replacement].map((runtime) => runtime.dispose()));
      replacementLease.revoke();
      retiredLease.revoke();
    }
  });

  it('authorizes hosted conversation only by exact generated entry identity', () => {
    const trusted = createPublicEntry({ providerId: 'happier.voice.elevenlabs/realtime-elevenlabs' });
    const collidingCopy = Object.freeze({
      ...trusted,
      declaration: Object.freeze({ ...trusted.declaration }),
    });

    expect(isBundledHostedConversationEntryAuthorized(trusted, [trusted])).toBe(true);
    expect(isBundledHostedConversationEntryAuthorized(collidingCopy, [trusted])).toBe(false);
  });

});
