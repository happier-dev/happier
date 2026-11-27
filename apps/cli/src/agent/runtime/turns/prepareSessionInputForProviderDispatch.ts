import { normalizeStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { isPluginError } from '@happier-dev/plugin-sdk';
import { RunnerDaemonPluginServicesPreparationCauseV1Schema, type RunnerDaemonPluginServicesPreparationCauseV1 } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';
import { projectActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { renderSessionInputContextPromptV1 } from '@happier-dev/protocol/sessions/messages/sessionInputPromptContextV1';
import { projectSessionInputReferencesV1 } from '@happier-dev/protocol/sessions/messages/sessionInputReferenceProjectionV1';
import { formatFileReviewNoteV1 } from '@happier-dev/protocol/messages/structured/fileReviewNoteV1';
import type { ComposerAttachmentValueV1, ComposerAttachmentResolveRequestV1, ComposerAttachmentResolveResultV1, PluginContributionIdentityV1, ProviderBoundModelRef } from '@happier-dev/protocol';
import { randomUUID } from 'node:crypto';
import { UsagePromptCompositionSchema, type UsagePromptComposition, type UsagePromptCompositionComponent } from '@happier-dev/protocol/usage/coach/usagePromptComposition';
import { createPromptCompositionScope, type PromptCompositionScope } from '@/agent/prompting/promptComposition';
import { logger } from '@/ui/logger';
import { projectNativeAgentSessionHostServiceError } from '@/agent/runtime/registry/engineRegistry/nativeAgentSessionBoundaryError';
import { renderRunFollowNotice } from '@/agent/runtime/session/follow/sessionFollowNotice';
import { normalizePermissionModeQueuedPromptLocalIds, type PermissionModeQueuedPrompt } from '@/agent/runtime/permissions/queuedPrompt';
import { SessionInputDispatchAdmissionError } from '@/api/session/sessionInputDispatchAdmissionError';
import type { SessionClientInteractionApi } from '@/api/session/client/transport/sessionClientInteractionApi';
import { isAbortLikeError } from '@/agent/runtime/lifecycle/classifyAbortLikeError';
import { DiscussionAttachmentPreparationError, type DiscussionAttachmentDispatchInput,
  type DiscussionAttachmentDispatchResult } from '@/discussions/materializeDiscussionInputAttachments';
import {
  resolveStructuredInputProviderDispatchContext,
  StructuredInputComposerReferenceUnavailableError,
  StructuredInputSessionMediaProjectionError,
  StructuredInputMentionResolutionError,
  StructuredInputComposerAttachmentResolutionError,
  StructuredInputComposerAttachmentUnavailableError,
  type StructuredInputCatalogReaders,
  type StructuredInputComposerAttachmentResolver,
  type StructuredInputComposerReferenceResolver,
  type StructuredInputProviderDispatchContext,
} from './resolveStructuredInputProviderContext';

export type ComposerAttachmentDispatchResolver = (input: Readonly<{
  sessionId: string;
  attachment: PluginContributionIdentityV1;
  request: ComposerAttachmentResolveRequestV1<ComposerAttachmentValueV1>;
  signal: AbortSignal;
}>) => Promise<ComposerAttachmentResolveResultV1>;

export function projectSessionComposerAttachmentDispatchInput(
  input: Parameters<StructuredInputComposerAttachmentResolver['resolve']>[0],
  sessionId: string,
): Parameters<ComposerAttachmentDispatchResolver>[0] {
  const request = 'scope' in input.request
    ? (() => {
        if (input.request.scope.kind !== 'session' || input.request.scope.sessionId !== sessionId) {
          throw new StructuredInputComposerAttachmentUnavailableError();
        }
        return Object.freeze({
          sessionId,
          localId: input.request.localId,
          attachments: input.request.attachments,
        });
      })()
    : input.request;
  return Object.freeze({
    sessionId,
    attachment: input.attachment,
    request,
    signal: input.signal,
  });
}

export type SessionInputDispatchServices = Readonly<{
  sessionId?: string;
  uploadWorkspace?: string;
  reconcileSessionInputForProviderDispatch?: SessionClientInteractionApi['reconcileSessionInputForProviderDispatch'];
  materializeDiscussionAttachmentsForDispatch?: (input: DiscussionAttachmentDispatchInput) => Promise<DiscussionAttachmentDispatchResult>;
  catalogs?: StructuredInputCatalogReaders;
  resolveComposerReference?: StructuredInputComposerReferenceResolver['resolve'];
  resolveComposerAttachmentForDispatch?: ComposerAttachmentDispatchResolver;
  /** Only exact host-plan fragments actually injected into this dispatch. */
  injectedPromptComponents?: readonly UsagePromptCompositionComponent[];
  retainPromptComposition?: (composition: UsagePromptComposition) => Promise<void>;
  /** Ephemeral identity of the complete dispatched host request, never a quality measurement. */
  modelRequest?: Readonly<{ scope: PromptCompositionScope; startupInstructions: string; toolSelection?: unknown;
    selection?: ProviderBoundModelRef; readSelection?: () => ProviderBoundModelRef }>;
}>;

function readComposerPreparationCause(error: unknown): RunnerDaemonPluginServicesPreparationCauseV1 | undefined {
  const details = isPluginError(error) ? error.details : undefined;
  const retained = RunnerDaemonPluginServicesPreparationCauseV1Schema.safeParse(
    details && typeof details === 'object' && 'cause' in details ? details.cause
      : error instanceof Error ? Object.getOwnPropertyDescriptor(error, 'preparationCause')?.value : undefined,
  );
  if (retained.success) return retained.data;
  const projected = RunnerDaemonPluginServicesPreparationCauseV1Schema.safeParse({
    code: projectActionFailureCauseV1(error).errorCode, stage: 'dispatch',
  });
  return projected.success ? projected.data : undefined;
}

/** Resolve one message's current reference context once for budgeting and final dispatch. */
export async function resolveSessionInputForProviderDispatch(input: Readonly<{
  prompt: PermissionModeQueuedPrompt;
  signal: AbortSignal;
  localId: string | null;
  services?: SessionInputDispatchServices;
}>): Promise<StructuredInputProviderDispatchContext> {
  const services = input.services;
  const sessionId = services?.sessionId;
  const attachmentResolver = services?.resolveComposerAttachmentForDispatch;
  let structuredInput = input.prompt.structuredInput;
  let attachments = input.prompt.attachments;
  if (input.prompt.discussionAddressing) {
    const materialize = services?.materializeDiscussionAttachmentsForDispatch;
    if (!materialize || !input.localId || sessionId !== input.prompt.discussionAddressing.participantSessionId) {
      throw new DiscussionAttachmentPreparationError();
    }
    try {
      const materialized = await materialize({ addressing: input.prompt.discussionAddressing,
        localId: input.localId, signal: input.signal });
      if (materialized) {
        attachments = [...attachments ?? [], ...materialized.attachments];
        const images = materialized.structuredInput?.imageInputs;
        if (images?.length) structuredInput = { ...structuredInput, v: 1,
          imageInputs: [...structuredInput?.imageInputs ?? [], ...images] };
      }
    } catch (error) {
      if (isAbortLikeError(error) || error instanceof DiscussionAttachmentPreparationError) throw error;
      throw new DiscussionAttachmentPreparationError();
    }
  }
  return await resolveStructuredInputProviderDispatchContext({
    structuredInput,
    attachments,
    uploadWorkspace: services?.uploadWorkspace,
    sessionMedia: input.prompt.sessionMedia,
    catalogs: services?.catalogs,
    signal: input.signal,
    ...(services?.resolveComposerReference ? { composerReferences: {
      resolve: async request => {
        try {
          return await services.resolveComposerReference!(request);
        } catch (cause) {
          const error = projectNativeAgentSessionHostServiceError(cause);
          if (isAbortLikeError(error) || error instanceof StructuredInputComposerReferenceUnavailableError) throw error;
          throw new StructuredInputComposerReferenceUnavailableError(
            isPluginError(error) ? error.retryable : true, readComposerPreparationCause(error),
          );
        }
      },
      signal: input.signal,
    } } : {}),
    ...(attachmentResolver && sessionId && input.localId ? { composerAttachments: {
      scope: { kind: 'session' as const, sessionId },
      localId: input.localId,
      signal: input.signal,
      resolve: async (request: Parameters<StructuredInputComposerAttachmentResolver['resolve']>[0]) => {
        try {
          return await attachmentResolver(projectSessionComposerAttachmentDispatchInput(request, sessionId));
        } catch (cause) {
          const error = projectNativeAgentSessionHostServiceError(cause);
          if (isAbortLikeError(error) || error instanceof StructuredInputComposerAttachmentResolutionError) throw error;
          const pluginError = isPluginError(error);
          throw new StructuredInputComposerAttachmentResolutionError(
            'composer_attachment_resolution_failed',
            pluginError ? error.retryable : true,
            'Composer attachment resolver failed before provider dispatch',
            readComposerPreparationCause(error),
          );
        }
      },
    } } : {}),
  });
}

export type SessionInputProviderPromptInput = Readonly<{
  prompt: PermissionModeQueuedPrompt;
  transformedUserText: string;
  providerNativeCommand: boolean;
  resolvedContext: StructuredInputProviderDispatchContext;
}>;

/** The actual required frame, shared by replay fitting and final provider dispatch. */
export function renderSessionInputProviderPrompt(input: SessionInputProviderPromptInput,
  optionalContext: Pick<Parameters<typeof renderSessionInputContextPromptV1>[0], 'sessionFollowUpdates' | 'workerUpdates'> & {
    runFollowDeliveries?: PermissionModeQueuedPrompt['followDeliveries'];
  } = {}): string {
  const context = input.resolvedContext;
  const rendered = renderSessionInputContextPromptV1({
    ...(input.prompt.inputContextBlock ? { provenanceBlock: input.prompt.inputContextBlock } : {}),
    inputProvenance: input.prompt.inputProvenance,
    returnedAnswer: input.prompt.returnedAnswer,
    ...context.promptContext,
    ...optionalContext,
    returnedAnswers: [...input.prompt.returnedAnswerContext ?? [],
      ...(input.prompt.returnedAnswer ? [{ reply: input.prompt.returnedAnswer,
        text: projectSessionInputReferencesV1({ text: input.transformedUserText, references: context.promptContext.references }).text }] : [])],
    transformedUserText: input.prompt.returnedAnswer ? '' : input.transformedUserText,
    ...(input.providerNativeCommand ? { userTextPlacement: 'beforeContext' as const }
      : input.prompt.discussionAddressing ? { userTextPlacement: 'alreadyRendered' as const } : {}),
  });
  const runFollowNotices = (optionalContext.runFollowDeliveries ?? []).map(({ delivery }) => renderRunFollowNotice(delivery)).filter(Boolean);
  // Keep primary slash/native command grammar untouched in queue custody.
  // Informational review facts join only the final actual provider input.
  const reviewNoteText = input.providerNativeCommand ? ''
    : (input.prompt.fileReviewNoteContext ?? []).map(({ note }) =>
      `<happier_review_note>${JSON.stringify({ text: formatFileReviewNoteV1(note, 'agent') })
        .replaceAll('<', '\\u003c').replaceAll('>', '\\u003e')}</happier_review_note>`).join('\n\n');
  return [[rendered, reviewNoteText].filter(Boolean).join('\n\n'), ...runFollowNotices].filter(Boolean).join('\n');
}

/** The shared final host preparation boundary for normal input and in-flight steer. */
export async function prepareSessionInputForProviderDispatch(input: Readonly<{
  prompt: PermissionModeQueuedPrompt;
  transformedUserText: string;
  providerNativeCommand: boolean;
  signal: AbortSignal;
  localId: string | null;
  services?: SessionInputDispatchServices;
  /** A context resolved by this same owner before replay-seed fitting. */
  resolvedContext?: StructuredInputProviderDispatchContext;
}>) {
  const services = input.services;
  const sessionId = services?.sessionId;
  const compositionScope = createPromptCompositionScope();
  let finalPrompt = '';
  const context = input.resolvedContext ?? await resolveSessionInputForProviderDispatch(input);
  const renderBasePrompt = (optionalContext: Parameters<typeof renderSessionInputProviderPrompt>[1] = {}) =>
    renderSessionInputProviderPrompt({ ...input, resolvedContext: context }, optionalContext);
  const requiredPrompt = renderBasePrompt();
  finalPrompt = requiredPrompt;
  const renderPrompt = (optionalContext: Parameters<typeof renderSessionInputProviderPrompt>[1] = {},
    prepareLiveWork?: (readUsedOptionalUtf8Bytes: () => number) => string | undefined) => {
    const rendered = renderBasePrompt(optionalContext);
    const liveWork = prepareLiveWork?.(() => Buffer.byteLength(rendered, 'utf8') - Buffer.byteLength(requiredPrompt, 'utf8'));
    finalPrompt = liveWork ? `${rendered}\n\n${liveWork}` : rendered;
    return finalPrompt;
  };
  const readComposition = (observation: Readonly<{
    deliveryKind: UsagePromptComposition['deliveryKind']; observedAtMs: number; turnId: string | null;
  }>): UsagePromptComposition | null => {
    if (!sessionId) return null;
    const injected = services?.injectedPromptComponents ?? [];
    const request = services?.modelRequest;
    const selection = request?.readSelection?.() ?? request?.selection;
    const requestIdentity = request && selection ? request.scope.identifyRequest(JSON.stringify([
      finalPrompt, context.structuredInput ? normalizeStrictJsonValue(context.structuredInput) : null,
      request.startupInstructions, request.toolSelection ?? null,
    ]), selection) : undefined;
    return UsagePromptCompositionSchema.parse({ v: 1, evidenceId: randomUUID(), sessionId,
      inputId: input.localId, ...observation, boundary: 'host_pre_dispatch', coverage: 'host_only',
      components: [compositionScope.measure('dispatch-payload', finalPrompt, 'other', 'user',
        injected.length ? 'known' : 'none'), ...injected],
      nativePrefix: null, contextWindowTokens: null, ...(requestIdentity ? { requestIdentity } : {}) });
  };
  const retainComposition = async (observation: Parameters<typeof readComposition>[0]): Promise<void> => {
    if (!services?.retainPromptComposition) return;
    try {
      const composition = readComposition(observation);
      if (composition) await services.retainPromptComposition(composition);
    }
    catch { logger.debug('[Usage composition] Session detail retention unavailable'); }
  };
  return {
    async assertAdmission(): Promise<boolean> {
      // Context-only input has its own host admission boundary. Every durable
      // protected input must re-enter Pending after arbitrary-duration prompt
      // preparation: materialization into the local queue is custody, not a
      // grant to dispatch an input that has since been discarded.
      if (input.prompt.hostContextOnly || (!input.prompt.discussionAddressing && !input.prompt.causalPermissionAuthority)) return true;
      const reconcile = services?.reconcileSessionInputForProviderDispatch;
      const localIds = normalizePermissionModeQueuedPromptLocalIds(input.prompt);
      if (!reconcile || localIds.length === 0) throw new SessionInputDispatchAdmissionError('outcomeUnknown');
      for (const localId of localIds) {
        let status: Awaited<ReturnType<typeof reconcile>>;
        try {
          status = await reconcile({ localId, ...(input.prompt.discussionAddressing
            ? { discussionAddressing: input.prompt.discussionAddressing } : {}), signal: input.signal });
        } catch (error) {
          if (error instanceof SessionInputDispatchAdmissionError || isAbortLikeError(error)) throw error;
          throw new SessionInputDispatchAdmissionError('outcomeUnknown', { cause: error });
        }
        if (status === 'withdrawn') return false;
        if (status !== 'admitted') throw new SessionInputDispatchAdmissionError(status);
      }
      return true;
    },
    readComposition,
    retainComposition,
    renderPrompt,
    requiredPrompt,
    requiredProviderContextForBudget: context.structuredInput
      ? `${requiredPrompt}\n${JSON.stringify(context.structuredInput)}`
      : requiredPrompt,
    structuredInput: context.structuredInput ? normalizeStrictJsonValue(context.structuredInput) : undefined,
  };
}

export function readStructuredInputPreparationFailure(error: unknown): Readonly<{ code: string; message: string; retryable: boolean; preparationCause?: RunnerDaemonPluginServicesPreparationCauseV1 }> | null {
  if (error instanceof DiscussionAttachmentPreparationError) return { code: error.code, message: error.message, retryable: error.retryable };
  if (error instanceof SessionInputDispatchAdmissionError) return { code: error.code, message: error.message, retryable: error.retryable };
  if (error instanceof StructuredInputComposerAttachmentResolutionError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      ...(error.preparationCause ? { preparationCause: error.preparationCause } : {}),
    };
  }
  if (error instanceof StructuredInputComposerReferenceUnavailableError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      ...(error.preparationCause ? { preparationCause: error.preparationCause } : {}),
    };
  }
  if (error instanceof StructuredInputSessionMediaProjectionError) {
    return {
      code: error.code,
      message: error.message,
      retryable: false,
    };
  }
  if (error instanceof StructuredInputMentionResolutionError) {
    return {
      code: error.code,
      message: error.message,
      retryable: false,
    };
  }
  return null;
}
