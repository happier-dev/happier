import { withParsedAcpExtensionHandler } from '@/agent/acp/testkit/extensionHandlerHarness';
import { describe, expect, it, vi } from 'vitest';

import type { AgentMessage } from '@/agent/core';
import { logger } from '@/ui/logger';

import { createCursorGeneratedMediaDescriptors } from '../generatedMedia';

describe('Cursor generated-media projection', () => {
  it('projects the source-real image payload into one generic session-media message', async () => {
    const emitted: AgentMessage[] = [];
    const descriptors = createCursorGeneratedMediaDescriptors({
      emit: (message) => emitted.push(message),
    });
    const request = descriptors.find((descriptor) => descriptor.kind === 'request');
    if (!request) throw new Error('missing request descriptor');

    const app = {
      onRequest: (_method: string, parser: unknown, handler: (context: Readonly<{
        params: unknown;
        signal: AbortSignal;
      }>) => unknown) => {
        void withParsedAcpExtensionHandler(parser, handler)({
          params: {
            toolCallId: ' image-call-1\n',
            description: 'A bounded architecture diagram',
            filePath: '/workspace/generated/diagram.png',
            referenceImagePaths: [
              '/workspace/references/input.png',
              '/workspace/references/style.png',
            ],
          },
          signal: new AbortController().signal,
        });
        return app;
      },
      onNotification: () => app,
    };

    request.register(app as never, () => ({
      method: 'cursor/generate_image',
      sessionId: 'cursor-session-1',
      signal: new AbortController().signal,
      agentName: 'cursor',
    }));

    expect(emitted).toMatchObject([{
      type: 'session-media',
      source: 'cursor-generate-image',
      media: [{
        kind: 'local-file',
        path: '/workspace/generated/diagram.png',
        suggestedName: 'diagram.png',
        description: 'A bounded architecture diagram',
        referenceImagePaths: [
          '/workspace/references/input.png',
          '/workspace/references/style.png',
        ],
        origin: {
          source: 'provider-generated',
          agentId: 'cursor',
          toolCallId: ' image-call-1\n',
          providerEventId: expect.stringMatching(/^cursor-generate-image:[a-f0-9]{64}$/),
        },
      }],
    }]);
    const providerEventId = emitted[0]?.type === 'session-media'
      ? emitted[0].media[0]?.origin.providerEventId
      : null;
    const origin = emitted[0]?.type === 'session-media' ? emitted[0].media[0]?.origin : null;
    expect(providerEventId).not.toContain('image-call-1');
    expect(origin).not.toHaveProperty('generationId');
  });

  it('acknowledges an absent output path without emitting an invalid media source', async () => {
    const emitted: AgentMessage[] = [];
    const descriptors = createCursorGeneratedMediaDescriptors({ emit: (message) => emitted.push(message) });
    const request = descriptors.find((descriptor) => descriptor.kind === 'request');
    if (!request) throw new Error('missing request descriptor');
    let callback: ((context: Readonly<{ params: unknown; signal: AbortSignal }>) => unknown) | null = null;
    const app = {
      onRequest: (_method: string, parser: unknown, handler: typeof callback) => {
        callback = withParsedAcpExtensionHandler(parser, handler);
        return app;
      },
      onNotification: () => app,
    };
    request.register(app as never, () => ({
      method: 'cursor/generate_image',
      sessionId: 'cursor-session-1',
      signal: new AbortController().signal,
      agentName: 'cursor',
    }));

    const invoke = callback as unknown as (context: Readonly<{ params: unknown; signal: AbortSignal }>) => Promise<unknown>;
    await expect(invoke({
      params: { toolCallId: 'image-call-2', description: 'No output path' },
      signal: new AbortController().signal,
    })).resolves.toEqual({});
    expect(emitted).toEqual([]);
  });

  it('validates nonblank paths without changing their opaque filesystem identity', async () => {
    const emitted: AgentMessage[] = [];
    const descriptors = createCursorGeneratedMediaDescriptors({ emit: (message) => emitted.push(message) });
    const request = descriptors.find((descriptor) => descriptor.kind === 'request');
    if (!request) throw new Error('missing request descriptor');
    let callback: ((context: Readonly<{ params: unknown; signal: AbortSignal }>) => unknown) | null = null;
    const app = {
      onRequest: (_method: string, parser: unknown, handler: typeof callback) => {
        callback = withParsedAcpExtensionHandler(parser, handler);
        return app;
      },
      onNotification: () => app,
    };
    request.register(app as never, () => ({
      method: 'cursor/generate_image',
      sessionId: 'cursor-session-1',
      signal: new AbortController().signal,
      agentName: 'cursor',
    }));

    const invoke = callback as unknown as (context: Readonly<{ params: unknown; signal: AbortSignal }>) => Promise<unknown>;
    const exactPath = '/workspace/generated/diagram with trailing space.png ';
    await invoke({ params: { filePath: exactPath }, signal: new AbortController().signal });

    expect(emitted[0]).toMatchObject({
      type: 'session-media',
      media: [{ path: exactPath }],
    });
  });

  it('does not copy a provider absolute path into durable-capable correlation metadata when call id is absent', async () => {
    const emitted: AgentMessage[] = [];
    const descriptors = createCursorGeneratedMediaDescriptors({ emit: (message) => emitted.push(message) });
    const notification = descriptors.find((descriptor) => descriptor.kind === 'notification');
    if (!notification) throw new Error('missing notification descriptor');
    let callback: ((context: Readonly<{ params: unknown; signal: AbortSignal }>) => unknown) | null = null;
    const app = {
      onRequest: () => app,
      onNotification: (_method: string, parser: unknown, handler: typeof callback) => {
        callback = withParsedAcpExtensionHandler(parser, handler);
        return app;
      },
    };
    notification.register(app as never, () => ({
      method: 'cursor/generate_image',
      sessionId: 'cursor-session-1',
      signal: new AbortController().signal,
      agentName: 'cursor',
    }));
    const invoke = callback as unknown as (context: Readonly<{ params: unknown; signal: AbortSignal }>) => Promise<void>;
    const privatePath = '/Users/alice/private/generated.png';
    await invoke({ params: { filePath: privatePath }, signal: new AbortController().signal });

    const serializedOrigin = JSON.stringify(
      emitted[0]?.type === 'session-media' ? emitted[0].media[0]?.origin : null,
    );
    expect(serializedOrigin).not.toContain(privatePath);
    expect(serializedOrigin).toMatch(/cursor-generate-image:[a-f0-9]{64}/);
  });

  it('keeps request-form delivery non-fatal when the downstream media observer rejects the event', async () => {
    const debug = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
    const descriptors = createCursorGeneratedMediaDescriptors({
      emit: () => { throw new Error('downstream media observer failed'); },
    });
    const request = descriptors.find((descriptor) => descriptor.kind === 'request');
    if (!request) throw new Error('missing request descriptor');
    let callback: ((context: Readonly<{ params: unknown; signal: AbortSignal }>) => unknown) | null = null;
    const app = {
      onRequest: (_method: string, parser: unknown, handler: typeof callback) => {
        callback = withParsedAcpExtensionHandler(parser, handler);
        return app;
      },
      onNotification: () => app,
    };
    request.register(app as never, () => ({
      method: 'cursor/generate_image',
      sessionId: 'cursor-session-1',
      signal: new AbortController().signal,
      agentName: 'cursor',
    }));
    const invoke = callback as unknown as (context: Readonly<{ params: unknown; signal: AbortSignal }>) => Promise<unknown>;

    try {
      await expect(invoke({
        params: { toolCallId: 'private-image-call-id', filePath: '/workspace/generated.png' },
        signal: new AbortController().signal,
      })).resolves.toEqual({});
      const serializedLog = JSON.stringify(debug.mock.calls);
      expect(serializedLog).not.toContain('private-image-call-id');
      expect(serializedLog).not.toContain('/workspace/generated.png');
      expect(serializedLog).toMatch(/[a-f0-9]{64}/);
    } finally {
      debug.mockRestore();
    }
  });
});
