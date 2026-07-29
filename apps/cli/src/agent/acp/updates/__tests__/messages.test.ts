import { describe, expect, it, vi } from 'vitest';

vi.mock('@/ui/logger', () => {
  return { logger: { debug: vi.fn() } };
});

import { logger } from '@/ui/logger';

import type { AgentMessage } from '@/agent/core/AgentMessage';
import type { TransportHandler } from '@/agent/transport';

import { handleAgentMessageChunk, handleAgentThoughtChunk } from '../messages';
import type { HandlerContext } from '../types';
import { createLegacyHandlerContextFixture } from '../../__tests__/legacyToolRuntimeFixture';

function createHandlerContext(options?: Readonly<{
  transport?: Partial<TransportHandler>;
  toolCallCountSincePrompt?: number;
}>): Readonly<{
  ctx: HandlerContext;
  emitted: AgentMessage[];
  idleTimeoutMs: { current: number | null };
}> {
  const emitted: AgentMessage[] = [];
  const idleTimeoutMs = { current: null as number | null };
  const transport: TransportHandler = {
    agentName: 'test',
    getInitTimeout: () => 1_000,
    getToolPatterns: () => [],
    ...(options?.transport ?? {}),
  };

  const base = createLegacyHandlerContextFixture({
    transport,
    emit: (msg) => emitted.push(msg),
    toolCallCountSincePrompt: options?.toolCallCountSincePrompt,
  });
  const ctx: HandlerContext = {
    ...base,
    setIdleTimeout: (_callback, ms) => { idleTimeoutMs.current = ms; },
  };

  return { ctx, emitted, idleTimeoutMs };
}

describe('ACP update message handlers', () => {
  it('does not log message chunk contents', () => {
    const { ctx } = createHandlerContext();

    handleAgentMessageChunk({ content: { text: 'SUPER_SECRET_VALUE' } }, ctx);

    expect(JSON.stringify((logger as any).debug.mock.calls)).not.toContain('SUPER_SECRET_VALUE');
  });

  it('treats bold-header message chunks as model output (not thinking events)', () => {
    const { ctx, emitted } = createHandlerContext();
    const text = '**Question**\nPlease choose an option to continue.';

    const result = handleAgentMessageChunk(
      { content: { text } },
      ctx,
    );

    expect(result.handled).toBe(true);
    expect(emitted).toEqual([{ type: 'model-output', textDelta: text }]);
  });

  it('preserves newline-only message chunks as model output', () => {
    const { ctx, emitted } = createHandlerContext();
    const text = '\n\n';

    const result = handleAgentMessageChunk(
      { content: { text } },
      ctx,
    );

    expect(result.handled).toBe(true);
    expect(emitted).toEqual([{ type: 'model-output', textDelta: text }]);
  });

  it('emits ACP text and image content blocks as one session media row request', () => {
    const { ctx, emitted } = createHandlerContext();

    const result = handleAgentMessageChunk(
      {
        content: [
          { type: 'text', text: 'Generated image:' },
          { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png', uri: 'file:///tmp/generated.png' },
        ],
      },
      ctx,
    );

    expect(result.handled).toBe(true);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      type: 'event',
      name: 'session_media',
      payload: {
        localId: expect.any(String),
        role: 'output',
        category: 'generated',
        messageText: 'Generated image:',
        media: [
          {
            source: {
              kind: 'base64',
              data: 'iVBORw0KGgo=',
              mimeType: 'image/png',
              fileNameHint: 'generated.png',
            },
            origin: {
              source: 'acp-content',
              agentEventId: expect.any(String),
            },
          },
        ],
      },
    });
  });

  it('emits ACP media blocks when accompanying text is whitespace keepalive content', () => {
    const { ctx, emitted } = createHandlerContext();

    const result = handleAgentMessageChunk(
      {
        content: [
          { type: 'text', text: '\n' },
          { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png', uri: 'file:///tmp/generated.png' },
        ],
      },
      ctx,
    );

    expect(result.handled).toBe(true);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      type: 'event',
      name: 'session_media',
      payload: {
        localId: expect.any(String),
        role: 'output',
        category: 'generated',
        media: [
          {
            source: {
              kind: 'base64',
              data: 'iVBORw0KGgo=',
              mimeType: 'image/png',
              fileNameHint: 'generated.png',
            },
            origin: {
              source: 'acp-content',
              agentEventId: expect.any(String),
            },
          },
        ],
      },
    });
    expect((emitted[0] as { payload?: Record<string, unknown> }).payload).not.toHaveProperty('messageText');
  });

  it('records unsupported ACP media blocks diagnostically without failing the turn', () => {
    const { ctx, emitted } = createHandlerContext();

    const result = handleAgentMessageChunk(
      { content: [{ type: 'audio', data: 'AAAA', mimeType: 'audio/wav' }] },
      ctx,
    );

    expect(result.handled).toBe(true);
    expect(emitted).toEqual([
      expect.objectContaining({
        type: 'event',
        name: 'session_media_diagnostics',
        payload: {
          diagnostics: [
            expect.objectContaining({
              code: 'unsupported_audio',
              contentIndex: 0,
            }),
          ],
        },
      }),
    ]);
  });

  it('records malformed ACP image base64 diagnostically without emitting session media', () => {
    const { ctx, emitted } = createHandlerContext();

    const result = handleAgentMessageChunk(
      { content: [{ type: 'image', data: '!!!!iVBORw0KGgo=', mimeType: 'image/png' }] },
      ctx,
    );

    expect(result.handled).toBe(true);
    expect(emitted).toEqual([
      expect.objectContaining({
        type: 'event',
        name: 'session_media_diagnostics',
        payload: {
          diagnostics: [
            expect.objectContaining({
              code: 'invalid_base64',
              contentIndex: 0,
            }),
          ],
        },
      }),
    ]);
  });

  it('extracts ACP resource and blob image blocks through the same provider-agnostic mapper', () => {
    const { ctx, emitted } = createHandlerContext();

    const result = handleAgentMessageChunk(
      {
        content: {
          content: [
            { type: 'resource', resource: { blob: 'iVBORw0KGgo=', mime_type: 'image/png', name: 'resource.png' } },
            { type: 'blob', data: 'iVBORw0KGgo=', mimeType: 'image/png', filename: 'blob.png' },
          ],
        },
      },
      ctx,
    );

    expect(result.handled).toBe(true);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      type: 'event',
      name: 'session_media',
      payload: {
        media: [
          {
            source: { kind: 'base64', data: 'iVBORw0KGgo=', mimeType: 'image/png', fileNameHint: 'resource.png' },
            origin: { source: 'acp-content' },
          },
          {
            source: { kind: 'base64', data: 'iVBORw0KGgo=', mimeType: 'image/png', fileNameHint: 'blob.png' },
            origin: { source: 'acp-content' },
          },
        ],
      },
    });
  });

  it('keeps explicit thought chunks mapped to thinking events', () => {
    const { ctx, emitted } = createHandlerContext();
    const text = 'reasoning content';

    const result = handleAgentThoughtChunk(
      { content: { text } },
      ctx,
    );

    expect(result.handled).toBe(true);
    expect(emitted).toEqual([{ type: 'event', name: 'thinking', payload: { text } }]);
  });

  it('uses the pre-tool idle timeout before the first tool call has started', () => {
    const { ctx, idleTimeoutMs } = createHandlerContext({
      transport: {
        getIdleTimeout: () => 500,
        getPreToolCallIdleTimeoutMs: () => 1_000,
      },
      toolCallCountSincePrompt: 0,
    });

    const result = handleAgentMessageChunk({ content: { text: 'Planning...' } }, ctx);

    expect(result.handled).toBe(true);
    expect(idleTimeoutMs.current).toBe(1_000);
  });

  it('uses the post-tool idle timeout after a tool call has started', () => {
    const { ctx, idleTimeoutMs } = createHandlerContext({
      transport: {
        getIdleTimeout: () => 500,
        getPreToolCallIdleTimeoutMs: () => 1_000,
      },
      toolCallCountSincePrompt: 1,
    });

    const result = handleAgentMessageChunk({ content: { text: 'Done.' } }, ctx);

    expect(result.handled).toBe(true);
    expect(idleTimeoutMs.current).toBe(1_000);
  });

  it('arms the idle fallback from thought chunks before the first tool call has started', () => {
    const { ctx, idleTimeoutMs } = createHandlerContext({
      transport: {
        getIdleTimeout: () => 500,
        getPreToolCallIdleTimeoutMs: () => 1_000,
      },
    });

    const result = handleAgentThoughtChunk({ content: { text: 'reasoning content' } }, ctx);

    expect(result.handled).toBe(true);
    expect(idleTimeoutMs.current).toBe(1_000);
  });

  it('uses the default idle fallback for thought chunks when the transport has no override', () => {
    const { ctx, idleTimeoutMs } = createHandlerContext();

    const result = handleAgentThoughtChunk({ content: { text: 'reasoning content' } }, ctx);

    expect(result.handled).toBe(true);
    expect(idleTimeoutMs.current).toBe(500);
  });
});
