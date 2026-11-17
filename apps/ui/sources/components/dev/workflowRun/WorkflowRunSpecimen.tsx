import * as React from 'react';
import { canStartWorkflowRunAgain } from '@/components/workflows/presentation/workflowLifecyclePresentation';
import { getStorage, useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import {
  WorkflowProgressEnvelopeV1Schema,
  type WorkflowProgressEnvelopeV1,
} from '@happier-dev/protocol/workflows/workflowProgressV1';

import {
  createWorkflowDefinitionFixture,
  createWorkflowInvocationIndexFixture,
  createWorkflowRunSummaryFixture,
} from '@/dev/testkit/fixtures/workflowRunFixtures';
import {
  WorkflowRunContent,
  type WorkflowRunDetailView,
} from '@/components/workflows/run/WorkflowRunContent';

/**
 * Dev-only specimen of Run detail (workflows lab run-R1), rendered through the real Run owners with
 * schema-parsed Run, invocation and progress records. It reaches states a QA stack cannot produce on
 * demand: a step that failed with a typed code, a succeeded Run whose step retains an older reason, and
 * an Action that failed before dispatch because its target Machine was offline (the coordinator's
 * `machine_unavailable` cause and message, WF-PREDISPATCH-1110), with Run again offered.
 * `?scene=failed|succeeded|offline`. No RPC is issued.
 */
export type WorkflowRunSpecimenScene = 'failed' | 'succeeded' | 'offline';

const definition = createWorkflowDefinitionFixture({
  blocks: [
    {
      kind: 'step',
      id: 'gather',
      name: 'Gather changes',
      document: {
        text: 'Collect closed issues and commits since 0.2',
        references: [],
        attachments: [],
      },
      input: [],
      result: { kind: 'text' },
    },
    {
      kind: 'step',
      id: 'tests',
      name: 'Run test suite',
      document: {
        text: 'Run the full test suite and report whether it passed',
        references: [],
        attachments: [],
      },
      input: [],
      result: { kind: 'text' },
    },
    {
      kind: 'step',
      id: 'publish',
      name: 'Publish summary',
      document: {
        text: 'Publish the release summary',
        references: [],
        attachments: [],
      },
      input: [],
      result: { kind: 'text' },
    },
  ],
});

/**
 * Every Run has one root invocation; its steps are its members. Without it each step projects
 * as the Run itself and every Activity row reads "Untitled run".
 */
function rootInvocation(lifecycle: 'completed' | 'failed') {
  return createWorkflowInvocationIndexFixture({
    id: 'inv-root',
    sequence: '0',
    memberOrdinal: '0',
    lifecycle,
  });
}

const rootProgress = WorkflowProgressEnvelopeV1Schema.parse({
  kind: 'happier.workflow-progress.v1',
  invocationPath: { blockId: '$root', scope: [] },
  blockKind: 'root',
  attempt: '0',
  logicalInvocationRecordId: 'inv-root',
});

function progress(
  blockId: string,
  invocationId: string,
  extra: Readonly<Record<string, unknown>> = {},
): WorkflowProgressEnvelopeV1 {
  return WorkflowProgressEnvelopeV1Schema.parse({
    kind: 'happier.workflow-progress.v1',
    invocationPath: { blockId, scope: [] },
    blockKind: 'step',
    attempt: '0',
    logicalInvocationRecordId: invocationId,
    ...extra,
  });
}

const offlineDefinition = createWorkflowDefinitionFixture({
  blocks: [
    {
      kind: 'action',
      id: 'close-preview',
      name: 'Close preview',
      actionId: 'deployments.teardown',
      input: {},
    },
  ],
});

function offlineSceneData() {
  return {
    run: createWorkflowRunSummaryFixture({
      id: 'run-specimen-offline',
      state: 'failed',
      workflowCustodyState: 'settled',
      availability: { pause: false, cancel: false },
    }),
    invocations: [
      rootInvocation('failed'),
      createWorkflowInvocationIndexFixture({
        id: 'inv-close',
        parentRecordId: 'inv-root',
        sequence: '1',
        memberOrdinal: '0',
        lifecycle: 'failed',
      }),
    ],
    byId: new Map<string, WorkflowProgressEnvelopeV1>([
      ['inv-root', rootProgress],
      [
        'inv-close',
        WorkflowProgressEnvelopeV1Schema.parse({
          kind: 'happier.workflow-progress.v1',
          invocationPath: { blockId: 'close-preview', scope: [] },
          blockKind: 'action',
          attempt: '0',
          logicalInvocationRecordId: 'inv-close',
          reason: {
            code: 'machine_unavailable',
            message: "The target Machine was offline; Retry when it's back.",
          },
        }),
      ],
    ]),
  };
}

function sceneData(scene: WorkflowRunSpecimenScene) {
  if (scene === 'offline') return offlineSceneData();
  const failed = scene === 'failed';
  const invocations = [
    rootInvocation(failed ? 'failed' : 'completed'),
    createWorkflowInvocationIndexFixture({
      id: 'inv-gather',
      parentRecordId: 'inv-root',
      sequence: '1',
      memberOrdinal: '0',
      lifecycle: 'completed',
    }),
    createWorkflowInvocationIndexFixture({
      id: 'inv-tests',
      parentRecordId: 'inv-root',
      sequence: '2',
      memberOrdinal: '1',
      lifecycle: failed ? 'failed' : 'completed',
    }),
    createWorkflowInvocationIndexFixture({
      id: 'inv-publish',
      parentRecordId: 'inv-root',
      sequence: '3',
      memberOrdinal: '2',
      lifecycle: failed ? 'skipped' : 'completed',
    }),
  ];
  const byId = new Map<string, WorkflowProgressEnvelopeV1>([
    ['inv-root', rootProgress],
    [
      'inv-gather',
      progress('gather', 'inv-gather', {
        result: 'Found 500 closed issues and 1,284 commits.',
      }),
    ],
    [
      'inv-tests',
      progress(
        'tests',
        'inv-tests',
        failed
          ? {
              reason: {
                code: 'result_contract_violation',
                message:
                  'The step finished, but its result was missing the required field Passed, so later steps couldn’t use it.',
              },
            }
          : // A succeeded step that still carries an older attempt's reason (FX-51's stale storage_unavailable).
            ({
              result: '1,904 tests ran; all passed.',
              reason: {
                code: 'storage_unavailable',
                message: 'The Run store could not be written.',
              },
            }),
      ),
    ],
    [
      'inv-publish',
      progress(
        'publish',
        'inv-publish',
        failed
          ? { reason: { code: 'condition_false' } }
          : ({ result: 'Published.' }),
      ),
    ],
  ]);
  return {
    run: createWorkflowRunSummaryFixture({
      id: `run-specimen-${scene}`,
      state: failed ? 'failed' : 'succeeded',
      workflowCustodyState: 'settled',
      availability: { pause: false, cancel: false },
    }),
    invocations,
    byId,
  };
}

export function WorkflowRunSpecimen(
  props: Readonly<{ scene: WorkflowRunSpecimenScene }>,
) {
  const data = React.useMemo(() => sceneData(props.scene), [props.scene]);
  // The real route publishes its exact invocation reads before Content renders; Activity reads that same keyed
  // owner, so the specimen publishes its fixture there too (opened rows carry their progress).
  const scope = useActiveServerAccountScope(null);
  React.useLayoutEffect(() => {
    getStorage().getState().applyWorkflowRunInvocationPage({ runId: data.run.id, scope,
      invocations: data.invocations.map((index) => {
        const progress = data.byId.get(index.id);
        return progress === undefined ? index : { ...index, opened: { index, progress, parentRevision: data.run.revision } };
      }),
      mode: 'replace', nextCursor: null, parentRevision: data.run.revision });
  }, [data, scope]);
  const offline = props.scene === 'offline';
  const [selected, setSelected] = React.useState<string | null>(
    offline ? 'inv-close' : 'inv-tests',
  );
  const [view, setView] = React.useState<WorkflowRunDetailView>('activity');
  return (
    <View testID="workflow-run-specimen" style={styles.root}>
      <WorkflowRunContent
        active={false}
        run={data.run}
        title={offline ? 'Close preview pr-482' : 'Prepare the 0.3 release'}
        machineName="MacBook Pro"
        machineReachable={!offline}
        definition={offline ? offlineDefinition : definition}
        invocations={data.invocations}
        invocationsLoaded
        invocationHistoryComplete
        firstFailedInvocationId={
          offline ? 'inv-close' : props.scene === 'failed' ? 'inv-tests' : null
        }
        firstFailedInvocationResolution="resolved"
        selectedInvocationId={selected}
        selectedInvocationProgress={
          selected === null ? null : (data.byId.get(selected) ?? null)
        }
        invocationProgressById={data.byId}
        onSelectInvocation={setSelected}
        onDeselectInvocation={() => setSelected(null)}
        view={view}
        onChangeView={setView}
        // The offline scene offers Run again exactly when the Run-again owner would: never while its Machine is away.
        {...(offline && canStartWorkflowRunAgain({ run: data.run, canEdit: true, hasAcceptedContext: true,
          machineReachable: !offline }) ? { onRunAgain: () => {} } : {})}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, backgroundColor: theme.colors.surface.base },
}));
