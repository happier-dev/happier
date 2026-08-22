import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockPost = vi.hoisted(() => vi.fn());

vi.mock('axios', () => ({
  default: {
    post: (...args: unknown[]) => mockPost(...args),
  },
}));

import {
  resolveMessageActionReferenceSnapshotV1,
  resolveMessageActionSnapshotFromCurrentMessageV1,
  resolveServerMessageActionReferenceV1,
} from './messageActionReference';

const reference = {
  v: 1,
  sessionId: 'session_1',
  messageId: 'message_1',
  observedRevision: 'message-updated-at:10',
} as const;

const durableAvailable = {
  status: 'available' as const,
  message: {
    sessionId: reference.sessionId,
    messageId: reference.messageId,
    observedRevision: reference.observedRevision,
    seq: 7,
    messageRole: 'agent' as const,
  },
};

describe('Message Action current-reference resolution', () => {
  beforeEach(() => {
    mockPost.mockReset();
  });

  it('builds only a bounded text snapshot from the exact durable row', () => {
    const result = resolveMessageActionSnapshotFromCurrentMessageV1({
      reference,
      durableResolution: durableAvailable,
      currentMessage: {
        sessionId: reference.sessionId,
        messageId: reference.messageId,
        observedRevision: reference.observedRevision,
        seq: 7,
        messageRole: 'agent',
        decryptedContent: {
          role: 'agent',
          content: { type: 'text', text: 'A visible transcript reply' },
          meta: {
            happierProvenanceV1: {
              v: 1,
              kind: 'pluginSession',
              pluginId: 'acme.source',
              contributionLocalId: 'inbound',
              surface: 'ui',
              sourceRef: 'must-not-reach-action',
              sourceRevisionOrEpoch: 'must-not-reach-action',
            },
          },
        },
      },
    });

    expect(result).toEqual({
      status: 'available',
      snapshot: {
        sessionId: reference.sessionId,
        messageId: reference.messageId,
        observedRevision: reference.observedRevision,
        role: 'agent',
        contentCategory: 'text',
        seq: 7,
        visibleText: 'A visible transcript reply',
        structuredPresentationSummary: null,
        provenanceCategory: 'plugin',
      },
    });
    expect(JSON.stringify(result)).not.toContain('must-not-reach-action');
  });

  it('fails closed when the fetched row no longer has the resolved revision', () => {
    expect(resolveMessageActionSnapshotFromCurrentMessageV1({
      reference,
      durableResolution: durableAvailable,
      currentMessage: {
        sessionId: reference.sessionId,
        messageId: reference.messageId,
        observedRevision: 'message-updated-at:11',
        seq: 7,
        messageRole: 'agent',
        decryptedContent: { role: 'agent', content: { type: 'text', text: 'new text' } },
      },
    })).toEqual({ status: 'stale' });
  });

  it('does not turn tool payloads or oversized text into a different eligible message', () => {
    const tool = resolveMessageActionSnapshotFromCurrentMessageV1({
      reference,
      durableResolution: durableAvailable,
      currentMessage: {
        sessionId: reference.sessionId,
        messageId: reference.messageId,
        observedRevision: reference.observedRevision,
        seq: 7,
        messageRole: 'agent',
        decryptedContent: {
          role: 'agent',
          content: { type: 'codex', data: { type: 'tool-result', output: 'secret output' } },
        },
      },
    });
    const oversized = resolveMessageActionSnapshotFromCurrentMessageV1({
      reference,
      durableResolution: durableAvailable,
      currentMessage: {
        sessionId: reference.sessionId,
        messageId: reference.messageId,
        observedRevision: reference.observedRevision,
        seq: 7,
        messageRole: 'agent',
        decryptedContent: {
          role: 'agent',
          content: { type: 'text', text: 'x'.repeat(32 * 1024 + 1) },
        },
      },
    });

    expect(tool).toEqual({ status: 'ineligible' });
    expect(oversized).toEqual({ status: 'ineligible' });
  });

  it('keeps a persisted structured presentation ineligible for action references', () => {
    const result = resolveMessageActionSnapshotFromCurrentMessageV1({
      reference,
      durableResolution: durableAvailable,
      currentMessage: {
        sessionId: reference.sessionId,
        messageId: reference.messageId,
        observedRevision: reference.observedRevision,
        seq: 7,
        messageRole: 'agent',
        decryptedContent: {
          v: 1,
          profile: 'pluginTranscriptV1',
          owner: { pluginId: 'acme.presentation', contributionLocalId: 'report' },
          snapshot: {
            kind: 'stack',
            children: [
              { kind: 'text', text: 'Historical report' },
              {
                kind: 'action',
                action: { pluginId: 'acme.presentation', localId: 'run' },
                label: 'Run current action',
                input: { protected: 'must-not-reach-action' },
              },
            ],
          },
        },
      },
    });

    expect(result).toEqual({ status: 'ineligible' });
  });

  it('uses one strict server resolver request and makes unsupported or malformed responses unavailable', async () => {
    mockPost.mockResolvedValueOnce({ status: 200, data: durableAvailable });

    await expect(resolveServerMessageActionReferenceV1({
      token: 'account-token',
      reference,
      serverUrl: 'https://server.example/',
      timeoutMs: 321.9,
    })).resolves.toEqual(durableAvailable);
    expect(mockPost).toHaveBeenCalledWith(
      'https://server.example/v1/sessions/session_1/messages/action-reference/resolve',
      reference,
      expect.objectContaining({
        timeout: 321,
        headers: expect.objectContaining({ Authorization: 'Bearer account-token' }),
      }),
    );

    mockPost.mockResolvedValueOnce({ status: 404, data: { error: 'not found' } });
    await expect(resolveServerMessageActionReferenceV1({
      token: 'account-token',
      reference,
      serverUrl: 'https://server.example',
    })).resolves.toEqual({ status: 'unavailable' });

    mockPost.mockResolvedValueOnce({ status: 200, data: { status: 'available', message: { localId: 'forbidden' } } });
    await expect(resolveServerMessageActionReferenceV1({
      token: 'account-token',
      reference,
      serverUrl: 'https://server.example',
    })).resolves.toEqual({ status: 'unavailable' });
  });

  it('preserves caller cancellation instead of disguising it as an unavailable reference', async () => {
    const controller = new AbortController();
    const cancelled = Object.assign(new Error('cancelled'), { name: 'CanceledError' });
    controller.abort();
    mockPost.mockRejectedValueOnce(cancelled);

    await expect(resolveServerMessageActionReferenceV1({
      token: 'account-token',
      reference,
      serverUrl: 'https://server.example',
      signal: controller.signal,
    })).rejects.toBe(cancelled);
  });

  it('does not read decrypted content until the durable owner resolves the exact reference', async () => {
    const readCurrentMessage = vi.fn(async () => ({
      sessionId: reference.sessionId,
      messageId: reference.messageId,
      observedRevision: reference.observedRevision,
      seq: 7,
      messageRole: 'agent' as const,
      decryptedContent: { role: 'agent', content: { type: 'text', text: 'Current text' } },
    }));
    mockPost.mockResolvedValueOnce({ status: 200, data: durableAvailable });

    await expect(resolveMessageActionReferenceSnapshotV1({
      token: 'account-token',
      reference,
      serverUrl: 'https://server.example',
      readCurrentMessage,
    })).resolves.toEqual({
      status: 'available',
      snapshot: expect.objectContaining({ visibleText: 'Current text' }),
    });
    expect(readCurrentMessage).toHaveBeenCalledWith({
      reference,
      durableMessage: durableAvailable.message,
    });
  });
});
