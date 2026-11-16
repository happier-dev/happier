import { describe, expect, it, vi } from 'vitest';
import tweetnacl from 'tweetnacl';

import { encodeBase64 } from '../crypto/base64.js';

import { EPHEMERAL_RUNNER_ACTION_IDS_V1 } from '../ephemeralRunner/actionIdsV1.js';
import { EPHEMERAL_RUNNER_ACTION_TRANSPORTS_V1 } from '../ephemeralRunner/actionsV1.js';
import { getActionSpec } from './actionSpecs.js';
import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';

const activationId = '2e2fcd1c-8f28-4a1a-9d0a-0f8f1f2a6a11';

const createRequest = {
  v: 1 as const,
  activationId,
  draftId: 'draft-runner-action',
  homeServerIdentityId: 'srv_runner_action',
  activationSigningPublicKey: encodeBase64(
    tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7)).publicKey,
    'base64url',
  ),
  activationExpiresAt: null,
  workspace: { kind: 'choose_on_endpoint' as const },
  authoringCommitment: encodeBase64(new Uint8Array(32).fill(7), 'base64url'),
  artifact: {
    product: 'happier-runner' as const,
    version: '0.3.0',
    target: 'linux-x64' as const,
    sha256: 'b'.repeat(64),
  },
  endpointFactsRecipient: { mode: 'plain' as const, creatorAccountId: 'creator-runner-action' },
};

describe('createActionExecutor (Ephemeral Runner activation family)', () => {
  it('dispatches all three creator intents through one family dependency', async () => {
    const ephemeralRunnerAction = vi.fn(async ({ actionId }: Readonly<{ actionId: string }>) => (
      actionId === 'sessions.runner.activation.cancel'
        ? { activationId, closed: true }
        : { activationId }
    ));
    const executor = createActionExecutor({
      ephemeralRunnerAction,

    } as unknown as ActionExecutorDeps);

    for (const actionId of EPHEMERAL_RUNNER_ACTION_IDS_V1) {
      const input = actionId === 'sessions.runner.activation.create' ? createRequest : { activationId };
      await executor.execute(actionId, input, { surface: 'ui', authority: 'present_user' });
    }

    expect(ephemeralRunnerAction.mock.calls.map(([call]) => call.actionId))
      .toEqual(EPHEMERAL_RUNNER_ACTION_IDS_V1);
  });

  it('fails closed when the Home activation adapter is absent', async () => {
    const executor = createActionExecutor({  } as unknown as ActionExecutorDeps);
    await expect(executor.execute('sessions.runner.activation.get', { activationId }, { surface: 'ui', authority: 'present_user' })).resolves.toEqual({
      ok: false,
      errorCode: 'unsupported_action',
      error: 'unsupported_action:sessions.runner.activation.get',
    });
  });

  it('declares the exact registered Runner activation routes as its server transport', () => {
    expect(EPHEMERAL_RUNNER_ACTION_TRANSPORTS_V1).toEqual({
      'sessions.runner.activation.create': { method: 'POST', path: '/v1/ephemeral-runners/activations' },
      'sessions.runner.activation.get': { method: 'GET', path: '/v1/ephemeral-runners/activations/:activationId' },
      'sessions.runner.activation.cancel': { method: 'DELETE', path: '/v1/ephemeral-runners/activations/:activationId' },
    });
    for (const actionId of EPHEMERAL_RUNNER_ACTION_IDS_V1) {
      expect(getActionSpec(actionId).serverTransport).toEqual(EPHEMERAL_RUNNER_ACTION_TRANSPORTS_V1[actionId]);
    }
  });
});
