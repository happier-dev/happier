import { describe, expect, it, vi } from 'vitest';

import type {
  ComposerAttachmentRuntime,
  PluginInvocationContext,
} from '@happier-dev/plugin-sdk';
import type {
  ComposerAttachmentDraftV1,
  ComposerAttachmentInputV1,
  ComposerAttachmentMessageAcceptedV1,
  ComposerAttachmentPrepareRequestV1,
  ComposerAttachmentPrepareResultV1,
  ComposerAttachmentResolveRequestV1,
  ComposerAttachmentResolveResultV1,
} from '@happier-dev/protocol';

import {
  createTargetComposerAttachmentRegistry,
  type TargetComposerAttachmentInvocationContextFactory,
} from './targetComposerAttachments';

const ATTACHMENT = { pluginId: 'acme.issues', localId: 'issue-context' } as const;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function invocationContext(
  signal = new AbortController().signal,
  diagnostic: ReturnType<typeof vi.fn> = vi.fn(),
): PluginInvocationContext {
  return Object.freeze({
    plugin: Object.freeze({ id: ATTACHMENT.pluginId, version: '1.0.0' }),
    contribution: Object.freeze({
      id: ATTACHMENT.localId,
      qualifiedId: `${ATTACHMENT.pluginId}/composerAttachments/${ATTACHMENT.localId}`,
    }),
    surface: 'cli',
    signal,
    services: Object.freeze({
      logger: Object.freeze({
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        diagnostic,
      }),
    }) as unknown as PluginInvocationContext['services'],
  });
}

function fixture(
  overrides: Partial<ComposerAttachmentRuntime> = {},
  options: Readonly<{ callbackTimeoutMs?: number }> = {},
) {
  const retirement = new AbortController();
  let current = true;
  const diagnostic = vi.fn();
  const completedContexts: ReturnType<typeof vi.fn>[] = [];
  const createInvocationContext = vi.fn((input: Readonly<{
    attachment: Readonly<{ pluginId: string; localId: string }>;
    generation: string;
    sessionId: string;
    signal: AbortSignal;
    isCurrent(): boolean;
  }>) => {
    const complete = vi.fn();
    completedContexts.push(complete);
    return Object.freeze({
      context: invocationContext(input.signal, diagnostic),
      complete,
    });
  });
  const runtime: ComposerAttachmentRuntime = {
    prepareForSend: vi.fn(async (request) => ({
      attachments: [...request.attachments].reverse().map((attachment) => ({
        instanceId: attachment.instanceId,
        status: 'ready' as const,
        value: { ...attachment.value, prepared: true },
      })),
    })),
    resolveForDispatch: vi.fn(async (request) => ({
      attachments: [...request.attachments].reverse().map((attachment) => ({
        instanceId: attachment.instanceId,
        status: 'ready' as const,
        context: `Context for ${attachment.key}`,
      })),
    })),
    afterMessageAccepted: vi.fn(async () => {}),
    ...overrides,
  };
  const entry = Object.freeze({
    pluginId: ATTACHMENT.pluginId,
    generation: '7',
    registration: Object.freeze({
      family: 'composerAttachments' as const,
      localId: ATTACHMENT.localId,
      value: runtime,
    }),
  });
  const registry = createTargetComposerAttachmentRegistry({
    activateAttachmentOnDemand: async () => {},
    targetRegistrations: [entry],
    resolveGenerationLifecycle: () => ({
      isCurrent: () => current,
      retirementSignal: retirement.signal,
    }),
    createInvocationContext,
    callbackTimeoutMs: options.callbackTimeoutMs,
  });
  return {
    registry,
    runtime,
    diagnostic,
    createInvocationContext,
    completedContexts,
    retire: () => { current = false; retirement.abort(new Error('retired')); },
  };
}

const prepareRequest = {
  sessionId: 'session-1',
  localId: 'local-1',
  attachments: [
    { instanceId: 'attachment-1', key: 'issue', value: { issueId: '42' } },
    { instanceId: 'attachment-2', key: 'issue', value: { issueId: '43' } },
  ],
} satisfies ComposerAttachmentPrepareRequestV1;

const resolveRequest = {
  sessionId: 'session-1',
  localId: 'local-1',
  attachments: [
    { instanceId: 'attachment-1', key: 'issue', value: { issueId: '42', prepared: true } },
    { instanceId: 'attachment-2', key: 'issue', value: { issueId: '43', prepared: true } },
  ],
} satisfies ComposerAttachmentResolveRequestV1;

const acceptedEvent = {
  sessionId: 'session-1',
  localId: 'local-1',
  attachments: resolveRequest.attachments,
} satisfies ComposerAttachmentMessageAcceptedV1;

describe('target composer attachment registry', () => {
  it('keeps a retained attachment registration while still rejecting duplicate registrations', async () => {
    const runtime: ComposerAttachmentRuntime = {
      prepareForSend: async () => ({ attachments: [] }),
    };
    const registration = Object.freeze({
      pluginId: ATTACHMENT.pluginId,
      generation: '7',
      registration: Object.freeze({
        family: 'composerAttachments' as const,
        localId: ATTACHMENT.localId,
        value: runtime,
      }),
    });
    const lifecycle = () => ({
      isCurrent: () => true,
      retirementSignal: new AbortController().signal,
    });
    const createInvocationContext: TargetComposerAttachmentInvocationContextFactory = () => Object.freeze({
      context: invocationContext(),
      complete: () => {},
    });

    const retained = createTargetComposerAttachmentRegistry({
      activateAttachmentOnDemand: async () => {},
      targetRegistrations: [registration],
      resolveGenerationLifecycle: lifecycle,
      createInvocationContext,
    });
    await expect(retained.supports({ attachment: ATTACHMENT, phase: 'prepareForSend' })).resolves.toBe(true);
    expect(() => createTargetComposerAttachmentRegistry({
      activateAttachmentOnDemand: async () => {},
      targetRegistrations: [registration, registration],
      resolveGenerationLifecycle: lifecycle,
      createInvocationContext,
    })).toThrow(/more than once/i);
  });

  it('admits only an exact current phase and returns every prepared and resolved outcome in request order', async () => {
    const subject = fixture();
    const signal = new AbortController().signal;

    await expect(subject.registry.supports({
      attachment: ATTACHMENT,
      phase: 'prepareForSend',
    })).resolves.toBe(true);
    await expect(subject.registry.supports({
      attachment: { pluginId: ATTACHMENT.pluginId, localId: 'other' },
      phase: 'prepareForSend',
    })).resolves.toBe(false);
    await expect(subject.registry.prepareForSend({
      attachment: ATTACHMENT,
      request: prepareRequest,
      signal,
    })).resolves.toEqual({
      attachments: [
        { instanceId: 'attachment-1', status: 'ready', value: { issueId: '42', prepared: true } },
        { instanceId: 'attachment-2', status: 'ready', value: { issueId: '43', prepared: true } },
      ],
    });
    await expect(subject.registry.resolveForDispatch({
      attachment: ATTACHMENT,
      request: resolveRequest,
      signal,
    })).resolves.toEqual({
      attachments: [
        { instanceId: 'attachment-1', status: 'ready', context: 'Context for issue' },
        { instanceId: 'attachment-2', status: 'ready', context: 'Context for issue' },
      ],
    });
    await expect(subject.registry.afterMessageAccepted({
      attachment: ATTACHMENT,
      event: acceptedEvent,
      signal,
    })).resolves.toBeUndefined();
    expect(subject.createInvocationContext).toHaveBeenCalledTimes(3);
    expect(subject.createInvocationContext).toHaveBeenNthCalledWith(1, expect.objectContaining({
      attachment: ATTACHMENT,
      generation: '7',
      sessionId: 'session-1',
      signal: expect.any(AbortSignal),
      isCurrent: expect.any(Function),
    }));
    expect(subject.completedContexts).toHaveLength(3);
    for (const complete of subject.completedContexts) {
      expect(complete).toHaveBeenCalledTimes(1);
    }
  });

  it('surfaces a failed post-acceptance callback through the plugin diagnostic owner', async () => {
    const failure = new Error('fixture post-acceptance failure');
    const subject = fixture({
      afterMessageAccepted: vi.fn(async () => {
        throw failure;
      }),
    });

    await expect(subject.registry.afterMessageAccepted({
      attachment: ATTACHMENT,
      event: acceptedEvent,
      signal: new AbortController().signal,
    })).rejects.toBe(failure);
    expect(subject.diagnostic).toHaveBeenCalledWith({
      code: 'plugin_composer_attachment_after_message_accepted_failed',
      severity: 'error',
      message: 'Composer attachment post-acceptance callback failed',
    });
  });

  it('fails closed before invoking an attachment callback for malformed input or a missing phase', async () => {
    const subject = fixture({ resolveForDispatch: undefined });
    const signal = new AbortController().signal;

    await expect(subject.registry.supports({
      attachment: ATTACHMENT,
      phase: 'resolveForDispatch',
    })).resolves.toBe(false);
    await expect(subject.registry.prepareForSend({
      attachment: ATTACHMENT,
      request: {
        ...prepareRequest,
        attachments: [{ ...prepareRequest.attachments[0]!, forged: true }],
      } as unknown as ComposerAttachmentPrepareRequestV1,
      signal,
    })).rejects.toMatchObject({ code: 'composer_attachment_request_invalid' });
    expect(subject.runtime.prepareForSend).not.toHaveBeenCalled();
    await expect(subject.registry.resolveForDispatch({
      attachment: ATTACHMENT,
      request: resolveRequest,
      signal,
    })).rejects.toMatchObject({ code: 'composer_attachment_callback_unavailable' });
  });

  it('activates a dormant attachment plugin on first callback demand and not again', async () => {
    const runtime: ComposerAttachmentRuntime = {
      resolveForDispatch: vi.fn(async (request: ComposerAttachmentResolveRequestV1) => ({
        attachments: request.attachments.map((attachment) => ({
          instanceId: attachment.instanceId,
          status: 'ready' as const,
          context: `Context for ${attachment.key}`,
        })),
      })),
    };
    // The generation-owned array activation publishes into: a dormant plugin
    // contributes no entry until its exact attachment is demanded.
    const targetRegistrations: Array<{
      pluginId: string;
      generation: string;
      registration: Readonly<{
        family: 'composerAttachments';
        localId: string;
        value: ComposerAttachmentRuntime;
      }>;
    }> = [];
    const activateAttachmentOnDemand = vi.fn(async () => {
      targetRegistrations.push({
        pluginId: ATTACHMENT.pluginId,
        generation: '7',
        registration: Object.freeze({
          family: 'composerAttachments' as const,
          localId: ATTACHMENT.localId,
          value: runtime,
        }),
      });
    });
    const registry = createTargetComposerAttachmentRegistry({
      targetRegistrations,
      declaredAttachments: [{
        attachment: ATTACHMENT,
        title: 'Issue context',
        cardinality: 'many',
        valueSchema: { type: 'object' },
        runtime: { resolveForDispatch: true },
      }],
      resolveGenerationLifecycle: () => ({
        isCurrent: () => true,
        retirementSignal: new AbortController().signal,
      }),
      createInvocationContext: () => ({
        context: invocationContext(),
        complete() {},
      }),
      activateAttachmentOnDemand,
    });

    expect(registry.requires({ attachment: ATTACHMENT, phase: 'resolveForDispatch' })).toBe(true);
    await expect(registry.supports({
      attachment: ATTACHMENT,
      phase: 'resolveForDispatch',
    })).resolves.toBe(true);
    expect(activateAttachmentOnDemand).toHaveBeenCalledTimes(1);
    expect(activateAttachmentOnDemand).toHaveBeenCalledWith(ATTACHMENT);

    await expect(registry.resolveForDispatch({
      attachment: ATTACHMENT,
      request: resolveRequest,
      signal: new AbortController().signal,
    })).resolves.toEqual({
      attachments: [
        { instanceId: 'attachment-1', status: 'ready', context: 'Context for issue' },
        { instanceId: 'attachment-2', status: 'ready', context: 'Context for issue' },
      ],
    });
    // An activated attachment is reached directly: every staged draft must not
    // re-enter the registry-wide demand refresh on the send path.
    expect(activateAttachmentOnDemand).toHaveBeenCalledTimes(1);
  });

  it('derives direct-versus-required lifecycle behavior from the static declaration, not callback presence', async () => {
    const registry = createTargetComposerAttachmentRegistry({
      activateAttachmentOnDemand: async () => {},
      targetRegistrations: [],
      declaredAttachments: [{
        attachment: ATTACHMENT,
        title: 'Issue context',
        cardinality: 'many',
        valueSchema: { type: 'object' },
        runtime: { prepareForSend: true },
      }],
      resolveGenerationLifecycle: () => ({
        isCurrent: () => true,
        retirementSignal: new AbortController().signal,
      }),
      createInvocationContext: () => ({
        context: invocationContext(),
        complete() {},
      }),
    });

    expect(registry.isDeclared(ATTACHMENT)).toBe(true);
    expect(registry.requires({ attachment: ATTACHMENT, phase: 'prepareForSend' })).toBe(true);
    expect(registry.requires({ attachment: ATTACHMENT, phase: 'resolveForDispatch' })).toBe(false);
    await expect(registry.supports({
      attachment: ATTACHMENT,
      phase: 'prepareForSend',
    })).resolves.toBe(false);
    expect(registry.isDeclared({ pluginId: ATTACHMENT.pluginId, localId: 'missing' })).toBe(false);
  });

  it('admits only declaration-valid values, enforces cardinality, and stamps its immutable fallback title', () => {
    const declaredAttachments = [{
      attachment: ATTACHMENT,
      title: { key: 'attachment.issue.title', fallback: 'Issue context' },
      cardinality: 'one',
      valueSchema: {
        type: 'object',
        properties: { issueId: { type: 'string' } },
        required: ['issueId'],
        additionalProperties: false,
      },
      preparedValueSchema: {
        type: 'object',
        properties: {
          issueId: { type: 'string' },
          prepared: { const: true },
        },
        required: ['issueId', 'prepared'],
        additionalProperties: false,
      },
    }] satisfies NonNullable<Parameters<typeof createTargetComposerAttachmentRegistry>[0]['declaredAttachments']>;
    const registry = createTargetComposerAttachmentRegistry({
      activateAttachmentOnDemand: async () => {},
      targetRegistrations: [],
      declaredAttachments,
      resolveGenerationLifecycle: () => ({
        isCurrent: () => true,
        retirementSignal: new AbortController().signal,
      }),
      createInvocationContext: () => ({
        context: invocationContext(),
        complete() {},
      }),
    });
    const draft = {
      v: 1,
      instanceId: 'issue-1',
      attachment: ATTACHMENT,
      key: 'issue-42',
      value: { issueId: '42' },
      presentation: { label: 'Issue #42', typeLabel: 'Forged label' },
    } as const satisfies ComposerAttachmentInputV1;

    expect(registry.admit({ phase: 'draft', attachments: [draft] })).toEqual([{
      ...draft,
      presentation: { label: 'Issue #42', typeLabel: 'Issue context' },
    }]);
    expect(() => registry.admit({
      phase: 'draft',
      attachments: [{ ...draft, value: { issueId: 42 } }],
    })).toThrow(expect.objectContaining({ code: 'composer_attachment_value_invalid' }));
    expect(() => registry.admit({
      phase: 'draft',
      attachments: [draft, { ...draft, instanceId: 'issue-2', key: 'issue-43' }],
    })).toThrow(expect.objectContaining({ code: 'composer_attachment_cardinality_invalid' }));
    expect(() => registry.admit({
      phase: 'prepared',
      attachments: [{ ...draft, value: { issueId: '42' } }],
    })).toThrow(expect.objectContaining({ code: 'composer_attachment_value_invalid' }));
    expect(registry.admit({
      phase: 'prepared',
      attachments: [{
        ...draft,
        value: { issueId: '42', prepared: true },
        presentation: { label: 'Issue #42 (prepared)', typeLabel: 'Still forged' },
      }],
    })).toEqual([{
      ...draft,
      value: { issueId: '42', prepared: true },
      presentation: { label: 'Issue #42 (prepared)', typeLabel: 'Issue context' },
    }]);
  });

  it('keeps a validated staged-media draft intact until the SessionMedia finalizer replaces it', () => {
    const registry = createTargetComposerAttachmentRegistry({
      activateAttachmentOnDemand: async () => {},
      targetRegistrations: [],
      declaredAttachments: [{
        attachment: ATTACHMENT,
        title: 'Issue context',
        cardinality: 'many',
        valueSchema: { type: 'object' },
      }],
      resolveGenerationLifecycle: () => ({
        isCurrent: () => true,
        retirementSignal: new AbortController().signal,
      }),
      createInvocationContext: () => ({
        context: invocationContext(),
        complete() {},
      }),
    });
    const stagedDraft = {
      v: 1,
      instanceId: 'image-1',
      attachment: ATTACHMENT,
      key: 'image-42',
      value: { issueId: '42' },
      presentation: { label: 'Image #42', typeLabel: 'Forged label' },
      content: {
        kind: 'stagedMedia',
        handle: {
          v: 1,
          id: 'stage-image-42',
          executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
          owner: ATTACHMENT,
          mediaKind: 'image',
          mimeType: 'image/png',
          name: 'image-42.png',
          sizeBytes: 42,
          sha256: 'a'.repeat(64),
        },
      },
    } as const satisfies ComposerAttachmentDraftV1;

    expect(registry.admit({
      phase: 'draft',
      attachments: [stagedDraft],
    })).toEqual([{
      ...stagedDraft,
      presentation: { label: 'Image #42', typeLabel: 'Issue context' },
    }]);
  });

  it('fences a retired direct declaration before schema admission without requiring a callback registration', () => {
    let current = true;
    const registry = createTargetComposerAttachmentRegistry({
      activateAttachmentOnDemand: async () => {},
      targetRegistrations: [],
      declaredAttachments: [{
        attachment: ATTACHMENT,
        title: 'Issue context',
        cardinality: 'many',
        valueSchema: { type: 'object' },
      }],
      resolveGenerationLifecycle: () => ({
        isCurrent: () => current,
        retirementSignal: new AbortController().signal,
      }),
      createInvocationContext: () => ({
        context: invocationContext(),
        complete() {},
      }),
    });
    const draft = {
      v: 1,
      instanceId: 'issue-stale-1',
      attachment: ATTACHMENT,
      key: 'issue-stale-42',
      value: { issueId: '42' },
      presentation: { label: 'Issue #42', typeLabel: 'Forged label' },
    } as const satisfies ComposerAttachmentInputV1;

    current = false;

    expect(() => registry.admit({ phase: 'draft', attachments: [draft] })).toThrow(
      expect.objectContaining({ code: 'plugin_generation_stale' }),
    );
  });

  it('rejects a schema-valid result that is not exactly correlated to the requested attachment instances', async () => {
    const subject = fixture({
      resolveForDispatch: vi.fn(async () => ({
        attachments: [{ instanceId: 'attachment-other', status: 'ready' as const }],
      })),
    });

    await expect(subject.registry.resolveForDispatch({
      attachment: ATTACHMENT,
      request: resolveRequest,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'composer_attachment_result_mismatch' });
  });

  it('cancels on retirement and fences a late attachment result', async () => {
    const pending = deferred<ComposerAttachmentPrepareResultV1>();
    let observedSignal: AbortSignal | undefined;
    const subject = fixture({
      prepareForSend: vi.fn(async (_request, context) => {
        observedSignal = context.signal;
        return await pending.promise;
      }),
    });
    const prepare = subject.registry.prepareForSend({
      attachment: ATTACHMENT,
      request: prepareRequest,
      signal: new AbortController().signal,
    });
    await vi.waitFor(() => expect(subject.runtime.prepareForSend).toHaveBeenCalledTimes(1));
    subject.retire();
    pending.resolve({
      attachments: prepareRequest.attachments.map((attachment) => ({
        instanceId: attachment.instanceId,
        status: 'ready' as const,
        value: attachment.value,
      })),
    });

    await expect(prepare).rejects.toMatchObject({ code: 'plugin_generation_stale' });
    expect(observedSignal?.aborted).toBe(true);
  });

  it('returns the typed abort result without invoking or leaking an unhandled rejection when already aborted', async () => {
    const subject = fixture();
    const cancellation = new AbortController();
    const onUnhandledRejection = vi.fn();
    cancellation.abort(new Error('caller cancelled before invocation'));
    process.on('unhandledRejection', onUnhandledRejection);

    try {
      await expect(subject.registry.prepareForSend({
        attachment: ATTACHMENT,
        request: prepareRequest,
        signal: cancellation.signal,
      })).rejects.toMatchObject({ code: 'composer_attachment_not_current' });
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(subject.runtime.prepareForSend).not.toHaveBeenCalled();
      expect(subject.createInvocationContext).not.toHaveBeenCalled();
      expect(onUnhandledRejection).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  });

  it('enforces the host callback deadline even when an attachment ignores cancellation', async () => {
    vi.useFakeTimers();
    try {
      let observedSignal: AbortSignal | undefined;
      const subject = fixture({
        prepareForSend: vi.fn(async (_request, context) => {
          observedSignal = context.signal;
          return await new Promise<ComposerAttachmentPrepareResultV1>(() => {});
        }),
      }, { callbackTimeoutMs: 25 });
      const prepare = subject.registry.prepareForSend({
        attachment: ATTACHMENT,
        request: prepareRequest,
        signal: new AbortController().signal,
      });
      // Reaching the attachment runtime is asynchronous: it may have to
      // activate a dormant plugin before the callback can be invoked.
      await vi.advanceTimersByTimeAsync(0);
      expect(subject.runtime.prepareForSend).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(25);

      await expect(prepare).rejects.toMatchObject({ code: 'composer_attachment_timed_out' });
      expect(observedSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
