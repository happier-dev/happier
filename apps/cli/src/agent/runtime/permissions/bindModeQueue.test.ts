import { describe, expect, it, vi } from 'vitest';

import type { Metadata, PermissionMode, UserMessage } from '@/api/types';
import { registerPermissionModeMessageQueueBinding } from './bindModeQueue';
import type {
  PermissionModeQueuedPrompt,
  PermissionModeQueuedPromptMode,
} from '@/agent/runtime/permissions/queuedPrompt';
import {
  ProviderConnectionIdSchema,
  type ProviderBoundModelRef,
} from '@happier-dev/protocol';

describe('registerPermissionModeMessageQueueBinding', () => {
  function createSessionHarness(initialMetadata?: Metadata) {
    let userMessageHandler: ((message: UserMessage) => boolean | void) | null = null;
    let metadata =
      initialMetadata ?? ({ permissionMode: 'default', permissionModeUpdatedAt: 0 } as unknown as Metadata);

    return {
      session: {
        onUserMessage: (handler: (message: UserMessage) => boolean | void) => {
          userMessageHandler = handler;
        },
        updateMetadata: (updater: (current: Metadata) => Metadata) => {
          metadata = updater(metadata);
        },
      },
      emit: (message: UserMessage) => {
        if (!userMessageHandler) throw new Error('missing onUserMessage handler');
        return userMessageHandler(message);
      },
      getMetadata: () => metadata,
    };
  }

  function createHarness(activeSelection: ProviderBoundModelRef = {
    agentTargetKey: 'backend:opencode',
    providerConnectionId: null,
    modelId: 'default',
  }) {
    const queueCalls: Array<{
      type: 'push' | 'isolate' | 'clear';
      message: PermissionModeQueuedPrompt;
      mode: PermissionModeQueuedPromptMode;
    }> = [];
    let currentPermissionMode: PermissionMode | undefined;
    const sessionHarness = createSessionHarness();
    const rejectPromptBeforeProvider = vi.fn();

    const binding = registerPermissionModeMessageQueueBinding({
      session: sessionHarness.session,
      agentTargetKey: 'backend:opencode',
      queue: {
        push: (message: PermissionModeQueuedPrompt, mode: PermissionModeQueuedPromptMode) =>
          queueCalls.push({ type: 'push', message, mode }),
        pushIsolate: (message: PermissionModeQueuedPrompt, mode: PermissionModeQueuedPromptMode) =>
          queueCalls.push({ type: 'isolate', message, mode }),
        pushIsolateAndClear: (message: PermissionModeQueuedPrompt, mode: PermissionModeQueuedPromptMode) =>
          queueCalls.push({ type: 'clear', message, mode }),
      },
      getCurrentPermissionMode: () => currentPermissionMode,
      setCurrentPermissionMode: (mode: PermissionMode | undefined) => {
        currentPermissionMode = mode;
      },
      inFlightSteer: {
        readActiveModelSelection: () => activeSelection,
        supportsInFlightSteer: () => false,
        isTurnInFlight: () => false,
        steerText: async () => undefined,
        rejectPromptBeforeProvider,
      },
    });

    return {
      bindSession: binding.bindSession,
      releaseRejectedBeforeProviderPromptIdentity: (binding as {
        releaseRejectedBeforeProviderPromptIdentity: (
          session: typeof sessionHarness.session,
          message: PermissionModeQueuedPrompt,
        ) => void;
      }).releaseRejectedBeforeProviderPromptIdentity,
      emit: sessionHarness.emit,
      session: sessionHarness.session,
      getCurrentPermissionMode: () => currentPermissionMode,
      getMetadata: sessionHarness.getMetadata,
      queueCalls,
      rejectPromptBeforeProvider,
    };
  }

  it('queues regular messages with the current permission mode', () => {
    const harness = createHarness();

    harness.emit({
      role: 'user',
      content: { type: 'text', text: 'hello world' },
      localId: 'local-1',
      meta: {},
    } as UserMessage);

    expect(harness.queueCalls).toEqual([
      {
        type: 'push',
        message: { text: 'hello world', localId: 'local-1', localIds: ['local-1'] },
        mode: { permissionMode: 'default' },
      },
    ]);
  });

  it('releases only the active binding identity after a proven pre-provider rejection', () => {
    const harness = createHarness();
    const localId = 'local-retry-after-pre-effect-rejection';
    const retry = {
      role: 'user' as const,
      content: { type: 'text' as const, text: 'retry this exact pending input' },
      localId,
      meta: {},
    } as UserMessage;

    harness.emit(retry);
    harness.emit(retry);
    expect(harness.queueCalls).toHaveLength(1);

    harness.releaseRejectedBeforeProviderPromptIdentity({
      onUserMessage: () => undefined,
      updateMetadata: () => undefined,
    }, {
      text: retry.content.text,
      localId,
      localIds: [localId],
    });
    harness.emit(retry);
    expect(harness.queueCalls).toHaveLength(1);

    harness.releaseRejectedBeforeProviderPromptIdentity(harness.session, {
      text: retry.content.text,
      localId,
      localIds: [localId],
    });
    harness.emit(retry);

    expect(harness.queueCalls).toMatchObject([
      { type: 'push', message: { localId } },
      { type: 'push', message: { localId } },
    ]);
  });

  it('releases the exact local id and committed sequence after durable pre-provider retirement', () => {
    const localId = 'local-retry-with-seq';
    const queueCalls: Array<{ message: PermissionModeQueuedPrompt }> = [];
    let userMessageHandler: ((message: UserMessage) => boolean | void) | null = null;
    const session = {
      onUserMessage: (handler: (message: UserMessage) => boolean | void) => {
        userMessageHandler = handler;
      },
      updateMetadata: () => undefined,
      getCommittedUserMessageSeq: (candidateLocalId: string) => candidateLocalId === localId ? 42 : null,
    };
    const binding = registerPermissionModeMessageQueueBinding({
      session,
      queue: {
        push: (message: PermissionModeQueuedPrompt) => queueCalls.push({ message }),
        pushIsolate: (message: PermissionModeQueuedPrompt) => queueCalls.push({ message }),
        pushIsolateAndClear: (message: PermissionModeQueuedPrompt) => queueCalls.push({ message }),
      },
      getCurrentPermissionMode: () => 'default' as PermissionMode,
      setCurrentPermissionMode: () => undefined,
    });
    const retry = {
      role: 'user' as const,
      content: { type: 'text' as const, text: 'retry only after custody retirement' },
      localId,
      meta: {},
    } as UserMessage;

    expect(userMessageHandler!(retry)).toBe(true);
    expect(userMessageHandler!(retry)).toBe(true);
    expect(queueCalls).toHaveLength(1);

    binding.releaseRejectedBeforeProviderPromptIdentity(session, {
      text: retry.content.text,
      localId,
      localIds: [localId],
      userMessageSeq: 42,
      userMessageSeqs: [42],
    });

    expect(userMessageHandler!(retry)).toBe(true);
    expect(queueCalls).toHaveLength(2);
  });

  it('preserves canonical structured input and never steers it through the text-only path', async () => {
    const sessionHarness = createSessionHarness();
    const queueCalls: Array<{ type: 'push' | 'isolate' | 'clear'; message: PermissionModeQueuedPrompt }> = [];
    const steerText = vi.fn(async () => undefined);
    const structuredInput = {
      v: 1 as const,
      imageInputs: [{
        id: 'image-1',
        kind: 'localImage' as const,
        path: '.happier/uploads/messages/message-1/image.png',
        mimeType: 'image/png',
        sizeBytes: 4,
        sha256: 'a'.repeat(64),
        provenance: { kind: 'sessionAttachmentUpload' as const },
      }],
    };

    registerPermissionModeMessageQueueBinding({
      session: sessionHarness.session,
      queue: {
        push: (message: PermissionModeQueuedPrompt) => queueCalls.push({ type: 'push', message }),
        pushIsolate: (message: PermissionModeQueuedPrompt) => queueCalls.push({ type: 'isolate', message }),
        pushIsolateAndClear: (message: PermissionModeQueuedPrompt) => queueCalls.push({ type: 'clear', message }),
      },
      getCurrentPermissionMode: () => 'default',
      setCurrentPermissionMode: () => undefined,
      inFlightSteer: {
        supportsInFlightSteer: () => true,
        isTurnInFlight: () => true,
        steerText,
      },
    });

    sessionHarness.emit({
      role: 'user',
      content: { type: 'text', text: 'inspect this image' },
      localId: 'local-image-1',
      meta: {
        happierStructuredInputV1: structuredInput,
      },
    } as UserMessage);
    await Promise.resolve();

    expect(steerText).not.toHaveBeenCalled();
    expect(queueCalls).toEqual([{
      type: 'isolate',
      message: {
        text: 'inspect this image',
        localId: 'local-image-1',
        localIds: ['local-image-1'],
        structuredInput,
      },
    }]);
  });

  // The steer path renders only the provenance block, so it has no place to put the
  // `@session` reference projection. That is safe only because a mention can exist solely
  // inside the structured-input envelope, and a message carrying that envelope is never
  // steerable — it queues and reaches the prompt loop, which does render the reference
  // block. If the structured-input steer exclusion is ever relaxed, this test fails and the
  // steer dispatch must start supplying `sessionReferenceBlock` itself.
  it('queues a Session-mention message instead of steering it, keeping the reference projection reachable', async () => {
    const sessionHarness = createSessionHarness();
    const queueCalls: Array<{ type: 'push' | 'isolate' | 'clear'; message: PermissionModeQueuedPrompt }> = [];
    const steerText = vi.fn(async () => undefined);
    const structuredInput = {
      v: 1 as const,
      mentions: [{
        kind: 'session' as const,
        ref: 'session:source-session',
        token: '@session:source',
        start: 0,
        end: 15,
      }],
    };

    registerPermissionModeMessageQueueBinding({
      session: sessionHarness.session,
      queue: {
        push: (message: PermissionModeQueuedPrompt) => queueCalls.push({ type: 'push', message }),
        pushIsolate: (message: PermissionModeQueuedPrompt) => queueCalls.push({ type: 'isolate', message }),
        pushIsolateAndClear: (message: PermissionModeQueuedPrompt) => queueCalls.push({ type: 'clear', message }),
      },
      getCurrentPermissionMode: () => 'default',
      setCurrentPermissionMode: () => undefined,
      inFlightSteer: {
        supportsInFlightSteer: () => true,
        isTurnInFlight: () => true,
        steerText,
      },
    });

    sessionHarness.emit({
      role: 'user',
      content: { type: 'text', text: 'compare with @session:source' },
      localId: 'local-mention-1',
      meta: {
        happierStructuredInputV1: structuredInput,
      },
    } as UserMessage);
    await Promise.resolve();

    expect(steerText).not.toHaveBeenCalled();
    expect(queueCalls).toHaveLength(1);
    expect(queueCalls[0]?.message.structuredInput).toEqual(structuredInput);
  });

  it('carries only the exact admitted SessionMedia items alongside their Composer refs', () => {
    const harness = createHarness();
    const media = {
      id: 'media-review-1',
      role: 'input' as const,
      category: 'attachment' as const,
      mediaKind: 'image' as const,
      mimeType: 'image/png',
      name: 'review.png',
      path: '.happier/uploads/messages/session-1/local-review/review.png',
      sizeBytes: 67,
      sha256: 'a'.repeat(64),
      origin: { source: 'user-upload' as const },
    };

    harness.emit({
      role: 'user',
      content: { type: 'text', text: 'inspect this review image' },
      localId: 'local-review',
      meta: {
        happierStructuredInputV1: {
          v: 1,
          composerAttachments: [{
            v: 1,
            instanceId: 'review-media-1',
            attachment: { pluginId: 'acme.review', localId: 'review-media' },
            key: 'review-image',
            value: { reviewId: '42' },
            presentation: { label: 'Review image', typeLabel: 'Review media' },
            content: { kind: 'sessionMedia', mediaId: media.id },
          }],
        },
        happier: {
          kind: 'session_media.v1',
          payload: { media: [media] },
        },
      },
    } as UserMessage);

    expect(harness.queueCalls).toMatchObject([{
      type: 'isolate',
      message: {
        localId: 'local-review',
        structuredInput: {
          composerAttachments: [{ content: { kind: 'sessionMedia', mediaId: media.id } }],
        },
        sessionMedia: [media],
      },
    }]);
  });

  it('rejects a malformed canonical envelope instead of falling back to a text-only prompt', () => {
    const harness = createHarness();

    harness.emit({
      role: 'user',
      content: { type: 'text', text: 'do not dispatch forged attachment data' },
      localId: 'forged-canonical-input',
      meta: {
        happierStructuredInputV1: {
          v: 1,
          resolvedComposerAttachments: [{ instanceId: 'forged' }],
        },
      },
    } as UserMessage);

    expect(harness.queueCalls).toEqual([]);
    expect(harness.rejectPromptBeforeProvider).toHaveBeenCalledWith({
      localIds: ['forged-canonical-input'],
      userMessageSeq: null,
    });
  });

  it('refuses only the composer attachment whose media is still an unfinalized staged claim', () => {
    // A queued Pending row stores raw Message *ingress*: only the target daemon's
    // `finalizeComposerStagedMediaToSession`, which runs inside canonical Message
    // admission, replaces this transfer-owned claim with the durable `sessionMedia`
    // reference. The queue binding consumes the admitted envelope only, so an envelope
    // that never reached that finalizer must fail closed rather than hand the provider a
    // stage id it cannot resolve — while the same attachment without a staged claim is
    // ordinary admitted input and still reaches the queue.
    const attachment = {
      v: 1,
      instanceId: 'review-media-1',
      attachment: { pluginId: 'acme.review', localId: 'review-media' },
      key: 'review-image',
      value: { reviewId: '42' },
      presentation: { label: 'Review image', typeLabel: 'Review media' },
    };
    const stagedContent = {
      kind: 'stagedMedia',
      handle: {
        v: 1,
        id: 'stage-review-1',
        executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
        owner: { pluginId: 'acme.review', localId: 'review-media' },
        mediaKind: 'image',
        mimeType: 'image/png',
        name: 'review.png',
        sizeBytes: 67,
        sha256: 'a'.repeat(64),
      },
    };

    const staged = createHarness();
    staged.emit({
      role: 'user',
      content: { type: 'text', text: 'look at this screenshot' },
      localId: 'pending-staged-media',
      meta: {
        happierStructuredInputV1: {
          v: 1,
          composerAttachments: [{ ...attachment, content: stagedContent }],
        },
      },
    } as UserMessage);

    expect(staged.queueCalls).toEqual([]);
    expect(staged.rejectPromptBeforeProvider).toHaveBeenCalledWith({
      localIds: ['pending-staged-media'],
      userMessageSeq: null,
    });

    const finalized = createHarness();
    finalized.emit({
      role: 'user',
      content: { type: 'text', text: 'look at this screenshot' },
      localId: 'pending-contentless-attachment',
      meta: {
        happierStructuredInputV1: { v: 1, composerAttachments: [attachment] },
      },
    } as UserMessage);

    expect(finalized.queueCalls).toMatchObject([{
      type: 'isolate',
      message: {
        localId: 'pending-contentless-attachment',
        structuredInput: { composerAttachments: [attachment] },
      },
    }]);
    expect(finalized.rejectPromptBeforeProvider).not.toHaveBeenCalled();
  });

  it('does not decode a raw attachment envelope as structured input', () => {
    const harness = createHarness();
    const attachment = {
      v: 1,
      instanceId: 'review-instance-1',
      attachment: { pluginId: 'acme.review-comments', localId: 'review-comment' },
      key: 'review-42',
      value: { reviewId: '42' },
      presentation: { label: 'Review #42', typeLabel: 'Review comment' },
    };

    harness.emit({
      role: 'user',
      content: { type: 'text', text: 'inspect this review' },
      localId: 'raw-attachment-without-admission',
      meta: {
        happier: {
          kind: 'attachments.v1',
          payload: { attachments: [attachment] },
        },
      },
    } as UserMessage);

    expect(harness.queueCalls).toMatchObject([{
      type: 'push',
      message: {
        text: 'inspect this review',
        localId: 'raw-attachment-without-admission',
      },
    }]);
    expect(harness.queueCalls[0]?.message.structuredInput).toBeUndefined();
  });

  it('threads the committed user-message seq into the queued prompt for exact local-command replay suppression', () => {
    const queueCalls: Array<{ message: PermissionModeQueuedPrompt }> = [];
    let userMessageHandler: ((message: UserMessage) => boolean | void) | null = null;

    registerPermissionModeMessageQueueBinding({
      session: {
        onUserMessage: (handler: (message: UserMessage) => boolean | void) => {
          userMessageHandler = handler;
        },
        updateMetadata: () => void 0,
        getCommittedUserMessageSeq: (localId: string) => (localId === 'local-seq-1' ? 42 : null),
      },
      queue: {
        push: (message: PermissionModeQueuedPrompt) => queueCalls.push({ message }),
        pushIsolate: (message: PermissionModeQueuedPrompt) => queueCalls.push({ message }),
        pushIsolateAndClear: (message: PermissionModeQueuedPrompt) => queueCalls.push({ message }),
      },
      getCurrentPermissionMode: () => 'default' as PermissionMode,
      setCurrentPermissionMode: () => void 0,
    });

    userMessageHandler!({
      role: 'user',
      content: { type: 'text', text: 'confirm me later' },
      localId: 'local-seq-1',
      meta: {},
    } as UserMessage);

    expect(queueCalls).toEqual([
      {
        message: {
          text: 'confirm me later',
          localId: 'local-seq-1',
          localIds: ['local-seq-1'],
          userMessageSeq: 42,
          userMessageSeqs: [42],
        },
      },
    ]);
  });

  it('does not queue the same committed user-message row twice', () => {
    const queueCalls: Array<{ message: PermissionModeQueuedPrompt }> = [];
    let userMessageHandler: ((message: UserMessage) => boolean | void) | null = null;

    registerPermissionModeMessageQueueBinding({
      session: {
        onUserMessage: (handler: (message: UserMessage) => boolean | void) => {
          userMessageHandler = handler;
        },
        updateMetadata: () => void 0,
        getCommittedUserMessageSeq: (localId: string) => (localId === 'local-dup-1' ? 7 : null),
      },
      queue: {
        push: (message: PermissionModeQueuedPrompt) => queueCalls.push({ message }),
        pushIsolate: (message: PermissionModeQueuedPrompt) => queueCalls.push({ message }),
        pushIsolateAndClear: (message: PermissionModeQueuedPrompt) => queueCalls.push({ message }),
      },
      getCurrentPermissionMode: () => 'default' as PermissionMode,
      setCurrentPermissionMode: () => void 0,
    });

    const message = {
      role: 'user',
      content: { type: 'text', text: 'deliver exactly once' },
      localId: 'local-dup-1',
      meta: {},
    } as UserMessage;

    expect(userMessageHandler!(message)).toBe(true);
    expect(userMessageHandler!(message)).toBe(true);

    expect(queueCalls).toEqual([
      {
        message: {
          text: 'deliver exactly once',
          localId: 'local-dup-1',
          localIds: ['local-dup-1'],
          userMessageSeq: 7,
          userMessageSeqs: [7],
        },
      },
    ]);
  });

  it('updates permission mode from message metadata before queueing', () => {
    const harness = createHarness();

    harness.emit({
      role: 'user',
      content: { type: 'text', text: 'approve this' },
      localId: 'local-2',
      meta: { permissionMode: 'acceptEdits' },
      createdAt: 42,
    } as UserMessage);

    expect(harness.getCurrentPermissionMode()).toBe('safe-yolo');
    expect(harness.getMetadata().permissionMode).toBe('safe-yolo');
    expect(harness.getMetadata().permissionModeUpdatedAt).toBe(42);
    expect(harness.queueCalls).toEqual([
      {
        type: 'push',
        message: { text: 'approve this', localId: 'local-2', localIds: ['local-2'] },
        mode: { permissionMode: 'safe-yolo' },
      },
    ]);
  });

  it('queues model overrides from user message metadata as a prompt mode dimension', () => {
    const harness = createHarness();

    harness.emit({
      role: 'user',
      content: { type: 'text', text: 'use this model' },
      localId: 'local-model-1',
      meta: { model: ' opencode/big-pickle ' },
    } as UserMessage);

    expect(harness.queueCalls).toEqual([
      {
        type: 'push',
        message: { text: 'use this model', localId: 'local-model-1', localIds: ['local-model-1'] },
        mode: {
          permissionMode: 'default',
          modelSelection: {
            agentTargetKey: 'backend:opencode',
            providerConnectionId: null,
            modelId: 'opencode/big-pickle',
          },
        },
      },
    ]);
  });

  it('prefers a target-matched structured model selection over the legacy projection', () => {
    const harness = createHarness();

    harness.emit({
      role: 'user',
      content: { type: 'text', text: 'use this provider model' },
      localId: 'local-structured-model-1',
      meta: {
        model: 'stale-native-model',
        modelSelectionV1: {
          v: 1,
          updatedAt: 42,
          ref: {
            agentTargetKey: 'backend:opencode',
            providerConnectionId: 'pc_openrouter',
            modelId: 'default',
          },
        },
      },
    } as UserMessage);

    expect(harness.queueCalls).toEqual([
      {
        type: 'push',
        message: {
          text: 'use this provider model',
          localId: 'local-structured-model-1',
          localIds: ['local-structured-model-1'],
        },
        mode: {
          permissionMode: 'default',
          modelSelection: {
            agentTargetKey: 'backend:opencode',
            providerConnectionId: 'pc_openrouter',
            modelId: 'default',
          },
        },
      },
    ]);
  });

  it('fails closed for a legacy model-only message when the active selection is Provider-bound', () => {
    const harness = createHarness({
      agentTargetKey: 'backend:opencode',
      providerConnectionId: ProviderConnectionIdSchema.parse('pc_openrouter'),
      modelId: 'provider-active',
    });

    harness.emit({
      role: 'user',
      content: { type: 'text', text: 'must not bypass the Provider owner' },
      localId: 'local-provider-legacy-model',
      meta: { model: 'legacy-bypass' },
    } as UserMessage);

    expect(harness.queueCalls).toEqual([]);
  });

  it('rejects before provider effect when structured model metadata is invalid or targets another agent', () => {
    const harness = createHarness();

    for (const [localId, modelSelectionV1] of [
      ['local-invalid-model', { v: 1, updatedAt: 42, ref: { agentTargetKey: 'backend:opencode', providerConnectionId: 'pc_1', modelId: 'invalid model' } }],
      ['local-wrong-target', { v: 1, updatedAt: 43, ref: { agentTargetKey: 'backend:codex', providerConnectionId: 'pc_1', modelId: 'provider-model' } }],
    ] as const) {
      harness.emit({
        role: 'user',
        content: { type: 'text', text: localId },
        localId,
        meta: { model: 'must-not-apply', modelSelectionV1 },
      } as UserMessage);
    }

    expect(harness.queueCalls).toEqual([]);
    expect(harness.rejectPromptBeforeProvider.mock.calls).toEqual([
      [{
        localIds: ['local-invalid-model'],
        userMessageSeq: null,
      }],
      [{
        localIds: ['local-wrong-target'],
        userMessageSeq: null,
      }],
    ]);
  });

  it('updates metadata through the rebound session after bindSession swaps the client', () => {
    const harness = createHarness();
    const reboundSession = createSessionHarness();

    harness.bindSession(reboundSession.session);

    reboundSession.emit({
      role: 'user',
      content: { type: 'text', text: 'approve this' },
      localId: 'local-rebind-1',
      meta: { permissionMode: 'acceptEdits' },
      createdAt: 42,
    } as UserMessage);

    expect(reboundSession.getMetadata().permissionMode).toBe('safe-yolo');
    expect(reboundSession.getMetadata().permissionModeUpdatedAt).toBe(42);
    expect(harness.getMetadata().permissionMode).toBe('default');
    expect(harness.getMetadata().permissionModeUpdatedAt).toBe(0);
    expect(harness.queueCalls).toEqual([
      {
        type: 'push',
        message: { text: 'approve this', localId: 'local-rebind-1', localIds: ['local-rebind-1'] },
        mode: { permissionMode: 'safe-yolo' },
      },
    ]);
  });

  it('ignores old-session user messages after bindSession swaps to a new client', () => {
    const harness = createHarness();
    const reboundSession = createSessionHarness();

    harness.bindSession(reboundSession.session);

    const accepted = harness.emit({
      role: 'user',
      content: { type: 'text', text: 'stale session message' },
      localId: 'local-stale-1',
      meta: { permissionMode: 'acceptEdits' },
      createdAt: 42,
    } as UserMessage);

    expect(accepted).toBe(false);
    expect(harness.getCurrentPermissionMode()).toBeUndefined();
    expect(harness.getMetadata().permissionMode).toBe('default');
    expect(harness.getMetadata().permissionModeUpdatedAt).toBe(0);
    expect(reboundSession.getMetadata().permissionMode).toBe('default');
    expect(reboundSession.getMetadata().permissionModeUpdatedAt).toBe(0);
    expect(harness.queueCalls).toEqual([]);
  });

  it('routes clear commands through isolate-and-clear queue path', () => {
    const harness = createHarness();

    harness.emit({
      role: 'user',
      content: { type: 'text', text: '/clear' },
      localId: 'local-3',
      meta: {},
    } as UserMessage);

    expect(harness.queueCalls).toEqual([
      {
        type: 'clear',
        message: { text: '/clear', localId: 'local-3', localIds: ['local-3'] },
        mode: { permissionMode: 'default' },
      },
    ]);
  });

  it.each(['/clear', '/compact preserve the summary'])('isolates structured input even when %s is non-steerable', (text) => {
    const harness = createHarness();

    harness.emit({
      role: 'user',
      content: { type: 'text', text },
      localId: `local-structured-${text.startsWith('/clear') ? 'clear' : 'compact'}`,
      meta: {
        happierStructuredInputV1: {
          v: 1,
          skillMentions: [{ name: 'review', path: '/skills/review/SKILL.md' }],
        },
      },
    } as UserMessage);

    expect(harness.queueCalls).toMatchObject([
      {
        type: 'isolate',
        message: {
          text,
          localId: `local-structured-${text.startsWith('/clear') ? 'clear' : 'compact'}`,
          localIds: [`local-structured-${text.startsWith('/clear') ? 'clear' : 'compact'}`],
          structuredInput: {
            v: 1,
            skillMentions: [{ name: 'review', path: '/skills/review/SKILL.md' }],
          },
        },
        mode: { permissionMode: 'default' },
      },
    ]);
  });

  it('passes the user message local id when steering an in-flight turn', async () => {
    const sessionHarness = createSessionHarness();
    const queueCalls: PermissionModeQueuedPrompt[] = [];
    const steerCalls: Array<Readonly<{ text: string; localId: string | null | undefined }>> = [];

    registerPermissionModeMessageQueueBinding({
      session: sessionHarness.session,
      queue: {
        push: (message: PermissionModeQueuedPrompt) => {
          queueCalls.push(message);
        },
        pushIsolate: (message: PermissionModeQueuedPrompt) => {
          queueCalls.push(message);
        },
        pushIsolateAndClear: (message: PermissionModeQueuedPrompt) => {
          queueCalls.push(message);
        },
      },
      getCurrentPermissionMode: () => 'default',
      setCurrentPermissionMode: () => undefined,
      inFlightSteer: {
        supportsInFlightSteer: () => true,
        isTurnInFlight: () => true,
        steerText: async (text, options) => {
          steerCalls.push({ text, localId: options?.localId });
        },
      },
    });

    sessionHarness.emit({
      role: 'user',
      content: { type: 'text', text: 'nudge active turn' },
      localId: 'local-steer-1',
      meta: {},
    } as UserMessage);

    await Promise.resolve();

    expect(queueCalls).toEqual([]);
    expect(steerCalls).toEqual([
      { text: 'nudge active turn', localId: 'local-steer-1' },
    ]);
  });

  it('reads appendSystemPrompt from prototype-less metadata objects', () => {
    const harness = createHarness();
    const meta = Object.assign(Object.create(null) as Record<string, unknown>, {
      appendSystemPrompt: 'Use the latest project conventions.',
    });

    harness.emit({
      role: 'user',
      content: { type: 'text', text: 'hello world' },
      localId: 'local-4',
      meta,
    } as UserMessage);

    expect(harness.queueCalls).toEqual([
      {
        type: 'push',
        message: { text: 'hello world', localId: 'local-4', localIds: ['local-4'] },
        mode: {
          permissionMode: 'default',
          appendSystemPrompt: 'Use the latest project conventions.',
        },
      },
    ]);
  });
});
