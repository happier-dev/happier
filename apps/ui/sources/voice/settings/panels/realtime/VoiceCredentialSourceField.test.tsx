import React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { VoiceProviderContributionSchema } from '@happier-dev/protocol';

import { renderScreen } from '@/dev/testkit';
import { installConnectedAccountDescriptorProjection } from '@/sync/domains/connectedServices/connectedServiceRegistry';

const state = vi.hoisted(() => ({
  settings: null as any,
  profile: {
    connectedAccountsV4: [] as any[],
    connectedAccountGroupsV4: [] as any[],
  },
  settingsVersion: 4 as number | null,
  currentDeclaration: null as any,
  currentEntryKind: 'voice.conversation-provider.v1' as
    | 'voice.conversation-provider.v1'
    | 'voice.speech-engine.v1',
  mutateAccountSettingsOnce: vi.fn(),
  lastFireAndForget: null as Promise<unknown> | null,
  projectedConnectedServicesRegistry: Object.freeze({ revision: 0, entries: [] }) as object,
}));

vi.mock('@/sync/store/hooks', () => ({
  useSettings: () => state.settings,
  useSettingsVersion: () => state.settingsVersion,
  useProfile: () => state.profile,
}));

vi.mock('@/sync/sync', () => ({
  sync: {
    mutateAccountSettingsOnce: (...args: any[]) => state.mutateAccountSettingsOnce(...args),
  },
}));

vi.mock('@/voice/registry/defaultRegistry', () => ({
  createDefaultVoiceProviderRegistry: () => ({
    get: () => state.currentDeclaration
      ? { kind: state.currentEntryKind, declaration: state.currentDeclaration }
      : null,
  }),
}));

vi.mock('@/sync/domains/settings/settings', () => ({
  settingsParse: (value: unknown) => value,
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
  DropdownMenu: (props: any) => React.createElement('DropdownMenu', props),
}));

vi.mock('@/components/appShell/plugins/AppShellPluginUiProjection', () => ({
  useProjectedConnectedServicesRegistry: () => state.projectedConnectedServicesRegistry,
}));

vi.mock('@/text', () => ({
  t: (key: string) => key,
  tLoose: (key: string) => key,
}));

vi.mock('@/utils/system/fireAndForget', () => ({
  fireAndForget: (promise: Promise<unknown>) => {
    state.lastFireAndForget = promise;
    void promise.catch(() => {});
  },
}));

const contribution = Object.freeze({
  pluginId: 'happier.voice.openai',
  localId: 'realtime-openai',
});
const declaration = VoiceProviderContributionSchema.parse({
  id: contribution.localId,
  title: 'OpenAI realtime',
  kind: 'conversation',
  roles: ['realtime_conversation'],
  platforms: ['web'],
  capabilities: { turn: { cancelResponse: false, bargeIn: false } },
  credentials: {
  slot: {
    id: 'api_key',
    purpose: 'voice.client-auth',
    title: 'OpenAI credential',
  },
  requirement: { kind: 'always' },
  sources: [
    {
      kind: 'savedSecret',
      secretKinds: ['apiKey'],
      rawGrants: [{
        realm: 'web',
        phase: 'prepare',
        request: {
          kind: 'httpHeaders',
          origin: 'https://api.openai.com',
          headerNames: ['authorization'],
        },
      }],
    },
    {
      kind: 'connectedAccount',
      service: { pluginId: 'happier.voice.openai', localId: 'openai' },
      rawGrants: [{
        realm: 'web',
        phase: 'prepare',
        request: {
          kind: 'httpHeaders',
          origin: 'https://api.openai.com',
          headerNames: ['authorization'],
        },
      }],
    },
    {
      kind: 'connectedAccount',
      service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
      rawGrants: [{
        realm: 'web',
        phase: 'prepare',
        request: {
          kind: 'httpHeaders',
          origin: 'https://api.openai.com',
          headerNames: ['authorization'],
        },
      }],
    },
  ],
  hostMediated: {
    operations: [{
      id: 'client-auth',
      purpose: 'voice.client-auth',
      credentialSlotId: 'api_key',
      effect: 'read',
      request: {
        origin: 'https://api.openai.com',
        pathTemplate: '/v1/realtime/client_secrets',
        queryTemplate: [],
        headerTemplate: [],
        bodyTemplate: { kind: 'json', value: {} },
        method: 'POST',
        credential: { kind: 'httpHeader', name: 'authorization', format: 'bearer' },
        redirect: 'error',
        maxBodyBytes: 65_536,
        contentTypes: ['application/json'],
      },
      parameters: {
        schema: { type: 'object', properties: {}, additionalProperties: false },
        mapping: [],
      },
      response: { maxBytes: 65_536, contentTypes: ['application/json'] },
    }],
  },
  },
  client: {
    artifactId: 'web-runtime',
    modulePath: './voiceRuntime',
    exportName: 'activate',
  },
});
const credentials = declaration.credentials!;

function installCodexDescriptor(options: Readonly<{
  requiresAccountConfiguration?: boolean;
  includeOpenAi?: boolean;
}> = {}) {
  installConnectedAccountDescriptorProjection({
    scopeKey: 'voice-credential-source-test',
    status: 'ready',
    descriptors: [{
      id: 'openai-codex',
      serviceId: 'openai-codex',
      pluginId: 'happier.agent.codex',
      provenance: 'first_party',
      sourceKind: 'bundled',
      title: 'Codex',
      authentication: {
        defaultModeId: 'oauth',
        modes: [{
          id: 'oauth',
          kind: 'oauthAuthorizationCode',
          scopes: ['openid', 'profile', 'email', 'offline_access'],
          pkce: 'required',
          outcomeReconciliation: 'none',
          ...(options.requiresAccountConfiguration ? {
            configuration: {
              scope: 'account' as const,
              changeBehavior: 'reconnect' as const,
              fields: [{
                id: 'organization',
                title: 'Organization',
                schema: { type: 'string' as const, minLength: 1 },
                required: true,
                secret: false,
              }],
            },
          } : {}),
        }],
      },
      capabilities: [],
      availability: { state: 'available', reason: 'resolved' },
      diagnostics: [],
    }, ...(options.includeOpenAi ? [{
      id: 'openai',
      serviceId: 'openai',
      pluginId: 'happier.voice.openai',
      provenance: 'first_party' as const,
      sourceKind: 'bundled' as const,
      title: 'OpenAI',
      authentication: {
        defaultModeId: 'api-key',
        modes: [{
          id: 'api-key',
          kind: 'manual' as const,
          outcomeReconciliation: 'none' as const,
          fields: [{
            id: 'api-key',
            title: 'API key',
            schema: { type: 'string' as const, minLength: 1 },
            secret: true,
          }],
        }],
      },
      capabilities: [],
      availability: { state: 'available' as const, reason: 'resolved' as const },
      diagnostics: [],
    }] : [])],
    conflicts: [],
    errorReason: null,
  });
}

describe('VoiceCredentialSourceField', () => {
  beforeEach(() => {
    installCodexDescriptor();
    state.settings = {
      schemaVersion: 7,
      secrets: [],
      voiceSettingsV1: { credentialBindings: [] },
      connectedAccountPurposeBindingsV1: { v: 1, bindings: [] },
    };
    state.profile.connectedAccountsV4 = [{
      ref: {
        service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
        accountId: 'codex-work',
      },
      status: 'connected',
      configurationReady: false,
      authenticationModeId: 'oauth',
      revisionSemantics: 'revisioned',
      credentialRevision: 'cred-1',
      configurationRevision: null,
      displayName: 'Work Codex',
      scopes: [],
    }];
    state.profile.connectedAccountGroupsV4 = [];
    state.settingsVersion = 4;
    state.currentDeclaration = declaration;
    state.currentEntryKind = 'voice.conversation-provider.v1';
    state.lastFireAndForget = null;
    state.projectedConnectedServicesRegistry = Object.freeze({
      revision: 0,
      entries: [{
        serviceId: 'openai-codex',
        service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
        connectCommand: '',
        supportsOauth: true,
        projectedTitle: 'Codex',
      }],
    });
    state.mutateAccountSettingsOnce.mockReset();
    state.mutateAccountSettingsOnce.mockImplementation(async (input: any) => {
      const applied = input.mutate(state.settings);
      state.settings = applied.settings;
      state.settingsVersion = 5;
      return { status: 'applied', settingsVersion: 5, value: applied.value };
    });
  });

  it('selects one exact declared account through the Account Settings source/binding mutation', async () => {
    const { VoiceCredentialSourceField } = await import('./VoiceCredentialSourceField');
    const screen = await renderScreen(<VoiceCredentialSourceField
      contribution={contribution}
      declaration={declaration}
      credentials={credentials}
    />);
    const dropdown = screen.tree.findByType('DropdownMenu' as any);
    const accountRow = dropdown.props.items.find((item: any) => item.title === 'Work Codex');

    expect(accountRow).toBeTruthy();
    expect(accountRow).toMatchObject({
      subtitle: 'Codex · codex-work',
      accessibilityLabel: 'Codex · Work Codex · codex-work',
    });
    await act(async () => dropdown.props.onSelect(accountRow.id));

    expect(state.mutateAccountSettingsOnce).toHaveBeenCalledTimes(1);
    expect(state.settings.voiceSettingsV1.credentialBindings).toEqual([
      expect.objectContaining({
        contribution,
        credentialSlotId: 'api_key',
        credentialSource: { kind: 'connectedAccount' },
      }),
    ]);
    expect(state.settings.connectedAccountPurposeBindingsV1.bindings).toEqual([{
      purpose: { consumer: contribution, purpose: 'voice.client-auth' },
      target: {
        kind: 'account',
        account: {
          service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
          accountId: 'codex-work',
        },
      },
    }]);
  });

  it('keeps a source-selection outcome unknown visible after its safe readback without replaying it', async () => {
    state.mutateAccountSettingsOnce.mockReset();
    state.mutateAccountSettingsOnce.mockResolvedValueOnce({
      status: 'outcomeUnknown',
      lastKnownSettingsVersion: 5,
      safeSnapshotVersion: 5,
    });
    const { VoiceCredentialSourceField } = await import('./VoiceCredentialSourceField');
    const screen = await renderScreen(<VoiceCredentialSourceField
      contribution={contribution}
      declaration={declaration}
      credentials={credentials}
    />);
    const dropdown = screen.tree.findByType('DropdownMenu' as any);
    const accountRow = dropdown.props.items.find((item: any) => item.title === 'Work Codex');

    await act(async () => {
      dropdown.props.onSelect(accountRow.id);
      await state.lastFireAndForget;
    });

    expect(state.mutateAccountSettingsOnce).toHaveBeenCalledOnce();
    expect(state.settings.voiceSettingsV1.credentialBindings).toEqual([]);
    expect(screen.tree.findByType('DropdownMenu' as any).props.itemTrigger.subtitle)
      .toBe('settingsProviders.errors.mutationOutcomeUnknownDescription');
  });

  it('selects a declared account for a speech contribution through the same source mutation', async () => {
    const speechContribution = Object.freeze({
      pluginId: contribution.pluginId,
      localId: 'speech',
    });
    const speechDeclaration = VoiceProviderContributionSchema.parse({
      id: speechContribution.localId,
      title: 'OpenAI speech',
      kind: 'speech',
      roles: ['dictation_stt'],
      platforms: ['web'],
      credentials: {
        slot: {
          id: 'api_key',
          purpose: 'voice.speech.transcribe',
          title: 'OpenAI credential',
        },
        requirement: { kind: 'always' },
        sources: [{
          kind: 'savedSecret',
          secretKinds: ['apiKey'],
          rawGrants: [{
            realm: 'daemon',
            phase: 'speech',
            request: { kind: 'environment', keys: ['OPENAI_API_KEY'] },
          }],
        }, {
          kind: 'connectedAccount',
          service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
          rawGrants: [{
            realm: 'daemon',
            phase: 'speech',
            request: { kind: 'environment', keys: ['OPENAI_API_KEY'] },
          }],
        }],
      },
      settings: {
        schemaVersion: 1,
        fields: [{
          id: 'model',
          title: 'Model',
          schema: { type: 'string', minLength: 1, maxLength: 64 },
          default: 'whisper-1',
          presentation: { control: 'text' },
        }],
      },
    });
    if (speechDeclaration.kind !== 'speech' || !speechDeclaration.credentials) {
      throw new Error('expected speech credential declaration');
    }
    state.currentDeclaration = speechDeclaration;
    state.currentEntryKind = 'voice.speech-engine.v1';

    const { VoiceCredentialSourceField } = await import('./VoiceCredentialSourceField');
    const screen = await renderScreen(<VoiceCredentialSourceField
      contribution={speechContribution}
      declaration={speechDeclaration}
      credentials={speechDeclaration.credentials}
    />);
    const dropdown = screen.tree.findByType('DropdownMenu' as any);
    const accountRow = dropdown.props.items.find((item: any) => item.title === 'Work Codex');

    await act(async () => dropdown.props.onSelect(accountRow.id));

    await expect(state.lastFireAndForget).resolves.toMatchObject({ status: 'applied' });
    expect(state.settings.voiceSettingsV1.credentialBindings).toEqual([
      expect.objectContaining({
        contribution: speechContribution,
        credentialSlotId: 'api_key',
        credentialSource: { kind: 'connectedAccount' },
      }),
    ]);
  });

  it('disables a connected account whose authentication mode still needs account configuration', async () => {
    installCodexDescriptor({ requiresAccountConfiguration: true });
    const { VoiceCredentialSourceField } = await import('./VoiceCredentialSourceField');
    const screen = await renderScreen(<VoiceCredentialSourceField
      contribution={contribution}
      declaration={declaration}
      credentials={credentials}
    />);
    const dropdown = screen.tree.findByType('DropdownMenu' as any);
    const accountRow = dropdown.props.items.find((item: any) => item.title === 'Work Codex');

    expect(accountRow.disabled).toBe(true);
    await act(async () => dropdown.props.onSelect(accountRow.id));
    expect(state.mutateAccountSettingsOnce).not.toHaveBeenCalled();
  });

  it('recomputes account eligibility when the authoritative descriptor projection arrives after mount', async () => {
    installConnectedAccountDescriptorProjection({
      scopeKey: 'voice-credential-source-test',
      status: 'loading',
      descriptors: [],
      conflicts: [],
      errorReason: null,
    });
    const { VoiceCredentialSourceField } = await import('./VoiceCredentialSourceField');
    const element = () => <VoiceCredentialSourceField
      contribution={contribution}
      declaration={declaration}
      credentials={credentials}
    />;
    const screen = await renderScreen(element());
    let accountRow = screen.tree.findByType('DropdownMenu' as any).props.items.find(
      (item: any) => item.title === 'Work Codex',
    );
    expect(accountRow.disabled).toBe(true);

    installCodexDescriptor();
    state.projectedConnectedServicesRegistry = Object.freeze({ revision: 1, entries: [] });
    await screen.update(element());
    accountRow = screen.tree.findByType('DropdownMenu' as any).props.items.find(
      (item: any) => item.title === 'Work Codex',
    );
    expect(accountRow.disabled).not.toBe(true);
  });

  it('offers only none, SavedSecret, and accounts from the two manifest-declared OpenAI services', async () => {
    state.profile.connectedAccountsV4.push({
      ...state.profile.connectedAccountsV4[0],
      ref: {
        service: { pluginId: 'happier.voice.openai', localId: 'openai' },
        accountId: 'api-work',
      },
      authenticationModeId: 'api-key',
      configurationReady: true,
      displayName: 'Work API key',
    });
    const { VoiceCredentialSourceField } = await import('./VoiceCredentialSourceField');
    const screen = await renderScreen(<VoiceCredentialSourceField
      contribution={contribution}
      declaration={declaration}
      credentials={credentials}
    />);

    expect(screen.tree.findByType('DropdownMenu' as any).props.items.map((item: any) => item.title)).toEqual([
      'common.none',
      'settingsVoice.realtimeProviders.authentication.savedSecret.title',
      'Work Codex',
      'Work API key',
    ]);
  });

  it('does not present an unresolvable stored selection as an explicit "none"', async () => {
    // A Connected Account purpose binding whose Voice credential source no
    // longer selects it makes the whole resolution throw. Rendering the "—"
    // row as the current selection says the user chose no authentication
    // source, which is a claim about stored state this read never resolved.
    state.settings = {
      ...state.settings,
      connectedAccountPurposeBindingsV1: {
        v: 1,
        bindings: [{
          purpose: { consumer: contribution, purpose: credentials.slot.purpose },
          target: {
            kind: 'account',
            account: {
              service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
              accountId: 'codex-work',
            },
          },
        }],
      },
    };
    const { VoiceCredentialSourceField } = await import('./VoiceCredentialSourceField');
    const screen = await renderScreen(<VoiceCredentialSourceField
      contribution={contribution}
      declaration={declaration}
      credentials={credentials}
    />);

    const dropdown = screen.tree.findByType('DropdownMenu' as any);
    expect(dropdown.props.itemTrigger.detailFormatter()).toBe('common.unavailable');
    expect(dropdown.props.selectedId).not.toBe('none');
  });

  it('switches the single purpose binding between declared accounts and removes it when none is selected', async () => {
    installCodexDescriptor({ includeOpenAi: true });
    state.profile.connectedAccountsV4.push({
      ...state.profile.connectedAccountsV4[0],
      ref: {
        service: { pluginId: 'happier.voice.openai', localId: 'openai' },
        accountId: 'api-work',
      },
      authenticationModeId: 'api-key',
      configurationReady: true,
      displayName: 'Work API key',
    });
    const { VoiceCredentialSourceField } = await import('./VoiceCredentialSourceField');
    const element = () => <VoiceCredentialSourceField
      contribution={contribution}
      declaration={declaration}
      credentials={credentials}
    />;
    const screen = await renderScreen(element());
    let dropdown = screen.tree.findByType('DropdownMenu' as any);

    await act(async () => dropdown.props.onSelect(
      dropdown.props.items.find((item: any) => item.title === 'Work Codex').id,
    ));
    await screen.update(element());
    dropdown = screen.tree.findByType('DropdownMenu' as any);
    await act(async () => dropdown.props.onSelect(
      dropdown.props.items.find((item: any) => item.title === 'Work API key').id,
    ));

    expect(state.settings.connectedAccountPurposeBindingsV1.bindings).toEqual([{
      purpose: { consumer: contribution, purpose: 'voice.client-auth' },
      target: {
        kind: 'account',
        account: {
          service: { pluginId: 'happier.voice.openai', localId: 'openai' },
          accountId: 'api-work',
        },
      },
    }]);

    await screen.update(element());
    dropdown = screen.tree.findByType('DropdownMenu' as any);
    await act(async () => dropdown.props.onSelect('none'));
    expect(state.settings.connectedAccountPurposeBindingsV1.bindings).toEqual([]);
    expect(state.settings.voiceSettingsV1.credentialBindings[0]).toMatchObject({
      contribution,
      credentialSlotId: 'api_key',
      credentialSource: { kind: 'none' },
    });
  });

  it('does not offer accounts from services absent from the provider declaration', async () => {
    state.profile.connectedAccountsV4.push({
      ...state.profile.connectedAccountsV4[0],
      ref: {
        service: { pluginId: 'unrelated.plugin', localId: 'other' },
        accountId: 'other-account',
      },
      displayName: 'Unrelated account',
    });
    const { VoiceCredentialSourceField } = await import('./VoiceCredentialSourceField');
    const screen = await renderScreen(<VoiceCredentialSourceField
      contribution={contribution}
      declaration={declaration}
      credentials={credentials}
    />);

    expect(screen.tree.findByType('DropdownMenu' as any).props.items).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ title: 'Unrelated account' })]),
    );
  });

  it('does not admit a selection from a retired provider declaration', async () => {
    const { VoiceCredentialSourceField } = await import('./VoiceCredentialSourceField');
    const screen = await renderScreen(<VoiceCredentialSourceField
      contribution={contribution}
      declaration={declaration}
      credentials={credentials}
      isCurrent={() => false}
    />);
    const dropdown = screen.tree.findByType('DropdownMenu' as any);
    const accountRow = dropdown.props.items.find((item: any) => item.title === 'Work Codex');

    await act(async () => dropdown.props.onSelect(accountRow.id));

    expect(state.mutateAccountSettingsOnce).not.toHaveBeenCalled();
  });

  it('admits an equivalent rehydrated declaration object', async () => {
    state.currentDeclaration = VoiceProviderContributionSchema.parse(
      structuredClone(declaration),
    );
    expect(state.currentDeclaration).not.toBe(declaration);
    const { VoiceCredentialSourceField } = await import('./VoiceCredentialSourceField');
    const screen = await renderScreen(<VoiceCredentialSourceField
      contribution={contribution}
      declaration={declaration}
      credentials={credentials}
    />);
    const dropdown = screen.tree.findByType('DropdownMenu' as any);
    const accountRow = dropdown.props.items.find((item: any) => item.title === 'Work Codex');

    await act(async () => dropdown.props.onSelect(accountRow.id));

    expect(state.mutateAccountSettingsOnce).toHaveBeenCalledOnce();
    expect(state.settings.voiceSettingsV1.credentialBindings).toEqual([
      expect.objectContaining({ credentialSource: { kind: 'connectedAccount' } }),
    ]);
  });

  it('admits semantically equivalent reordered raw credential grant sets', async () => {
    const expectedDeclaration = VoiceProviderContributionSchema.parse({
      ...declaration,
      credentials: {
        ...credentials,
        sources: credentials.sources.map((source) => source.kind === 'connectedAccount'
          && typeof source.service !== 'string'
          && source.service.localId === 'openai-codex'
          ? {
              ...source,
              rawGrants: [{
                realm: 'web',
                phase: 'prepare',
                request: {
                  kind: 'httpHeaders',
                  origin: 'https://api.openai.com',
                  headerNames: ['authorization', 'openai-organization'],
                },
              }, {
                realm: 'web',
                phase: 'connection',
                request: {
                  kind: 'httpHeaders',
                  origin: 'https://api.openai.com',
                  headerNames: ['authorization'],
                },
              }],
            }
          : source),
      },
    });
    const selectedSource = expectedDeclaration.credentials!.sources.find((source) => (
      source.kind === 'connectedAccount'
      && typeof source.service !== 'string'
      && source.service.localId === 'openai-codex'
    ));
    if (!selectedSource || selectedSource.kind !== 'connectedAccount') {
      throw new Error('expected Codex credential source');
    }
    state.currentDeclaration = VoiceProviderContributionSchema.parse({
      ...expectedDeclaration,
      credentials: {
        ...expectedDeclaration.credentials!,
        sources: expectedDeclaration.credentials!.sources.map((source) => source === selectedSource
          ? {
              ...source,
              rawGrants: [...source.rawGrants!].reverse().map((grant) => grant.request.kind === 'httpHeaders'
                ? {
                    ...grant,
                    request: {
                      ...grant.request,
                      headerNames: [...grant.request.headerNames].reverse(),
                    },
                  }
                : grant),
            }
          : source),
      },
    });
    const { VoiceCredentialSourceField } = await import('./VoiceCredentialSourceField');
    const screen = await renderScreen(<VoiceCredentialSourceField
      contribution={contribution}
      declaration={expectedDeclaration}
      credentials={expectedDeclaration.credentials!}
    />);
    const dropdown = screen.tree.findByType('DropdownMenu' as any);
    const accountRow = dropdown.props.items.find((item: any) => item.title === 'Work Codex');

    await act(async () => dropdown.props.onSelect(accountRow.id));

    await expect(state.lastFireAndForget).resolves.toEqual(expect.objectContaining({
      status: 'applied',
    }));
    expect(state.settings.voiceSettingsV1.credentialBindings).toEqual([
      expect.objectContaining({ credentialSource: { kind: 'connectedAccount' } }),
    ]);
  });

  it.each([
    ['slot', VoiceProviderContributionSchema.parse({
      ...declaration,
      credentials: {
        ...credentials,
        slot: { ...credentials.slot, id: 'replacement_key' },
        hostMediated: {
          operations: credentials.hostMediated!.operations.map((operation) => ({
            ...operation,
            credentialSlotId: 'replacement_key',
          })),
        },
      },
    })],
    ['purpose', VoiceProviderContributionSchema.parse({ ...declaration, credentials: { ...credentials, slot: { ...credentials.slot, purpose: 'voice.replacement' } } })],
    ['service', VoiceProviderContributionSchema.parse({
      ...declaration,
      credentials: {
        ...credentials,
        sources: credentials.sources.map((source) => source.kind === 'connectedAccount'
          && typeof source.service !== 'string'
          && source.service.localId === 'openai-codex'
          ? { ...source, service: { pluginId: 'replacement.plugin', localId: 'replacement' } }
          : source),
      },
    })],
    ['access contract', VoiceProviderContributionSchema.parse({
      ...declaration,
      credentials: {
        ...credentials,
        sources: credentials.sources.map((source) => source.kind === 'connectedAccount'
          && typeof source.service !== 'string'
          && source.service.localId === 'openai-codex'
          ? {
              ...source,
              rawGrants: [{
                realm: 'web',
                phase: 'prepare',
                request: {
                  kind: 'httpHeaders',
                  origin: 'https://replacement.example.com',
                  headerNames: ['authorization'],
                },
              }],
            }
          : source),
      },
    })],
  ])('does not mutate when the current manifest %s drifts after the gesture', async (_kind, drifted) => {
    state.mutateAccountSettingsOnce.mockImplementationOnce(async (input: any) => {
      state.currentDeclaration = drifted;
      return input.mutate(state.settings);
    });
    const before = structuredClone(state.settings);
    const { VoiceCredentialSourceField } = await import('./VoiceCredentialSourceField');
    const screen = await renderScreen(<VoiceCredentialSourceField
      contribution={contribution}
      declaration={declaration}
      credentials={credentials}
    />);
    const dropdown = screen.tree.findByType('DropdownMenu' as any);
    const accountRow = dropdown.props.items.find((item: any) => item.title === 'Work Codex');

    await act(async () => dropdown.props.onSelect(accountRow.id));

    expect(state.mutateAccountSettingsOnce).toHaveBeenCalledOnce();
    await expect(state.lastFireAndForget).resolves.toEqual({
      status: 'conflict',
      currentSettingsVersion: 4,
    });
    expect(state.settings).toEqual(before);
  });

  it.each([
    ['path', { request: { pathTemplate: '/v1/realtime/replacement' } }],
    ['method', { request: { method: 'PATCH' } }],
    ['purpose', { purpose: 'voice.client-auth.revised' }],
    ['bounds', { request: { maxBodyBytes: 32_768 }, response: { maxBytes: 32_768 } }],
  ])('conflicts when only the host-mediated operation %s changes', async (_kind, patch) => {
    const operation = credentials.hostMediated!.operations[0]!;
    const operationPatch = patch as Readonly<{
      purpose?: string;
      request?: Partial<typeof operation.request>;
      response?: Partial<typeof operation.response>;
    }>;
    state.currentDeclaration = VoiceProviderContributionSchema.parse({
      ...declaration,
      credentials: {
        ...credentials,
        hostMediated: {
          operations: [{
            ...operation,
            ...operationPatch,
            request: {
              ...operation.request,
              ...operationPatch.request,
            },
            response: {
              ...operation.response,
              ...operationPatch.response,
            },
          }],
        },
      },
    });
    const before = structuredClone(state.settings);
    const { VoiceCredentialSourceField } = await import('./VoiceCredentialSourceField');
    const screen = await renderScreen(<VoiceCredentialSourceField
      contribution={contribution}
      declaration={declaration}
      credentials={credentials}
    />);
    const dropdown = screen.tree.findByType('DropdownMenu' as any);
    const accountRow = dropdown.props.items.find((item: any) => item.title === 'Work Codex');

    await act(async () => dropdown.props.onSelect(accountRow.id));

    await expect(state.lastFireAndForget).resolves.toEqual({
      status: 'conflict',
      currentSettingsVersion: 4,
    });
    expect(state.settings).toEqual(before);
  });

  it('reports applied when the operation contract changes after mutation admission', async () => {
    const operation = credentials.hostMediated!.operations[0]!;
    const changedDeclaration = VoiceProviderContributionSchema.parse({
      ...declaration,
      credentials: {
        ...credentials,
        hostMediated: {
          operations: [{
            ...operation,
            request: { ...operation.request, pathTemplate: '/v1/realtime/replacement' },
          }],
        },
      },
    });
    state.mutateAccountSettingsOnce.mockImplementationOnce(async (input: any) => {
      const applied = input.mutate(state.settings);
      state.settings = applied.settings;
      state.settingsVersion = 5;
      state.currentDeclaration = changedDeclaration;
      return { status: 'applied', settingsVersion: 5, value: applied.value };
    });
    const { VoiceCredentialSourceField } = await import('./VoiceCredentialSourceField');
    const screen = await renderScreen(<VoiceCredentialSourceField
      contribution={contribution}
      declaration={declaration}
      credentials={credentials}
    />);
    const dropdown = screen.tree.findByType('DropdownMenu' as any);
    const accountRow = dropdown.props.items.find((item: any) => item.title === 'Work Codex');

    await act(async () => dropdown.props.onSelect(accountRow.id));

    await expect(state.lastFireAndForget).resolves.toMatchObject({
      status: 'applied',
      settingsVersion: 5,
      selection: { kind: 'connectedAccount' },
      binding: {
        purpose: { consumer: contribution, purpose: 'voice.client-auth' },
        target: {
          kind: 'account',
          account: {
            service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
            accountId: 'codex-work',
          },
        },
      },
    });
    expect(state.settings.voiceSettingsV1.credentialBindings).toEqual([
      expect.objectContaining({ credentialSource: { kind: 'connectedAccount' } }),
    ]);
  });
});
