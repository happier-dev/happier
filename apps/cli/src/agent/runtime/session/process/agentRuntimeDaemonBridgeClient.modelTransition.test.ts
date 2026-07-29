import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ProviderConnectionIdSchema,
  type ProviderRuntimeBindingBasisV1,
  type SessionProviderBindingMetadataV1,
} from '@happier-dev/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

const controlClientMock = vi.hoisted(() => ({
  dispatch: vi.fn(),
}));

vi.mock('@/daemon/controlClient', () => ({
  dispatchDaemonAgentRuntimeBridgeRequest: controlClientMock.dispatch,
}));

import {
  tryCreateDaemonSessionModelTransitionProviderAuthorizer,
} from './agentRuntimeDaemonBridgeClient';
import {
  HAPPIER_AGENT_RUNTIME_DAEMON_BRIDGE_TOKEN_FILE_ENV_KEY,
} from './agentRuntimeDaemonBridgeProtocol';

describe('daemon child Provider model-transition authorization bridge', () => {
  let root = '';

  afterEach(async () => {
    controlClientMock.dispatch.mockReset();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('carries only exact binding facts to the daemon-authoritative session operation', async () => {
    root = await mkdtemp(join(tmpdir(), 'happier-model-transition-bridge-'));
    const tokenFilePath = join(root, 'handoff.json');
    await writeFile(tokenFilePath, JSON.stringify({
      v: 1,
      token: 'bridge-token',
      descriptor: {
        v: 1,
        pluginId: 'happier.agent.codex',
        pluginVersion: '1.2.3',
        agentId: 'codex',
        backendId: 'codex',
        generation: 'generation-1',
        factoryControls: {
          continuation: false,
          goals: false,
          catalog: false,
          usageLimitRecovery: false,
        },
      },
    }), 'utf8');
    const connectionId =
      ProviderConnectionIdSchema.parse('pc_restarted');
    const selection = {
      agentTargetKey: 'backend:codex',
      providerConnectionId: connectionId,
      modelId: 'model-a',
    } as const;
    const runtimeBindingBasis = {
      v: 1,
      deployment: { kind: 'external' },
      agentTargetKey: selection.agentTargetKey,
      connectionId,
      contributionKey: 'provider.test',
      endpoint: {
        endpointTemplateId: 'responses',
        normalizedUrl: 'https://provider.example/v1',
        protocol: 'openai-responses',
        publicHeaders: {},
      },
      runtimeCredentialTransport: {
        id: 'bearer',
        protocols: ['openai-responses'],
        uses: ['runtime'],
        destination: {
          kind: 'httpHeader',
          name: 'authorization',
          format: 'bearer',
        },
      },
      prepared: { v: 1, materialization: 'spawnEnv' },
      adapterVersion: 1,
      credentialAuthorization: {
        connectionSecurityFingerprint: 'connection-security',
        grantFingerprint: 'grant',
        selectedSecretBindingId: 'secret-a',
        selectedSecretRecordFingerprint: 'secret-record-a',
      },
      agentSupport: {
        acceptsProtocols: ['openai-responses'],
        required: { streaming: true },
        credentialSupport: {
          supportsNoAuth: false,
          apiKeyTransports: [{
            protocol: 'openai-responses',
            destination: {
              kind: 'httpHeader',
              names: ['authorization'],
              formats: ['bearer'],
            },
          }],
        },
        authIsolation: {
          suppressConnectedServiceIds: [],
          ownedEnvKeys: [],
        },
        materialization: 'spawnEnv',
        applyPolicy: 'live',
        supportsFreeformModelIds: true,
      },
    } satisfies ProviderRuntimeBindingBasisV1;
    const sessionBindingMetadata = {
      v: 1,
      connectionId,
      contributionKey: 'provider.test',
      connectionRevision: 1,
      model: { id: 'model-a', name: 'Model A' },
      protocol: 'openai-responses',
      materialization: 'spawnEnv',
      compatibilityFingerprint: 'compatibility',
      bindingSecurityFingerprint: 'binding-security',
      runtimeBindingBasis,
      displaySnapshot: {
        providerName: 'Provider',
        connectionName: 'Connection',
        connectionRole: 'default',
        connectionDisplayNameMode: 'automatic',
      },
    } satisfies SessionProviderBindingMetadataV1;
    const authorization = {
      selection,
      policy: 'live' as const,
      model: sessionBindingMetadata.model!,
      sessionBindingMetadata,
      runtimeBindingBasis,
    };
    controlClientMock.dispatch.mockResolvedValue({
      ok: true,
      result: authorization,
    });
    const authorize =
      tryCreateDaemonSessionModelTransitionProviderAuthorizer(
        'session-restarted',
        {
          [HAPPIER_AGENT_RUNTIME_DAEMON_BRIDGE_TOKEN_FILE_ENV_KEY]:
            tokenFilePath,
        },
      );
    if (!authorize) throw new Error('Expected daemon authorization bridge');

    await expect(authorize({
      selection,
      activeSelection: selection,
      activeSessionBindingMetadata: sessionBindingMetadata,
    })).resolves.toEqual(authorization);

    expect(controlClientMock.dispatch).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        context: expect.objectContaining({
          sessionId: 'session-restarted',
          pluginId: 'happier.agent.codex',
          agentId: 'codex',
          generation: 'generation-1',
        }),
        operation: {
          kind: 'session.modelTransition.authorize',
          requestId: expect.any(String),
          selection,
        },
      }),
      expect.anything(),
    );
    expect(controlClientMock.dispatch.mock.calls[0]?.[0].operation)
      .not.toHaveProperty('providerBinding');
    expect(controlClientMock.dispatch.mock.calls[0]?.[0].operation)
      .not.toHaveProperty('activeSelection');
    expect(controlClientMock.dispatch.mock.calls[0]?.[0].operation)
      .not.toHaveProperty('activeSessionBindingMetadata');
    expect(controlClientMock.dispatch.mock.calls[0]?.[0].operation)
      .not.toHaveProperty('managedPurposeBindingSnapshot');
    expect(authorization).not.toHaveProperty('materialization');
  });
});
