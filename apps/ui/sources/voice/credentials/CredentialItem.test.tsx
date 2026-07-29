import * as React from 'react';
import { act } from 'react-test-renderer';
import { createRecipientContractDigestV1, normalizeRecipientContractV1 } from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import type { IModal } from '@/modal/types';
import type { Settings } from '@/sync/domains/settings/settings';

const boundary = vi.hoisted(() => ({
  confirm: vi.fn<IModal['confirm']>(async () => false),
  mutateAccountSettings: vi.fn(),
  prompt: vi.fn(async () => 'SHOULD_NOT_LEAK'),
  settings: null as Settings | null,
}));

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

vi.mock('@/modal', async () => {
  const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
  return createModalModuleMock({
    spies: {
      confirm: boundary.confirm,
      prompt: boundary.prompt,
    },
  }).module;
});

vi.mock('@/sync/api/account/apiAccountEncryptionMode', () => ({
  fetchAccountEncryptionMode: vi.fn(async () => ({ mode: 'e2ee' })),
}));

vi.mock('@/sync/domains/state/storage', async () => {
  const { settingsParse } = await import('@/sync/domains/settings/settings');
  const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
  return createStorageModuleStub({
    useSettings: () => boundary.settings ?? settingsParse({}),
  });
});

vi.mock('@/sync/sync', () => ({
  sync: {
    getCredentials: () => ({ token: 'account-token' }),
    mutateAccountSettings: boundary.mutateAccountSettings,
  },
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

describe('VoiceCredentialItem', () => {
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
      providerId: 'com.acme.voice/conversation',
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
      voice: {
        credentialBindings: [{
          providerId: 'com.acme.voice/conversation',
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
      providerId: 'com.acme.voice/conversation',
      credentialSlotId: 'api-key',
      recipientContract,
      recipientContractDigest: createRecipientContractDigestV1(recipientContract),
      disclosePlainStorage: true,
      onStatusChanged,
    }));

    expect(screen.tree.findByTestId('credential')?.props.detail)
      .toBe('settingsVoice.externalCredentials.reviewRequired');
    await vi.waitFor(() => expect(onStatusChanged).toHaveBeenCalledWith({
      exists: false,
      source: null,
      credentialIdentity: null,
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

    onStatusChanged.mockClear();
    await screen.update(React.createElement(VoiceCredentialItem, {
      testID: 'credential',
      title: 'API key',
      promptTitle: 'Connect',
      promptDescription: 'Paste key',
      providerId: 'com.acme.voice/conversation',
      credentialSlotId: 'api-key',
      disclosePlainStorage: true,
      onStatusChanged,
    }));
    await vi.waitFor(() => expect(onStatusChanged).toHaveBeenCalledWith({
      exists: true,
      source: 'account',
      credentialIdentity: 'credential',
    }));
  });
});
