import { describe, expect, it, vi } from 'vitest';

import {
  buildHappierReplayPromptFromDialog,
  HAPPIER_REPLAY_SEED_DISPATCH_RESERVED_CHARS,
} from '@happier-dev/agents';
import {
  MENTION_KIND_V1,
  buildComposerReferenceMentionPayloadV1,
  buildMentionRefForKindV1,
} from '@happier-dev/protocol';

import type { Metadata } from '@/api/types';
import { configuration, reloadConfiguration } from '@/configuration';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import type {
  PermissionModeQueuedPrompt,
  PermissionModeQueuedPromptMode,
} from '@/agent/runtime/permissions/queuedPrompt';
import { combinePermissionModeQueuedPrompts } from '@/agent/runtime/permissions/queuedPrompt';
import type { RuntimeTurnOperations } from '@/agent/runtime/turns/runtimeTurnOperations';
import type { StructuredInputComposerReferenceResolver } from '@/agent/runtime/turns/resolveStructuredInputProviderContext';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import {
  runPermissionModePromptLoop,
  type PermissionModePromptLoopTurnOperations,
} from './runPermissionModePromptLoop';

type PromptLoopMetadata = Metadata;

function createQueue() {
  return new MessageQueue2<PermissionModeQueuedPromptMode, PermissionModeQueuedPrompt>(
    (mode) => JSON.stringify(mode),
    { batcher: (messages) => combinePermissionModeQueuedPrompts(messages) },
  );
}

type RuntimeConfigUpdateMock = ReturnType<typeof vi.fn<RuntimeTurnOperations['updateSessionRuntimeConfig']>>;

function createRuntime(): PermissionModePromptLoopTurnOperations & Readonly<{
  sendTurnPrompt: ReturnType<typeof vi.fn>;
  updateSessionRuntimeConfig: RuntimeConfigUpdateMock;
}> {
  return {
    beginTurnLifecycle: vi.fn(),
    sendTurnPrompt: vi.fn(async () => {}),
    steerInFlightTurn: vi.fn(async () => {}),
    waitForTurnCompletion: vi.fn(async () => {}),
    subscribeRuntimeEvents: vi.fn(() => () => {}),
    respondToPermission: vi.fn(async () => {}),
    cancelTurn: vi.fn(async () => {}),
    readSessionIdentity: vi.fn(() => ({ sessionId: 'runtime-session' })),
    updateSessionRuntimeConfig: vi.fn<RuntimeTurnOperations['updateSessionRuntimeConfig']>(async () => {}),
    resetOrDisposeRuntime: vi.fn(async () => {}),
    shouldResumeAfterPermissionModeChange: vi.fn(() => true),
  } as unknown as PermissionModePromptLoopTurnOperations & Readonly<{
    sendTurnPrompt: ReturnType<typeof vi.fn>;
    updateSessionRuntimeConfig: RuntimeConfigUpdateMock;
  }>;
}

type StructuredInputRuntime = ReturnType<typeof createRuntime> & {
  listSkills?: () => Promise<unknown>;
  listVendorPlugins?: () => Promise<unknown>;
  resolveComposerReference?: StructuredInputComposerReferenceResolver['resolve'];
};

async function runOneSessionReferencePrompt(params: Readonly<{
  reference: string;
  label?: string;
}>): Promise<ReturnType<typeof createRuntime>> {
  const session = createMutableApiSessionClientFixture<PromptLoopMetadata>({
    overrides: {
      async enqueueAgentMessageCommitted() {
        return { persisted: true, delivered: false };
      },
    },
  });
  session.__setMetadata(createTestMetadata({
    permissionMode: 'default',
    permissionModeUpdatedAt: 0,
  }));
  const queue = createQueue();
  const runtime = createRuntime();
  queue.push({
    text: 'summarize @session:source',
    localId: 'local-session-reference',
    structuredInput: {
      v: 1,
      mentions: [{
        kind: MENTION_KIND_V1.session,
        ref: params.reference,
        token: '@session:source',
        start: 10,
        end: 25,
        ...(params.label ? { label: params.label } : {}),
      }],
    },
  }, { permissionMode: 'default' });

  let shouldExit = false;
  await runPermissionModePromptLoop({
    providerName: 'Test Provider',
    agentMessageType: 'qwen',
    explicitPermissionMode: undefined,
    session,
    messageQueue: queue,
    permissionHandler: {
      setPermissionMode: vi.fn(),
      reset: vi.fn(),
    },
    runtime,
    createOverrideSynchronizer: () => ({ syncFromMetadata: () => {}, flushPendingAfterStart: async () => {} }),
    messageBuffer: new MessageBuffer(),
    shouldExit: () => shouldExit,
    getAbortSignal: () => new AbortController().signal,
    keepAlive: () => {},
    setThinking: () => {},
    sendReady: () => {
      shouldExit = true;
    },
    currentPermissionModeUpdatedAt: 0,
    setCurrentPermissionMode: () => {},
    setCurrentPermissionModeUpdatedAt: () => {},
    formatPromptErrorMessage: (error) => `Error: ${String(error)}`,
  });
  return runtime;
}

async function runOneStructuredInputPrompt(params: Readonly<{
  text: string;
  structuredInput: PermissionModeQueuedPrompt['structuredInput'];
  inputContextBlock?: string;
  localId?: string;
  runtime?: StructuredInputRuntime;
  sessionMedia?: PermissionModeQueuedPrompt['sessionMedia'];
  resolveComposerAttachmentForDispatch?: Parameters<typeof runPermissionModePromptLoop>[0]['resolveComposerAttachmentForDispatch'];
}>) {
  const observeProviderInputSettlement = vi.fn(async () => false);
  const session = createMutableApiSessionClientFixture<PromptLoopMetadata>({
    overrides: {
      sessionId: 'session-structured-input',
      observeProviderInputSettlement,
      async enqueueAgentMessageCommitted() {
        return { persisted: true, delivered: false };
      },
    } as Partial<Parameters<typeof runPermissionModePromptLoop>[0]['session']>,
  });
  session.__setMetadata(createTestMetadata({
    permissionMode: 'default',
    permissionModeUpdatedAt: 0,
  }));
  const queue = createQueue();
  const runtime = params.runtime ?? (createRuntime() as StructuredInputRuntime);
  const localId = params.localId ?? 'local-structured-input';
  queue.push({
    text: params.text,
    localId,
    userMessageSeq: 42,
    userMessageSeqs: [42],
    structuredInput: params.structuredInput,
    ...(params.sessionMedia ? { sessionMedia: params.sessionMedia } : {}),
    ...(params.inputContextBlock ? { inputContextBlock: params.inputContextBlock } : {}),
  }, { permissionMode: 'default' });

  let shouldExit = false;
  await runPermissionModePromptLoop({
    providerName: 'Test Provider',
    agentMessageType: 'qwen',
    explicitPermissionMode: undefined,
    session,
    messageQueue: queue,
    permissionHandler: {
      setPermissionMode: vi.fn(),
      reset: vi.fn(),
    },
    runtime: runtime as unknown as Parameters<typeof runPermissionModePromptLoop>[0]['runtime'],
    createOverrideSynchronizer: () => ({ syncFromMetadata: () => {}, flushPendingAfterStart: async () => {} }),
    messageBuffer: new MessageBuffer(),
    shouldExit: () => shouldExit,
    getAbortSignal: () => new AbortController().signal,
    keepAlive: () => {},
    setThinking: () => {},
    sendReady: () => {
      shouldExit = true;
    },
    currentPermissionModeUpdatedAt: 0,
    setCurrentPermissionMode: () => {},
    setCurrentPermissionModeUpdatedAt: () => {},
    ...(params.resolveComposerAttachmentForDispatch
      ? { resolveComposerAttachmentForDispatch: params.resolveComposerAttachmentForDispatch }
      : {}),
    formatPromptErrorMessage: (error) => 'Error: ' + String(error),
  });

  return { observeProviderInputSettlement, runtime };
}

describe('runPermissionModePromptLoop Session reference dispatch', () => {
  it('projects a UI-shaped @session reference through the dispatch owner without reading a transcript', async () => {
    const runtime = await runOneSessionReferencePrompt({
      reference: buildMentionRefForKindV1(MENTION_KIND_V1.session, 'source-session'),
      label: 'Old UI title at insertion time',
    });

    expect(runtime.beginTurnLifecycle).toHaveBeenCalledOnce();
    expect(runtime.sendTurnPrompt).toHaveBeenCalledWith(
      expect.stringContaining('<happier_session_reference>'),
      {
        localId: 'local-session-reference',
        localIds: ['local-session-reference'],
        structuredInput: { v: 1 },
      },
    );
    const dispatchPrompt = runtime.sendTurnPrompt.mock.calls[0]?.[0] ?? '';
    expect(dispatchPrompt).toContain('source-session');
    expect(dispatchPrompt).toContain('Old UI title at insertion time');
    expect(dispatchPrompt).toContain('No transcript content is included');
    expect(dispatchPrompt).not.toContain('<happier_session_reference_context');
    expect(JSON.stringify(runtime.sendTurnPrompt.mock.calls[0]?.[1])).not.toContain('source-session');
  });

  it('states an unreadable Session wire and dispatches without guessing an identity', async () => {
    const runtime = await runOneSessionReferencePrompt({
      reference: buildMentionRefForKindV1(MENTION_KIND_V1.vendorPlugin, 'plugin://gmail@happier'),
    });

    expect(runtime.beginTurnLifecycle).toHaveBeenCalledOnce();
    const dispatchPrompt = runtime.sendTurnPrompt.mock.calls[0]?.[0] ?? '';
    expect(dispatchPrompt).toMatch(/could not be read/);
    expect(dispatchPrompt).not.toContain('gmail');
  });

  it('composes provenance, Session references, Composer references, attachments, then prose', async () => {
    const runtime = createRuntime() as StructuredInputRuntime;
    runtime.resolveComposerReference = vi.fn(async () => ({
      id: 'issue:42',
      label: 'Issue 42',
      context: 'COMPOSER_REFERENCE_MARKER',
    }));
    const resolveComposerAttachmentForDispatch = vi.fn(async () => ({
      attachments: [{
        instanceId: 'review-comment-1',
        status: 'ready' as const,
        context: 'ATTACHMENT_MARKER',
      }],
    }));

    const result = await runOneStructuredInputPrompt({
      text: 'PROSE_MARKER',
      inputContextBlock: 'PROVENANCE_MARKER',
      localId: 'local-mixed-context',
      runtime,
      resolveComposerAttachmentForDispatch,
      structuredInput: {
        v: 1,
        mentions: [
          {
            kind: MENTION_KIND_V1.session,
            ref: buildMentionRefForKindV1(MENTION_KIND_V1.session, 'source-session'),
            token: '@session:source',
            start: 0,
            end: 15,
          },
          {
            ...buildComposerReferenceMentionPayloadV1({
              reference: { pluginId: 'acme.issues', localId: 'issues' },
              candidate: { id: 'issue:42', label: 'Issue 42' },
            }),
            token: '@issue',
            start: 16,
            end: 22,
          },
        ],
        composerAttachments: [{
          v: 1,
          instanceId: 'review-comment-1',
          attachment: { pluginId: 'acme.review-comments', localId: 'review-comment' },
          key: 'comment-1',
          value: { reviewId: 'review-1' },
          presentation: { label: 'Review comment', typeLabel: 'Review comment' },
        }],
      },
    });

    const dispatchPrompt = result.runtime.sendTurnPrompt.mock.calls[0]?.[0] ?? '';
    const provenance = dispatchPrompt.indexOf('PROVENANCE_MARKER');
    const sessionReference = dispatchPrompt.indexOf('<happier_session_reference>');
    const composerReference = dispatchPrompt.indexOf('COMPOSER_REFERENCE_MARKER');
    const attachment = dispatchPrompt.indexOf('ATTACHMENT_MARKER');
    const prose = dispatchPrompt.indexOf('PROSE_MARKER');

    expect(provenance).toBeGreaterThanOrEqual(0);
    expect(sessionReference).toBeGreaterThan(provenance);
    expect(composerReference).toBeGreaterThan(sessionReference);
    expect(attachment).toBeGreaterThan(composerReference);
    expect(prose).toBeGreaterThan(attachment);
  });

  it('delivers resolved structured input with a provider-native command without altering its text', async () => {
    const runtime = {
      ...createRuntime(),
      isProviderNativeCommand: vi.fn((prompt: string) => prompt.startsWith('/goal')),
    } as StructuredInputRuntime;
    const resolveComposerAttachmentForDispatch = vi.fn(async () => ({
      attachments: [{
        instanceId: 'review-comment-1',
        status: 'ready' as const,
        context: 'ATTACHMENT_MARKER',
      }],
    }));

    const result = await runOneStructuredInputPrompt({
      text: '/goal fix authentication',
      localId: 'local-native-with-attachment',
      runtime,
      resolveComposerAttachmentForDispatch,
      structuredInput: {
        v: 1,
        composerAttachments: [{
          v: 1,
          instanceId: 'review-comment-1',
          attachment: { pluginId: 'acme.review-comments', localId: 'review-comment' },
          key: 'comment-1',
          value: { reviewId: 'review-1' },
          presentation: { label: 'Review comment', typeLabel: 'Review comment' },
        }],
      },
    });

    // The provider parses this text with its own command grammar, so the host
    // must not prepend a context block to it...
    expect(result.runtime.sendTurnPrompt.mock.calls[0]?.[0]).toBe('/goal fix authentication');
    // ...but the message was durably accepted with an attachment, so the
    // resolved envelope still has to reach the Agent input contract.
    const meta = result.runtime.sendTurnPrompt.mock.calls[0]?.[1];
    expect(meta?.structuredInput?.resolvedComposerAttachments).toEqual([
      expect.objectContaining({ instanceId: 'review-comment-1' }),
    ]);
    expect(resolveComposerAttachmentForDispatch).toHaveBeenCalledTimes(1);
  });

  it('rejects a provider-native command whose attachment cannot be resolved instead of dropping it', async () => {
    const runtime = {
      ...createRuntime(),
      isProviderNativeCommand: vi.fn((prompt: string) => prompt.startsWith('/goal')),
    } as StructuredInputRuntime;
    runtime.listSkills = vi.fn(async () => ({ skills: [] }));

    const result = await runOneStructuredInputPrompt({
      text: '/goal fix authentication',
      localId: 'local-native-unresolvable',
      runtime,
      structuredInput: {
        v: 1,
        mentions: [{
          kind: MENTION_KIND_V1.skill,
          ref: buildMentionRefForKindV1(MENTION_KIND_V1.skill, 'vendor:codex:missing'),
          token: '$missing',
          start: 6,
          end: 14,
        }],
      },
    });

    expect(result.runtime.sendTurnPrompt).not.toHaveBeenCalled();
    expect(result.observeProviderInputSettlement).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ kind: 'rejected_before_effect' }),
    );
  });

  it('settles an unresolved mention before provider dispatch as a terminal Pending rejection', async () => {
    const runtime = createRuntime() as StructuredInputRuntime;
    runtime.listSkills = vi.fn(async () => ({ skills: [] }));

    const result = await runOneStructuredInputPrompt({
      text: 'use missing skill',
      runtime,
      structuredInput: {
        v: 1,
        mentions: [{
          kind: MENTION_KIND_V1.skill,
          ref: buildMentionRefForKindV1(MENTION_KIND_V1.skill, 'vendor:codex:missing'),
          token: '$missing',
          start: 4,
          end: 12,
        }],
      },
    });

    expect(result.runtime.beginTurnLifecycle).not.toHaveBeenCalled();
    expect(result.runtime.sendTurnPrompt).not.toHaveBeenCalled();
    expect(result.observeProviderInputSettlement).toHaveBeenCalledExactlyOnceWith({
      kind: 'rejected_before_effect',
      localId: 'local-structured-input',
      userMessageSeq: 42,
      reason: 'provider_rejected_before_acceptance',
      diagnostic: expect.objectContaining({
        code: 'mention_reference_unresolved',
        severity: 'error',
      }),
      retryable: false,
    });
  });

  it('settles an oversized resolved context before provider dispatch as a terminal Pending rejection', async () => {
    const runtime = createRuntime() as StructuredInputRuntime;
    runtime.listSkills = vi.fn(async () => ({
      skills: [{
        name: 'review',
        displayName: 'Review',
        description: 'skill-context '.repeat(75),
        path: '/w/.codex/skills/review/SKILL.md',
        enabled: true,
        origin: 'codex_native',
      }],
    }));
    runtime.listVendorPlugins = vi.fn(async () => ({
      vendorPlugins: [{
        vendorPluginRef: 'plugin://linear@happier',
        name: 'linear',
        displayName: 'vendor-context '.repeat(75),
        installed: true,
        enabled: true,
      }],
    }));

    const result = await runOneStructuredInputPrompt({
      text: 'resolve oversized context',
      runtime,
      structuredInput: {
        v: 1,
        mentions: [
          {
            kind: MENTION_KIND_V1.session,
            ref: buildMentionRefForKindV1(MENTION_KIND_V1.session, 'source-session'),
            token: '@session:source',
            start: 0,
            end: 15,
          },
          {
            kind: MENTION_KIND_V1.skill,
            ref: buildMentionRefForKindV1(MENTION_KIND_V1.skill, 'vendor:codex:review'),
            token: '$review',
            start: 16,
            end: 23,
          },
          {
            kind: MENTION_KIND_V1.vendorPlugin,
            ref: buildMentionRefForKindV1(MENTION_KIND_V1.vendorPlugin, 'plugin://linear@happier'),
            token: '@linear',
            start: 24,
            end: 31,
          },
        ],
      },
    });

    expect(result.runtime.beginTurnLifecycle).not.toHaveBeenCalled();
    expect(result.runtime.sendTurnPrompt).not.toHaveBeenCalled();
    expect(result.observeProviderInputSettlement).toHaveBeenCalledExactlyOnceWith({
      kind: 'rejected_before_effect',
      localId: 'local-structured-input',
      userMessageSeq: 42,
      reason: 'provider_rejected_before_acceptance',
      diagnostic: expect.objectContaining({
        code: 'mention_resolved_context_too_large',
        severity: 'error',
      }),
      retryable: false,
    });
  });

  it('settles unavailable Composer-reference resolution before provider dispatch as a retryable Pending block', async () => {
    const result = await runOneStructuredInputPrompt({
      text: 'resolve current issue',
      structuredInput: {
        v: 1,
        mentions: [{
          ...buildComposerReferenceMentionPayloadV1({
            reference: { pluginId: 'acme.issues', localId: 'issues' },
            candidate: { id: 'issue:42', label: 'Issue 42' },
          }),
          token: '@issue',
          start: 0,
          end: 6,
        }],
      },
    });

    expect(result.runtime.beginTurnLifecycle).not.toHaveBeenCalled();
    expect(result.runtime.sendTurnPrompt).not.toHaveBeenCalled();
    expect(result.observeProviderInputSettlement).toHaveBeenCalledExactlyOnceWith({
      kind: 'rejected_before_effect',
      localId: 'local-structured-input',
      userMessageSeq: 42,
      reason: 'provider_unavailable_before_acceptance',
      diagnostic: expect.objectContaining({
        code: 'composer_reference_unavailable',
        severity: 'error',
      }),
      retryable: true,
    });
  });

  it('settles a generic pre-turn failure with its declared retryability before provider dispatch', async () => {
    const runtime = createRuntime() as StructuredInputRuntime;
    const failure = Object.assign(new Error('Runtime configuration is temporarily unavailable.'), {
      code: 'runtime_configuration_unavailable',
      retryable: true,
    });
    runtime.updateSessionRuntimeConfig.mockRejectedValueOnce(failure);

    const result = await runOneStructuredInputPrompt({
      text: 'dispatch after runtime configuration',
      runtime,
      structuredInput: { v: 1 },
    });

    expect(result.runtime.beginTurnLifecycle).not.toHaveBeenCalled();
    expect(result.runtime.sendTurnPrompt).not.toHaveBeenCalled();
    expect(result.observeProviderInputSettlement).toHaveBeenCalledExactlyOnceWith({
      kind: 'rejected_before_effect',
      localId: 'local-structured-input',
      userMessageSeq: 42,
      reason: 'provider_unavailable_before_acceptance',
      diagnostic: {
        code: 'runtime_configuration_unavailable',
        severity: 'error',
        message: 'Runtime configuration is temporarily unavailable.',
      },
      retryable: true,
    });
  });

  it('settles an ordinary generic pre-turn failure as a terminal Pending rejection', async () => {
    const runtime = createRuntime() as StructuredInputRuntime;
    runtime.updateSessionRuntimeConfig.mockRejectedValueOnce(
      new Error('Runtime configuration rejected the requested mode.'),
    );

    const result = await runOneStructuredInputPrompt({
      text: 'dispatch after rejected runtime configuration',
      runtime,
      structuredInput: { v: 1 },
    });

    expect(result.runtime.beginTurnLifecycle).not.toHaveBeenCalled();
    expect(result.runtime.sendTurnPrompt).not.toHaveBeenCalled();
    expect(result.observeProviderInputSettlement).toHaveBeenCalledExactlyOnceWith({
      kind: 'rejected_before_effect',
      localId: 'local-structured-input',
      userMessageSeq: 42,
      reason: 'provider_rejected_before_acceptance',
      diagnostic: {
        code: 'provider_pre_turn_failed',
        severity: 'error',
        message: 'Runtime configuration rejected the requested mode.',
      },
      retryable: false,
    });
  });

  /**
   * Section 9.2 of the cross-Agent continuation contract requires ONE true total
   * configured seed cap that includes the Session reference. The seed's cap is
   * enforced when the seed is built and sealed into Session metadata; the
   * reference block is composed in here, at dispatch. Without a refit the two
   * each spend the same budget and the prompt overruns the configured total by
   * up to the reference bound.
   */
  describe('replay seed and Session reference share one total budget', () => {
    async function runSeededPrompt(params: Readonly<{
      withSessionReference: boolean;
      sessionMentionCount?: number;
      sessionMentionLabel?: string;
      seedTextChars?: number;
      seedText?: string;
    }>) {
      const session = createMutableApiSessionClientFixture<PromptLoopMetadata>({
        overrides: {
          sessionId: 'session-seeded-budget',
          async enqueueAgentMessageCommitted() {
            return { persisted: true, delivered: false };
          },
        } as Partial<Parameters<typeof runPermissionModePromptLoop>[0]['session']>,
      });
      session.__setMetadata({
        ...createTestMetadata({ permissionMode: 'default', permissionModeUpdatedAt: 0 }),
        replaySeedV1: {
          v: 1,
          seedText: params.seedText ?? 'S'.repeat(params.seedTextChars ?? configuration.replaySeedMaxChars),
          sourceSessionId: 'source-session',
          sourceCutoffSeqInclusive: 7,
          createdAtMs: 1,
        },
      } as unknown as PromptLoopMetadata);
      const queue = createQueue();
      const runtime = createRuntime();
      queue.push({
        text: USER_TEXT,
        localId: 'local-seeded-budget',
        ...(params.withSessionReference
          ? {
              structuredInput: {
                v: 1 as const,
                mentions: Array.from(
                  { length: params.sessionMentionCount ?? 1 },
                  (_unused, index) => ({
                    kind: MENTION_KIND_V1.session,
                    ref: buildMentionRefForKindV1(
                      MENTION_KIND_V1.session,
                      index === 0 ? 'source-session' : `source-session-${index}`,
                    ),
                    token: '@session:source',
                    start: 0,
                    end: 15,
                    ...(params.sessionMentionLabel === undefined
                      ? {}
                      : { label: params.sessionMentionLabel }),
                  }),
                ),
              },
            }
          : {}),
      }, { permissionMode: 'default' });

      let shouldExit = false;
      await runPermissionModePromptLoop({
        providerName: 'Test Provider',
        agentMessageType: 'qwen',
        explicitPermissionMode: undefined,
        session,
        messageQueue: queue,
        permissionHandler: { setPermissionMode: vi.fn(), reset: vi.fn() },
        runtime,
        createOverrideSynchronizer: () => ({ syncFromMetadata: () => {}, flushPendingAfterStart: async () => {} }),
        messageBuffer: new MessageBuffer(),
        shouldExit: () => shouldExit,
        getAbortSignal: () => new AbortController().signal,
        keepAlive: () => {},
        setThinking: () => {},
        sendReady: () => {
          shouldExit = true;
        },
        currentPermissionModeUpdatedAt: 0,
        setCurrentPermissionMode: () => {},
        setCurrentPermissionModeUpdatedAt: () => {},
        formatPromptErrorMessage: (error) => 'Error: ' + String(error),
      });
      return {
        prompt: (runtime.sendTurnPrompt.mock.calls[0]?.[0] ?? '') as string,
        session,
      };
    }

    const USER_TEXT = 'continue please';

    it('keeps the seed at its full configured cap when no Session reference is composed', async () => {
      const { prompt } = await runSeededPrompt({ withSessionReference: false });

      // Control: without the block the seed spends the whole total, so the clip
      // below is caused by the reference block and not by some other bound.
      expect(prompt).not.toContain('<happier_session_reference>');
      expect(prompt.length - USER_TEXT.length - 2).toBe(configuration.replaySeedMaxChars);
    });

    it('fits an oversized persisted seed to the daemon budget without a Session reference', async () => {
      // A real sealed replay seed built under a larger producer cap. This is
      // the discriminating legacy/persisted case: a raw string could only show
      // that the fitter drops malformed input, not that it preserves a valid
      // seed while applying the one dispatch authority.
      const oversizedSeed = buildHappierReplayPromptFromDialog({
        previousSessionId: 'source-session',
        strategy: 'recent_messages',
        recentMessagesCount: 500,
        dialog: Array.from({ length: 180 }, (_unused, index) => ({
          role: index % 2 === 0 ? ('User' as const) : ('Assistant' as const),
          createdAt: index,
          text: 'T'.repeat(2_000),
        })),
        maxPromptChars: Math.min(200_000, configuration.replaySeedMaxChars + 50_000),
      }).trim();
      expect(oversizedSeed.length).toBeGreaterThan(configuration.replaySeedMaxChars);

      const { prompt } = await runSeededPrompt({
        withSessionReference: false,
        seedText: oversizedSeed,
      });

      expect(prompt).not.toContain('<happier_session_reference>');
      expect(prompt.length - USER_TEXT.length - 2).toBeLessThanOrEqual(configuration.replaySeedMaxChars);
      expect(prompt).toContain('omitted to fit the context budget');
    });

    // Retiring the seed destroys it — the consume updater writes `seedText: ''`.
    // So the one thing that must never happen is retiring a seed that was not
    // delivered at all. When the reference block's reservation leaves no room,
    // the fit returns nothing and the provider receives only the user's text;
    // settling there would erase the whole replay context for a prompt that
    // never carried a byte of it.
    it('does not retire the replay seed when the fit leaves no room to deliver any of it', async () => {
      // The smallest supported cap, so a handful of Session references is enough
      // to reserve the whole budget. Larger caps reach the same state; this one
      // reaches it without building a 120k-character reference block.
      const previousMaxSeedChars = process.env.HAPPIER_REPLAY_MAX_SEED_CHARS;
      process.env.HAPPIER_REPLAY_MAX_SEED_CHARS = '500';
      reloadConfiguration();
      let run: Awaited<ReturnType<typeof runSeededPrompt>>;
      try {
        run = await runSeededPrompt({
          withSessionReference: true,
          sessionMentionCount: 6,
        });
      } finally {
        if (previousMaxSeedChars === undefined) {
          delete process.env.HAPPIER_REPLAY_MAX_SEED_CHARS;
        } else {
          process.env.HAPPIER_REPLAY_MAX_SEED_CHARS = previousMaxSeedChars;
        }
        reloadConfiguration();
      }
      const { prompt, session } = run;

      // Control: this really is the no-room case, not an ordinary clip — the
      // reference block is there and not one character of the seed is.
      expect(prompt).toContain('<happier_session_reference>');
      expect(prompt).toContain(USER_TEXT);
      expect(prompt).not.toContain('SSSSSSSSSS');

      const seed = (session.__getMetadata() as { replaySeedV1?: { seedText?: string } } | null)?.replaySeedV1;
      expect(seed?.seedText?.length ?? 0).toBeGreaterThan(0);
    });

    /**
     * The refit is DESIGNED to be a no-op: the seed builder already subtracted
     * `HAPPIER_REPLAY_SEED_DISPATCH_RESERVED_CHARS` — the reference block's own
     * bound — from the same total before sealing the seed. It only bit because
     * the two sides counted different units: the block was bounded in code
     * points while the reservation, like every measurement in the replay budget,
     * is UTF-16 code units. One astral character costs two of the latter and one
     * of the former, so an emoji-titled Session could make the block cost more
     * than was reserved for it and the refit would delete transcript the seed
     * was entitled to keep.
     */
    it('does not refit a seed built against the canonical reservation when Session labels carry astral characters', async () => {
      // The largest seed a canonically-built draft can be: the whole total minus
      // the reservation this dispatch is expected to spend on the block.
      const seedTextChars = configuration.replaySeedMaxChars - HAPPIER_REPLAY_SEED_DISPATCH_RESERVED_CHARS;
      const { prompt } = await runSeededPrompt({
        withSessionReference: true,
        sessionMentionCount: 64,
        // 128 code points / 256 UTF-16 code units — the largest label the mention
        // schema admits, all astral.
        sessionMentionLabel: '\u{1F680}'.repeat(128),
        seedTextChars,
      });

      // Control: the astral block really was composed into this prompt.
      expect(prompt).toContain('<happier_session_reference>');
      expect(prompt).toContain('\u{1F680}');
      // The seed arrives WHOLE. This fixture's seed is not sealed transcript, so
      // a refit that fires cannot fit it by grammar and drops it entirely —
      // which is exactly the silent loss the reservation exists to prevent.
      expect(prompt).toContain('S'.repeat(seedTextChars));
      expect(prompt.length - USER_TEXT.length - 4).toBeLessThanOrEqual(configuration.replaySeedMaxChars);
    });

    it('clips the seed so the seed plus the Session reference stay inside one configured total', async () => {
      const { prompt } = await runSeededPrompt({ withSessionReference: true });

      expect(prompt).toContain('<happier_session_reference>');
      expect(prompt).toContain('source-session');
      // prompt = referenceBlock + "\n\n" + seed + "\n\n" + userText
      expect(prompt.length - USER_TEXT.length - 4).toBeLessThanOrEqual(configuration.replaySeedMaxChars);
      // The reference block is never the part that gives way.
      expect(prompt).toContain('No transcript content is included');
    });
  });
});
