import { describe, expect, it, vi } from 'vitest';

import { PluginError } from '@happier-dev/plugin-sdk';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

import type { RpcHandler, RpcHandlerRegistrar } from '@/api/rpc/types';
import { SessionStructuredInputAdmissionError } from '@/session/services/admitSessionStructuredInputV1';
import { registerSessionUserMessageSendHandler } from './sessionUserMessageSend';

function createHarness(): Readonly<{
  handlers: Map<string, RpcHandler>;
  registrar: RpcHandlerRegistrar;
}> {
  const handlers = new Map<string, RpcHandler>();
  return {
    handlers,
    registrar: {
      registerHandler(method, handler) {
        handlers.set(method, handler);
      },
    },
  };
}

const selectedPluginAttachment = {
  v: 1,
  instanceId: 'review-instance-1',
  attachment: { pluginId: 'acme.review-comments', localId: 'review-comment' },
  key: 'review-42',
  value: { reviewId: '42' },
  presentation: { label: 'Review #42', typeLabel: 'Review comment' },
};

const stagedMediaHandle = {
  v: 1,
  id: 'staged-content-1',
  executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
  owner: { pluginId: 'acme.review-comments', localId: 'review-comment' },
  mediaKind: 'image',
  mimeType: 'image/png',
  name: 'photo.png',
  sizeBytes: 2048,
  sha256: 'a'.repeat(64),
} as const;

const stagedImageAttachment = {
  ...selectedPluginAttachment,
  instanceId: 'staged-instance-1',
  key: 'staged-image-1',
  content: { kind: 'stagedMedia', handle: stagedMediaHandle },
};

const stagedVideoAttachment = {
  ...selectedPluginAttachment,
  instanceId: 'staged-instance-2',
  key: 'staged-video-1',
  content: {
    kind: 'stagedMedia',
    handle: { ...stagedMediaHandle, id: 'staged-content-2', mediaKind: 'video', mimeType: 'video/webm', name: 'clip.webm' },
  },
};

describe('session user message send', () => {
  it('forwards a selected r1.0 composer attachment to the shared pre-persistence admission path', async () => {
    const { handlers, registrar } = createHarness();
    const enqueueSessionUserMessage = vi.fn();
    registerSessionUserMessageSendHandler(registrar, {
      workingDirectory: process.cwd(),
      enqueueSessionUserMessage,
    });

    const handler = handlers.get(SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND);
    expect(handler).toBeDefined();
    if (!handler) return;

    await expect(handler({
      text: 'Please inspect the selected review comment.',
      localId: 'pending-attachment-1',
      meta: {
        happierStructuredInputV1: {
          v: 1,
          composerAttachments: [selectedPluginAttachment],
        },
      },
    })).resolves.toEqual({ ok: true });

    expect(enqueueSessionUserMessage).toHaveBeenCalledWith({
      text: 'Please inspect the selected review comment.',
      localId: 'pending-attachment-1',
      meta: {
        happierStructuredInputV1: {
          v: 1,
          composerAttachments: [selectedPluginAttachment],
        },
        source: 'ui',
        sentFrom: 'ui',
      },
    });
  });

  it('admits a blank attachment-only send whose media is still transfer-staged', async () => {
    for (const attachment of [stagedImageAttachment, stagedVideoAttachment]) {
      const { handlers, registrar } = createHarness();
      const enqueueSessionUserMessage = vi.fn();
      registerSessionUserMessageSendHandler(registrar, {
        workingDirectory: process.cwd(),
        enqueueSessionUserMessage,
      });

      const handler = handlers.get(SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND);
      expect(handler).toBeDefined();
      if (!handler) return;

      await expect(handler({
        text: '',
        localId: `pending-${attachment.instanceId}`,
        meta: {
          happierStructuredInputV1: {
            v: 1,
            composerAttachments: [attachment],
          },
        },
      })).resolves.toEqual({ ok: true });

      // The staged claim reaches the daemon finalizer untouched; only it may
      // replace it with a durable SessionMedia reference.
      expect(enqueueSessionUserMessage).toHaveBeenCalledWith({
        text: '',
        localId: `pending-${attachment.instanceId}`,
        meta: {
          happierStructuredInputV1: {
            v: 1,
            composerAttachments: [attachment],
          },
          source: 'ui',
          sentFrom: 'ui',
        },
      });
    }
  });

  it('rejects a blank attachment-only send whose staged media handle is unreadable', async () => {
    const { handlers, registrar } = createHarness();
    const enqueueSessionUserMessage = vi.fn();
    registerSessionUserMessageSendHandler(registrar, {
      workingDirectory: process.cwd(),
      enqueueSessionUserMessage,
    });

    const handler = handlers.get(SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND);
    expect(handler).toBeDefined();
    if (!handler) return;

    await expect(handler({
      text: '',
      localId: 'pending-staged-expired-1',
      meta: {
        happierStructuredInputV1: {
          v: 1,
          composerAttachments: [{
            ...stagedImageAttachment,
            content: { kind: 'stagedMedia', handle: { ...stagedMediaHandle, sha256: 'expired' } },
          }],
        },
      },
    })).resolves.toEqual({
      ok: false,
      error: 'session_structured_input_attachment_invalid',
      errorCode: 'session_structured_input_attachment_invalid',
    });

    expect(enqueueSessionUserMessage).not.toHaveBeenCalled();
  });

  it('rejoins the one media outcome when the caller retries after losing the response', async () => {
    const { handlers, registrar } = createHarness();
    const enqueueSessionUserMessage = vi.fn();
    registerSessionUserMessageSendHandler(registrar, {
      workingDirectory: process.cwd(),
      enqueueSessionUserMessage,
    });

    const handler = handlers.get(SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND);
    expect(handler).toBeDefined();
    if (!handler) return;

    const request = {
      text: '',
      localId: 'pending-staged-retry-1',
      meta: {
        happierStructuredInputV1: {
          v: 1,
          composerAttachments: [stagedImageAttachment],
        },
      },
    };

    await expect(handler(request)).resolves.toEqual({ ok: true });
    await expect(handler(request)).resolves.toEqual({ ok: true });
    expect(enqueueSessionUserMessage).toHaveBeenCalledTimes(1);

    await expect(handler({
      ...request,
      meta: {
        happierStructuredInputV1: {
          v: 1,
          composerAttachments: [stagedVideoAttachment],
        },
      },
    })).resolves.toEqual({
      ok: false,
      error: 'session_user_message_id_payload_conflict',
      errorCode: 'session_user_message_id_payload_conflict',
    });
    expect(enqueueSessionUserMessage).toHaveBeenCalledTimes(1);
  });

  it('does not degrade a mixed selected attachment payload to its valid sibling', async () => {
    const { handlers, registrar } = createHarness();
    const enqueueSessionUserMessage = vi.fn();
    registerSessionUserMessageSendHandler(registrar, {
      workingDirectory: process.cwd(),
      enqueueSessionUserMessage,
    });

    const handler = handlers.get(SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND);
    expect(handler).toBeDefined();
    if (!handler) return;

    await expect(handler({
      text: 'Please inspect the selected review comment.',
      localId: 'pending-mixed-attachment-1',
      meta: {
        happierStructuredInputV1: {
          v: 1,
          composerAttachments: [
            selectedPluginAttachment,
            { ...selectedPluginAttachment, attachment: { kind: 'host', owner: 'forged' } },
          ],
        },
      },
    })).resolves.toEqual({
      ok: false,
      error: 'session_structured_input_attachment_invalid',
      errorCode: 'session_structured_input_attachment_invalid',
    });

    expect(enqueueSessionUserMessage).not.toHaveBeenCalled();
  });

  it('fails closed for a raw malformed attachment selection before request-schema sanitization', async () => {
    const { handlers, registrar } = createHarness();
    const enqueueSessionUserMessage = vi.fn();
    registerSessionUserMessageSendHandler(registrar, {
      workingDirectory: process.cwd(),
      enqueueSessionUserMessage,
    });

    const handler = handlers.get(SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND);
    expect(handler).toBeDefined();
    if (!handler) return;

    await expect(handler({
      text: 'Please inspect the selected review comment.',
      localId: 'pending-malformed-attachment-1',
      meta: {
        happierStructuredInputV1: {
          v: 1,
          composerAttachments: { forged: true },
        },
      },
    })).resolves.toEqual({
      ok: false,
      error: 'session_structured_input_attachment_invalid',
      errorCode: 'session_structured_input_attachment_invalid',
    });

    expect(enqueueSessionUserMessage).not.toHaveBeenCalled();
  });

  it('fails closed for malformed generic structured input before either local runtime or durable enqueue', async () => {
    const { handlers, registrar } = createHarness();
    const handleUserMessage = vi.fn(async () => ({ handled: true, result: { ok: true } }));
    const enqueueSessionUserMessage = vi.fn();
    registerSessionUserMessageSendHandler(registrar, {
      workingDirectory: process.cwd(),
      sessionRuntimeControls: { handleUserMessage } as never,
      enqueueSessionUserMessage,
    });

    const handler = handlers.get(SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND);
    expect(handler).toBeDefined();
    if (!handler) return;

    await expect(handler({
      text: 'Please review this.',
      localId: 'pending-malformed-generic-structured-input-1',
      meta: {
        happierStructuredInputV1: {
          v: 1,
          mentions: { malformed: true },
        },
      },
    })).resolves.toEqual({
      ok: false,
      error: 'session_structured_input_attachment_invalid',
      errorCode: 'session_structured_input_attachment_invalid',
    });

    expect(handleUserMessage).not.toHaveBeenCalled();
    expect(enqueueSessionUserMessage).not.toHaveBeenCalled();
  });

  it('rejects a Composer attachment envelope over the Protocol aggregate budget before durable enqueue', async () => {
    const { handlers, registrar } = createHarness();
    const enqueueSessionUserMessage = vi.fn();
    registerSessionUserMessageSendHandler(registrar, {
      workingDirectory: process.cwd(),
      enqueueSessionUserMessage,
    });

    const handler = handlers.get(SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND);
    expect(handler).toBeDefined();
    if (!handler) return;

    await expect(handler({
      text: 'Please inspect these review comments.',
      localId: 'pending-overbound-composer-attachment-envelope-1',
      meta: {
        happierStructuredInputV1: {
          v: 1,
          composerAttachments: Array.from({ length: 64 }, (_, index) => ({
            ...selectedPluginAttachment,
            instanceId: `review-instance-${index}`,
            key: `review-${index}`,
            value: { payload: 'x'.repeat(4_096) },
          })),
        },
      },
    })).resolves.toEqual({
      ok: false,
      error: 'session_structured_input_attachment_invalid',
      errorCode: 'session_structured_input_attachment_invalid',
    });

    expect(enqueueSessionUserMessage).not.toHaveBeenCalled();
  });

  it('does not reserve the local id when a rejected attachment-bearing send is corrected and retried', async () => {
    const { handlers, registrar } = createHarness();
    const enqueueSessionUserMessage = vi.fn()
      .mockRejectedValueOnce(new SessionStructuredInputAdmissionError(
        'session_structured_input_attachment_preparation_required',
      ));
    registerSessionUserMessageSendHandler(registrar, {
      workingDirectory: process.cwd(),
      enqueueSessionUserMessage,
    });

    const handler = handlers.get(SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND);
    expect(handler).toBeDefined();
    if (!handler) return;
    const localId = 'pending-retry-attachment-1';

    await expect(handler({
      text: 'Please inspect the selected review comment.',
      localId,
      meta: {
        happierStructuredInputV1: {
          v: 1,
          composerAttachments: [selectedPluginAttachment],
        },
      },
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'session_structured_input_attachment_preparation_required',
    });

    await expect(handler({
      text: 'Please inspect the corrected request.',
      localId,
      meta: {},
    })).resolves.toEqual({ ok: true });

    expect(enqueueSessionUserMessage).toHaveBeenCalledTimes(2);
    expect(enqueueSessionUserMessage).toHaveBeenLastCalledWith({
      text: 'Please inspect the corrected request.',
      localId,
      meta: { source: 'ui', sentFrom: 'ui' },
    });
  });

  it('releases a stable local id when a pre-admission runtime promise rejects', async () => {
    const { handlers, registrar } = createHarness();
    const handleUserMessage = vi.fn()
      .mockRejectedValueOnce(new SessionStructuredInputAdmissionError(
        'session_structured_input_attachment_preparation_required',
      ))
      .mockResolvedValueOnce({ handled: true, result: { ok: true } });
    registerSessionUserMessageSendHandler(registrar, {
      workingDirectory: process.cwd(),
      sessionRuntimeControls: { handleUserMessage } as never,
    });

    const handler = handlers.get(SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND);
    expect(handler).toBeDefined();
    if (!handler) return;
    const localId = 'pending-retry-rejected-promise-1';

    await expect(handler({
      text: 'Needs correction.',
      localId,
      meta: {},
    })).rejects.toMatchObject({
      code: 'session_structured_input_attachment_preparation_required',
    });

    await expect(handler({
      text: 'Corrected request.',
      localId,
      meta: {},
    })).resolves.toEqual({ ok: true });

    expect(handleUserMessage).toHaveBeenCalledTimes(2);
  });

  it('retries a currentness refusal through the recovered attachment owner and caches its acceptance', async () => {
    const { handlers, registrar } = createHarness();
    const staleErrorFromIndependentSdk = Object.assign(
      new Error('The previous attachment generation retired.'),
      {
        name: 'PluginError',
        code: 'plugin_generation_stale',
        retryable: false,
        data: {
          name: 'PluginError' as const,
          code: 'plugin_generation_stale',
          message: 'The previous attachment generation retired.',
          retryable: false,
        },
      },
    );
    const enqueueSessionUserMessage = vi.fn()
      .mockRejectedValueOnce(staleErrorFromIndependentSdk);
    registerSessionUserMessageSendHandler(registrar, {
      workingDirectory: process.cwd(),
      enqueueSessionUserMessage,
    });

    const handler = handlers.get(SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND);
    expect(handler).toBeDefined();
    if (!handler) return;
    const request = {
      text: 'Please inspect the selected review comment.',
      localId: 'pending-retry-currentness-1',
      meta: {
        happierStructuredInputV1: {
          v: 1,
          composerAttachments: [selectedPluginAttachment],
        },
      },
    };

    await expect(handler(request)).rejects.toMatchObject({ code: 'plugin_generation_stale' });
    await expect(handler(request)).resolves.toEqual({ ok: true });
    await expect(handler(request)).resolves.toEqual({ ok: true });

    expect(enqueueSessionUserMessage).toHaveBeenCalledTimes(2);
  });

  it('retains an invalid attachment result as the exact outcome', async () => {
    const { handlers, registrar } = createHarness();
    const enqueueSessionUserMessage = vi.fn()
      .mockRejectedValue(new PluginError({
        code: 'composer_attachment_result_invalid',
        message: 'The attachment callback returned an invalid result.',
      }));
    registerSessionUserMessageSendHandler(registrar, {
      workingDirectory: process.cwd(),
      enqueueSessionUserMessage,
    });

    const handler = handlers.get(SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND);
    expect(handler).toBeDefined();
    if (!handler) return;
    const request = {
      text: 'Please inspect the selected review comment.',
      localId: 'pending-invalid-result-1',
      meta: {
        happierStructuredInputV1: {
          v: 1,
          composerAttachments: [selectedPluginAttachment],
        },
      },
    };

    await expect(handler(request)).rejects.toMatchObject({ code: 'composer_attachment_result_invalid' });
    await expect(handler(request)).rejects.toMatchObject({ code: 'composer_attachment_result_invalid' });

    expect(enqueueSessionUserMessage).toHaveBeenCalledOnce();
  });

  it('does not treat a malformed currentness lookalike as a target PluginError', async () => {
    const { handlers, registrar } = createHarness();
    const malformedError = Object.assign(new Error('The previous attachment generation retired.'), {
      name: 'PluginError',
      code: 'plugin_generation_stale',
      retryable: false,
      data: {
        name: 'PluginError' as const,
        code: 'plugin_generation_stale',
      },
    });
    const enqueueSessionUserMessage = vi.fn().mockRejectedValue(malformedError);
    registerSessionUserMessageSendHandler(registrar, {
      workingDirectory: process.cwd(),
      enqueueSessionUserMessage,
    });

    const handler = handlers.get(SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND);
    expect(handler).toBeDefined();
    if (!handler) return;
    const request = {
      text: 'Please inspect the selected review comment.',
      localId: 'pending-malformed-currentness-code-1',
      meta: {
        happierStructuredInputV1: {
          v: 1,
          composerAttachments: [selectedPluginAttachment],
        },
      },
    };

    await expect(handler(request)).rejects.toBe(malformedError);
    await expect(handler(request)).rejects.toBe(malformedError);

    expect(enqueueSessionUserMessage).toHaveBeenCalledOnce();
  });

  it('does not pass an untrusted local image path to the attachment-free runtime-local handler', async () => {
    const { handlers, registrar } = createHarness();
    const handleUserMessage = vi.fn(async () => ({ handled: true, result: { ok: true } }));
    registerSessionUserMessageSendHandler(registrar, {
      workingDirectory: process.cwd(),
      sessionRuntimeControls: { handleUserMessage } as never,
    });

    const handler = handlers.get(SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND);
    expect(handler).toBeDefined();
    if (!handler) return;

    await expect(handler({
      text: 'Inspect this image.',
      localId: 'runtime-local-untrusted-image-1',
      meta: {
        happierStructuredInputV1: {
          v: 1,
          imageInputs: [{
            id: 'private-image-1',
            kind: 'localImage',
            path: '/tmp/private.png',
            mimeType: 'image/png',
          }],
        },
      },
    })).resolves.toEqual({ ok: true });

    expect(handleUserMessage).toHaveBeenCalledWith({
      text: 'Inspect this image.',
      localId: 'runtime-local-untrusted-image-1',
      meta: {
        happierStructuredInputV1: { v: 1 },
        source: 'ui',
        sentFrom: 'ui',
      },
    });
  });

  it('keeps accepted local-id outcomes exact while refusing a changed payload', async () => {
    const { handlers, registrar } = createHarness();
    const enqueueSessionUserMessage = vi.fn();
    registerSessionUserMessageSendHandler(registrar, {
      workingDirectory: process.cwd(),
      enqueueSessionUserMessage,
    });

    const handler = handlers.get(SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND);
    expect(handler).toBeDefined();
    if (!handler) return;
    const localId = 'pending-exact-accepted-1';
    const accepted = { text: 'Exact request.', localId, meta: {} };

    await expect(handler(accepted)).resolves.toEqual({ ok: true });
    await expect(handler(accepted)).resolves.toEqual({ ok: true });
    await expect(handler({ ...accepted, text: 'Changed request.' })).resolves.toEqual({
      ok: false,
      error: 'session_user_message_id_payload_conflict',
      errorCode: 'session_user_message_id_payload_conflict',
    });
    expect(enqueueSessionUserMessage).toHaveBeenCalledOnce();
  });

  it('does not let a runtime-local handler bypass canonical attachment admission', async () => {
    const { handlers, registrar } = createHarness();
    const enqueueSessionUserMessage = vi.fn();
    const handleUserMessage = vi.fn(async () => ({ handled: true, result: { ok: true } }));
    registerSessionUserMessageSendHandler(registrar, {
      workingDirectory: process.cwd(),
      enqueueSessionUserMessage,
      sessionRuntimeControls: { handleUserMessage } as never,
    });

    const handler = handlers.get(SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND);
    expect(handler).toBeDefined();
    if (!handler) return;

    await expect(handler({
      text: 'Please inspect the selected review comment.',
      localId: 'attachment-no-runtime-bypass-1',
      meta: {
        happierStructuredInputV1: {
          v: 1,
          composerAttachments: [selectedPluginAttachment],
        },
      },
    })).resolves.toEqual({ ok: true });

    expect(handleUserMessage).not.toHaveBeenCalled();
    expect(enqueueSessionUserMessage).toHaveBeenCalledOnce();
  });

  it('keeps the temporary attachment containment narrow for ordinary structured input', async () => {
    const { handlers, registrar } = createHarness();
    const enqueueSessionUserMessage = vi.fn();
    registerSessionUserMessageSendHandler(registrar, {
      workingDirectory: process.cwd(),
      enqueueSessionUserMessage,
    });

    const handler = handlers.get(SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND);
    expect(handler).toBeDefined();
    if (!handler) return;

    await expect(handler({
      text: 'Please inspect this.',
      localId: 'pending-no-attachment-1',
      meta: {
        happierStructuredInputV1: {
          v: 1,
          skillMentions: [{ id: 'review', name: 'review' }],
        },
      },
    })).resolves.toEqual({ ok: true });

    expect(enqueueSessionUserMessage).toHaveBeenCalledOnce();
  });

  it('accepts an eagerly serialized empty composer attachment list as no selection', async () => {
    const { handlers, registrar } = createHarness();
    const enqueueSessionUserMessage = vi.fn();
    registerSessionUserMessageSendHandler(registrar, {
      workingDirectory: process.cwd(),
      enqueueSessionUserMessage,
    });

    const handler = handlers.get(SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND);
    expect(handler).toBeDefined();
    if (!handler) return;

    await expect(handler({
      text: 'Ordinary text with an eagerly serialized empty list.',
      localId: 'pending-empty-attachment-list',
      meta: {
        happierStructuredInputV1: {
          v: 1,
          composerAttachments: [],
        },
      },
    })).resolves.toEqual({ ok: true });

    expect(enqueueSessionUserMessage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      localId: 'pending-empty-attachment-list',
    }));
  });
});
