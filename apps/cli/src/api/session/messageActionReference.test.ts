import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';

const mockPost = vi.hoisted(() => vi.fn());

import {
  resolveMessageActionReferenceSnapshotV1,
  resolveMessageActionSnapshotFromCurrentMessageV1,
  resolveServerMessageActionReferenceV1,
} from './messageActionReference';
import { buildAcpAgentMessageEnvelope } from './acpMessageEnvelope';
import { MessageActionAvailableSnapshotV1Schema } from '@happier-dev/protocol/sessions/messages/messageActionReferenceV1';

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
    vi.spyOn(axios, 'post').mockImplementation(mockPost);
  });

  afterEach(() => vi.restoreAllMocks());

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

  it.each(['codex', 'acme.agent'])('discloses the complete committed %s ACP answer as transcript text', (provider) => {
    const text = `  # Answer\n${'Long answer café 🦊\n'.repeat(700)}Final suffix\n  `;
    const result = resolveMessageActionSnapshotFromCurrentMessageV1({
      reference,
      durableResolution: durableAvailable,
      currentMessage: {
        ...durableAvailable.message,
        decryptedContent: buildAcpAgentMessageEnvelope({
          provider,
          body: { type: 'message', message: text },
        }),
      },
    });
    expect(result.status).toBe('available');
    if (result.status !== 'available') throw new Error('Expected a committed answer');
    expect(MessageActionAvailableSnapshotV1Schema.parse(result.snapshot)).toMatchObject({
      role: 'agent', contentCategory: 'text', visibleText: text,
      structuredPresentationSummary: null,
    });
  });

  it('uses the transcript text from native output without exposing tools or thinking', () => {
    const text = '  Native answer\nwith final suffix  ';
    const result = resolveMessageActionSnapshotFromCurrentMessageV1({
      reference,
      durableResolution: durableAvailable,
      currentMessage: {
        ...durableAvailable.message,
        decryptedContent: {
          role: 'agent',
          content: { type: 'output', data: { type: 'assistant', message: {
            role: 'assistant', content: [
              { type: 'thinking', thinking: 'must-not-reach-action' },
              { type: 'text', text },
              { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'must-not-reach-action' } },
            ],
          } } },
        },
      },
    });
    expect(result).toMatchObject({ status: 'available', snapshot: { visibleText: text } });
    expect(JSON.stringify(result)).not.toContain('must-not-reach-action');
  });

  it.each([32_768, 32_769])('applies the existing disclosure boundary to a %i-byte native answer', (size) => {
    const text = 'é'.repeat(16_384) + (size === 32_769 ? '!' : '');
    const result = resolveMessageActionSnapshotFromCurrentMessageV1({
      reference,
      durableResolution: durableAvailable,
      currentMessage: {
        ...durableAvailable.message,
        decryptedContent: buildAcpAgentMessageEnvelope({
          provider: 'acme.agent', body: { type: 'message', message: text },
        }),
      },
    });
    expect(result).toEqual(size === 32_768
      ? { status: 'available', snapshot: expect.objectContaining({ visibleText: text }) }
      : { status: 'ineligible' });
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
          content: { type: 'codex', data: { type: 'tool-result', callId: 'call-1', output: 'secret output' } },
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
