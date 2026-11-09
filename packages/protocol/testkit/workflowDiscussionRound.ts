import { createActionExecutor } from '../src/actions/actionExecutor.js';
import { createWorkflowAccountRunActionOwner, type WorkflowAccountRunActionDeps } from '../src/actions/executor/workflowRunActions.js';
import { WorkflowInvocationGetResultV1Schema, WorkflowInvocationListRequestV1Schema, WorkflowInvocationRetryResultV1Schema } from '../src/workflows/actionsV1.js';
import { DEBATE_WORKFLOW_V1 } from '../src/workflows/builtins/debate.js';
import { materializeWorkflowAcceptedSnapshotV1 } from '../src/workflows/materializeWorkflowAcceptedSnapshotV1.js';
import { WorkflowProgressEnvelopeV1Schema, WorkflowRunInvocationIndexV1Schema, WorkflowRunSummaryV1Schema } from '../src/workflows/workflowProgressV1.js';
import { openWorkflowProgressStoredEnvelopeV1, parseWorkflowStoredContentEnvelopeV1, sealWorkflowAcceptedSnapshotStoredEnvelopeV1, sealWorkflowCheckpointStoredEnvelopeV1, sealWorkflowProgressStoredEnvelopeV1, serializeWorkflowStoredContentEnvelopeV1 } from '../src/workflows/workflowStoredContentV1.js';
import { WorkflowRunRecipientCensusResponseV1Schema } from '../src/workflows/workflowRunKeyV1.js';
import { WorkflowDiscussionRoundProjectResultV1Schema } from '../src/workflows/workflowDiscussionRoundV1.js';
import type { ActionExecutorContext, ActionExecutorDeps } from '../src/actions/executor/types.js';
import type { WorkflowBlock, WorkflowDefinitionV1 } from '../src/workflows/workflowV1.js';
import { StrictJsonValueSchema } from '../src/json/strictJsonValue.js';

const runId = '11111111-1111-4111-8111-111111111111';

type ConditionalShape = 'collection-in-if' | 'projector-in-if';

export async function createWorkflowDiscussionRoundFixture(conditionalShape?: ConditionalShape, participantCount = 2, consumer: 'round' | 'review' = 'round', framePath?: 'item' | 'parallel' | 'workflow') {
  const conditional = (id: string, blocks: WorkflowBlock[]): WorkflowBlock => ({ kind: 'if', id,
    when: { kind: 'compare', operator: 'eq', left: { kind: 'literal', value: true }, right: { kind: 'literal', value: true } },
    then: blocks, otherwise: [] });
  let definition: WorkflowDefinitionV1 = conditionalShape ? { ...DEBATE_WORKFLOW_V1,
    blocks: DEBATE_WORKFLOW_V1.blocks.map(block => block.kind === 'loop' ? { ...block,
      body: block.body.flatMap(child => conditionalShape === 'collection-in-if' && child.kind === 'loop'
        && child.id === 'speakers' && child.repetition.kind === 'items' && child.repetition.items.kind === 'result'
        ? [conditional('conditional-speakers', [{ ...child,
          repetition: { ...child.repetition, items: { ...child.repetition.items,
            producer: { ...child.repetition.items.producer, scope: { kind: 'outer', levels: 1 } } } },
          body: child.body.map(reply => reply.kind === 'step' ? { ...reply, input: reply.input.map(reference =>
            reference.kind === 'result' && reference.producer.blockId === 'context'
              ? { ...reference, producer: { ...reference.producer, scope: { kind: 'outer', levels: 2 } } } : reference) } : reply),
        }])]
        : conditionalShape === 'projector-in-if' && child.kind === 'action' && child.id === 'outcomes'
          ? [child, conditional('conditional-outcomes', [{ ...child, id: 'nested-outcomes' }])]
          : [child]),
    } : block),
  } : DEBATE_WORKFLOW_V1;
  const address = { serverId: 'home', sessionId: 'review-target' };
  if (consumer === 'review') {
    const replace = (blocks: readonly WorkflowBlock[]): WorkflowBlock[] => blocks.map(block => {
      if (block.kind === 'action' && (block.id === 'outcomes' || block.id === 'nested-outcomes')) return {
        ...block, actionId: 'reviews.comments.list', input: { sessionId: { kind: 'input', name: 'reviewSession', path: ['sessionId'] } },
      };
      if (block.kind === 'if') return { ...block, then: replace(block.then), otherwise: replace(block.otherwise) };
      if (block.kind === 'loop') return { ...block, body: replace(block.body) };
      return block;
    });
    definition = { ...definition, inputs: [...definition.inputs, { name: 'reviewSession', valueType: 'json', required: true,
      inputType: { hostType: 'session' } }], blocks: replace(definition.blocks) };
  }
  const childDefinition = definition;
  if (framePath === 'item') definition = { ...definition, blocks: [{ kind: 'loop', id: 'panels',
    repetition: { kind: 'items', items: { kind: 'literal', value: ['panel'] }, execution: 'sequential', failurePolicy: 'fail_stop' }, body: definition.blocks }],
    finalOutput: { kind: 'result', producer: { blockId: 'panels', scope: { kind: 'current' } }, path: [] } };
  if (framePath === 'parallel') definition = { ...definition, blocks: [{ kind: 'parallel', id: 'panels', failurePolicy: 'fail_stop',
    branches: [{ id: 'panel', blocks: definition.blocks }] }],
    finalOutput: { kind: 'result', producer: { blockId: 'panels', scope: { kind: 'current' } }, path: [] } };
  if (framePath === 'workflow') definition = { ...definition, blocks: [{ kind: 'workflow', id: 'panel', workflowRef: 'builtin:debate',
    input: Object.fromEntries(definition.inputs.filter(input => input.required).map(input => [input.name, { kind: 'input' as const, name: input.name }])) }],
    finalOutput: { kind: 'result', producer: { blockId: 'panel', scope: { kind: 'current' } }, path: [] } };
  const participants = Array.from({ length: participantCount }, (_, index) => ({ kind: 'session' as const,
    session: { serverId: 'home', sessionId: `participant-${index}` } }));
  const accepted = await materializeWorkflowAcceptedSnapshotV1({ definition,
    context: { source: { kind: 'inline' }, inputs: { question: 'Review this change', participants, rounds: 3,
      ...(consumer === 'review' ? { reviewSession: address } : {}) }, machineId: 'machine-a',
      executionTarget: { kind: 'session' }, workspaceTarget: { project: { machineId: 'machine-a', directory: '/repo', checkoutRootPath: '/repo' } },
      origin: { kind: 'direct' }, authorization: { principal: { kind: 'host' } } }, admission: { kind: 'user' },
    effects: { resolveTargetAvailability: async () => true,
      readWorkflowDefinition: async () => ({ definition: childDefinition, sourceKey: 'builtin:debate' }),
      resolveSessionTarget: async value => {
        if ((value as { sessionId?: string }).sessionId === address.sessionId) return { address, machineId: 'machine-a' };
        const participant = participants.find(participant => participant.session.sessionId === (value as { sessionId?: string }).sessionId);
        return participant ? { address: participant.session, machineId: 'machine-a' } : null;
      }, readActionContract: async () => ({ inputSchema: { type: 'object' }, outputSchema: { type: 'object' } }) } });
  if (!accepted.ok) throw new Error(JSON.stringify(accepted.error));
  const rows: { index: ReturnType<typeof WorkflowRunInvocationIndexV1Schema.parse>;
    progress: ReturnType<typeof WorkflowProgressEnvelopeV1Schema.parse>; contentEnvelope: string }[] = [];
  const seal = (row: typeof rows[number]) => {
    row.contentEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ mode: 'plain',
      binding: { v: 1, purpose: 'invocation_progress', accountId: 'account-1', runId, recordId: row.index.id,
        sequence: row.index.sequence, parentRecordId: row.index.parentRecordId, memberOrdinal: row.index.memberOrdinal, attempt: row.index.attempt },
      progress: row.progress }));
  };
  const row = (id: string) => {
    const found = rows.find(row => row.index.id === id);
    if (!found) throw new Error(`Missing fixture row: ${id}`);
    return found;
  };
  const add = (parentRecordId: string | null, memberOrdinal: number,
    progress: Omit<ReturnType<typeof WorkflowProgressEnvelopeV1Schema.parse>, 'kind' | 'attempt' | 'logicalInvocationRecordId'>,
    previousId?: string) => {
    const id = `22222222-2222-4222-8222-${String(rows.length).padStart(12, '0')}`;
    const previous = previousId ? row(previousId) : undefined;
    const attempt = previous ? String(BigInt(previous.index.attempt) + 1n) : '0';
    const index = WorkflowRunInvocationIndexV1Schema.parse({ id, runId, parentRecordId, memberOrdinal: String(memberOrdinal),
      sequence: String(rows.length), attempt, contentRevision: '0', lifecycle: 'completed',
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });
    const added = { index, progress: WorkflowProgressEnvelopeV1Schema.parse({ ...progress, kind: 'happier.workflow-progress.v1',
      attempt, logicalInvocationRecordId: previous?.progress.logicalInvocationRecordId ?? id,
      ...(previousId ? { previousAttemptRecordId: previousId } : {}) }), contentEnvelope: '' };
    rows.push(added);
    seal(added);
    return id;
  };
  const recover = (id: string, parentRecordId = row(id).index.parentRecordId) => {
    const previous = row(id);
    previous.index.lifecycle = 'superseded';
    return add(parentRecordId, Number(previous.index.memberOrdinal), previous.progress, id);
  };
  const move = (id: string, parentRecordId: string) => {
    const moved = row(id);
    moved.index.parentRecordId = parentRecordId;
    seal(moved);
  };
  const root = add(null, 0, { blockKind: 'root', invocationPath: { blockId: '$root', scope: [] } });
  const outerScope = framePath === 'item' ? [{ kind: 'iteration' as const, blockId: 'panels', index: 0 }]
    : framePath === 'parallel' ? [{ kind: 'branch' as const, blockId: 'panels', branchId: 'panel' }]
      : framePath === 'workflow' ? [{ kind: 'workflow' as const, blockId: 'panel' }] : [];
  const outerLoop = framePath === 'item' ? add(root, 0, { blockKind: 'loop', invocationPath: { blockId: 'panels', scope: [] },
    container: { kind: 'loop', mode: 'items', source: { kind: 'definition', reference: { kind: 'literal', value: ['panel'] } },
      itemCount: '1', nextMemberIndex: '1', nextBodyBlockOrdinal: '0' } })
    : framePath === 'parallel' ? add(root, 0, { blockKind: 'parallel', invocationPath: { blockId: 'panels', scope: [] },
      container: { kind: 'parallel', nextBranchOrdinal: '1' } }) : root;
  const outerFrame = framePath === 'item' ? add(outerLoop, 0, { blockKind: 'loop', invocationPath: { blockId: 'panels', scope: outerScope },
    frame: { ownerBlockId: 'panels', source: { kind: 'item', index: '0' } } })
    : framePath === 'parallel' ? add(outerLoop, 0, { blockKind: 'parallel', invocationPath: { blockId: 'panels', scope: outerScope },
      frame: { ownerBlockId: 'panels', source: { kind: 'branch', branchId: 'panel' } } })
      : framePath === 'workflow' ? add(root, 0, { blockKind: 'workflow', invocationPath: { blockId: 'panel', scope: [] },
        container: { kind: 'body', nextBlockOrdinal: '1', frameInputs: { question: 'Review this change', participants, rounds: 3,
          ...(consumer === 'review' ? { reviewSession: address } : {}) } } }) : root;
  const loop = add(outerFrame, 0, { blockKind: 'loop', invocationPath: { blockId: 'rounds', scope: outerScope },
    container: { kind: 'loop', mode: 'until', nextMemberIndex: '3', nextBodyBlockOrdinal: '0' } });
  const rounds = [];
  for (let round = 0; round < 3; round += 1) {
    const scope = [...outerScope, { kind: 'iteration' as const, blockId: 'rounds', index: round }];
    const frame = add(loop, round, { blockKind: 'loop', invocationPath: { blockId: 'rounds', scope },
      frame: { ownerBlockId: 'rounds', source: { kind: 'iteration', index: String(round) } } });
    const result = WorkflowDiscussionRoundProjectResultV1Schema.parse({ allPassed: false, hasNext: true,
      nextParticipants: participants, outcomeReferences: [], throughSeq: round + 1 });
    const prepare = add(frame, 0, { blockKind: 'action', invocationPath: { blockId: 'context', scope }, result: StrictJsonValueSchema.parse(result) });
    const collectionParent = conditionalShape === 'collection-in-if'
      ? add(frame, 1, { blockKind: 'if', invocationPath: { blockId: 'conditional-speakers', scope }, container: { kind: 'if', selected: 'then', nextBlockOrdinal: '1' } })
      : frame;
    const collection = add(collectionParent, conditionalShape === 'collection-in-if' ? 0 : 1, { blockKind: 'loop', invocationPath: { blockId: 'speakers', scope },
      container: { kind: 'loop', mode: 'items', source: { kind: 'result', recordId: prepare, path: ['nextParticipants'] },
        itemCount: String(participants.length), nextMemberIndex: String(participants.length), nextBodyBlockOrdinal: '0' } });
    const replies = [];
    const itemFrames: string[] = [];
    for (let item = 0; item < participants.length; item += 1) {
      const itemScope = [...scope, { kind: 'iteration' as const, blockId: 'speakers', index: item }];
      const itemFrame = add(collection, item, { blockKind: 'loop', invocationPath: { blockId: 'speakers', scope: itemScope },
        frame: { ownerBlockId: 'speakers', source: { kind: 'item', index: String(item) } } });
      itemFrames.push(itemFrame);
      const reply = { kind: 'answer' as const, result: { sessionId: participants[item]!.session.sessionId, messageId: `answer-${round}-${item}` } };
      const id = add(itemFrame, 0, { blockKind: 'step', invocationPath: { blockId: 'reply', scope: itemScope }, replyOutcome: reply, result: `answer ${item}` });
      replies.push({ runId, invocationRecordId: id, participant: participants[item]!, kind: 'answer' as const, result: `answer ${item}`, reply });
    }
    let complete = add(frame, 2, { blockKind: 'action', invocationPath: { blockId: 'outcomes', scope }, result: StrictJsonValueSchema.parse({ ...result, outcomeReferences: replies }) });
    if (conditionalShape === 'projector-in-if') {
      const projectorParent = add(frame, 3, { blockKind: 'if', invocationPath: { blockId: 'conditional-outcomes', scope }, container: { kind: 'if', selected: 'then', nextBlockOrdinal: '1' } });
      complete = add(projectorParent, 0, { blockKind: 'action', invocationPath: { blockId: 'nested-outcomes', scope } });
    }
    rounds.push({ frame, prepare, collectionParent, collection, complete, itemFrames, replies });
  }
  const run = WorkflowRunSummaryV1Schema.parse({ id: runId, sourceArtifactId: null, ownerAccountId: 'account-1', visibleTeamId: null,
    origin: { kind: 'direct' }, state: 'running', revision: 0, machineId: 'machine-a', workflowCustodyState: 'pending', originDeliveryAckRevision: null,
    attentionRequired: false, failureUnseen: false, invocationAttentionRequired: false, attentionSeenFailureAt: null, finishedAt: null,
    availability: { pause: true, resumeBoundary: false, restoreWorkspace: false, cancel: true, inspectExecution: false, disabledReasons: [] },
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });
  const snapshot = { run, acceptedEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
    binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'account-1', runId }, acceptedSnapshot: accepted.snapshot })), checkpointEnvelope: null as string | null, resultEnvelope: null,
    keyCensus: WorkflowRunRecipientCensusResponseV1Schema.parse({ runId, ownerAccountId: 'account-1', visibleTeamId: null, encryptionMode: 'plain', access: 'owner',
      ownerAccountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null }, dataEncryptionKey: null, callerDataEncryptionKey: null, recipients: [] }) };
  const cost = { requests: 0, pages: 0, historyPages: 0, envelopes: 0, bytes: 0 };
  let miswire = false;
  let miswireChildren = false;
  const owner = createWorkflowAccountRunActionOwner({ resolveAccountId: async () => 'account-1',
    // This fixture creates settled records without launching native inputs.
    // Supply that execution-boundary fact explicitly; absent correspondence
    // alone is not evidence of inactivity in the production recovery owner.
    observeRecovery: async ({ index }) => ({
      activity: index.lifecycle === 'failed' || index.lifecycle === 'cancelled' || index.lifecycle === 'completed'
        ? 'not_active' : 'unknown',
      canReattach: false, canContinueConversation: false,
    }),
    resolveEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
    randomBytes: () => { throw new Error('plain_account_does_not_need_keys'); },
    definitions: { get: async () => { throw new Error('No mutable definition read'); } },
    normalizeAbsolutePath: directory => directory.startsWith('/') ? directory : null,
    storage: { execute: async operation => {
      cost.requests += 1;
      if (operation.operation === 'get') return snapshot;
      if (operation.operation === 'invocations.get') return { invocation: { ...row(String(operation.invocationId)), parentRevision: run.revision } };
      if (operation.operation === 'invocations.recover') {
        // Substitute only persistence: all replacement identities, progress and
        // envelopes are produced by the real retry Action above this boundary.
        const replacements = operation.recoveries as Array<{ invocationId: string; newInvocationId: string; contentEnvelope: string }>;
        const replacementIds = new Map(replacements.map(item => [item.invocationId, item.newInvocationId]));
        for (const item of replacements) {
          const previous = row(item.invocationId);
          const index = WorkflowRunInvocationIndexV1Schema.parse({ ...previous.index, id: item.newInvocationId,
            parentRecordId: replacementIds.get(previous.index.parentRecordId!) ?? previous.index.parentRecordId,
            sequence: String(rows.length), attempt: String(BigInt(previous.index.attempt) + 1n), lifecycle: 'pending' });
          const opened = openWorkflowProgressStoredEnvelopeV1({ mode: 'plain', envelope: parseWorkflowStoredContentEnvelopeV1(item.contentEnvelope)!,
            binding: { v: 1, purpose: 'invocation_progress', accountId: 'account-1', runId, recordId: index.id,
              sequence: index.sequence, parentRecordId: index.parentRecordId, memberOrdinal: index.memberOrdinal, attempt: index.attempt } });
          if (opened.kind !== 'available') throw new Error('retry_producer_envelope_invalid');
          previous.index.lifecycle = 'superseded';
          rows.push({ index, progress: WorkflowProgressEnvelopeV1Schema.parse(opened.content), contentEnvelope: item.contentEnvelope });
        }
        run.revision += 1;
        run.state = 'queued';
        snapshot.checkpointEnvelope = String(operation.checkpointEnvelope);
        return { run, invocations: replacements.map(item => row(item.newInvocationId).index), disposition: 'accepted' };
      }
      if (operation.operation !== 'invocations.list') throw new Error('Unexpected storage operation');
      cost.pages += 1;
      const input = WorkflowInvocationListRequestV1Schema.parse({ runId, ...(operation.invocationId === undefined ? {} : { invocationId: operation.invocationId }),
        ...(operation.parentRecordIds === undefined ? {} : { parentRecordIds: operation.parentRecordIds }),
        ...(operation.parentRecordId === undefined ? {} : { parentRecordId: operation.parentRecordId }),
        ...(operation.memberOrdinal === undefined ? {} : { memberOrdinal: operation.memberOrdinal }) });
      if (input.invocationId === undefined && input.parentRecordId === undefined && input.parentRecordIds === undefined) cost.historyPages += 1;
      let selected = miswire || (miswireChildren && input.parentRecordIds) ? rows.slice(0, 1) : rows.filter(row => (!input.invocationId || row.index.id === input.invocationId)
        && (input.parentRecordId === undefined || row.index.parentRecordId === input.parentRecordId)
        && (!input.parentRecordIds || row.index.parentRecordId !== null && input.parentRecordIds.includes(row.index.parentRecordId))
        && (input.memberOrdinal === undefined || row.index.memberOrdinal === input.memberOrdinal));
      if (!miswire && input.memberOrdinal !== undefined) selected = selected.sort((left, right) =>
        Number(BigInt(right.index.attempt) - BigInt(left.index.attempt))).slice(0, 1);
      // Deliberately small transport pages exercise cursor traversal, not a product cap.
      const start = Number(operation.cursor ?? 0);
      const page = selected.slice(start, start + 100);
      if (operation.progressEnvelopes === true) {
        cost.envelopes += page.length;
        cost.bytes += page.reduce((sum, row) => sum + Buffer.byteLength(row.contentEnvelope), 0);
      }
      return { invocations: page.map(row => row.index), parentRevision: run.revision, keyCensus: snapshot.keyCensus,
        ...(start + page.length < selected.length ? { nextCursor: String(start + page.length) } : {}),
        ...(operation.progressEnvelopes === true ? { progressEnvelopesByInvocationId: Object.fromEntries(page.map(row => [row.index.id, row.contentEnvelope])) } : {}) };
    } },
  } satisfies WorkflowAccountRunActionDeps);
  const deps = { workflowAction: (args: Parameters<typeof owner.execute>[0]) => owner.execute(args),
    resolveSessionReference: async () => ({ kind: 'unique' as const, address }) };
  // Fixture supplies only Run Actions and the exercised external ports; unexpected system calls fail loudly.
  const executor = createActionExecutor(deps as unknown as ActionExecutorDeps);
  const context = (id: string): ActionExecutorContext => ({ surface: 'agent', serverId: 'home',
    actionRequestId: `${runId}/${row(id).progress.logicalInvocationRecordId}/${row(id).index.attempt}`,
    actionCaller: { kind: 'workflowRun', runId, authorization: accepted.snapshot.authorization } });
  let currentRoot = root;
  const inspect = async (id: string) => WorkflowInvocationGetResultV1Schema.parse(await owner.execute({
    actionId: 'workflow.run.invocations.get', input: { runId, invocationId: id },
    context: { surface: 'ui', authority: 'present_user', callerPermissionMode: 'yolo' } }));
  const requestRetry = async (id: string, causalInvocationIds: readonly string[], conversation: 'fresh_agent' | 'same_conversation' = 'fresh_agent') => WorkflowInvocationRetryResultV1Schema.parse(await owner.execute({
    actionId: 'workflow.run.invocations.retry', input: { runId, invocation: { recordId: id },
      expectedRevision: run.revision, causalInvocationIds: [...causalInvocationIds], conversation, input: { kind: 'original' } },
    context: { surface: 'ui', authority: 'present_user', callerPermissionMode: 'yolo' } }));
  const retry = async (id: string, recoverParent: boolean | 'ancestors' | 'root' = false) => {
    const failed = row(id);
    failed.index.lifecycle = failed.index.parentRecordId === null ? 'needs_attention' : 'failed';
    if (recoverParent === true) {
      const parent = row(failed.index.parentRecordId!);
      parent.index.lifecycle = 'failed';
      if (parent.progress.blockKind === 'loop' || parent.progress.blockKind === 'parallel') {
        failed.progress.reason = { code: `container_fail_stop:${parent.index.id}` };
      }
      seal(parent);
    }
    if (recoverParent === 'ancestors' || recoverParent === 'root') {
      let parentId = failed.index.parentRecordId;
      while (parentId !== null) {
        const parent = row(parentId);
        if (parent.index.parentRecordId !== null || recoverParent === 'root') {
          parent.index.lifecycle = parent.index.parentRecordId === null ? 'needs_attention' : 'failed';
          seal(parent);
        }
        parentId = parent.index.parentRecordId;
      }
    }
    seal(failed);
    run.state = 'interrupted';
    snapshot.checkpointEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowCheckpointStoredEnvelopeV1({ mode: 'plain',
      binding: { v: 1, purpose: 'checkpoint', accountId: 'account-1', runId }, checkpoint: {
        kind: 'happier.workflow-checkpoint.v1', rootRecordId: currentRoot, nextSequence: String(rows.length),
        frontier: { nextBlockOrdinal: 0, paused: false } } }));
    const context: ActionExecutorContext = { surface: 'ui', authority: 'present_user', callerPermissionMode: 'yolo' };
    const detail = WorkflowInvocationGetResultV1Schema.parse(await owner.execute({ actionId: 'workflow.run.invocations.get',
      input: { runId, invocationId: id }, context }));
    const availability = detail.invocation.recoveryAvailability?.retry;
    if (availability?.kind !== 'available') throw new Error(`retry_unavailable:${JSON.stringify(availability)}`);
    const result = WorkflowInvocationRetryResultV1Schema.parse(await owner.execute({ actionId: 'workflow.run.invocations.retry',
      input: { runId, invocation: { recordId: id }, expectedRevision: run.revision,
        causalInvocationIds: availability.causalInvocationIds, conversation: 'fresh_agent', input: { kind: 'original' } }, context }));
    if (result.disposition !== 'accepted') throw new Error('fixture_retry_not_accepted');
    currentRoot = rows.find(item => item.index.parentRecordId === null && item.index.lifecycle !== 'superseded')!.index.id;
    Object.assign(cost, { requests: 0, pages: 0, historyPages: 0, envelopes: 0, bytes: 0 });
    return result.invocation.id;
  };
  return { run, cost, executor, context, rounds, recover, retry, inspect, requestRetry, move, row, seal, root, deps, address,
    interrupt: () => { run.state = 'interrupted'; },
    currentRoot: () => currentRoot,
    retainOriginalCheckpointRoot: () => {
      snapshot.checkpointEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowCheckpointStoredEnvelopeV1({ mode: 'plain',
        binding: { v: 1, purpose: 'checkpoint', accountId: 'account-1', runId }, checkpoint: {
          kind: 'happier.workflow-checkpoint.v1', rootRecordId: root, nextSequence: String(rows.length),
          frontier: { nextBlockOrdinal: 0, paused: false } } }));
    },
    omit: (id: string) => { rows.splice(rows.indexOf(row(id)), 1); }, miswire: () => { miswire = true; },
    miswireChildren: () => { miswireChildren = true; } };
}


