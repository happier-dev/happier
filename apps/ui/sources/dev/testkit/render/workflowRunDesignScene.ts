import {
  WorkflowDefinitionV1Schema,
  type WorkflowDefinitionV1} from '@happier-dev/protocol/workflows/workflowV1';
import {
  WorkflowProgressEnvelopeV1Schema,
  type WorkflowInvocationLifecycleV1,
  type WorkflowProgressEnvelopeV1,
  type WorkflowRunInvocationIndexV1,
} from '@happier-dev/protocol/workflows/workflowProgressV1';
import {
  type WorkflowMaterializedLeafV1} from '@happier-dev/protocol/workflows/workflowDefinitionV1';
import { BUNDLED_AGENT_CONTRIBUTION_IDENTITIES } from '@happier-dev/agents/agent-ids';

import { createWorkflowInvocationIndexFixture } from '../fixtures/workflowRunFixtures';

/**
 * The design lab's "Prepare the 0.3 release" Run (`run-A_*`, `hold-H*`), as the canonical
 * protocol shapes the real Run owners read. Design lanes judge the composed page against
 * realistic content; the hold is a Wait inside the Changelog lane so the real review owner
 * renders it. Every shape is parsed by its Protocol schema.
 */
export type WorkflowRunDesignSceneRow = Readonly<{
  index: WorkflowRunInvocationIndexV1;
  progress: WorkflowProgressEnvelopeV1 | null;
}>;
export type WorkflowRunDesignScene = Readonly<{
  title: string;
  definition: WorkflowDefinitionV1;
  materializedLeaves: WorkflowMaterializedLeafV1[];
  rows: WorkflowRunDesignSceneRow[];
  lateRows: WorkflowRunDesignSceneRow[];
  rootId: string;
  holdId: string;
  stepProgress: Readonly<{ completed: number; total: number }>;
}>;

const doc = (text: string) => ({ text, references: [], attachments: [] });
/**
 * An object result declaring named fields in the lab's authored order (lab `run-A`). */
const fieldsResult = (fields: Readonly<Record<string, string>>, required: readonly string[] = Object.keys(fields)) => ({
  kind: 'json',
  schema: {
    type: 'object',
    properties: Object.fromEntries(
      Object.entries(fields).map(([key, title]) => [key, { type: 'string', title }]),
    ),
    required: [...required],
  },
});
const step = (
  id: string,
  name: string,
  text: string,
  result: unknown = { kind: 'text' },
) => ({
  kind: 'step',
  id,
  name,
  document: doc(text),
  input: [],
  result,
});
/** What the Changelog lane's review asks for (lab `hold-H1`). */
const changelogReviewContract = fieldsResult({
  version: 'Version',
  summary: 'Summary',
  highlights: 'Highlights',
  breaking: 'Breaking changes',
});

export function createWorkflowRunReleaseScene(
  params: Readonly<{
    runId: string;
    rootId: string;
    holdId: string;
    failed?: boolean;
    /** Z16: source-reported reset; null deliberately means no reported reset. */
    usageLimitResetAtMs?: number | null;
    /** The Changelog step finished and its published result waits for review (lab `run-A_hold`). */
    review?: boolean;
  }>,
): WorkflowRunDesignScene {
  const definition = WorkflowDefinitionV1Schema.parse({
    version: 1,
    inputs: [],
    defaults: {},
    blocks: [
      step(
        'gather',
        'Gather changes',
        'List everything merged since the previous tag. Group it by area and link each issue it closes.',
        fieldsResult({ issues: 'issues', commits: 'commits' }),
      ),
      {
        kind: 'parallel',
        id: 'lanes',
        name: 'Side by side',
        failurePolicy: 'collect_outcomes',
        branches: [
          {
            id: 'changelog',
            name: 'Changelog',
            blocks: [
              step(
                'changelog',
                'Write changelog',
                'Write the 0.3 changelog from the gathered summary. Lead with what people will notice and link every issue.',
                changelogReviewContract,
              ),
              {
                kind: 'wait',
                id: 'notes',
                name: 'Review before continuing',
                document: doc(
                  'Read the changelog draft. Is it ready to publish with the release?',
                ),
                result: changelogReviewContract,
              },
            ],
          },
          {
            id: 'issues',
            name: 'Issues',
            blocks: [
              {
                kind: 'loop',
                id: 'each-issue',
                name: 'For each issue',
                repetition: {
                  kind: 'items',
                  items: {
                    kind: 'literal',
                    value: ['#1480', '#1482', '#1487'],
                  },
                  execution: 'parallel',
                  failurePolicy: 'collect_outcomes',
                },
                body: [
                  step(
                    'check',
                    'Check the fix',
                    'Confirm the fix for this issue is merged and covered by a test.',
                  ),
                ],
              },
            ],
          },
          {
            id: 'tests',
            name: 'Tests',
            blocks: [
              step(
                'tests',
                'Run test suite',
                'Run the full test suite on the release branch and report failures.',
              ),
            ],
          },
        ],
      },
      step(
        'review',
        'Review the release',
        'Review the release notes, the issue checks and the test results together.',
      ),
      step(
        'publish',
        'Publish summary',
        'Publish a short release summary for the team.',
      ),
    ],
  });
  const claude = {
    kind: 'agent',
    identity: BUNDLED_AGENT_CONTRIBUTION_IDENTITIES.claude,
  };
  const codex = {
    kind: 'agent',
    identity: BUNDLED_AGENT_CONTRIBUTION_IDENTITIES.codex,
  };
  const leaf = (blockId: string, kind: 'step' | 'wait', agentTarget: unknown) =>
    ({
      sourceKey: '$root',
      blockId,
      kind,
      selection: agentTarget === null ? {} : { agentTarget },
      authoredWorkspace: { kind: 'inherit' },
      executionTarget: { kind: 'session' },
    }) as WorkflowMaterializedLeafV1;
  const materializedLeaves = [
    leaf('gather', 'step', claude),
    leaf('changelog', 'step', claude),
    leaf('notes', 'wait', null),
    leaf('check', 'step', codex),
    leaf('tests', 'step', codex),
    leaf('review', 'step', claude),
    leaf('publish', 'step', claude),
  ];

  // A failed Run is settled: every lane finished and only the last step failed (lab `run-A_failed`).
  const live = params.failed ? 'completed' : 'running';
  let sequence = 0;
  const rows: WorkflowRunDesignSceneRow[] = [];
  const add = (
    spec: Readonly<{
      id: string;
      parent: string | null;
      ordinal: number;
      lifecycle: WorkflowInvocationLifecycleV1;
      progress?: Omit<
        WorkflowProgressEnvelopeV1,
        'kind' | 'attempt' | 'logicalInvocationRecordId'
      >;
    }>,
  ) => {
    const index = createWorkflowInvocationIndexFixture({
      id: spec.id,
      runId: params.runId,
      sequence: String(sequence++),
      parentRecordId: spec.parent,
      memberOrdinal: String(spec.ordinal),
      attempt: '0',
      contentRevision: '7',
      lifecycle: spec.lifecycle,
    });
    const progress =
      spec.progress === undefined
        ? null
        : WorkflowProgressEnvelopeV1Schema.parse({
            kind: 'happier.workflow-progress.v1',
            attempt: '0',
            logicalInvocationRecordId: spec.id,
            ...spec.progress,
          });
    rows.push({ index, progress });
  };
  const id = (n: number) =>
    `5555${String(n).padStart(4, '0')}-5555-4555-8555-555555555555`;
  const lanes = (branchId: string) => [
    { kind: 'branch' as const, blockId: 'lanes', branchId },
  ];
  const branchFrame = (branchId: string) => ({ blockKind: 'parallel' as const, invocationPath: { blockId: 'lanes', scope: [] },
    frame: { ownerBlockId: 'lanes', source: { kind: 'branch' as const, branchId } } });
  const stepProgress = { completed: 3, total: 9 };
  add({
    id: params.rootId,
    parent: null,
    ordinal: 0,
    lifecycle: params.failed ? 'failed' : 'running',
    progress: {
      blockKind: 'root',
      invocationPath: { blockId: '$root', scope: [] },
      stepProgress,
    },
  });
  add({
    id: id(1),
    parent: params.rootId,
    ordinal: 0,
    lifecycle: 'completed',
    progress: {
      blockKind: 'step',
      invocationPath: { blockId: 'gather', scope: [] },
      result: { issues: '14 issues', commits: '38 commits' },
    },
  });
  add({ id: id(2), parent: params.rootId, ordinal: 1, lifecycle: live,
    progress: { blockKind: 'parallel', invocationPath: { blockId: 'lanes', scope: [] } } });
  add({ id: id(3), parent: id(2), ordinal: 0, lifecycle: live, progress: branchFrame('changelog') });
  add({
    id: id(4),
    parent: id(3),
    ordinal: 0,
    lifecycle: params.review ? 'waiting_for_review' : 'completed',
    progress: {
      blockKind: 'step',
      invocationPath: { blockId: 'changelog', scope: lanes('changelog') },
      ...(params.review ? { resultContract: changelogReviewContract } : {}),
      result: params.review
        ? {
            version: '0.3.0',
            summary:
              'Happier 0.3 brings workflows to every device: run a prompt as a repeatable workflow, watch each step live, and review a result before the next step uses it.',
            highlights: 'Side-by-side lanes, repeat for each, and conditions',
            breaking: 'None',
          }
        : 'Happier 0.3 brings workflows to every device: run a prompt as a repeatable workflow, watch each step live, and review a result before the next step uses it.',
    },
  });
  add({
    id: params.holdId,
    parent: id(3),
    ordinal: 1,
    lifecycle: params.failed ? 'completed' : 'waiting_for_review',
    progress: {
      blockKind: 'wait',
      invocationPath: { blockId: 'notes', scope: lanes('changelog') },
      resultContract: changelogReviewContract,
    },
  });
  add({ id: id(5), parent: id(2), ordinal: 1, lifecycle: live, progress: branchFrame('issues') });
  add({ id: id(6), parent: id(5), ordinal: 0, lifecycle: live,
    progress: { blockKind: 'loop', invocationPath: { blockId: 'each-issue', scope: lanes('issues') } } });
  for (const [item, lifecycle] of [
    [0, 'completed'],
    [1, live],
  ] as const) {
    add({
      id: id(10 + item * 2),
      parent: id(6),
      ordinal: item,
      lifecycle: live,
      progress: { blockKind: 'loop', invocationPath: { blockId: 'each-issue', scope: lanes('issues') },
        frame: { ownerBlockId: 'each-issue', source: { kind: 'item', index: String(item) } } },
    });
    add({
      id: id(11 + item * 2),
      parent: id(10 + item * 2),
      ordinal: 0,
      lifecycle,
      progress: {
        blockKind: 'step',
        invocationPath: {
          blockId: 'check',
          scope: [
            ...lanes('issues'),
            { kind: 'iteration', blockId: 'each-issue', index: item },
          ],
        },
        frame: {
          ownerBlockId: 'each-issue',
          source: { kind: 'item', index: String(item) },
        },
        ...(lifecycle === 'completed'
          ? { result: 'Fixed in #1479 and covered by the reconnect test.' }
          : {}),
      },
    });
  }
  add({ id: id(7), parent: id(2), ordinal: 2, lifecycle: live, progress: branchFrame('tests') });
  add({
    id: id(8),
    parent: id(7),
    ordinal: 0,
    lifecycle: live,
    progress: {
      blockKind: 'step',
      invocationPath: { blockId: 'tests', scope: lanes('tests') },
    },
  });
  // The steps after the lanes. A running Run has not reached them; a settled one has.
  const late: WorkflowRunDesignSceneRow[] = [];
  const lateRow = (
    n: number,
    ordinal: number,
    blockId: 'review' | 'publish',
    lifecycle: WorkflowInvocationLifecycleV1,
    detail: Record<string, unknown>,
  ) => {
    const index = createWorkflowInvocationIndexFixture({
      id: id(n),
      runId: params.runId,
      sequence: String(sequence++),
      parentRecordId: params.rootId,
      memberOrdinal: String(ordinal),
      attempt: '0',
      contentRevision: '7',
      lifecycle,
    });
    late.push({
      index,
      progress: WorkflowProgressEnvelopeV1Schema.parse({
        kind: 'happier.workflow-progress.v1',
        attempt: '0',
        logicalInvocationRecordId: index.id,
        blockKind: 'step',
        invocationPath: { blockId, scope: [] },
        ...detail,
      }),
    });
  };
  lateRow(20, 2, 'review', 'completed', {
    result: 'The notes, issue checks and test results agree. Ready to publish.',
  });
  lateRow(21, 3, 'publish', params.failed ? 'failed' : 'completed', params.failed
    ? { reason: params.usageLimitResetAtMs === undefined
      ? { code: 'step_failed', message: 'The release summary could not be published.' }
      : { code: 'session_input_failed', message: 'Current turn failed', runtimeIssueV1: {
          v: 1, scope: 'primary_session', status: 'failed', code: 'usage_limit', source: 'usage_limit',
          occurredAt: Date.parse('2026-10-19T10:28:00.000Z'), sanitizedPreview: 'Usage limit reached',
          usageLimit: { v: 1, resetAtMs: params.usageLimitResetAtMs, retryAfterMs: null, quotaScope: 'account', recoverability: 'wait' },
        } } }
    : { result: 'Published the 0.3 release summary to the team.' });
  if (params.failed) rows.push(...late);
  return {
    title: 'Prepare the 0.3 release',
    definition,
    materializedLeaves,
    rows,
    /** Rows of the steps after the lanes, which a running Run has not reached yet. */
    lateRows: params.failed ? [] : late,
    rootId: params.rootId,
    holdId: params.holdId,
    stepProgress,
  };
}
