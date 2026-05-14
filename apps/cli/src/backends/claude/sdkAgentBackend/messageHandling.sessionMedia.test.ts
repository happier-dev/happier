import { describe, expect, it, vi } from 'vitest';

import type { AgentMessage } from '@/agent/core/AgentBackend';

import { handleClaudeSdkMessage } from './messageHandling';
import { createClaudeSdkLifecycleState, createClaudeSdkRuntimeState } from './runtimeState';

function collectMessages(sdkMessage: unknown): AgentMessage[] {
  const emitted: AgentMessage[] = [];
  const lifecycle = createClaudeSdkLifecycleState();
  const runtime = createClaudeSdkRuntimeState();

  handleClaudeSdkMessage({
    emit: (message) => emitted.push(message),
    emitTokenCountTelemetry: vi.fn(),
    lifecycle,
    noteVendorSessionId: vi.fn(),
    runtime,
    sdkMessage: sdkMessage as { type: string },
  });

  return emitted;
}

describe('handleClaudeSdkMessage session media mapping', () => {
  it('does not classify Claude SDK assistant image blocks as provider-generated session media', () => {
    const messages = collectMessages({
      type: 'assistant',
      uuid: 'assistant-img-1',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Generated image:' },
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: 'iVBORw0KGgo=',
            },
          },
        ],
      },
    });

    expect(messages).toContainEqual({ type: 'model-output', fullText: 'Generated image:' });
    expect(messages).not.toContainEqual(expect.objectContaining({
      type: 'event',
      name: 'session_media',
    }));
  });

  it('maps Claude SDK tool_result image blocks to tool-output session media events', () => {
    const messages = collectMessages({
      type: 'user',
      uuid: 'tool-result-img-1',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_image_1',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/png',
                  data: 'iVBORw0KGgo=',
                },
              },
            ],
          },
        ],
      },
    });

    expect(messages).toContainEqual(expect.objectContaining({
      type: 'event',
      name: 'session_media',
      payload: expect.objectContaining({
        role: 'output',
        category: 'tool-artifact',
        media: [
          expect.objectContaining({
            source: { kind: 'base64', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
            origin: {
              source: 'tool-output',
              toolCallId: 'toolu_image_1',
              providerEventId: 'tool-result-img-1',
            },
          }),
        ],
      }),
    }));
  });
});
