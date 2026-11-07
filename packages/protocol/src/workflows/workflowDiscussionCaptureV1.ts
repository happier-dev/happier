import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { DiscussionAddressV1Schema, DiscussionMessageIdSchema, DiscussionMessageRefV1Schema } from '../discussions/references.js';
import type { DiscussionOpenedMessageV1 } from '../discussions/actions.js';
import { StrictJsonValueSchema, projectNativeJsonValueForTransport, type JsonValue } from '../json/strictJsonValue.js';
import { WorkflowDefinitionV1Schema, type WorkflowDefinitionV1, type WorkflowBlock, type WorkflowInputDefinition, type WorkflowStep } from './workflowV1.js';
import type { WorkflowValueReference } from './workflowReferenceV1.js';
import { WorkflowDefinitionCaptureProvenanceV1Schema } from './workflowDefinitionV1.js';
import { ExecutableParticipantSelectionV1Schema } from '../discussions/executableParticipants.js';
import { readDiscussionAttachmentPayloadsV1 } from '../discussions/content.js';

/** Closed, read-only capture operands. Source text is always read under the caller's authority. */
export const WorkflowDefinitionCaptureRequestV1Schema = lazyZodSchema(() => z.strictObject({
  discussion: DiscussionAddressV1Schema,
  messageIds: z.array(DiscussionMessageIdSchema).check(z.minLength(1), z.refine(ids => new Set(ids).size === ids.length)),
  name: z.optional(z.string().check(z.trim(), z.minLength(1))),
  choices: z.optional(z.array(z.strictObject({
    messageId: DiscussionMessageIdSchema,
    role: z.enum(['input', 'step', 'exclude']),
    dependsOnMessageIds: z.optional(z.array(DiscussionMessageIdSchema)),
    instruction: z.optional(z.string().check(z.minLength(1))),
    perRun: z.optional(z.boolean()),
    participant: z.optional(ExecutableParticipantSelectionV1Schema),
  })).check(z.refine(choices => new Set(choices.map(choice => choice.messageId)).size === choices.length))),
}));
export type WorkflowDefinitionCaptureRequestV1 = z.infer<typeof WorkflowDefinitionCaptureRequestV1Schema>;

const CaptureStepSchema = lazyZodSchema(() => z.strictObject({
  messageId: DiscussionMessageIdSchema, source: DiscussionMessageRefV1Schema,
  role: z.enum(['input', 'step', 'exclude']), text: z.string(),
  dependsOnMessageIds: z.array(DiscussionMessageIdSchema),
  inputName: z.optional(z.string()), instruction: z.optional(z.string()),
  perRun: z.boolean(), participantInputName: z.optional(z.string()),
  participant: z.optional(ExecutableParticipantSelectionV1Schema),
}));
export const WorkflowDefinitionCaptureResultV1Schema = lazyZodSchema(() => z.strictObject({
  status: z.enum(['ready', 'needs_review']), name: z.string(),
  definition: z.nullable(WorkflowDefinitionV1Schema),
  steps: z.array(CaptureStepSchema),
  inputs: z.record(z.string(), StrictJsonValueSchema),
  unresolved: z.array(z.strictObject({ messageId: DiscussionMessageIdSchema,
    reason: z.enum(['unlinked_message', 'missing_dependency', 'participant_required', 'no_steps', 'unsupported_content', 'ambiguous_workflow']) })),
  provenance: WorkflowDefinitionCaptureProvenanceV1Schema,
}).check(z.refine(value => value.status === 'ready'
  ? value.definition !== null && value.unresolved.length === 0
  : value.definition === null && value.unresolved.length > 0,
  'Only a resolved capture has an executable draft')));
export type WorkflowDefinitionCaptureResultV1 = z.infer<typeof WorkflowDefinitionCaptureResultV1Schema>;

/** One draft graph producer for UI, Agents and plugins. Answer prose is review data, never a prompt. */
export function captureWorkflowDiscussionV1(request: WorkflowDefinitionCaptureRequestV1,
  messages: readonly DiscussionOpenedMessageV1[]): WorkflowDefinitionCaptureResultV1 {
  const selectedIds = new Set(request.messageIds);
  const selected = messages.filter(message => selectedIds.has(message.id)).sort((a, b) => a.seq - b.seq);
  const byId = new Map(selected.map(message => [message.id, message]));
  const choices = new Map(request.choices?.map(choice => [choice.messageId, choice]));
  if (request.messageIds.some(id => !byId.has(id)) || [...choices.keys()].some(id => !byId.has(id))) {
    throw Object.assign(new Error('capture_source_unavailable'), { code: 'content_unavailable' });
  }
  const unresolved: WorkflowDefinitionCaptureResultV1['unresolved'] = [];
  const inputs: Record<string, JsonValue> = {};
  let inputIndex = 0;
  const steps = selected.map((message): WorkflowDefinitionCaptureResultV1['steps'][number] => {
    const choice = choices.get(message.id);
    const parent = message.replyTarget?.kind === 'message' ? message.replyTarget.messageId : undefined;
    const role = choice?.role ?? (message.producerV1 ? 'step' : 'input');
    const participant = choice?.participant ?? (message.producerV1?.kind === 'agent'
      ? { kind: 'session' as const, session: { serverId: request.discussion.serverId, sessionId: message.producerV1.sessionId } } : undefined);
    const dependsOnMessageIds = role === 'exclude' ? [] : choice?.dependsOnMessageIds ?? (parent ? [parent] : []);
    const text = message.content && 'parts' in message.content
      ? message.content.parts.filter(part => part.t === 'text').map(part => part.text).join('') : '';
    if (!message.content) throw Object.assign(new Error('capture_source_unavailable'), { code: 'content_unavailable' });
    if (role !== 'exclude' && (!('parts' in message.content) || readDiscussionAttachmentPayloadsV1(message.content).length > 0)) {
      unresolved.push({ messageId: message.id, reason: 'unsupported_content' });
    }
    if (role === 'step' && !choice && !parent) unresolved.push({ messageId: message.id, reason: 'unlinked_message' });
    if (role === 'step' && !participant) unresolved.push({ messageId: message.id, reason: 'participant_required' });
    for (const id of dependsOnMessageIds) {
      const dependency = byId.get(id);
      if (!dependency || dependency.seq >= message.seq || choices.get(id)?.role === 'exclude') {
        unresolved.push({ messageId: message.id, reason: 'missing_dependency' });
      }
    }
    const inputName = role === 'input' ? inputIndex++ === 0 ? 'question' : `context_${inputIndex}` : undefined;
    if (inputName) inputs[inputName] = text;
    return { messageId: message.id, source: message.messageRef, role, text, dependsOnMessageIds, perRun: choice?.perRun !== false,
      ...(inputName ? { inputName } : {}),
      ...(participant ? { participant } : {}),
      ...(role === 'step' ? { instruction: choice?.instruction ?? (parent && byId.get(parent)?.producerV1
        ? 'Review the exact supplied result. Explain corrections, missing evidence and disagreements.'
        : 'Respond to the supplied question and context.') } : {}),
    };
  });
  // A person's follow-up can address a reviewer while replying to an earlier
  // answer. Its authored input and that exact answer are both dependencies.
  // Chronological validation above makes this one forward pass, not a graph scheduler.
  const expandedDependencies = new Map<string, readonly string[]>();
  const stepByMessage = new Map(steps.map(step => [step.messageId, step]));
  for (const step of steps) {
    const dependencies = [...new Set(step.dependsOnMessageIds.flatMap(id => [id,
      ...(stepByMessage.get(id)?.role === 'input' ? expandedDependencies.get(id) ?? [] : []),
    ]))];
    step.dependsOnMessageIds = dependencies;
    expandedDependencies.set(step.messageId, dependencies);
  }
  const executable = steps.filter(step => step.role === 'step');
  const executableDependencies = new Set(executable.flatMap(step => step.dependsOnMessageIds));
  for (const step of steps) {
    if (step.role === 'input' && !choices.has(step.messageId) && !executableDependencies.has(step.messageId)) {
      unresolved.push({ messageId: step.messageId, reason: 'unlinked_message' });
    }
  }
  if (!executable.length) unresolved.push({ messageId: selected[0]!.id, reason: 'no_steps' });
  const inputDefinitions: WorkflowInputDefinition[] = steps.filter(step => step.inputName).map(step => ({
    name: step.inputName!, valueType: 'string', required: step.perRun,
    ...(!step.perRun ? { default: inputs[step.inputName!]! } : {}),
  }));
  const blocks: WorkflowBlock[] = [];
  const references = new Map<string, WorkflowValueReference>();
  steps.forEach(step => { if (step.inputName) references.set(step.messageId, { kind: 'input', name: step.inputName }); });
  const depths = new Map<string, number>();
  executable.forEach(step => depths.set(step.messageId, Math.max(0, ...step.dependsOnMessageIds.map(id =>
    depths.has(id) ? depths.get(id)! + 1 : 0))));
  const levels = [...new Set(depths.values())].sort((a, b) => a - b);
  let participantGroupIndex = 0;
  for (const level of levels) {
    const siblings = executable.filter(step => depths.get(step.messageId) === level);
    // The same authored role uses one roster. A parallel item body consumes
    // every chosen participant, including a roster edited before a later run.
    // Different instructions, dependencies or fixed/per-run choices remain distinct roles.
    const rolesByKey = new Map<string, typeof siblings>();
    for (const step of siblings) {
      const key = JSON.stringify([step.instruction, step.perRun, step.dependsOnMessageIds]);
      const role = rolesByKey.get(key);
      if (role) role.push(step);
      else rolesByKey.set(key, [step]);
    }
    const roles = [...rolesByKey.values()];
    const parallel = roles.length > 1;
    const groupId = `exchange_${level + 1}`;
    const leaves = roles.map((role, branchIndex): WorkflowBlock => {
      const step = role[0]!;
      const index = executable.indexOf(step) + 1;
      const id = `step_${index}`;
      const multiple = role.length > 1;
      const participantName = multiple ? ++participantGroupIndex === 1 ? 'participants' : `participants_${participantGroupIndex}` : `participant_${index}`;
      role.forEach(member => { member.participantInputName = participantName; });
      const participantValue = multiple
        ? role.every(member => member.participant) ? projectNativeJsonValueForTransport(role.map(member => member.participant)) : undefined
        : step.participant ? projectNativeJsonValueForTransport(step.participant) : undefined;
      inputDefinitions.push({ name: participantName, valueType: 'json', ...(multiple ? { multiple: true } : {}),
        required: step.perRun, inputType: { hostType: 'agentParticipant' },
        ...(!step.perRun && participantValue !== undefined ? { default: participantValue } : {}) });
      if (participantValue !== undefined) inputs[participantName] = participantValue;
      const outerLevels = Number(parallel) + Number(multiple);
      const input = step.dependsOnMessageIds.flatMap(messageId => {
        const ref = references.get(messageId);
        if (!ref) return [];
        return [ref.kind === 'result' && outerLevels ? { ...ref, producer: { ...ref.producer, scope: { kind: 'outer' as const, levels: outerLevels } } } : ref];
      });
      const roleId = parallel ? `role_${index}` : groupId;
      role.forEach((member, memberIndex) => references.set(member.messageId, {
        kind: 'result', producer: { blockId: parallel ? groupId : multiple ? roleId : id, scope: { kind: 'current' } },
        path: [...(parallel ? [branchIndex, 'results', multiple ? roleId : id] : []), ...(multiple ? [memberIndex, 'results', id] : [])],
      }));
      const leaf: WorkflowStep = { kind: 'step', id, document: { text: step.instruction!, references: [], attachments: [] },
        execution: { participant: multiple ? { kind: 'item', field: 'value' } : { kind: 'input', name: participantName } }, input, result: { kind: 'text' } };
      return multiple ? { kind: 'loop', id: roleId, repetition: { kind: 'items', items: { kind: 'input', name: participantName },
        execution: 'parallel', failurePolicy: 'collect_outcomes' }, body: [leaf] } : leaf;
    });
    blocks.push(...(parallel ? [{ kind: 'parallel' as const, id: groupId, failurePolicy: 'collect_outcomes' as const,
      branches: leaves.map(leaf => ({ id: `branch_${leaf.id}`, blocks: [leaf] })) }] : leaves));
  }
  const definition: WorkflowDefinitionV1 | null = unresolved.length ? null : { version: 1, defaults: {}, inputs: inputDefinitions, blocks };
  return WorkflowDefinitionCaptureResultV1Schema.parse({ status: definition ? 'ready' : 'needs_review',
    name: request.name ?? 'Untitled pattern', definition, steps, inputs, unresolved,
    provenance: { discussion: request.discussion, messages: selected.map(message => ({ source: message.messageRef,
      authorAccountId: message.authorAccountId, ...(message.producerV1?.kind === 'agent' ? { participantSessionId: message.producerV1.sessionId } : {}) })) },
  });
}
