import { describe, expect, it, vi } from 'vitest';

import type { AgentMessage } from '@/agent/core/AgentBackend';

import { createTerminalRuntimeExecutionRunBackend } from './terminal';

describe('createTerminalRuntimeExecutionRunBackend', () => {
  it('does not attach a late subscription after the caller already unsubscribed', async () => {
    type RuntimeMessage = {
      type: 'message';
      message: {
        type: 'message';
        message: string;
      };
    };

    let resolveLaunch!: (value: unknown) => void;
    const launchPromise = new Promise((resolve: (value: unknown) => void) => {
      resolveLaunch = resolve;
    });

    let runtimeHandler: ((message: RuntimeMessage) => void) | null = null;
    const subscribeMessages = vi.fn((handler: (message: RuntimeMessage) => void) => {
      runtimeHandler = handler;
      return () => {
        runtimeHandler = null;
      };
    });
    const runtime = createTerminalRuntimeExecutionRunBackend({
      cwd: '/tmp/plugin-backend',
      backendId: 'acme.sample.backend',
      backend: {
        id: 'acme.sample.backend',
        providerId: 'acme.sample.provider',
        provenance: 'external',
        source: { kind: 'path' },
        runtimeKind: 'native',
        definition: { id: 'acme.sample.backend', providerId: 'acme.sample.provider' },
      } as never,
      launch: vi.fn(async () => await launchPromise) as never,
      permissionMode: 'read_only',
    });

    const sessionPromise = runtime.provisionSession({ initialPrompt: 'boot' });
    const handler = vi.fn();
    const unsubscribe = runtime.subscribeMessages(handler);
    unsubscribe();

    resolveLaunch({
      runtime: {
        readResumeSupport: async () => false,
        provisionSession: async () => ({ sessionId: 'plugin-session-1' }),
        sendPrompt: async () => {},
        cancel: async () => {},
        subscribeMessages,
        dispose: async () => {},
      },
    });

    await expect(sessionPromise).resolves.toEqual({ sessionId: 'plugin-session-1' });
    const emitLateMessage = runtimeHandler;
    if (emitLateMessage) {
      (emitLateMessage as (message: RuntimeMessage) => void)({
        type: 'message',
        message: {
          type: 'message',
          message: 'late message',
        },
      });
    }

    expect(subscribeMessages).toHaveBeenCalledTimes(1);
    expect(handler).not.toHaveBeenCalled();
  });

  it('fails closed to the generic plugin descriptor when launch returns a malformed runtimeDescriptor payload', async () => {
    const subscribeMessages = vi.fn(() => () => undefined);
    const runtime = createTerminalRuntimeExecutionRunBackend({
      cwd: '/tmp/plugin-backend',
      backendId: 'acme.sample.backend',
      backend: {
        id: 'acme.sample.backend',
        providerId: 'acme.sample.provider',
        provenance: 'external',
        source: { kind: 'path' },
        runtimeKind: 'native',
        definition: { id: 'acme.sample.backend', providerId: 'acme.sample.provider' },
      } as never,
      launch: vi.fn(async () => ({
        runtime: {
          readResumeSupport: async () => false,
          provisionSession: async () => ({ sessionId: 'plugin-session-1' }),
          sendPrompt: async () => {},
          cancel: async () => {},
          subscribeMessages,
          dispose: async () => {},
        },
        runtimeDescriptor: {
          backendId: 'acme.sample.backend',
          runtimeKind: 'native',
        },
      })) as never,
      permissionMode: 'read_only',
    });

    const messages: AgentMessage[] = [];
    const unsubscribe = runtime.subscribeMessages((message) => {
      messages.push(message);
    });

    await expect(runtime.provisionSession({ initialPrompt: 'boot' })).resolves.toEqual({ sessionId: 'plugin-session-1' });
    unsubscribe();

    expect(messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'event',
        name: 'runtime.descriptor',
        payload: expect.objectContaining({
          v: 1,
          providerId: 'acme.sample.provider',
          provider: expect.objectContaining({
            backendMode: 'native',
            providerExtra: expect.objectContaining({
              owner: 'happier',
              schemaId: 'happier.pluginRuntimeDescriptorExtra',
              v: 1,
              runtimeHandle: expect.objectContaining({
                backendId: 'acme.sample.backend',
                providerId: 'acme.sample.provider',
                provenance: 'external',
                source: { kind: 'path' },
              }),
            }),
          }),
        }),
      }),
    ]));
    expect(messages.filter((message) => message.type === 'event' && message.name === 'runtime.descriptor')).toHaveLength(1);
  });

  it('rejects execution-run launch payloads that still use bindings instead of runtime', async () => {
    const runtime = createTerminalRuntimeExecutionRunBackend({
      cwd: '/tmp/plugin-backend',
      backendId: 'acme.sample.backend',
      backend: {
        id: 'acme.sample.backend',
        providerId: 'acme.sample.provider',
        provenance: 'external',
        source: { kind: 'path' },
        runtimeKind: 'native',
        definition: { id: 'acme.sample.backend', providerId: 'acme.sample.provider' },
      } as never,
      launch: vi.fn(async () => ({
        bindings: {
          readResumeSupport: async () => false,
          provisionSession: async () => ({ sessionId: 'plugin-session-1' }),
          sendPrompt: async () => {},
          cancel: async () => {},
          subscribeMessages: vi.fn(() => () => undefined),
          dispose: async () => {},
        },
      })) as never,
      permissionMode: 'read_only',
    });

    await expect(runtime.provisionSession({ initialPrompt: 'boot' })).rejects.toThrow(
      /must include an execution-run runtime surface/i,
    );
  });
});
