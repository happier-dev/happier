import { lazyZodSchema } from '../lazyZodSchema.js';
import type { WorkflowMaterializedLeafV1 } from './workflowDefinitionV1.js';
import type { WorkflowBlock, WorkflowDefinitionV1, WorkflowLeafV1, WorkflowStepExecutionSelection } from './workflowV1.js';
import { listWorkflowBlockOrdinalsV1, workflowBlockReferenceLabel } from './workflowStepLabel.js';
import { z } from '../zodRuntimePolicy.js';
import { listWorkflowAcceptedLeafSelectionsV1 } from './workflowStepSelectionV1.js';
import { ActionSessionAddressV1Schema } from '../actions/sessionTargetV1.js';
import type { JsonValue } from '../json/strictJsonValue.js';
import { readWorkflowValuePathV1 } from './workflowReferenceV1.js';
import { DiscussionAddressV1Schema, DiscussionAddressingV1Schema } from '../discussions/references.js';
import { FollowPolicyV1Schema } from '../sessions/follow/sessionFollowPolicyV1.js';
import { preservedBoundedNfcString } from '../strings/preservedBoundedNfcString.js';

/** A committed C3 frontier, frozen inside the existing accepted Run envelope. */
export const WorkflowDiscussionOriginV1Schema = lazyZodSchema(() => z.strictObject({
  discussion: DiscussionAddressV1Schema,
  messageId: DiscussionAddressingV1Schema.shape.messageId,
  throughSeq: DiscussionAddressingV1Schema.shape.throughSeq,
}));
export type WorkflowDiscussionOriginV1 = z.infer<typeof WorkflowDiscussionOriginV1Schema>;

export const WorkflowRunOnCompleteV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('originating_session') }),
  z.strictObject({ kind: z.literal('originating_discussion') }),
]));

export const WorkflowDiscussionResultDeliveryV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('originating_discussion'), ...WorkflowDiscussionOriginV1Schema.shape,
}));

export const WorkflowResultDeliveryV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('originating_session'),
    originSessionId: preservedBoundedNfcString(191, 'Session ids'), reportPolicy: z.optional(FollowPolicyV1Schema) }),
  WorkflowDiscussionResultDeliveryV1Schema,
]));

/** Authored structure has one leaf traversal for admission and destination projections. */
export function collectWorkflowLeavesV1(definition: WorkflowDefinitionV1): WorkflowLeafV1[] {
  return collectWorkflowLeafPositionsV1(definition).map(entry => entry.leaf);
}

function collectWorkflowLeafPositionsV1(definition: WorkflowDefinitionV1): Array<{ leaf: WorkflowLeafV1; ordinal: number }> {
  const leaves: Array<{ leaf: WorkflowLeafV1; ordinal: number }> = [];
  const ordinals = listWorkflowBlockOrdinalsV1(definition.blocks);
  const siblings = (blocks: readonly WorkflowBlock[]) => [...blocks].reverse();
  const pending = siblings(definition.blocks);
  while (pending.length > 0) {
    const block = pending.pop()!;
    if (block.kind === 'parallel') pending.push(...block.branches.slice().reverse().flatMap(branch => siblings(branch.blocks)));
    else if (block.kind === 'if') pending.push(...siblings(block.otherwise), ...siblings(block.then));
    else if (block.kind === 'loop') {
      if (block.repetition.kind === 'evaluate') pending.push(block.repetition.evaluator);
      pending.push(...siblings(block.body));
    } else leaves.push({ leaf: block, ordinal: Number(ordinals.get(block.id)) });
  }
  return leaves;
}

function actionInputNames(leaf: WorkflowLeafV1): Set<string> {
  if (leaf.kind !== 'action') return new Set<string>();
  const references = Object.values(leaf.input).flatMap(binding => binding.kind === 'list' ? binding.items
    : binding.kind === 'object' ? Object.values(binding.fields) : binding.kind === 'text' ? binding.input : [binding]);
  return new Set(references.flatMap(reference => reference.kind === 'input' ? [reference.name] : []));
}

/** The materializer's existing per-leaf Session availability relation. */
export function readWorkflowLeafTargetSessionIdsV1(selection: Pick<WorkflowStepExecutionSelection, 'conversation'>,
  originSessionId?: string): string[] {
  return [...new Set([
    ...(originSessionId ? [originSessionId] : []),
    ...(selection.conversation?.kind === 'existing_session' ? [selection.conversation.sessionId] : []),
  ])];
}

/**
 * `usesOriginSession`: an unbound definition can still describe its origin destination.
 * `unresolvedWorkflowRefs`: a reference cannot be projected until its current definition has been read.
 * The type is the wire schema's, so a projection result is assignable wherever the schema's shape is.
 */
export const WorkflowDestinationsV1Schema = lazyZodSchema(() => z.strictObject({
  targetSessionIds: z.array(z.string().check(z.minLength(1))), usesOriginSession: z.boolean(),
  unresolvedWorkflowRefs: z.array(z.string().check(z.minLength(1))),
  leaves: z.array(z.strictObject({ sourceKey: z.string().check(z.minLength(1)), blockId: z.string().check(z.minLength(1)),
    ordinal: z.optional(z.number().check(z.int(), z.positive())), name: z.optional(z.string()),
    sessionIds: z.array(z.string().check(z.minLength(1))) })),
}));

export type WorkflowDestinationsV1 = z.infer<typeof WorkflowDestinationsV1Schema>;

/** Loading uses the caller's authorized reader, not a second definition catalog. */
export async function resolveWorkflowDestinationsV1(input: Parameters<typeof deriveWorkflowDestinationsV1>[0],
  read: (ref: string) => Promise<WorkflowDefinitionV1 | null>): Promise<WorkflowDestinationsV1> {
  const children = { ...input.children };
  const attempted = new Set<string>();
  let destinations = deriveWorkflowDestinationsV1({ ...input, children });
  while (destinations.unresolvedWorkflowRefs.some(ref => !attempted.has(ref))) {
    for (const ref of destinations.unresolvedWorkflowRefs) {
      if (attempted.has(ref)) continue;
      attempted.add(ref);
      const child = await read(ref);
      if (child) children[ref] = child;
    }
    destinations = deriveWorkflowDestinationsV1({ ...input, children });
  }
  return destinations;
}

/** Pure projection of current definitions or the already-resolved accepted graph. */
export function deriveWorkflowDestinationsV1(input: Readonly<{
  definition: WorkflowDefinitionV1;
  children?: Readonly<Record<string, WorkflowDefinitionV1>>;
  materializedLeaves?: readonly WorkflowMaterializedLeafV1[];
  originSessionId?: string;
  inputs?: Readonly<Record<string, JsonValue>>;
}>): WorkflowDestinationsV1 {
  const leaves: WorkflowDestinationsV1['leaves'] = [];
  const targetSessionIds = new Set<string>();
  const unresolved = new Set<string>();
  let usesOriginSession = false;
  const visit = (sourceKey: string, blockId: string, selection: Pick<WorkflowStepExecutionSelection, 'conversation'>,
    position?: { leaf: WorkflowLeafV1; ordinal: number }, boundInput?: Readonly<{ sessionIds: string[]; usesOriginSession: boolean }>) => {
    usesOriginSession ||= boundInput?.usesOriginSession === true || selection.conversation?.kind === 'origin_session';
    const sessionIds = boundInput?.sessionIds ?? readWorkflowLeafTargetSessionIdsV1(selection,
      selection.conversation?.kind === 'origin_session' ? input.originSessionId : undefined);
    for (const sessionId of sessionIds) targetSessionIds.add(sessionId);
    leaves.push({ sourceKey, blockId, sessionIds, ...(position ? { ordinal: position.ordinal,
      name: workflowBlockReferenceLabel(position.leaf) } : {}) });
  };
  if (input.materializedLeaves) {
    const positions = new Map<string, ReturnType<typeof collectWorkflowLeafPositionsV1>>();
    positions.set('$root', collectWorkflowLeafPositionsV1(input.definition));
    for (const [key, definition] of Object.entries(input.children ?? {})) positions.set(key, collectWorkflowLeafPositionsV1(definition));
    for (const leaf of input.materializedLeaves.flatMap(listWorkflowAcceptedLeafSelectionsV1)) {
      const position = positions.get(leaf.sourceKey)?.find(position => position.leaf.id === leaf.blockId);
      const names = position ? actionInputNames(position.leaf) : new Set<string>();
      const actionTargets = leaf.sessionAuthorityBindings?.filter(binding => binding.inputName === undefined
        ? leaf.actionId === 'review.start' : names.has(binding.inputName))
        .flatMap(binding => binding.targets.map(target => target.address.sessionId));
      visit(leaf.sourceKey, leaf.blockId, leaf.selection, position,
        actionTargets?.length ? { sessionIds: [...new Set(actionTargets)], usesOriginSession: false } : undefined);
    }
  } else {
    const pending = [{ sourceKey: '$root', definition: input.definition, inputs: input.inputs ?? {} }];
    const visited = new Set<string>();
    while (pending.length > 0) {
      const frame = pending.pop()!;
      const frameKey = JSON.stringify([frame.sourceKey, frame.inputs]);
      if (visited.has(frameKey)) continue;
      visited.add(frameKey);
      const sessionInput = (name: string) => {
        const field = frame.definition.inputs.find(field => field.name === name);
        const supplied = Object.hasOwn(frame.inputs, name);
        const address = ActionSessionAddressV1Schema.safeParse(supplied ? frame.inputs[name] : field?.default);
        const fromOrigin = !supplied && field?.defaultFrom === 'origin_session';
        return { sessionIds: address.success ? [address.data.sessionId] : fromOrigin && input.originSessionId ? [input.originSessionId] : [],
          usesOriginSession: fromOrigin };
      };
      for (const position of collectWorkflowLeafPositionsV1(frame.definition)) {
        const leaf = position.leaf;
        const conversation = leaf.execution?.conversation ?? frame.definition.defaults.conversation;
        let boundInput: Parameters<typeof visit>[4];
        if (conversation?.kind === 'input') boundInput = sessionInput(conversation.name);
        if (leaf.kind === 'action') {
          const names = actionInputNames(leaf);
          const sessionIds: string[] = [];
          let usesOriginSession = false;
          const fields = frame.definition.inputs.filter(field => names.has(field.name) && field.inputType
            && 'hostType' in field.inputType && field.inputType.hostType === 'session');
          for (const field of fields) {
            const target = sessionInput(field.name);
            sessionIds.push(...target.sessionIds);
            usesOriginSession ||= target.usesOriginSession;
          }
          if (fields.length) boundInput = { sessionIds: [...new Set(sessionIds)], usesOriginSession };
        }
        visit(frame.sourceKey, leaf.id, { conversation }, position, boundInput);
        if (leaf.kind !== 'workflow') continue;
        const child = input.children?.[leaf.workflowRef];
        if (child) {
          const childInputs: Record<string, JsonValue> = Object.fromEntries(child.inputs.filter(field => field.default !== undefined).map(field => [field.name, field.default!]));
          for (const [name, reference] of Object.entries(leaf.input)) childInputs[name] = reference.kind === 'literal' ? reference.value
            : reference.kind === 'input' ? readWorkflowValuePathV1(frame.inputs[reference.name] ?? null, reference.path ?? []) ?? null : null;
          pending.push({ sourceKey: leaf.workflowRef, definition: child, inputs: childInputs });
        }
        else unresolved.add(leaf.workflowRef);
      }
    }
  }
  return { targetSessionIds: [...targetSessionIds], usesOriginSession, unresolvedWorkflowRefs: [...unresolved], leaves };
}
