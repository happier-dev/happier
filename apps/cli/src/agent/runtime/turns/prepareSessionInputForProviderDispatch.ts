import { normalizeStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { renderSessionInputContextPromptV1 } from '@happier-dev/protocol/sessions/messages/sessionInputPromptContextV1';
import type { ComposerAttachmentValueV1, ComposerAttachmentResolveRequestV1, ComposerAttachmentResolveResultV1, PluginContributionIdentityV1, ProviderBoundModelRef } from '@happier-dev/protocol';
import { randomUUID } from 'node:crypto';
import { UsagePromptCompositionSchema, type UsagePromptComposition, type UsagePromptCompositionComponent } from '@happier-dev/protocol/usage/coach/usagePromptComposition';
import { createPromptCompositionScope, type PromptCompositionScope } from '@/agent/prompting/promptComposition';
import { logger } from '@/ui/logger';
import type { PermissionModeQueuedPrompt } from '@/agent/runtime/permissions/queuedPrompt';
import { isAbortLikeError } from '@/agent/runtime/lifecycle/classifyAbortLikeError';
import {
  resolveStructuredInputProviderDispatchContext,
  ResolvedMentionContextTooLargeError,
  StructuredInputComposerReferenceUnavailableError,
  StructuredInputSessionMediaProjectionError,
  StructuredInputMentionResolutionError,
  StructuredInputComposerAttachmentResolutionError,
  StructuredInputComposerAttachmentUnavailableError,
  type StructuredInputCatalogReaders,
  type StructuredInputComposerAttachmentResolver,
  type StructuredInputComposerReferenceResolver,
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

/** The shared final host preparation boundary for normal input and in-flight steer. */
export async function prepareSessionInputForProviderDispatch(input: Readonly<{
  prompt: PermissionModeQueuedPrompt;
  transformedUserText: string;
  providerNativeCommand: boolean;
  signal: AbortSignal;
  localId: string | null;
  services?: SessionInputDispatchServices;
}>) {
  const services = input.services;
  const compositionScope = createPromptCompositionScope();
  let finalPrompt = '';
  const sessionId = services?.sessionId;
  const attachmentResolver = services?.resolveComposerAttachmentForDispatch;
  const context = await resolveStructuredInputProviderDispatchContext({
    structuredInput: input.prompt.structuredInput,
    sessionMedia: input.prompt.sessionMedia,
    catalogs: services?.catalogs,
    ...(services?.resolveComposerReference ? { composerReferences: {
      resolve: services.resolveComposerReference,
      signal: input.signal,
    } } : {}),
    ...(attachmentResolver && sessionId && input.localId ? { composerAttachments: {
      scope: { kind: 'session' as const, sessionId },
      localId: input.localId,
      signal: input.signal,
      resolve: async (request: Parameters<StructuredInputComposerAttachmentResolver['resolve']>[0]) => {
        try {
          return await attachmentResolver(projectSessionComposerAttachmentDispatchInput(request, sessionId));
        } catch (error) {
          if (isAbortLikeError(error) || error instanceof StructuredInputComposerAttachmentResolutionError) throw error;
          throw new StructuredInputComposerAttachmentUnavailableError();
        }
      },
    } } : {}),
  });
  const renderPrompt = (optionalContext: Pick<Parameters<typeof renderSessionInputContextPromptV1>[0], 'sessionFollowUpdates' | 'workerUpdates'> = {}) => {
    const rendered = renderSessionInputContextPromptV1({
      provenanceBlock: input.prompt.inputContextBlock ?? '',
      ...context.promptContext,
      ...optionalContext,
      transformedUserText: input.providerNativeCommand ? '' : input.transformedUserText,
    });
    finalPrompt = input.providerNativeCommand
      ? [input.transformedUserText, rendered].filter(Boolean).join('\n\n')
      : rendered;
    return finalPrompt;
  };
  const requiredPrompt = renderPrompt();
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

export function readStructuredInputPreparationFailure(error: unknown): Readonly<{ code: string; message: string; retryable: boolean }> | null {
  if (error instanceof StructuredInputComposerAttachmentResolutionError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    };
  }
  if (error instanceof StructuredInputComposerReferenceUnavailableError) {
    return {
      code: error.code,
      message: error.message,
      retryable: true,
    };
  }
  if (error instanceof StructuredInputSessionMediaProjectionError) {
    return {
      code: error.code,
      message: error.message,
      retryable: false,
    };
  }
  if (
    error instanceof StructuredInputMentionResolutionError
    || error instanceof ResolvedMentionContextTooLargeError
  ) {
    return {
      code: error.code,
      message: error.message,
      retryable: false,
    };
  }
  return null;
}
