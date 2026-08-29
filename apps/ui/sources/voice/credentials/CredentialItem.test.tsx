import * as React from 'react';
import { act } from 'react-test-renderer';
import {
  createRecipientContractDigestV1,
  normalizeRecipientContractV1,
  VoiceProviderContributionSchema,
} from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import type { IModal } from '@/modal/types';
import type { Settings } from '@/sync/domains/settings/settings';

const boundary = vi.hoisted(() => ({
  confirm: vi.fn<IModal['confirm']>(async () => false),
  show: vi.fn<IModal['show']>(() => 'modal-id'),
  mutateAccountSettings: vi.fn(),
  mutateAccountSettingsOnce: vi.fn(),
  prompt: vi.fn(async () => 'SHOULD_NOT_LEAK'),
  log: vi.fn<(message: string) => void>(),
  settings: null as Settings | null,
  settingsVersion: 4 as number | null,
  currentDeclaration: null as ReturnType<typeof VoiceProviderContributionSchema.parse> | null,
}));

// The console sink is the one report that survives a dismissed overlay; the
// record itself stays real logic under this boundary.
vi.mock('@/log', () => ({ log: { log: boundary.log } }));

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock({
    Platform: {
      OS: 'web',
      select: (options: Record<string, unknown>) => options.web ?? options.default,
    },
  });
});

vi.mock('@/components/ui/lists/Item', () => ({
  Item: (props: object) => React.createElement('Item', props),
}));

vi.mock('./VoiceRawCredentialAccessReview', () => ({
  VoiceRawCredentialAccessReview: (props: object) => React.createElement('VoiceRawCredentialAccessReview', props),
}));

vi.mock('@/modal', async () => {
  const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
  return createModalModuleMock({
    spies: {
      confirm: boundary.confirm,
      prompt: boundary.prompt,
      show: boundary.show,
    },
  }).module;
});

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
  DropdownMenu: (props: object) => React.createElement('DropdownMenu', props),
}));

// The shared picker is a modal boundary this unit only hands to `Modal.show`;
// it owns its own coverage and pulls the live sync singleton into module scope.
vi.mock('@/components/ui/forms/valueRefs/SavedSecretPickerModal', () => ({
  SavedSecretPickerModal: (props: object) => React.createElement('SavedSecretPickerModal', props),
}));

vi.mock('@/sync/api/account/apiAccountEncryptionMode', () => ({
  fetchAccountEncryptionMode: vi.fn(async () => ({ mode: 'e2ee' })),
}));

vi.mock('@/sync/domains/state/storage', async () => {
  const { settingsParse } = await import('@/sync/domains/settings/settings');
  const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
  const readSettings = () => boundary.settings ?? settingsParse({});
  return {
    ...createStorageModuleStub({ useSettings: readSettings }),
    // The gesture verifies the account snapshot the write left behind, so the
    // canonical store has to answer here as it does in the app.
    storage: { getState: () => ({ settings: readSettings() }) },
    getStorage: () => ({ getState: () => ({ settings: readSettings() }) }),
  };
});

vi.mock('@/sync/sync', () => ({
  sync: {
    getCredentials: () => ({ token: 'account-token' }),
    mutateAccountSettings: boundary.mutateAccountSettings,
    mutateAccountSettingsOnce: boundary.mutateAccountSettingsOnce,
  },
}));

vi.mock('@/sync/store/hooks', () => ({
  useSettingsVersion: () => boundary.settingsVersion,
}));

vi.mock('@/voice/registry/defaultRegistry', () => ({
  createDefaultVoiceProviderRegistry: () => ({
    get: () => boundary.currentDeclaration
      ? { kind: 'voice.conversation-provider.v1', declaration: boundary.currentDeclaration }
      : null,
  }),
}));

vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock({
    translate: (key, params) => params ? `${key} ${JSON.stringify(params)}` : key,
  });
});

const recipientContract = normalizeRecipientContractV1({
  version: 1,
  package: {
    pluginId: 'com.acme.voice',
    source: { kind: 'package', locator: '@acme/voice' },
  },
  publisher: {
    trust: 'verified',
    identity: 'npm:https://registry.npmjs.org:@acme',
  },
  contribution: {
    pluginId: 'com.acme.voice',
    localId: 'conversation',
  },
  credentialSlot: {
    id: 'api-key',
    scope: 'account',
  },
  operations: [
    {
      id: 'z-catalog',
      purpose: 'voice.catalog',
      credentialSlotId: 'api-key',
      effect: 'read',
      request: {
        origin: 'https://catalog.example.com',
        pathTemplate: '/v1/voices',
        queryTemplate: [{ name: 'internal-mode', value: 'DO_NOT_SHOW_STATIC' }],
        headerTemplate: [{ name: 'x-static', value: 'DO_NOT_SHOW_HEADER' }],
        bodyTemplate: { kind: 'none' },
        method: 'GET',
        credential: { kind: 'httpHeader', name: 'x-api-key', format: 'raw' },
        redirect: 'error',
        maxBodyBytes: 0,
        contentTypes: [],
      },
      parameters: {
        schema: { type: 'object', properties: {}, additionalProperties: false },
        mapping: [],
      },
      response: {
        maxBytes: 32_768,
        contentTypes: ['application/json'],
      },
    },
    {
      id: 'a-create',
      purpose: 'voice.session-create',
      credentialSlotId: 'api-key',
      effect: 'mutation',
      request: {
        origin: 'https://api.example.com',
        pathTemplate: '/v1/sessions',
        queryTemplate: [],
        headerTemplate: [],
        bodyTemplate: { kind: 'json', value: { internal: 'DO_NOT_SHOW_BODY' } },
        method: 'POST',
        credential: { kind: 'httpHeader', name: 'authorization', format: 'bearer' },
        redirect: 'error',
        maxBodyBytes: 4_096,
        contentTypes: ['application/json'],
      },
      parameters: {
        schema: { type: 'object', properties: {}, additionalProperties: false },
        mapping: [],
      },
      response: {
        maxBytes: 65_536,
        contentTypes: ['application/json'],
      },
    },
  ],
  presentation: { title: 'Acme Voice' },
});

const credentialSourceDeclaration = VoiceProviderContributionSchema.parse({
  id: 'conversation',
  title: 'Acme Voice',
  kind: 'conversation',
  roles: ['realtime_conversation'],
  platforms: ['web'],
  capabilities: { turn: { cancelResponse: false, bargeIn: false } },
  credentials: {
    slot: { id: 'api-key', purpose: 'voice.client-auth', title: 'API key' },
    requirement: { kind: 'always' },
    sources: [{
      kind: 'savedSecret',
      secretKinds: ['apiKey'],
      rawGrants: [{
        realm: 'web',
        phase: 'prepare',
        request: {
          kind: 'httpHeaders',
          origin: 'https://api.example.com',
          headerNames: ['authorization'],
        },
      }],
    }],
  },
  client: {
    artifactId: 'web-runtime',
    modulePath: './voiceRuntime',
    exportName: 'activate',
  },
});

describe('VoiceCredentialItem', () => {
  it('mounts raw review only for the selected source in the current realm and phase', async () => {
    const { settingsParse } = await import('@/sync/domains/settings/settings');
    const {
      applyAccountVoiceCredentialSourceSelection,
      upsertAccountVoiceCredential,
    } = await import('./accountVoiceCredential');
    const contribution = { pluginId: 'com.acme.voice', localId: 'conversation' } as const;
    const withSecret = upsertAccountVoiceCredential({
      settings: settingsParse({}), contribution, credentialSlotId: 'api-key', value: 'secret',
      generateId: () => 'secret-id', now: 1, expectedSecretId: null, expectedSecretUpdatedAt: null,
    }).settings;
    boundary.settings = applyAccountVoiceCredentialSourceSelection({
      settings: withSecret,
      mutation: {
        contribution,
        credentialSlotId: 'api-key',
        selection: { kind: 'savedSecret' },
        expectedSettingsVersion: 0,
      },
      currentDeclaration: credentialSourceDeclaration,
    }).settings;
    const { VoiceCredentialItem } = await import('./CredentialItem');
    const screen = await renderScreen(<VoiceCredentialItem
      testID="credential"
      title="API key"
      promptTitle="Connect"
      promptDescription="Paste key"
      contribution={contribution}
      credentialSlotId="api-key"
      credentialSourcePurpose="voice.client-auth"
      credentialSourceDeclaration={credentialSourceDeclaration}
      rawCredentialReviewGrants={credentialSourceDeclaration.credentials?.sources[0]?.rawGrants ?? []}
      disclosePlainStorage={true}
    />);

    const review = screen.tree.findByTestId('credential-raw-credential-access');
    expect(review?.props.contribution).toEqual({
      pluginId: 'com.acme.voice',
      localId: 'conversation',
    });
    expect(review?.props.rawGrant).toEqual(
      credentialSourceDeclaration.credentials?.sources[0]?.rawGrants?.[0],
    );

    await screen.update(<VoiceCredentialItem
      testID="credential"
      title="API key"
      promptTitle="Connect"
      promptDescription="Paste key"
      contribution={contribution}
      credentialSlotId="api-key"
      credentialSourcePurpose="voice.client-auth"
      credentialSourceDeclaration={credentialSourceDeclaration}
      rawCredentialReviewGrants={[]}
      disclosePlainStorage={true}
    />);
    expect(screen.tree.findByTestId('credential-raw-credential-access')).toBeNull();
  });

  it('replaces a legacy OpenAI SavedSecret without changing a dormant Account source selection', async () => {
    const { settingsParse } = await import('@/sync/domains/settings/settings');
    boundary.settings = settingsParse({
      secrets: [{
        id: 'openai-secret',
        name: 'OpenAI',
        kind: 'apiKey',
        encryptedValue: { _isSecretValue: true, value: 'sk-old' },
        createdAt: 1,
        updatedAt: 1,
      }],
      voiceSettingsV1: {
        credentialBindings: [{
          contribution: { pluginId: 'happier.voice.openai', localId: 'realtime-openai' },
          credentialSlotId: 'api_key',
          credentialSource: { kind: 'connectedAccount' },
          credentialBindings: { account: { api_key: 'openai-secret' } },
        }],
      },
      connectedAccountPurposeBindingsV1: {
        v: 1,
        bindings: [{
          purpose: {
            consumer: { pluginId: 'happier.voice.openai', localId: 'realtime-openai' },
            purpose: 'voice.client-auth',
          },
          target: {
            kind: 'account',
            account: {
              service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
              accountId: 'codex-account',
            },
          },
        }],
      },
    });
    boundary.confirm.mockReset();
    boundary.prompt.mockReset();
    boundary.prompt.mockResolvedValue('sk-replaced');
    boundary.mutateAccountSettings.mockReset();
    let changed: any = null;
    boundary.mutateAccountSettings.mockImplementationOnce(async (update) => {
      changed = update(boundary.settings);
    });

    const { VoiceCredentialItem } = await import('./CredentialItem');
    const screen = await renderScreen(<VoiceCredentialItem
      testID="credential"
      title="API key"
      promptTitle="Connect"
      promptDescription="Paste key"
      contribution={{ pluginId: 'happier.voice.openai', localId: 'realtime-openai' }}
      credentialSlotId="api_key"
      disclosePlainStorage={true}
    />);

    act(() => screen.tree.findByTestId('credential')?.props.onSelect('enterNew'));
    await vi.waitFor(() => expect(boundary.mutateAccountSettings).toHaveBeenCalledOnce());
    expect(changed.voiceSettingsV1.credentialBindings[0].credentialSource)
      .toEqual({ kind: 'connectedAccount' });
    expect(changed.connectedAccountPurposeBindingsV1).toEqual({
      v: 1,
      bindings: [{
        purpose: {
          consumer: { pluginId: 'happier.voice.openai', localId: 'realtime-openai' },
          purpose: 'voice.client-auth',
        },
        target: {
          kind: 'account',
          account: {
            service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
            accountId: 'codex-account',
          },
        },
      }],
    });
    expect(changed.secrets).toEqual([
      expect.objectContaining({
        encryptedValue: { _isSecretValue: true, value: 'sk-replaced' },
      }),
    ]);
  });

  it('binds a SavedSecret the account already stores instead of demanding re-entry', async () => {
    const { settingsParse } = await import('@/sync/domains/settings/settings');
    // The binding row is gone while the SavedSecret record survives: the state
    // a user is left in after a Voice binding-loss event.
    boundary.settings = settingsParse({
      secrets: [{
        id: 'elevenlabs-secret',
        name: 'ElevenLabs',
        kind: 'apiKey',
        encryptedValue: { _isSecretValue: true, value: 'sk-already-stored' },
        createdAt: 1,
        updatedAt: 1,
      }],
      voiceSettingsV1: { credentialBindings: [] },
    });
    boundary.confirm.mockReset();
    boundary.prompt.mockReset();
    boundary.prompt.mockResolvedValue('SHOULD_NOT_BE_PROMPTED');
    boundary.show.mockReset();
    boundary.show.mockImplementation((config) => {
      const picker = config as unknown as Readonly<{
        props: Readonly<{ selectedId: string | null; onSelectId(id: string | null): void }>;
      }>;
      picker.props.onSelectId('elevenlabs-secret');
      return 'modal-id';
    });
    boundary.mutateAccountSettings.mockReset();
    let changed: any = null;
    boundary.mutateAccountSettings.mockImplementationOnce(async (update: any) => {
      changed = update(boundary.settings);
    });

    const { VoiceCredentialItem } = await import('./CredentialItem');
    const screen = await renderScreen(<VoiceCredentialItem
      testID="credential"
      title="API key"
      promptTitle="Connect"
      promptDescription="Paste key"
      contribution={{ pluginId: 'happier.voice.elevenlabs', localId: 'realtime-elevenlabs' }}
      credentialSlotId="api_key"
      disclosePlainStorage={true}
    />);

    const row = screen.tree.findByTestId('credential');
    expect(row?.props.items.map((item: { id: string }) => item.id))
      .toEqual(['useSavedSecret', 'enterNew']);

    act(() => row?.props.onSelect('useSavedSecret'));
    await vi.waitFor(() => expect(boundary.mutateAccountSettings).toHaveBeenCalledOnce());

    const { SavedSecretPickerModal } = await import('@/components/ui/forms/valueRefs/SavedSecretPickerModal');
    const shown = boundary.show.mock.calls[0]?.[0] as unknown as Readonly<{
      component: unknown;
      props: Readonly<{ includeNoneRow?: boolean; allowAdd?: boolean; allowEdit?: boolean }>;
    }>;
    expect(shown.component).toBe(SavedSecretPickerModal);
    // The picker is opened as a selector over what the account already stores: creating, renaming,
    // replacing and deleting a record all belong to flows that carry their own disclosure.
    expect(shown.props).toMatchObject({ includeNoneRow: false, allowAdd: false, allowEdit: false });
    expect(boundary.prompt).not.toHaveBeenCalled();
    expect(changed.secrets).toEqual(boundary.settings.secrets);
    expect(changed.voiceSettingsV1.credentialBindings).toEqual([{
      contribution: { pluginId: 'happier.voice.elevenlabs', localId: 'realtime-elevenlabs' },
      credentialSlotId: 'api_key',
      credentialSource: { kind: 'none' },
      credentialBindings: { account: { api_key: 'elevenlabs-secret' } },
    }]);
  });

  it('writes the selected SavedSecret through the source owner when the slot still names a destroyed record', async () => {
    const { settingsParse } = await import('@/sync/domains/settings/settings');
    // The live state after a binding-loss event: the slot keeps a reference the
    // account can no longer resolve, so the row reads as unset while every CAS
    // it can build names a record that is gone.
    boundary.settings = settingsParse({
      secrets: [{
        id: 'surviving-secret',
        name: 'Voice: acme',
        kind: 'apiKey',
        encryptedValue: { _isSecretValue: true, value: 'sk-already-stored' },
        createdAt: 1,
        updatedAt: 1,
      }],
      voiceSettingsV1: {
        credentialBindings: [{
          contribution: { pluginId: 'com.acme.voice', localId: 'conversation' },
          credentialSlotId: 'api-key',
          credentialSource: { kind: 'savedSecret' },
          credentialBindings: { account: { 'api-key': 'destroyed-secret' } },
        }],
      },
    });
    boundary.settingsVersion = 4;
    boundary.currentDeclaration = VoiceProviderContributionSchema.parse(
      structuredClone(credentialSourceDeclaration),
    );
    boundary.log.mockReset();
    boundary.confirm.mockReset();
    boundary.confirm.mockResolvedValue(true);
    boundary.prompt.mockReset();
    boundary.prompt.mockResolvedValue('SHOULD_NOT_BE_PROMPTED');
    boundary.show.mockReset();
    boundary.show.mockImplementation((config) => {
      const picker = config as unknown as Readonly<{
        props: Readonly<{ onSelectId(id: string | null): void }>;
      }>;
      picker.props.onSelectId('surviving-secret');
      return 'modal-id';
    });
    boundary.mutateAccountSettings.mockReset();
    boundary.mutateAccountSettingsOnce.mockReset();
    let changed: any = null;
    boundary.mutateAccountSettingsOnce.mockImplementationOnce(async (input: any) => {
      const { settingsParse } = await import('@/sync/domains/settings/settings');
      const applied = input.mutate(boundary.settings);
      changed = applied.settings;
      // An applied write becomes the account snapshot; the gesture verifies
      // against it, so a stub that reports success without storing anything is
      // not a faithful stand-in for the transport.
      boundary.settings = settingsParse(applied.settings);
      return { status: 'applied', settingsVersion: 5, value: applied.value };
    });

    const { VoiceCredentialItem } = await import('./CredentialItem');
    const screen = await renderScreen(<VoiceCredentialItem
      testID="credential"
      title="API key"
      promptTitle="Connect"
      promptDescription="Paste key"
      contribution={{ pluginId: 'com.acme.voice', localId: 'conversation' }}
      credentialSlotId="api-key"
      credentialSourcePurpose="voice.client-auth"
      credentialSourceDeclaration={credentialSourceDeclaration}
      recipientContract={recipientContract}
      disclosePlainStorage={true}
    />);

    act(() => screen.tree.findByTestId('credential')?.props.onSelect('useSavedSecret'));
    // The contract is the write, not the callback: the gesture is only complete
    // when the account-settings mutation boundary receives the binding.
    await vi.waitFor(() => expect(boundary.mutateAccountSettingsOnce).toHaveBeenCalledOnce());
    expect(boundary.prompt).not.toHaveBeenCalled();
    // Reaching the boundary is not enough: a rejected mutation produces no
    // settings at all, which is exactly how this bind failed in the app.
    expect(changed, 'the account-settings boundary received no settings').not.toBeNull();
    expect(changed.secrets).toEqual(boundary.settings!.secrets);
    expect(changed.voiceSettingsV1.credentialBindings).toEqual([{
      contribution: { pluginId: 'com.acme.voice', localId: 'conversation' },
      credentialSlotId: 'api-key',
      credentialSource: { kind: 'savedSecret' },
      credentialBindings: { account: { 'api-key': 'surviving-secret' } },
      approvedRecipientContractDigest: createRecipientContractDigestV1(recipientContract),
    }]);
    expect(boundary.log.mock.calls.map(([message]) => message)
      .filter((message) => message.includes('voice_credential:'))).toEqual([]);
  });

  it('re-asserts the selected SavedSecret when the slot already names it under a dormant source', async () => {
    const { settingsParse } = await import('@/sync/domains/settings/settings');
    // Selecting the record the slot already stores is not a no-op: the source
    // that decides whether it is used can still be dormant, which is exactly
    // the state the row reports as unusable.
    boundary.settings = settingsParse({
      secrets: [{
        id: 'surviving-secret',
        name: 'Voice: acme',
        kind: 'apiKey',
        encryptedValue: { _isSecretValue: true, value: 'sk-already-stored' },
        createdAt: 1,
        updatedAt: 1,
      }],
      voiceSettingsV1: {
        credentialBindings: [{
          contribution: { pluginId: 'com.acme.voice', localId: 'conversation' },
          credentialSlotId: 'api-key',
          credentialSource: { kind: 'none' },
          credentialBindings: { account: { 'api-key': 'surviving-secret' } },
        }],
      },
    });
    boundary.settingsVersion = 4;
    boundary.currentDeclaration = VoiceProviderContributionSchema.parse(
      structuredClone(credentialSourceDeclaration),
    );
    boundary.log.mockReset();
    boundary.confirm.mockReset();
    boundary.confirm.mockResolvedValue(true);
    boundary.prompt.mockReset();
    boundary.show.mockReset();
    boundary.show.mockImplementation((config) => {
      const picker = config as unknown as Readonly<{
        props: Readonly<{ onSelectId(id: string | null): void }>;
      }>;
      picker.props.onSelectId('surviving-secret');
      return 'modal-id';
    });
    boundary.mutateAccountSettings.mockReset();
    boundary.mutateAccountSettingsOnce.mockReset();
    let changed: any = null;
    boundary.mutateAccountSettingsOnce.mockImplementationOnce(async (input: any) => {
      const { settingsParse } = await import('@/sync/domains/settings/settings');
      const applied = input.mutate(boundary.settings);
      changed = applied.settings;
      // An applied write becomes the account snapshot; the gesture verifies
      // against it, so a stub that reports success without storing anything is
      // not a faithful stand-in for the transport.
      boundary.settings = settingsParse(applied.settings);
      return { status: 'applied', settingsVersion: 5, value: applied.value };
    });

    const { VoiceCredentialItem } = await import('./CredentialItem');
    const screen = await renderScreen(<VoiceCredentialItem
      testID="credential"
      title="API key"
      promptTitle="Connect"
      promptDescription="Paste key"
      contribution={{ pluginId: 'com.acme.voice', localId: 'conversation' }}
      credentialSlotId="api-key"
      credentialSourcePurpose="voice.client-auth"
      credentialSourceDeclaration={credentialSourceDeclaration}
      disclosePlainStorage={true}
    />);

    act(() => screen.tree.findByTestId('credential')?.props.onSelect('useSavedSecret'));
    await vi.waitFor(() => expect(boundary.mutateAccountSettingsOnce).toHaveBeenCalledOnce());
    expect(changed.voiceSettingsV1.credentialBindings[0]).toMatchObject({
      credentialSource: { kind: 'savedSecret' },
      credentialBindings: { account: { 'api-key': 'surviving-secret' } },
    });
  });

  it('records one bounded failure instead of silently applying nothing after a selection', async () => {
    const { settingsParse } = await import('@/sync/domains/settings/settings');
    boundary.settings = settingsParse({
      secrets: [{
        id: 'surviving-secret',
        name: 'Voice: acme',
        kind: 'apiKey',
        encryptedValue: { _isSecretValue: true, value: 'sk-already-stored' },
        createdAt: 1,
        updatedAt: 1,
      }],
      voiceSettingsV1: { credentialBindings: [] },
    });
    boundary.settingsVersion = 4;
    boundary.currentDeclaration = VoiceProviderContributionSchema.parse(
      structuredClone(credentialSourceDeclaration),
    );
    boundary.log.mockReset();
    boundary.confirm.mockReset();
    // The approval never returns true — declined by the user, or dismissed
    // before it was ever readable. Both are this same `false`.
    boundary.confirm.mockResolvedValue(false);
    boundary.prompt.mockReset();
    boundary.show.mockReset();
    boundary.show.mockImplementation((config) => {
      const picker = config as unknown as Readonly<{
        props: Readonly<{ onSelectId(id: string | null): void }>;
      }>;
      picker.props.onSelectId('surviving-secret');
      return 'modal-id';
    });
    boundary.mutateAccountSettings.mockReset();
    boundary.mutateAccountSettingsOnce.mockReset();

    const { VoiceCredentialItem } = await import('./CredentialItem');
    const screen = await renderScreen(<VoiceCredentialItem
      testID="credential"
      title="API key"
      promptTitle="Connect"
      promptDescription="Paste key"
      contribution={{ pluginId: 'com.acme.voice', localId: 'conversation' }}
      credentialSlotId="api-key"
      credentialSourcePurpose="voice.client-auth"
      credentialSourceDeclaration={credentialSourceDeclaration}
      recipientContract={recipientContract}
      disclosePlainStorage={true}
    />);

    act(() => screen.tree.findByTestId('credential')?.props.onSelect('useSavedSecret'));
    await vi.waitFor(() => expect(boundary.log).toHaveBeenCalled());
    expect(boundary.mutateAccountSettingsOnce).not.toHaveBeenCalled();
    expect(boundary.mutateAccountSettings).not.toHaveBeenCalled();
    expect(boundary.log.mock.calls.map(([message]) => message)).toEqual([
      `[voiceRuntimeFailure] ${JSON.stringify({
        providerId: 'com.acme.voice/conversation',
        outcome: 'declined',
        kind: 'voice_credential:useSavedSecret',
        reason: 'recipient_contract_not_approved',
      })}`,
    ]);
  });

  it('records one bounded failure when the binding cannot reach the source owner', async () => {
    const { settingsParse } = await import('@/sync/domains/settings/settings');
    boundary.settings = settingsParse({
      secrets: [{
        id: 'surviving-secret',
        name: 'Voice: acme',
        kind: 'apiKey',
        encryptedValue: { _isSecretValue: true, value: 'sk-already-stored' },
        createdAt: 1,
        updatedAt: 1,
      }],
      voiceSettingsV1: { credentialBindings: [] },
    });
    // No readable settings version: the source mutation has no CAS basis, so
    // the gesture cannot write and must say so.
    boundary.settingsVersion = null;
    boundary.currentDeclaration = VoiceProviderContributionSchema.parse(
      structuredClone(credentialSourceDeclaration),
    );
    boundary.log.mockReset();
    boundary.confirm.mockReset();
    boundary.confirm.mockResolvedValue(true);
    boundary.prompt.mockReset();
    boundary.show.mockReset();
    boundary.show.mockImplementation((config) => {
      const picker = config as unknown as Readonly<{
        props: Readonly<{ onSelectId(id: string | null): void }>;
      }>;
      picker.props.onSelectId('surviving-secret');
      return 'modal-id';
    });
    boundary.mutateAccountSettings.mockReset();
    boundary.mutateAccountSettingsOnce.mockReset();

    const { VoiceCredentialItem } = await import('./CredentialItem');
    const screen = await renderScreen(<VoiceCredentialItem
      testID="credential"
      title="API key"
      promptTitle="Connect"
      promptDescription="Paste key"
      contribution={{ pluginId: 'com.acme.voice', localId: 'conversation' }}
      credentialSlotId="api-key"
      credentialSourcePurpose="voice.client-auth"
      credentialSourceDeclaration={credentialSourceDeclaration}
      disclosePlainStorage={true}
    />);

    act(() => screen.tree.findByTestId('credential')?.props.onSelect('useSavedSecret'));
    await vi.waitFor(() => expect(boundary.log).toHaveBeenCalled());
    expect(boundary.mutateAccountSettingsOnce).not.toHaveBeenCalled();
    expect(boundary.log.mock.calls.map(([message]) => message)).toEqual([
      `[voiceRuntimeFailure] ${JSON.stringify({
        providerId: 'com.acme.voice/conversation',
        outcome: 'failed',
        kind: 'voice_credential:useSavedSecret',
        reason: 'voice_credential_source_declaration_unavailable',
      })}`,
    ]);
  });

  it('atomically saves and activates a SavedSecret when the selector purpose is declared', async () => {
    const { settingsParse } = await import('@/sync/domains/settings/settings');
    boundary.settings = settingsParse({});
    boundary.confirm.mockReset();
    boundary.confirm.mockResolvedValue(false);
    boundary.prompt.mockReset();
    boundary.prompt.mockResolvedValue('sk-atomic');
    boundary.mutateAccountSettings.mockReset();
    boundary.mutateAccountSettingsOnce.mockReset();
    boundary.settingsVersion = 4;
    boundary.currentDeclaration = VoiceProviderContributionSchema.parse(
      structuredClone(credentialSourceDeclaration),
    );
    let changed: unknown = null;
    boundary.mutateAccountSettingsOnce.mockImplementationOnce(async (input) => {
      const applied = input.mutate(boundary.settings);
      changed = applied.settings;
      return { status: 'applied', settingsVersion: 5, value: applied.value };
    });

    const { VoiceCredentialItem } = await import('./CredentialItem');
    const screen = await renderScreen(<VoiceCredentialItem
      testID="credential"
      title="API key"
      promptTitle="Connect"
      promptDescription="Paste key"
      contribution={{ pluginId: 'com.acme.voice', localId: 'conversation' }}
      credentialSlotId="api-key"
      credentialSourcePurpose="voice.client-auth"
      credentialSourceDeclaration={credentialSourceDeclaration}
      disclosePlainStorage={true}
    />);

    act(() => screen.tree.findByTestId('credential')?.props.onPress());
    await vi.waitFor(() => expect(boundary.mutateAccountSettingsOnce).toHaveBeenCalledOnce());
    expect(boundary.mutateAccountSettings).not.toHaveBeenCalled();
    expect(changed).toMatchObject({
      voiceSettingsV1: {
        credentialBindings: [{
          contribution: { pluginId: 'com.acme.voice', localId: 'conversation' },
          credentialSlotId: 'api-key',
          credentialSource: { kind: 'savedSecret' },
        }],
      },
    });
  });

  it('fails closed instead of falling back when a qualified declaration is unavailable', async () => {
    const { settingsParse } = await import('@/sync/domains/settings/settings');
    boundary.settings = settingsParse({});
    boundary.currentDeclaration = null;
    boundary.settingsVersion = 4;
    boundary.prompt.mockReset();
    boundary.prompt.mockResolvedValue('sk-legacy');
    boundary.mutateAccountSettings.mockReset();
    boundary.mutateAccountSettingsOnce.mockReset();
    const { Modal } = await import('@/modal');
    vi.mocked(Modal.alertAsync).mockClear();

    const { VoiceCredentialItem } = await import('./CredentialItem');
    const screen = await renderScreen(<VoiceCredentialItem
      testID="credential"
      title="API key"
      promptTitle="Connect"
      promptDescription="Paste key"
      contribution={{ pluginId: 'happier.voice.openai-compat', localId: 'stt' }}
      credentialSlotId="api_key"
      credentialSourcePurpose="voice.speech.transcribe"
      disclosePlainStorage={false}
    />);

    act(() => screen.tree.findByTestId('credential')?.props.onPress());
    await vi.waitFor(() => expect(Modal.alertAsync).toHaveBeenCalledWith(
      'common.error',
      'settingsVoice.local.voiceCredential.operationFailed',
    ));
    expect(boundary.mutateAccountSettingsOnce).not.toHaveBeenCalled();
    expect(boundary.mutateAccountSettings).not.toHaveBeenCalled();
  });

  it('reports a qualified save-and-use conflict without claiming the credential changed', async () => {
    const { Modal } = await import('@/modal');
    const { settingsParse } = await import('@/sync/domains/settings/settings');
    boundary.settings = settingsParse({});
    boundary.currentDeclaration = VoiceProviderContributionSchema.parse(
      structuredClone(credentialSourceDeclaration),
    );
    boundary.settingsVersion = 4;
    boundary.prompt.mockReset();
    boundary.prompt.mockResolvedValue('sk-loser');
    boundary.mutateAccountSettings.mockReset();
    boundary.mutateAccountSettingsOnce.mockReset();
    boundary.mutateAccountSettingsOnce.mockResolvedValueOnce({
      status: 'conflict',
      currentSettingsVersion: 5,
    });
    vi.mocked(Modal.alertAsync).mockClear();
    const onChanged = vi.fn();

    const { VoiceCredentialItem } = await import('./CredentialItem');
    const screen = await renderScreen(<VoiceCredentialItem
      testID="credential"
      title="API key"
      promptTitle="Connect"
      promptDescription="Paste key"
      contribution={{ pluginId: 'com.acme.voice', localId: 'conversation' }}
      credentialSlotId="api-key"
      credentialSourcePurpose="voice.client-auth"
      credentialSourceDeclaration={credentialSourceDeclaration}
      disclosePlainStorage={true}
      onChanged={onChanged}
    />);

    act(() => screen.tree.findByTestId('credential')?.props.onPress());
    await vi.waitFor(() => expect(Modal.alertAsync).toHaveBeenCalledWith(
      'common.error',
      'settingsVoice.local.voiceCredential.operationFailed',
    ));

    expect(boundary.mutateAccountSettingsOnce).toHaveBeenCalledOnce();
    expect(boundary.mutateAccountSettings).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('reports an ambiguous selected SavedSecret binding without claiming it became effective', async () => {
    const { Modal } = await import('@/modal');
    const { settingsParse } = await import('@/sync/domains/settings/settings');
    boundary.settings = settingsParse({
      secrets: [{
        id: 'surviving-secret',
        name: 'Voice: acme',
        kind: 'apiKey',
        encryptedValue: { _isSecretValue: true, value: 'sk-already-stored' },
        createdAt: 1,
        updatedAt: 1,
      }],
      voiceSettingsV1: { credentialBindings: [] },
    });
    boundary.currentDeclaration = VoiceProviderContributionSchema.parse(
      structuredClone(credentialSourceDeclaration),
    );
    boundary.settingsVersion = 4;
    boundary.show.mockReset();
    boundary.show.mockImplementation((config) => {
      const picker = config as unknown as Readonly<{
        props: Readonly<{ onSelectId(id: string | null): void }>;
      }>;
      picker.props.onSelectId('surviving-secret');
      return 'modal-id';
    });
    boundary.mutateAccountSettings.mockReset();
    boundary.mutateAccountSettingsOnce.mockReset();
    boundary.mutateAccountSettingsOnce.mockResolvedValueOnce({
      status: 'outcomeUnknown',
      lastKnownSettingsVersion: 5,
      safeSnapshotVersion: 5,
    });
    boundary.log.mockReset();
    vi.mocked(Modal.alertAsync).mockClear();
    const onChanged = vi.fn();

    const { VoiceCredentialItem } = await import('./CredentialItem');
    const screen = await renderScreen(<VoiceCredentialItem
      testID="credential"
      title="API key"
      promptTitle="Connect"
      promptDescription="Paste key"
      contribution={{ pluginId: 'com.acme.voice', localId: 'conversation' }}
      credentialSlotId="api-key"
      credentialSourcePurpose="voice.client-auth"
      credentialSourceDeclaration={credentialSourceDeclaration}
      disclosePlainStorage={true}
      onChanged={onChanged}
    />);

    act(() => screen.tree.findByTestId('credential')?.props.onSelect('useSavedSecret'));
    await vi.waitFor(() => expect(Modal.alertAsync).toHaveBeenCalledWith(
      'common.error',
      'settingsProviders.errors.mutationOutcomeUnknownDescription',
    ));

    expect(boundary.mutateAccountSettingsOnce).toHaveBeenCalledOnce();
    expect(boundary.mutateAccountSettings).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
    expect(boundary.log.mock.calls.map(([message]) => message)).toContain(
      `[voiceRuntimeFailure] ${JSON.stringify({
        providerId: 'com.acme.voice/conversation',
        outcome: 'unapplied',
        kind: 'voice_credential:useSavedSecret',
        reason: 'saved_secret_binding_outcome_unknown',
      })}`,
    );
  });

  it('reports an ambiguous new SavedSecret replacement without firing onChanged', async () => {
    const { Modal } = await import('@/modal');
    const { settingsParse } = await import('@/sync/domains/settings/settings');
    boundary.settings = settingsParse({});
    boundary.currentDeclaration = VoiceProviderContributionSchema.parse(
      structuredClone(credentialSourceDeclaration),
    );
    boundary.settingsVersion = 4;
    boundary.prompt.mockReset();
    boundary.prompt.mockResolvedValue('sk-possibly-applied');
    boundary.mutateAccountSettings.mockReset();
    boundary.mutateAccountSettingsOnce.mockReset();
    boundary.mutateAccountSettingsOnce.mockResolvedValueOnce({
      status: 'outcomeUnknown',
      lastKnownSettingsVersion: 5,
      safeSnapshotVersion: 5,
    });
    boundary.log.mockReset();
    vi.mocked(Modal.alertAsync).mockClear();
    const onChanged = vi.fn();

    const { VoiceCredentialItem } = await import('./CredentialItem');
    const screen = await renderScreen(<VoiceCredentialItem
      testID="credential"
      title="API key"
      promptTitle="Connect"
      promptDescription="Paste key"
      contribution={{ pluginId: 'com.acme.voice', localId: 'conversation' }}
      credentialSlotId="api-key"
      credentialSourcePurpose="voice.client-auth"
      credentialSourceDeclaration={credentialSourceDeclaration}
      disclosePlainStorage={true}
      onChanged={onChanged}
    />);

    act(() => screen.tree.findByTestId('credential')?.props.onPress());
    await vi.waitFor(() => expect(Modal.alertAsync).toHaveBeenCalledWith(
      'common.error',
      'settingsProviders.errors.mutationOutcomeUnknownDescription',
    ));

    expect(boundary.mutateAccountSettingsOnce).toHaveBeenCalledOnce();
    expect(boundary.mutateAccountSettings).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
    expect(boundary.log.mock.calls.map(([message]) => message)).toContain(
      `[voiceRuntimeFailure] ${JSON.stringify({
        providerId: 'com.acme.voice/conversation',
        outcome: 'unapplied',
        kind: 'voice_credential:enterNew',
        reason: 'saved_secret_replacement_outcome_unknown',
      })}`,
    );
  });

  it('shows every bounded recipient fact and cancellation persists or sends nothing', async () => {
    boundary.settings = null;
    boundary.confirm.mockClear();
    boundary.mutateAccountSettings.mockClear();
    boundary.prompt.mockClear();

    const { VoiceCredentialItem } = await import('./CredentialItem');
    const screen = await renderScreen(React.createElement(VoiceCredentialItem, {
      testID: 'credential',
      title: 'API key',
      promptTitle: 'Connect',
      promptDescription: 'Paste key',
      contribution: { pluginId: 'com.acme.voice', localId: 'conversation' },
      credentialSlotId: 'api-key',
      recipientContract,
      recipientContractDigest: createRecipientContractDigestV1(recipientContract),
      disclosePlainStorage: true,
    }));

    await act(async () => {
      screen.tree.findByTestId('credential')?.props.onPress();
    });
    await vi.waitFor(() => expect(boundary.confirm).toHaveBeenCalledTimes(1));

    const approvalBody = String(boundary.confirm.mock.calls[0]?.[1]);
    expect(approvalBody).toContain('com.acme.voice');
    expect(approvalBody).toContain('@acme/voice');
    expect(approvalBody).toContain('verified');
    expect(approvalBody).toContain('npm:https://registry.npmjs.org:@acme');
    expect(approvalBody).toContain('conversation');
    expect(approvalBody.indexOf('a-create')).toBeLessThan(approvalBody.indexOf('z-catalog'));
    expect(approvalBody).toContain('voice.session-create');
    expect(approvalBody).toContain('mutation');
    expect(approvalBody).toContain('POST');
    expect(approvalBody).toContain('https://api.example.com');
    expect(approvalBody).toContain('/v1/sessions');
    expect(approvalBody).toContain('authorization');
    expect(approvalBody).toContain('bearer');
    expect(approvalBody).toContain('4096');
    expect(approvalBody).toContain('65536');
    expect(approvalBody).toContain('voice.catalog');
    expect(approvalBody).toContain('read');
    expect(approvalBody).toContain('GET');
    expect(approvalBody).toContain('https://catalog.example.com');
    expect(approvalBody).toContain('/v1/voices');
    expect(approvalBody).toContain('x-api-key');
    expect(approvalBody).toContain('raw');
    expect(approvalBody).toContain('0');
    expect(approvalBody).toContain('32768');
    expect(approvalBody).not.toContain('SHOULD_NOT_LEAK');
    expect(approvalBody).not.toContain('DO_NOT_SHOW_STATIC');
    expect(approvalBody).not.toContain('DO_NOT_SHOW_HEADER');
    expect(approvalBody).not.toContain('DO_NOT_SHOW_BODY');
    expect(boundary.mutateAccountSettings).not.toHaveBeenCalled();
  });

  it('presents a retained credential with an obsolete recipient digest as requiring review', async () => {
    const { settingsParse } = await import('@/sync/domains/settings/settings');
    const obsoleteSettings = settingsParse({
      secrets: [{
        id: 'credential',
        name: 'Acme Voice',
        kind: 'apiKey',
        encryptedValue: { _isSecretValue: true, value: 'retained-secret' },
        createdAt: 1,
        updatedAt: 1,
      }],
      voiceSettingsV1: {
        credentialBindings: [{
          contribution: { pluginId: 'com.acme.voice', localId: 'conversation' },
          credentialSlotId: 'api-key',
          credentialSource: { kind: 'savedSecret' },
          approvedRecipientContractDigest: `sha256:${'0'.repeat(64)}`,
          credentialBindings: {
            account: { 'api-key': 'credential' },
          },
        }],
      },
    });
    boundary.settings = obsoleteSettings;
    boundary.confirm.mockClear();

    const { VoiceCredentialItem } = await import('./CredentialItem');
    const onStatusChanged = vi.fn();
    const screen = await renderScreen(React.createElement(VoiceCredentialItem, {
      testID: 'credential',
      title: 'API key',
      promptTitle: 'Connect',
      promptDescription: 'Paste key',
      contribution: { pluginId: 'com.acme.voice', localId: 'conversation' },
      credentialSlotId: 'api-key',
      recipientContract,
      recipientContractDigest: createRecipientContractDigestV1(recipientContract),
      disclosePlainStorage: true,
      onChanged: vi.fn(),
      onStatusChanged,
    }));

    expect(screen.tree.findByTestId('credential')?.props.detail)
      .toBe('settingsVoice.externalCredentials.reviewRequired');
    await vi.waitFor(() => expect(onStatusChanged).toHaveBeenCalledWith({
      status: 'review_required',
      exists: true,
      usable: false,
      source: 'account',
      credentialIdentity: 'credential',
    }));

    boundary.confirm.mockResolvedValueOnce(true);
    boundary.prompt.mockClear();
    boundary.mutateAccountSettings.mockClear();
    let approvedAccountSettings: unknown = null;
    boundary.mutateAccountSettings.mockImplementationOnce(async (update) => {
      approvedAccountSettings = update(obsoleteSettings);
    });
    act(() => {
      screen.tree.findByTestId('credential')?.props.onPress();
    });
    expect(boundary.confirm).not.toHaveBeenCalled();
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    await vi.waitFor(() => expect(boundary.mutateAccountSettings).toHaveBeenCalledTimes(1));
    expect(boundary.prompt).not.toHaveBeenCalled();
    expect(JSON.stringify(boundary.confirm.mock.calls)).not.toContain('retained-secret');
    expect((approvedAccountSettings as {
      secrets: ReadonlyArray<{ id: string; encryptedValue: unknown }>;
      voiceSettingsV1: {
        credentialBindings: ReadonlyArray<{
          approvedRecipientContractDigest?: string;
        }>;
      };
    }).secrets).toEqual(obsoleteSettings.secrets);
    expect((approvedAccountSettings as {
      voiceSettingsV1: {
        credentialBindings: ReadonlyArray<{
          approvedRecipientContractDigest?: string;
        }>;
      };
    }).voiceSettingsV1.credentialBindings[0]?.approvedRecipientContractDigest)
      .toBe(createRecipientContractDigestV1(recipientContract));

    boundary.settings = settingsParse(approvedAccountSettings);
    onStatusChanged.mockClear();
    await screen.update(React.createElement(VoiceCredentialItem, {
      testID: 'credential',
      title: 'API key',
      promptTitle: 'Connect',
      promptDescription: 'Paste key',
      contribution: { pluginId: 'com.acme.voice', localId: 'conversation' },
      credentialSlotId: 'api-key',
      recipientContract,
      recipientContractDigest: createRecipientContractDigestV1(recipientContract),
      disclosePlainStorage: true,
      onStatusChanged,
    }));
    await vi.waitFor(() => expect(onStatusChanged).toHaveBeenCalledWith({
      status: 'ready',
      exists: true,
      usable: true,
      source: 'account',
      credentialIdentity: 'credential',
    }));
  });

  it('reports an unreadable account-settings snapshot instead of claiming the key is not saved', async () => {
    const { settingsParse } = await import('@/sync/domains/settings/settings');
    const parsed = settingsParse({
      secrets: [{
        id: 'credential',
        name: 'Acme',
        kind: 'apiKey',
        encryptedValue: { _isSecretValue: true, value: 'stored-secret' },
        createdAt: 1,
        updatedAt: 1,
      }],
    });
    // One non-canonical entry makes the whole `credentialBindings` collection
    // unreadable. The SavedSecret above is still stored; the row must not tell
    // the user it was never saved.
    boundary.settings = {
      ...parsed,
      voiceSettingsV1: {
        ...parsed.voiceSettingsV1,
        credentialBindings: [{ notACredentialBinding: true }],
      },
    } as unknown as Settings;

    const { VoiceCredentialItem } = await import('./CredentialItem');
    const onStatusChanged = vi.fn();
    const screen = await renderScreen(React.createElement(VoiceCredentialItem, {
      testID: 'credential',
      title: 'API key',
      promptTitle: 'Connect',
      promptDescription: 'Paste key',
      contribution: { pluginId: 'com.acme.voice', localId: 'conversation' },
      credentialSlotId: 'api-key',
      disclosePlainStorage: true,
      onStatusChanged,
    }));

    expect(screen.tree.findByTestId('credential')?.props.detail)
      .toBe('voice.readiness.credential_unknown');
    await vi.waitFor(() => expect(onStatusChanged).toHaveBeenCalledWith({
      status: 'unknown',
      exists: false,
      usable: false,
      source: null,
      credentialIdentity: null,
    }));
  });
});
