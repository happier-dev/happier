import { describe, expect, it } from 'vitest';

import {
  CONNECTED_ACCOUNT_AUTHENTICATION_COMMAND_RPC_METHOD,
  CONNECTED_ACCOUNT_CONTROL_COMMAND_RPC_METHOD,
  ConnectedAccountAttemptResponseSchema,
  ConnectedAccountAuthenticationCommandRequestSchema,
  ConnectedAccountControlCommandRequestSchema,
  ConnectedAccountDaemonControlResponseSchema,
} from './connectedAccountDaemonRpcV1.js';

describe('Connected Account daemon RPC v1', () => {
  it('owns the exact stable method names', () => {
    expect(CONNECTED_ACCOUNT_AUTHENTICATION_COMMAND_RPC_METHOD)
      .toBe('daemon.connectedAccounts.authentication.command');
    expect(CONNECTED_ACCOUNT_CONTROL_COMMAND_RPC_METHOD)
      .toBe('daemon.connectedAccounts.control.command');
  });

  it('rejects response values outside the one bounded producer contract', () => {
    expect(ConnectedAccountAttemptResponseSchema.safeParse({
      status: 'awaitingOAuth',
      attemptId: 'attempt-1',
      authorizationUrl: 'not-a-url',
      callbackUrl: 'http://127.0.0.1/callback',
    }).success).toBe(false);
    expect(ConnectedAccountAttemptResponseSchema.safeParse({
      status: 'awaitingDeviceAuthorization',
      attemptId: 'attempt-1',
      verificationUri: `https://example.com/${'x'.repeat(8_192)}`,
      pollIntervalMs: 0,
    }).success).toBe(false);
    expect(ConnectedAccountAttemptResponseSchema.safeParse({
      status: 'pending',
      attemptId: 'attempt-1',
      retryAfterMs: 1.5,
    }).success).toBe(false);
  });

  it('keeps reconnect configuration CAS and strict response envelopes', () => {
    expect(ConnectedAccountAuthenticationCommandRequestSchema.parse({
      v: 1,
      machineId: 'machine-1',
      command: {
        operation: 'beginReconnect',
        account: {
          service: {
            pluginId: 'acme.accounts',
            localId: 'work',
          },
          accountId: 'account-1',
        },
        expectedConfigurationRevision: 'configuration-1',
      },
    })).toMatchObject({
      command: {
        operation: 'beginReconnect',
        expectedConfigurationRevision: 'configuration-1',
      },
    });
    expect(ConnectedAccountDaemonControlResponseSchema.safeParse({
      status: 'outcomeUnknown',
      account: {
        service: {
          pluginId: 'acme.accounts',
          localId: 'work',
        },
        accountId: 'account-1',
      },
      extra: true,
    }).success).toBe(false);
  });

  it('carries daemon-proven account-list transport only when the caller requests admission', () => {
    expect(ConnectedAccountControlCommandRequestSchema.parse({
      v: 1,
      machineId: 'machine-1',
      command: {
        operation: 'describeService',
        service: {
          pluginId: 'happier.agent.codex',
          localId: 'openai-codex',
        },
        requiredOperation: 'account_list',
      },
    })).toMatchObject({
      command: {
        operation: 'describeService',
        requiredOperation: 'account_list',
      },
    });
    expect(ConnectedAccountDaemonControlResponseSchema.parse({
      status: 'described',
      service: {
        pluginId: 'happier.agent.codex',
        localId: 'openai-codex',
      },
      descriptor: {
        id: 'openai-codex',
        title: 'Codex',
        authentication: {
          defaultModeId: 'oauth',
          modes: [{
            id: 'oauth',
            kind: 'oauthAuthorizationCode',
            pkce: 'required',
            outcomeReconciliation: 'none',
          }],
        },
      },
      generation: 'generation-1',
      immutableGenerationId: 'artifact-1',
      accounts: [],
      operationTransport: {
        kind: 'legacy',
        peerClass: 'exact_v0_2_1',
        serviceId: 'openai-codex',
      },
    })).toMatchObject({
      status: 'described',
      operationTransport: {
        peerClass: 'exact_v0_2_1',
      },
    });
    // The daemon relays whatever the Account holds for the service, including
    // rows preserved past the capacity a current writer would admit. Rejecting
    // them here would take the whole describe response, not one row, offline.
    expect(ConnectedAccountDaemonControlResponseSchema.safeParse({
      status: 'described',
      service: {
        pluginId: 'happier.agent.codex',
        localId: 'openai-codex',
      },
      descriptor: {
        id: 'openai-codex',
        title: 'Codex',
        authentication: {
          defaultModeId: 'oauth',
          modes: [{
            id: 'oauth',
            kind: 'oauthAuthorizationCode',
            pkce: 'required',
            outcomeReconciliation: 'none',
          }],
        },
      },
      generation: 'generation-1',
      immutableGenerationId: 'artifact-1',
      accounts: Array.from({ length: 501 }, (_unused, index) => ({
        ref: {
          service: {
            pluginId: 'happier.agent.codex',
            localId: 'openai-codex',
          },
          accountId: `retained/${index}`,
        },
        status: 'connected',
        authenticationModeId: 'oauth',
        revisionSemantics: 'revisioned',
        credentialRevision: 'csr_abcdefghijklmnopqrstuvwxyz',
        configurationReady: false,
        configurationRevision: null,
        kind: 'oauth',
        expiresAt: null,
        lastUsedAt: null,
      })),
    }).success).toBe(true);
    expect(ConnectedAccountControlCommandRequestSchema.parse({
      v: 1,
      machineId: 'machine-1',
      command: {
        operation: 'describeService',
        service: {
          pluginId: 'happier.agent.codex',
          localId: 'openai-codex',
        },
        requiredOperation: 'quota_refresh',
      },
    })).toMatchObject({
      command: { requiredOperation: 'quota_refresh' },
    });
  });
});
