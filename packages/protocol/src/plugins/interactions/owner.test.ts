import { describe, expect, it, vi } from 'vitest';

import type {
  InteractionTransientRequestV1,
  InteractionTransientResultV1,
} from './transientV1.js';

import { createTransientInteractionOwner } from './owner.js';

const requester = Object.freeze({
  pluginId: 'acme.voice',
  contributionId: 'elevenlabs',
  generationId: 'generation-1',
  invocationId: 'settings-invocation-1',
});

describe('host transient interaction lifecycle owner', () => {
  it('stamps app scope, follows the present-user invocation, and rejects a late answer', async () => {
    const invocation = new AbortController();
    let request!: InteractionTransientRequestV1;
    let resolvePresenter!: (result: InteractionTransientResultV1) => void;
    const owner = createTransientInteractionOwner({
      scope: Object.freeze({ kind: 'app' }),
      isGenerationCurrent: () => true,
      deadlineMs: 1_000,
      now: () => 10,
      createRequestId: () => 'app-request-1',
      present: async (nextRequest) => {
        request = nextRequest;
        return await new Promise<InteractionTransientResultV1>((resolve) => {
          resolvePresenter = resolve;
        });
      },
    });

    const pending = owner.request({
      kind: 'confirmation',
      title: 'Continue?',
      message: 'Continue with the existing Agent?',
    }, { requester, signal: invocation.signal });

    await vi.waitFor(() => expect(request).toBeDefined());
    expect(request).toMatchObject({
      requestId: 'app-request-1',
      scope: { kind: 'app' },
      requester,
      createdAtMs: 10,
      expiresAtMs: 1_010,
    });
    expect(request).not.toHaveProperty('sessionId');

    invocation.abort();
    await expect(pending).resolves.toEqual({
      requestId: 'app-request-1',
      kind: 'confirmation',
      status: 'requesterAborted',
    });
    expect(owner.settle({
      requestId: 'app-request-1',
      kind: 'confirmation',
      status: 'approved',
    })).toEqual({ status: 'notCurrent', requestId: 'app-request-1' });
    resolvePresenter({
      requestId: 'app-request-1',
      kind: 'confirmation',
      status: 'approved',
    });
  });

  it('settles unavailable when an app presenter returns an owner-only lifecycle status', async () => {
    for (const status of ['sessionEnded', 'requesterAborted', 'unavailable'] as const) {
      const owner = createTransientInteractionOwner({
        scope: Object.freeze({ kind: 'app' }),
        isGenerationCurrent: () => true,
        deadlineMs: 1_000,
        now: () => 10,
        createRequestId: () => `app-owner-only-${status}`,
        present: async (request) => ({
          requestId: request.requestId,
          kind: 'confirmation',
          status,
        }),
      });

      await expect(owner.request({
        kind: 'confirmation',
        title: 'Continue?',
        message: 'Continue with the current operation?',
      }, { requester })).resolves.toEqual({
        requestId: `app-owner-only-${status}`,
        kind: 'confirmation',
        status: 'unavailable',
      });
    }
  });
});
