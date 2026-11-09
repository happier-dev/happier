import type { ActionExecutorContext, ActionExecutorDeps } from './types.js';
import { readActionFailureEnvelope } from './actionFailureEnvelope.js';
import { DiscussionReadResultV1Schema, type DiscussionOpenedMessageV1 } from '../../discussions/actions.js';
import { areServerProfileIdentifiersEquivalent } from '../../features/payload/capabilities/serverIdentityCapabilities.js';
import { captureWorkflowDiscussionV1, WorkflowDefinitionCaptureRequestV1Schema, WorkflowDefinitionCaptureResultV1Schema } from '../../workflows/workflowDiscussionCaptureV1.js';
import { WorkflowRunGetResultV1Schema } from '../../workflows/actionsV1.js';
import { validateWorkflowDefinition } from '../../workflows/workflowValidationV1.js';
import { readDiscussionAttachmentPayloadsV1 } from '../../discussions/content.js';

/** Definition capture composes the existing authorized Discussion and Workflow read owners. */
export async function captureWorkflowDefinitionV1(input: unknown, context: ActionExecutorContext,
  deps: Pick<ActionExecutorDeps, 'discussionAction' | 'workflowAction' | 'resolveServerProfileScopeId'>): Promise<unknown> {
  const request = WorkflowDefinitionCaptureRequestV1Schema.parse(input);
  const unavailable = () => ({ ok: false, errorCode: 'content_unavailable', error: 'capture_source_unavailable' } as const);
  if (!deps.discussionAction || !deps.workflowAction) return unavailable();
  const sameHome = (left: string, right: string) => areServerProfileIdentifiersEquivalent(left, right,
    id => id === context.serverId && context.serverIdentityId ? context.serverIdentityId : deps.resolveServerProfileScopeId?.(id));
  if (!context.serverId || !sameHome(context.serverId, request.discussion.serverId)) return unavailable();
  const messages = new Map<string, DiscussionOpenedMessageV1>();
  let throughSeq: number | undefined;
  // Exact reads share the first observed frontier; unrelated history is never opened.
  for (const messageId of request.messageIds) {
    context.signal?.throwIfAborted();
    const raw = await deps.discussionAction({ actionId: 'discussion.read', context,
      input: { discussionId: request.discussion.discussionId, messageId,
        ...(throughSeq === undefined ? {} : { throughSeq }) }, ...(context.signal ? { signal: context.signal } : {}) });
    const failure = readActionFailureEnvelope(raw);
    if (failure) return failure;
    const page = DiscussionReadResultV1Schema.safeParse(raw);
    if (!page.success || !sameHome(page.data.serverId, request.discussion.serverId)
      || page.data.discussionId !== request.discussion.discussionId) return unavailable();
    throughSeq ??= page.data.messageSeq;
    const message = page.data.messages[0];
    if (page.data.messages.length !== 1 || page.data.hasMoreOlder || !message || message.id !== messageId
      || !sameHome(message.messageRef.discussion.serverId, request.discussion.serverId)
      || message.discussionId !== request.discussion.discussionId || message.seq > throughSeq
      || !message.content) return unavailable();
    messages.set(message.id, message);
  }
  const selected = [...messages.values()].sort((a, b) => a.seq - b.seq);
  const runIds = new Set(selected.flatMap(message => message.producerV1?.kind === 'workflow' ? [message.producerV1.runId]
    : message.producerV1?.kind === 'agent' && message.producerV1.replyReturn?.workflow ? [message.producerV1.replyReturn.workflow.runId] : []));
  const captured = captureWorkflowDiscussionV1(request, selected);
  const attachmentMessageIds = new Set(selected.filter(message => message.content
    && readDiscussionAttachmentPayloadsV1(message.content).length > 0).map(message => message.id));
  // Accepted-run restoration can bypass narrative graph reconstruction, but
  // cannot turn a selected binary source into a successful text-only capture.
  const unsupportedAttachments = captured.unresolved.some(item => item.reason === 'unsupported_content'
    && attachmentMessageIds.has(item.messageId));
  let draft;
  if (unsupportedAttachments) {
    draft = captured;
  } else if (runIds.size === 1) {
    const runId = [...runIds][0]!;
    const raw = await deps.workflowAction({ actionId: 'workflow.run.get', input: { runId }, context,
      ...(context.signal ? { signal: context.signal } : {}) });
    const failure = readActionFailureEnvelope(raw);
    if (failure) return failure;
    const run = WorkflowRunGetResultV1Schema.safeParse(raw);
    if (!run.success || run.data.run.id !== runId) return unavailable();
    const origin = 'origin' in run.data.acceptedContext ? run.data.acceptedContext.origin.discussion : undefined;
    if (!origin || origin.discussion.discussionId !== request.discussion.discussionId
      || !sameHome(origin.discussion.serverId, request.discussion.serverId)) return unavailable();
    const source = run.data.acceptedContext.source;
    const provenanceSource = { kind: source.kind,
      ...('definitionId' in source && source.definitionId ? { definitionId: source.definitionId } : {}),
      ...('sourceArtifactId' in source && source.sourceArtifactId ? { definitionId: source.sourceArtifactId } : {}),
      ...('revision' in source && source.revision ? { revision: source.revision } : {}),
      ...('ref' in source ? { ref: source.ref, version: source.version } : {}),
      ...('automationId' in source ? { automationId: source.automationId } : {}),
    };
    draft = { status: 'ready' as const, name: request.name ?? run.data.acceptedContext.metadata?.title ?? 'Untitled pattern',
      definition: run.data.authoredDefinition, steps: captured.steps,
      inputs: Object.fromEntries(run.data.authoredDefinition.inputs.flatMap(input =>
        run.data.acceptedContext.inputs[input.name] === undefined ? [] : [[input.name, run.data.acceptedContext.inputs[input.name]]])), unresolved: [],
      provenance: { discussion: request.discussion, messages: selected.map(message => ({ source: message.messageRef,
        authorAccountId: message.authorAccountId, ...(message.producerV1?.kind === 'agent' ? { participantSessionId: message.producerV1.sessionId } : {}) })),
        workflow: { runId, source: provenanceSource } },
    };
  } else {
    draft = captured;
    if (runIds.size > 1) draft = { ...draft, status: 'needs_review', definition: null,
      unresolved: [{ messageId: selected[0]!.id, reason: 'ambiguous_workflow' }] };
  }
  if (draft.definition && !validateWorkflowDefinition(draft.definition).valid) return unavailable();
  context.signal?.throwIfAborted();
  return WorkflowDefinitionCaptureResultV1Schema.parse(draft);
}
