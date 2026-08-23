import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createRecipientContractDigestV1,
  normalizeRecipientContractV1,
} from '@happier-dev/protocol';

import {
  createAccountVoiceCredentialAuthorityLease,
  createAccountVoiceOperationService as createQualifiedAccountVoiceOperationService,
} from './accountVoiceOperationService';
import { createVoiceClientRawCredentialAccess } from './rawCredentialClient';

const contribution = Object.freeze({
  pluginId: 'happier.voice.openai',
  localId: 'realtime-openai',
});

const rawCredentialIdentity = Object.freeze({
  pluginId: contribution.pluginId,
  contributionId: contribution.localId,
  artifactDigest: `sha256:${'a'.repeat(64)}`,
  hostAppVersion: '2.0.0',
  hostUiApiVersion: '1.0.0',
  reactVersion: '19.0.0',
  reactNativeVersion: '0.83.4',
  platform: 'web' as const,
  channel: 'internal' as const,
  nativeCapabilitiesDigest: `sha256:${'b'.repeat(64)}`,
  projectionGeneration: 12,
});

const rawCredentialRequest = Object.freeze({
  kind: 'httpHeaders' as const,
  origin: 'https://voice.example.test',
  headerNames: Object.freeze(['authorization']),
});

type TestConnectedAccountPurposeBindings = Readonly<{
  v: 1;
  bindings: readonly Readonly<{
    purpose: Readonly<{
      consumer: typeof contribution;
      purpose: string;
    }>;
    target: Readonly<{
      kind: 'account';
      account: Readonly<{
        service: Readonly<{ pluginId: string; localId: string }>;
        accountId: string;
      }>;
    }>;
  }>[];
}>;

function createAccountVoiceOperationService(
  input: Omit<Parameters<typeof createQualifiedAccountVoiceOperationService>[0], 'contribution'>,
) {
  return createQualifiedAccountVoiceOperationService({ ...input, contribution });
}

const mocks = vi.hoisted(() => ({
  state: {
    settingsScope: Object.freeze({ serverId: 'server-1', accountId: 'account-1' }) as Readonly<{
      serverId: string;
      accountId: string;
    }> | null,
    settings: {
      voiceSettingsV1: {
        providers: {
          'happier.voice.openai/realtime-openai': {
            schemaVersion: 1,
            config: {
              model: 'gpt-realtime',
              session: { voice: 'marin', modalities: ['audio', 'text'] },
            },
          },
        },
        credentialBindings: [{
          contribution: {
            pluginId: 'happier.voice.openai',
            localId: 'realtime-openai',
          },
          credentialSlotId: 'api_key',
          credentialSource: { kind: 'savedSecret' as 'savedSecret' | 'connectedAccount' | 'none' },
          credentialBindings: { account: { api_key: 'secret-1' } },
        }],
      },
      secrets: [{
        id: 'secret-1',
        name: 'OpenAI',
        kind: 'apiKey' as const,
        encryptedValue: { _isSecretValue: true as const, value: 'account-secret' },
        createdAt: 1,
        updatedAt: 1,
      }],
      connectedAccountPurposeBindingsV1: undefined as TestConnectedAccountPurposeBindings | undefined,
    },
      profile: {
      connectedServicesV2: [] as Array<{
        serviceId: string;
        profiles: Array<{ profileId: string; status: string; kind: string }>;
        groups: Array<{
          groupId: string;
          activeProfileId: string;
          generation: number;
          memberProfileIds: string[];
        }>;
      }>,
      connectedServiceCredentialRevisionsV1: [] as Array<{
        serviceId: string;
        profileId: string;
        credentialRevision: string;
      }>,
    },
  },
}));

vi.mock('@/sync/domains/state/storage', () => ({
  storage: { getState: () => mocks.state },
}));

vi.mock('@/sync/sync', () => ({
  sync: { decryptSecretValue: () => 'account-secret' },
}));

function createSettings(
  secretId: string,
  updatedAt: number,
  approvedRecipientContractDigest: string | null = recipientContractDigest,
) {
  return {
    voiceSettingsV1: {
      providers: {
        'happier.voice.openai/realtime-openai': {
          schemaVersion: 1,
          config: {
            model: 'gpt-realtime',
            session: { voice: 'marin', modalities: ['audio', 'text'] },
          },
        },
      },
      credentialBindings: [{
        contribution,
        credentialSlotId: 'api_key',
        credentialSource: { kind: 'savedSecret' as 'savedSecret' | 'connectedAccount' | 'none' },
        credentialBindings: { account: { api_key: secretId } },
        ...(approvedRecipientContractDigest
          ? { approvedRecipientContractDigest }
          : {}),
      }],
    },
    secrets: [{
      id: secretId,
      name: 'OpenAI',
      kind: 'apiKey' as const,
      encryptedValue: { _isSecretValue: true as const, value: `account-secret-${updatedAt}` },
      createdAt: 1,
      updatedAt,
    }],
    connectedAccountPurposeBindingsV1: undefined as TestConnectedAccountPurposeBindings | undefined,
  };
}

function createMachineOverrideSettings(machineSecretUpdatedAt: number) {
  const settings = createSettings('account-secret', 1);
  return {
    ...settings,
    voiceSettingsV1: {
      ...settings.voiceSettingsV1,
      credentialBindings: [{
        ...settings.voiceSettingsV1.credentialBindings[0]!,
        credentialBindings: {
          account: { api_key: 'account-secret' },
          byMachineId: { 'machine-1': { api_key: 'machine-secret' } },
        },
      }],
    },
    secrets: [
      ...settings.secrets,
      {
        id: 'machine-secret',
        name: 'Machine OpenAI',
        kind: 'apiKey' as const,
        encryptedValue: {
          _isSecretValue: true as const,
          value: `machine-secret-${machineSecretUpdatedAt}`,
        },
        createdAt: 1,
        updatedAt: machineSecretUpdatedAt,
      },
    ],
  };
}

const recipientContract = normalizeRecipientContractV1({
  version: 1 as const,
  package: Object.freeze({
    pluginId: 'happier.voice.openai',
    source: Object.freeze({ kind: 'bundled' as const, locator: '@happier-dev/plugins-openai' }),
  }),
  publisher: Object.freeze({ trust: 'bundled' as const, identity: 'happier:first-party' }),
  contribution: Object.freeze({ pluginId: 'happier.voice.openai', localId: 'realtime-openai' }),
  credentialSlot: Object.freeze({ id: 'api_key', scope: 'account' as const }),
  operations: Object.freeze([Object.freeze({
    id: 'client-auth',
    purpose: 'voice.client-auth',
    credentialSlotId: 'api_key',
    effect: 'read' as const,
    request: Object.freeze({
      origin: 'https://api.openai.com',
      pathTemplate: '/v1/realtime/client_secrets',
      queryTemplate: Object.freeze([]),
      headerTemplate: Object.freeze([
        Object.freeze({ name: 'accept', value: 'application/json' }),
        Object.freeze({ name: 'content-type', value: 'application/json' }),
      ]),
      bodyTemplate: Object.freeze({ kind: 'json' as const, value: Object.freeze({}) }),
      method: 'POST' as const,
      credential: Object.freeze({
        kind: 'httpHeader' as const,
        name: 'authorization',
        format: 'bearer' as const,
      }),
      redirect: 'error' as const,
      maxBodyBytes: 64 * 1024,
      contentTypes: Object.freeze(['application/json']),
    }),
    parameters: Object.freeze({
      schema: Object.freeze({
        type: 'object' as const,
        properties: Object.freeze({
          body: Object.freeze({ type: 'object' as const, additionalProperties: true }),
        }),
        required: Object.freeze(['body']),
        additionalProperties: false,
      }),
      mapping: Object.freeze([Object.freeze({
        parameter: 'body',
        target: Object.freeze({ kind: 'body' as const, pointer: '' }),
      })]),
    }),
    response: Object.freeze({
      maxBytes: 64 * 1024,
      contentTypes: Object.freeze(['application/json']),
    }),
  })]),
});
const recipientContractDigest = createRecipientContractDigestV1(recipientContract);

/**
 * The same declaration published by a party that could rewrite where the raw
 * key is sent. Only this publisher class carries a re-approval fence.
 */
const externalRecipientContract = normalizeRecipientContractV1({
  ...recipientContract,
  package: { pluginId: 'happier.voice.openai', source: { kind: 'package', locator: '@acme/voice' } },
  publisher: { trust: 'verified' as const, identity: 'npm:https://registry.npmjs.org:@acme' },
});

const multiPurposeRecipientContract = normalizeRecipientContractV1({
  ...recipientContract,
  operations: [
    ...recipientContract.operations,
    {
      id: 'voices',
      purpose: 'voice.catalog.voices',
      credentialSlotId: 'api_key',
      effect: 'read',
      request: {
        ...recipientContract.operations[0]!.request,
        pathTemplate: '/v1/audio/voices',
      },
      parameters: recipientContract.operations[0]!.parameters,
      response: {
        maxBytes: 64 * 1024,
        contentTypes: ['application/json'],
      },
    },
  ],
});

function requestClientAuth(service: ReturnType<typeof createAccountVoiceOperationService>) {
  return service.request({
    operationId: 'client-auth',
    parameters: {
      body: {
        session: {
          type: 'realtime',
          model: 'gpt-realtime',
          audio: { output: { voice: 'marin' } },
        },
      },
    },
    signal: new AbortController().signal,
  });
}

describe('account Voice operation service', () => {
  beforeEach(() => {
    mocks.state = {
      settingsScope: Object.freeze({ serverId: 'server-1', accountId: 'account-1' }),
      settings: createSettings('secret-1', 1),
      profile: {
        connectedServicesV2: [],
        connectedServiceCredentialRevisionsV1: [],
      },
    };
  });

  it('does not re-materialize a changed machine-scoped secret during one live raw invocation', async () => {
    mocks.state = {
      ...mocks.state,
      settings: createMachineOverrideSettings(1),
    };
    const lease = createAccountVoiceCredentialAuthorityLease({
      contribution,
      providerId: 'happier.voice.openai/realtime-openai',
      credentialSlotId: 'api_key',
      purpose: { consumer: contribution, purpose: 'voice.client-auth' },
      machineId: 'machine-1',
      isCurrent: () => true,
    });
    const invoke = vi.fn(async () => ({
      ok: true,
      materialization: {
        kind: 'httpHeaders' as const,
        headers: { authorization: 'Bearer machine-secret' },
      },
      credentialRevision: null,
    }));
    const raw = createVoiceClientRawCredentialAccess({
      identity: rawCredentialIdentity,
      phase: 'connection',
      signal: new AbortController().signal,
      isCurrent: () => true,
      isInvocationCurrent: lease.isCurrent,
      machineId: 'machine-1',
      client: { invoke },
    });

    await expect(raw.materialize(rawCredentialRequest)).resolves.toEqual({
      kind: 'httpHeaders',
      headers: { authorization: 'Bearer machine-secret' },
    });
    mocks.state = {
      ...mocks.state,
      // The source keeps the same SavedSecret id; only the exact selected
      // machine record is replaced while the callback remains live.
      settings: createMachineOverrideSettings(2),
    };

    expect(lease.isCurrent()).toBe(false);
    await expect(raw.materialize(rawCredentialRequest)).rejects.toMatchObject({
      code: 'plugin_voice_credential_access_unavailable',
    });
    expect(invoke).toHaveBeenCalledOnce();
  });

  it('rejects a recipient path that can escape its displayed origin before secret materialization or fetch', () => {
    const materializeSecret = vi.fn(async () => 'account-secret');
    const fetch = vi.fn();
    expect(() => createAccountVoiceOperationService({
      providerId: 'happier.voice.openai/realtime-openai',
      recipientContract: {
        version: 1,
        package: {
          pluginId: 'happier.voice.openai',
          source: { kind: 'package', locator: '@malicious/copied-provider' },
        },
        publisher: { trust: 'verified', identity: 'registry:malicious' },
        contribution: { pluginId: 'happier.voice.openai', localId: 'realtime-openai' },
        credentialSlot: { id: 'api_key', scope: 'account' },
        operations: [{
          id: 'client-auth',
          purpose: 'voice.client-auth',
          credentialSlotId: 'api_key',
          effect: 'read',
          request: {
            origin: 'https://api.openai.com',
            pathTemplate: '//attacker.example/collect',
            queryTemplate: [],
            headerTemplate: [{ name: 'content-type', value: 'application/json' }],
            bodyTemplate: { kind: 'json', value: {} },
            method: 'POST',
            credential: { kind: 'httpHeader', name: 'authorization', format: 'bearer' },
            redirect: 'error',
            maxBodyBytes: 1_024,
            contentTypes: ['application/json'],
          },
          parameters: {
            schema: { type: 'object', properties: {}, additionalProperties: false },
            mapping: [],
          },
          response: { maxBytes: 32_768, contentTypes: ['application/json'] },
        }],
      },
      signal: new AbortController().signal,
      isCurrent: () => true,
      fetch,
      materializeSecret,
    })).toThrow();
    expect(materializeSecret).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('materializes the account secret only inside the exact declared client-auth request', async () => {
    const materializeSecret = vi.fn(async () => 'account-secret');
    const fetch = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ authorization: 'Bearer account-secret' });
      return new Response(JSON.stringify({
        value: 'short-lived-client-auth',
        expires_at: Math.floor(Date.now() / 1_000) + 60,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const service = createAccountVoiceOperationService({
      providerId: 'happier.voice.openai/realtime-openai',
      recipientContract,
      signal: new AbortController().signal,
      isCurrent: () => true,
      fetch,
      materializeSecret,
    });

    expect(materializeSecret).not.toHaveBeenCalled();
    const response = await requestClientAuth(service);

    expect(materializeSecret).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(new TextDecoder().decode(response.body)).toContain('short-lived-client-auth');
    expect(new TextDecoder().decode(response.body)).not.toContain('account-secret');
  });

  it('inspects SavedSecret availability without materializing the secret or calling the provider', async () => {
    const materializeSecret = vi.fn(async () => 'account-secret');
    const fetch = vi.fn();
    const service = createAccountVoiceOperationService({
      providerId: 'happier.voice.openai/realtime-openai',
      recipientContract,
      signal: new AbortController().signal,
      isCurrent: () => true,
      fetch,
      materializeSecret,
    });

    await expect(service.inspectAvailability()).resolves.toBeUndefined();

    expect(materializeSecret).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not fall back to a dormant SavedSecret when a Connected Account source is selected', async () => {
    mocks.state = {
      ...mocks.state,
      settings: {
        ...createSettings('secret-1', 1),
        voiceSettingsV1: {
          ...createSettings('secret-1', 1).voiceSettingsV1,
          credentialBindings: [{
            ...createSettings('secret-1', 1).voiceSettingsV1.credentialBindings[0],
            credentialSource: { kind: 'connectedAccount' as const },
          }],
        },
        connectedAccountPurposeBindingsV1: {
          v: 1 as const,
          bindings: [{
            purpose: { consumer: contribution, purpose: 'voice.client-auth' },
            target: {
              kind: 'account' as const,
              account: {
                service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
                accountId: 'codex-work',
              },
            },
          }],
        },
      },
    };
    const materializeSecret = vi.fn(async () => 'must-not-materialize');
    const fetch = vi.fn();
    const service = createAccountVoiceOperationService({
      providerId: 'happier.voice.openai/realtime-openai',
      recipientContract,
      signal: new AbortController().signal,
      isCurrent: () => true,
      fetch,
      materializeSecret,
    });

    await expect(service.inspectAvailability()).rejects.toMatchObject({
      code: 'credential_unavailable',
    });
    expect(materializeSecret).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('uses the selected Connected Account headers for the mediated request without reading the dormant SavedSecret', async () => {
    mocks.state = {
      ...mocks.state,
      settings: {
        ...createSettings('secret-1', 1),
        voiceSettingsV1: {
          ...createSettings('secret-1', 1).voiceSettingsV1,
          credentialBindings: [{
            ...createSettings('secret-1', 1).voiceSettingsV1.credentialBindings[0],
            credentialSource: { kind: 'connectedAccount' as const },
          }],
        },
        connectedAccountPurposeBindingsV1: {
          v: 1 as const,
          bindings: [{
            purpose: { consumer: contribution, purpose: 'voice.client-auth' },
            target: {
              kind: 'account' as const,
              account: {
                service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
                accountId: 'codex-work',
              },
            },
          }],
        },
      },
    };
    const materializeSecret = vi.fn(async () => 'must-not-materialize');
    const materializeConnectedAccountHeaders = vi.fn(async () => ({
      authorization: 'Bearer codex-access-token',
      'chatgpt-account-id': 'account-work',
    }));
    const fetch = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({
        authorization: 'Bearer codex-access-token',
        'chatgpt-account-id': 'account-work',
      });
      return new Response(JSON.stringify({
        value: 'short-lived-client-auth',
        expires_at: Math.floor(Date.now() / 1_000) + 60,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const service = createAccountVoiceOperationService({
      providerId: 'happier.voice.openai/realtime-openai',
      recipientContract,
      signal: new AbortController().signal,
      isCurrent: () => true,
      fetch,
      materializeSecret,
      materializeConnectedAccountHeaders,
    });

    await expect(service.inspectAvailability()).resolves.toBeUndefined();
    await expect(requestClientAuth(service)).resolves.toMatchObject({ status: 200 });

    // The exact selection this operation's captured authority resolved is what
    // the daemon must be told to materialize under: it resolves its own current
    // Connected Account otherwise.
    expect(materializeConnectedAccountHeaders).toHaveBeenCalledWith({
      operationId: 'client-auth',
      selection: {
        kind: 'account',
        account: {
          service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
          accountId: 'codex-work',
        },
      },
      signal: expect.any(AbortSignal),
    });
    expect(materializeSecret).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('authorizes each operation in a multi-purpose recipient against its exact declared purpose', async () => {
    mocks.state = {
      ...mocks.state,
      settings: {
        ...createSettings('secret-1', 1),
        voiceSettingsV1: {
          ...createSettings('secret-1', 1).voiceSettingsV1,
          credentialBindings: [{
            ...createSettings('secret-1', 1).voiceSettingsV1.credentialBindings[0],
            credentialSource: { kind: 'connectedAccount' as const },
          }],
        },
        connectedAccountPurposeBindingsV1: {
          v: 1 as const,
          bindings: [{
            purpose: { consumer: contribution, purpose: 'voice.catalog.voices' },
            target: {
              kind: 'account' as const,
              account: {
                service: { pluginId: 'happier.voice.openai', localId: 'openai' },
                accountId: 'catalog-account',
              },
            },
          }],
        },
      },
    };
    const materializeConnectedAccountHeaders = vi.fn(async () => ({
      authorization: 'Bearer catalog-token',
    }));
    const fetch = vi.fn(async () => new Response(JSON.stringify({ voices: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const service = createAccountVoiceOperationService({
      providerId: 'happier.voice.openai/realtime-openai',
      recipientContract: multiPurposeRecipientContract,
      signal: new AbortController().signal,
      isCurrent: () => true,
      fetch,
      materializeConnectedAccountHeaders,
    });

    await expect(service.request({
      operationId: 'voices',
      parameters: {
        body: {
          session: {
            type: 'realtime',
            model: 'gpt-realtime',
            audio: { output: { voice: 'marin' } },
          },
        },
      },
      signal: new AbortController().signal,
    })).resolves.toMatchObject({ status: 200 });
    // The client-auth purpose has no qualified binding in this snapshot, so the
    // account-settings read cannot resolve it. That is indeterminate, not an
    // absent credential: it must not claim the bound account is unusable.
    await expect(requestClientAuth(service)).rejects.toMatchObject({
      code: 'service_temporarily_unavailable',
    });

    expect(materializeConnectedAccountHeaders).toHaveBeenCalledTimes(1);
    expect(materializeConnectedAccountHeaders).toHaveBeenCalledWith({
      operationId: 'voices',
      selection: {
        kind: 'account',
        account: {
          service: { pluginId: 'happier.voice.openai', localId: 'openai' },
          accountId: 'catalog-account',
        },
      },
      signal: expect.any(AbortSignal),
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('preserves missing-credential classification when no SavedSecret exists to approve', async () => {
    mocks.state = {
      ...mocks.state,
      settings: {
        ...createSettings('secret-1', 1, null),
        secrets: [],
      },
    };
    const materializeSecret = vi.fn(async () => 'must-not-materialize');
    const fetch = vi.fn();
    const service = createAccountVoiceOperationService({
      providerId: 'happier.voice.openai/realtime-openai',
      recipientContract,
      signal: new AbortController().signal,
      isCurrent: () => true,
      fetch,
      materializeSecret,
    });

    await expect(service.inspectAvailability()).rejects.toMatchObject({
      code: 'credential_unavailable',
    });
    expect(materializeSecret).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reports an unreadable credential snapshot as indeterminate instead of an absent credential', async () => {
    // A Connected Account source whose qualified purpose binding is not in the
    // snapshot makes the account-settings read throw. That is "I cannot tell
    // right now", not "there is no credential": it must not reach the surface
    // as a credential-remediation code (which renders "Review credentials" for
    // a credential that may be perfectly valid).
    mocks.state = {
      ...mocks.state,
      settings: {
        ...createSettings('secret-1', 1),
        voiceSettingsV1: {
          ...createSettings('secret-1', 1).voiceSettingsV1,
          credentialBindings: [{
            ...createSettings('secret-1', 1).voiceSettingsV1.credentialBindings[0],
            credentialSource: { kind: 'connectedAccount' as const },
          }],
        },
        connectedAccountPurposeBindingsV1: undefined,
      },
    };
    const materializeSecret = vi.fn(async () => 'must-not-materialize');
    const materializeConnectedAccountHeaders = vi.fn(async () => ({ authorization: 'Bearer x' }));
    const fetch = vi.fn();
    const service = createAccountVoiceOperationService({
      providerId: 'happier.voice.openai/realtime-openai',
      recipientContract,
      signal: new AbortController().signal,
      isCurrent: () => true,
      fetch,
      materializeSecret,
      materializeConnectedAccountHeaders,
    });

    await expect(service.inspectAvailability()).rejects.toMatchObject({
      code: 'service_temporarily_unavailable',
    });
    await expect(requestClientAuth(service)).rejects.toMatchObject({
      code: 'service_temporarily_unavailable',
    });
    expect(materializeConnectedAccountHeaders).not.toHaveBeenCalled();
    expect(materializeSecret).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects request drift before materializing the account secret', async () => {
    const materializeSecret = vi.fn(async () => 'account-secret');
    const fetch = vi.fn();
    const service = createAccountVoiceOperationService({
      providerId: 'happier.voice.openai/realtime-openai',
      recipientContract,
      signal: new AbortController().signal,
      isCurrent: () => true,
      fetch,
      materializeSecret,
    });

    await expect(service.request({
      operationId: 'unknown-operation',
      parameters: {},
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'voice_account_operation_unauthorized' });
    expect(materializeSecret).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([401, 403])(
    'classifies provider HTTP %s as unavailable credentials and cancels the unread body',
    async (status) => {
      let cancelled = false;
      const fetch = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new TextEncoder().encode('private provider response'));
        },
        cancel() {
          cancelled = true;
        },
      }), { status }));
      const service = createAccountVoiceOperationService({
        providerId: 'happier.voice.openai/realtime-openai',
        recipientContract,
        signal: new AbortController().signal,
        isCurrent: () => true,
        fetch,
        materializeSecret: async () => 'account-secret',
      });

      await expect(requestClientAuth(service)).rejects.toMatchObject({
        code: 'credential_unavailable',
        message: 'credential_unavailable',
      });
      expect(cancelled).toBe(true);
    },
  );

  it.each([
    {
      name: 'a non-success HTTP status',
      response: () => new Response('private provider response', { status: 422 }),
      expected: { kind: 'http_status', status: 422, statusClass: '4xx' },
    },
    {
      name: 'an unexpected content type',
      response: () => new Response('{}', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      }),
      expected: { kind: 'content_type', status: 200, statusClass: '2xx' },
    },
    {
      name: 'an oversized response body',
      response: () => new Response('{}', {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'content-length': '65537',
        },
      }),
      expected: { kind: 'body_too_large', status: 200, statusClass: '2xx' },
    },
    {
      name: 'an unreadable response body',
      response: () => new Response(new ReadableStream<Uint8Array>({
        pull() {
          throw new Error('private provider read failure');
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
      expected: { kind: 'body_read_failed', status: 200, statusClass: '2xx' },
    },
    {
      name: 'an invalid JSON response projection',
      response: () => new Response('{', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
      expected: { kind: 'json_projection_failed', status: 200, statusClass: '2xx' },
    },
  ])('retains a bounded response failure diagnostic for $name', async ({ response, expected }) => {
    const service = createAccountVoiceOperationService({
      providerId: 'happier.voice.openai/realtime-openai',
      recipientContract,
      signal: new AbortController().signal,
      isCurrent: () => true,
      fetch: async () => response(),
      materializeSecret: async () => 'account-secret',
    });

    await expect(requestClientAuth(service)).rejects.toMatchObject({
      code: 'provider_response_invalid',
      responseFailure: expected,
    });
  });

  it('never reads or retains provider response prose on a non-success HTTP status', async () => {
    // A provider error body is arbitrary text: it can legitimately carry user
    // or startup instructions, tool definitions, workspace/agent identifiers,
    // and transcript fragments that are not byte-identical to any registered
    // credential. The owner therefore keeps the structural failure tuple and
    // never consumes the body at all, so nothing can reach a diagnostic later.
    const sentinel = 'HAPPIER_PROVIDER_PROSE_SENTINEL agent_prompt.tool_ids is not owned by this workspace';
    const response = new Response(
      JSON.stringify({ detail: { status: 'invalid_tool_ids', message: sentinel } }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    );
    const responseBody = response.body;
    if (!responseBody) throw new Error('missing_response_body');
    // Every way the body can be consumed, so a reintroduced read fails here
    // whichever entry point it uses.
    const consumers = [
      vi.spyOn(responseBody, 'getReader'),
      vi.spyOn(response, 'text'),
      vi.spyOn(response, 'json'),
      vi.spyOn(response, 'arrayBuffer'),
    ];
    const cancelBody = vi.spyOn(responseBody, 'cancel');
    const fetch = vi.fn(async () => response);
    const service = createAccountVoiceOperationService({
      providerId: 'happier.voice.openai/realtime-openai',
      recipientContract,
      signal: new AbortController().signal,
      isCurrent: () => true,
      fetch,
      materializeSecret: async () => 'account-secret',
    });

    const failure = await requestClientAuth(service).then(
      () => null,
      (error: unknown) => error as Error & Readonly<{
        code: string;
        responseFailure: Readonly<Record<string, unknown>>;
      }>,
    );

    expect(failure?.code).toBe('provider_response_invalid');
    for (const consumer of consumers) expect(consumer).not.toHaveBeenCalled();
    expect(cancelBody).toHaveBeenCalled();
    // The whole failure tuple is enumerated, so a future field carrying
    // provider text fails here instead of silently reaching a log.
    expect(failure?.responseFailure).toEqual({
      kind: 'http_status',
      status: 400,
      statusClass: '4xx',
    });
    const serialized = JSON.stringify({
      message: failure?.message,
      ...(failure as unknown as Record<string, unknown>),
    });
    expect(serialized).not.toContain('HAPPIER_PROVIDER_PROSE_SENTINEL');
    expect(serialized).not.toContain('account-secret');
  });

  it('retains a bounded response failure diagnostic for a followed redirect', async () => {
    const response = new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    Object.defineProperty(response, 'redirected', { value: true });
    const service = createAccountVoiceOperationService({
      providerId: 'happier.voice.openai/realtime-openai',
      recipientContract,
      signal: new AbortController().signal,
      isCurrent: () => true,
      fetch: async () => response,
      materializeSecret: async () => 'account-secret',
    });

    await expect(requestClientAuth(service)).rejects.toMatchObject({
      code: 'provider_response_invalid',
      responseFailure: { kind: 'redirect', status: 200, statusClass: '2xx' },
    });
  });

  it('retains the selected secret but blocks use until recipient access is reviewed', async () => {
    mocks.state = {
      ...mocks.state,
      settings: createSettings('secret-1', 1, null),
    };
    const materializeSecret = vi.fn(async () => 'account-secret');
    const fetch = vi.fn();
    const service = createAccountVoiceOperationService({
      providerId: 'happier.voice.openai/realtime-openai',
      recipientContract: externalRecipientContract,
      signal: new AbortController().signal,
      isCurrent: () => true,
      fetch,
      materializeSecret,
    });

    await expect(requestClientAuth(service)).rejects.toMatchObject({
      code: 'credential_access_review_required',
      message: 'credential_access_review_required',
    });
    expect(materializeSecret).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.state.settings.voiceSettingsV1.credentialBindings[0]?.credentialBindings.account.api_key)
      .toBe('secret-1');
  });

  it('keeps a first-party bundled recipient usable after an update changed its operations', async () => {
    // The stored approval was collected for the operations Happier shipped
    // before the update; a contract Happier itself authored must not revoke
    // itself, so the credential still reaches the declared origin.
    mocks.state = {
      ...mocks.state,
      settings: createSettings('secret-1', 1, 'sha256:' + 'f'.repeat(64)),
    };
    const materializeSecret = vi.fn(async () => 'account-secret');
    const fetch = vi.fn(async () => new Response(
      '{"value":"ephemeral"}',
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    const service = createAccountVoiceOperationService({
      providerId: 'happier.voice.openai/realtime-openai',
      recipientContract,
      signal: new AbortController().signal,
      isCurrent: () => true,
      fetch,
      materializeSecret,
    });

    await expect(requestClientAuth(service)).resolves.toMatchObject({
      status: 200,
      finalUrl: 'https://api.openai.com/v1/realtime/client_secrets',
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(materializeSecret).toHaveBeenCalledOnce();
  });

  it('rejects a source credential reflected directly or through JSON escaping', async () => {
    for (const responseBody of [
      '{"nested":{"token":"account-secret"}}',
      String.raw`{"nested":{"token":"account-\u0073ecret"}}`,
    ]) {
      const fetch = vi.fn(async () => new Response(
        responseBody,
        { status: 200, headers: { 'content-type': 'application/json' } },
      ));
      const service = createAccountVoiceOperationService({
        providerId: 'happier.voice.openai/realtime-openai',
        recipientContract,
        signal: new AbortController().signal,
        isCurrent: () => true,
        fetch,
        materializeSecret: async () => 'account-secret',
      });

      await expect(requestClientAuth(service)).rejects.toMatchObject({
        code: 'provider_response_invalid',
        responseFailure: {
          kind: 'json_projection_failed',
          status: 200,
          statusClass: '2xx',
        },
      });
    }
  });

  it('withdraws authority when the bundled runtime generation retires during materialization', async () => {
    let current = true;
    const fetch = vi.fn();
    const service = createAccountVoiceOperationService({
      providerId: 'happier.voice.openai/realtime-openai',
      recipientContract,
      signal: new AbortController().signal,
      isCurrent: () => current,
      fetch,
      materializeSecret: async () => {
        current = false;
        return 'account-secret';
      },
    });

    await expect(requestClientAuth(service)).rejects.toMatchObject({ code: 'voice_account_operation_cancelled' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('aborts the exact fetch signal when host authority retires despite a distinct live request signal', async () => {
    const authority = new AbortController();
    const request = new AbortController();
    const fetchSignals: AbortSignal[] = [];
    const fetch = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      const fetchSignal = init?.signal;
      if (!fetchSignal) throw new Error('missing_fetch_signal');
      fetchSignals.push(fetchSignal);
      return await new Promise<Response>((_resolve, reject) => {
        fetchSignal.addEventListener('abort', () => reject(
          Object.assign(new Error('fetch_aborted'), { name: 'AbortError' }),
        ), { once: true });
      });
    });
    const service = createAccountVoiceOperationService({
      providerId: 'happier.voice.openai/realtime-openai',
      recipientContract,
      signal: authority.signal,
      isCurrent: () => !authority.signal.aborted,
      fetch,
      materializeSecret: async () => 'account-secret',
    });
    const pending = service.request({
      operationId: 'client-auth',
      parameters: {
        body: {
          session: {
            type: 'realtime',
            model: 'gpt-realtime',
            audio: { output: { voice: 'marin' } },
          },
        },
      },
      signal: request.signal,
    });
    await vi.waitFor(() => expect(fetchSignals).toHaveLength(1));
    expect(fetchSignals[0]).not.toBe(authority.signal);
    expect(fetchSignals[0]).not.toBe(request.signal);
    authority.abort();
    expect(fetchSignals[0]?.aborted).toBe(true);
    expect(request.signal.aborted).toBe(false);
    await expect(pending).rejects.toMatchObject({ code: 'voice_account_operation_cancelled' });
  });

  it('withdraws authority when the account credential binding rotates during materialization', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      value: 'short-lived-client-auth',
      expires_at: Math.floor(Date.now() / 1_000) + 60,
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const service = createAccountVoiceOperationService({
      providerId: 'happier.voice.openai/realtime-openai',
      recipientContract,
      signal: new AbortController().signal,
      isCurrent: () => true,
      fetch,
      materializeSecret: async () => {
        mocks.state = { ...mocks.state, settings: createSettings('secret-2', 2) };
        return 'account-secret';
      },
    });

    await expect(requestClientAuth(service)).rejects.toMatchObject({ code: 'voice_account_operation_cancelled' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('withdraws authority when the account credential binding rotates while reading the response', async () => {
    const fetch = vi.fn(async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(JSON.stringify({
            value: 'short-lived-client-auth',
            expires_at: Math.floor(Date.now() / 1_000) + 60,
          })));
          mocks.state = { ...mocks.state, settings: createSettings('secret-2', 2) };
          controller.close();
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const service = createAccountVoiceOperationService({
      providerId: 'happier.voice.openai/realtime-openai',
      recipientContract,
      signal: new AbortController().signal,
      isCurrent: () => true,
      fetch,
      materializeSecret: async () => 'account-secret',
    });

    await expect(requestClientAuth(service)).rejects.toMatchObject({ code: 'voice_account_operation_cancelled' });
  });

  it('preserves authority when settings sync rehydrates the same account credential during the response', async () => {
    const fetch = vi.fn(async () => {
      const settings = structuredClone(mocks.state.settings);
      settings.voiceSettingsV1.providers['happier.voice.openai/realtime-openai'] = {
        config: {
          session: { modalities: ['audio', 'text'], voice: 'marin' },
          model: 'gpt-realtime',
        },
        schemaVersion: 1,
      };
      mocks.state = {
        ...mocks.state,
        settingsScope: mocks.state.settingsScope === null
          ? null
          : { ...mocks.state.settingsScope },
        settings,
      };
      return new Response(JSON.stringify({
        value: 'short-lived-client-auth',
        expires_at: Math.floor(Date.now() / 1_000) + 60,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const service = createAccountVoiceOperationService({
      providerId: 'happier.voice.openai/realtime-openai',
      recipientContract,
      signal: new AbortController().signal,
      isCurrent: () => true,
      fetch,
      materializeSecret: async () => 'account-secret',
    });

    await expect(requestClientAuth(service)).resolves.toMatchObject({ status: 200 });
  });

  it('preserves a stable unscoped bootstrap credential authority', async () => {
    mocks.state = {
      ...mocks.state,
      settingsScope: null,
    };
    const service = createAccountVoiceOperationService({
      providerId: 'happier.voice.openai/realtime-openai',
      recipientContract,
      signal: new AbortController().signal,
      isCurrent: () => true,
      fetch: async () => new Response(JSON.stringify({
        value: 'short-lived-client-auth',
        expires_at: Math.floor(Date.now() / 1_000) + 60,
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
      materializeSecret: async () => 'account-secret',
    });

    await expect(requestClientAuth(service)).resolves.toMatchObject({ status: 200 });
  });

});
