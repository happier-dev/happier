import { describe, expect, it, vi } from 'vitest';

import type { RpcHandler } from '@/api/rpc/types';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { createSessionProviderInputConsumer } from './sessionProviderInputConsumer';
import {
  registerSessionProviderInputAdmissionRpc,
  requestSessionProviderInputAdmission,
} from './sessionProviderInputAdmissionRpc';

describe('session provider-input admission RPC composition', () => {
  it('uses the persistent gate and exact-epoch compare-and-set', async () => {
    const consumer = createSessionProviderInputConsumer({
      messageQueue: new MessageQueue2<{ id: string }, string>(() => 'hash'),
      session: {
        waitForMetadataUpdate: () => new Promise<boolean>(() => {}),
        materializeNextPendingMessageSafely: vi.fn(async () => ({ type: 'no_pending' as const })),
      },
    });
    const handlers = new Map<string, RpcHandler>();
    registerSessionProviderInputAdmissionRpc({
      consumer,
      rpcHandlerRegistrar: { registerHandler: (method, handler) => handlers.set(method, handler) },
    });
    const callRpc = async (method: string, request: unknown) => {
      const handler = handlers.get(method);
      if (!handler) throw new Error('missing handler');
      return await handler(request);
    };

    await requestSessionProviderInputAdmission({
      callRpc,
      action: 'enforce',
      reason: 'generation_pending',
      serviceId: 'openai-codex',
      groupId: 'primary',
      epochId: 'revision-1',
    });
    await requestSessionProviderInputAdmission({
      callRpc,
      action: 'enforce',
      reason: 'generation_pending',
      serviceId: 'openai-codex',
      groupId: 'primary',
      epochId: 'revision-2',
    });

    await expect(requestSessionProviderInputAdmission({
      callRpc,
      action: 'clear',
      serviceId: 'openai-codex',
      groupId: 'primary',
      epochId: 'revision-1',
    })).resolves.toEqual({ status: 'not_matched' });
    expect(consumer.readProviderInputAdmission()).toMatchObject({ epochId: 'revision-2' });
  });

  it('clears a preexisting unavailable block after exact generation adoption clears', async () => {
    const consumer = createSessionProviderInputConsumer({
      messageQueue: new MessageQueue2<{ id: string }, string>(() => 'hash'),
      session: {
        waitForMetadataUpdate: () => new Promise<boolean>(() => {}),
        materializeNextPendingMessageSafely: vi.fn(async () => ({ type: 'no_pending' as const })),
      },
    });
    await consumer.enforceProviderInputAdmission({
      kind: 'action_required',
      reason: 'group_unavailable',
      serviceId: 'openai-codex',
      groupId: 'primary',
    });
    await consumer.enforceProviderInputAdmission({
      kind: 'action_required',
      reason: 'generation_pending',
      serviceId: 'openai-codex',
      groupId: 'primary',
      epochId: 'revision-2',
    });

    await expect(consumer.clearProviderInputAdmission({
      serviceId: 'openai-codex', groupId: 'primary', epochId: 'revision-2',
    })).resolves.toEqual({ status: 'cleared' });
    expect(consumer.readProviderInputAdmission()).toMatchObject({ reason: 'group_unavailable' });
    await expect(consumer.clearProviderInputAdmission({
      serviceId: 'openai-codex', groupId: 'primary',
    })).resolves.toEqual({ status: 'cleared' });
    expect(consumer.readProviderInputAdmission()).toEqual({ kind: 'admitted' });
  });

  it('notifies the provider runtime after exact application without making notification part of admission settlement', async () => {
    const consumer = createSessionProviderInputConsumer({
      messageQueue: new MessageQueue2<{ id: string }, string>(() => 'hash'),
      session: {
        waitForMetadataUpdate: () => new Promise<boolean>(() => {}),
        materializeNextPendingMessageSafely: vi.fn(async () => ({ type: 'no_pending' as const })),
      },
    });
    await consumer.enforceProviderInputAdmission({
      kind: 'action_required',
      reason: 'generation_pending',
      serviceId: 'claude-subscription',
      groupId: 'primary',
      epochId: 'revision-2',
    });
    const handlers = new Map<string, RpcHandler>();
    const onApplicationSettled = vi.fn(async () => {
      throw new Error('provider_surface_cleanup_failed');
    });
    registerSessionProviderInputAdmissionRpc({
      consumer,
      onApplicationSettled,
      rpcHandlerRegistrar: { registerHandler: (method, handler) => handlers.set(method, handler) },
    });
    const callRpc = async (method: string, request: unknown) => {
      const handler = handlers.get(method);
      if (!handler) throw new Error('missing handler');
      return await handler(request);
    };

    await expect(requestSessionProviderInputAdmission({
      callRpc,
      action: 'clear',
      serviceId: 'claude-subscription',
      groupId: 'primary',
      epochId: 'revision-2',
      applicationSettled: true,
    })).resolves.toEqual({ status: 'cleared' });
    expect(onApplicationSettled).toHaveBeenCalledOnce();
    expect(consumer.readProviderInputAdmission()).toEqual({ kind: 'admitted' });

    await expect(requestSessionProviderInputAdmission({
      callRpc,
      action: 'clear',
      serviceId: 'claude-subscription',
      groupId: 'primary',
      epochId: 'revision-stale',
      applicationSettled: true,
    })).resolves.toEqual({ status: 'not_matched' });
    expect(onApplicationSettled).toHaveBeenCalledOnce();
  });
});
