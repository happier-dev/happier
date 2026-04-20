import { describe, expect, it, vi } from 'vitest';

import { createLazyExecutionRunHostRuntime } from './lazy';

describe('createLazyExecutionRunHostRuntime', () => {
  it('does not attach a late subscription after the caller already unsubscribed', async () => {
    let resolveRuntime!: (value: {
      readResumeSupport: () => Promise<boolean>;
      provisionSession: () => Promise<{ sessionId: string }>;
      sendPrompt: () => Promise<void>;
      cancel: () => Promise<void>;
      subscribeMessages: ReturnType<typeof vi.fn>;
      dispose: () => Promise<void>;
    }) => void;

    const runtimePromise = new Promise<{
      readResumeSupport: () => Promise<boolean>;
      provisionSession: () => Promise<{ sessionId: string }>;
      sendPrompt: () => Promise<void>;
      cancel: () => Promise<void>;
      subscribeMessages: ReturnType<typeof vi.fn>;
      dispose: () => Promise<void>;
    }>((resolve) => {
      resolveRuntime = resolve;
    });

    const subscribeMessages = vi.fn(() => () => {});
    const runtime = createLazyExecutionRunHostRuntime({
      resolveRuntime: async () => await runtimePromise,
    });

    const sessionPromise = runtime.provisionSession();
    const unsubscribe = runtime.subscribeMessages(() => {});
    unsubscribe();

    resolveRuntime({
      readResumeSupport: async () => false,
      provisionSession: async () => ({ sessionId: 'lazy-runtime-session-1' }),
      sendPrompt: async () => {},
      cancel: async () => {},
      subscribeMessages,
      dispose: async () => {},
    });

    await expect(sessionPromise).resolves.toEqual({ sessionId: 'lazy-runtime-session-1' });
    expect(subscribeMessages).not.toHaveBeenCalled();
  });

  it('publishes runtime facets once after the lazy runtime resolves', async () => {
    let resolveRuntime!: (value: {
      readResumeSupport: () => Promise<boolean>;
      provisionSession: () => Promise<{ sessionId: string }>;
      sendPrompt: () => Promise<void>;
      cancel: () => Promise<void>;
      subscribeMessages: ReturnType<typeof vi.fn>;
      dispose: () => Promise<void>;
    }) => void;

    const runtimePromise = new Promise<{
      readResumeSupport: () => Promise<boolean>;
      provisionSession: () => Promise<{ sessionId: string }>;
      sendPrompt: () => Promise<void>;
      cancel: () => Promise<void>;
      subscribeMessages: ReturnType<typeof vi.fn>;
      dispose: () => Promise<void>;
    }>((resolve) => {
      resolveRuntime = resolve;
    });

    const runtimeParams = {
      resolveRuntime: async () => await runtimePromise,
      runtimeDescriptor: {
        v: 1,
        providerId: 'acme.provider',
        provider: {
          backendMode: 'native',
        },
      },
      runtimeCapabilities: {
        executionRun: { supported: true },
      },
      runtimeFacets: {
        v: 1,
        transcriptSource: {
          supported: true,
        },
      },
    };
    const runtime = createLazyExecutionRunHostRuntime(runtimeParams);
    const messages: unknown[] = [];
    runtime.subscribeMessages((message) => {
      messages.push(message);
    });

    const sessionPromise = runtime.provisionSession();

    resolveRuntime({
      readResumeSupport: async () => false,
      provisionSession: async () => ({ sessionId: 'lazy-runtime-session-1' }),
      sendPrompt: async () => {},
      cancel: async () => {},
      subscribeMessages: vi.fn(() => () => {}),
      dispose: async () => {},
    });

    await expect(sessionPromise).resolves.toEqual({ sessionId: 'lazy-runtime-session-1' });
    expect(messages).toEqual([
      {
        type: 'event',
        name: 'runtime.descriptor',
        payload: {
          v: 1,
          providerId: 'acme.provider',
          provider: {
            backendMode: 'native',
          },
        },
      },
      {
        type: 'event',
        name: 'runtime.capabilities',
        payload: {
          executionRun: { supported: true },
        },
      },
      {
        type: 'event',
        name: 'runtime.facets',
        payload: {
          v: 1,
          transcriptSource: {
            supported: true,
          },
        },
      },
    ]);
  });
});
