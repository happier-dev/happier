import * as React from 'react';
import type { WorkflowRunSummaryV1 } from '@happier-dev/protocol/workflows/workflowProgressV1';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Icon } from '@/components/ui/icons/Icon';
import {
  formatWorkflowRunDisplayName,
  resolveWorkflowRunDisplayName,
} from '@/components/workflows/presentation/workflowRunDisplayName';
import { describeWorkflowRunProgress } from '@/components/workflows/presentation/workflowRunProgress';
import { formatWorkflowRunStateLabel } from '@/components/workflows/run/workflowRunDetailPresentation';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { createWorkflowRunRoute } from '@/sync/domains/workflows/workflowRunRoute';
import { useWorkflowRun } from '@/sync/store/hooks';
import { t } from '@/text';
import { useUnistyles } from 'react-native-unistyles';

/**
 * "Started from it" (lab `events` detail): the Runs this exact fact started, from the occurrence owner's join over the
 * already demanded Run page. Nothing renders while no Run names this fact as its cause.
 */
export const WorkflowEventStartedRuns = React.memo(
  function WorkflowEventStartedRuns(
    props: Readonly<{
      runs: readonly WorkflowRunSummaryV1[];
      scope: ServerAccountScope | null;
      testID: string;
    }>,
  ) {
    if (props.runs.length === 0) return null;
    return (
      <ItemGroup
        testID={`${props.testID}:started`}
        title={t('workflows.events.startedFromIt')}
      >
        {props.runs.map((run) => (
          <StartedRunRow
            key={run.id}
            run={run}
            scope={props.scope}
            testID={`${props.testID}:started:${run.id}`}
          />
        ))}
      </ItemGroup>
    );
  },
);

/** One Run: its name from the Run label owner, its lifecycle word and step progress, and a press that opens it. */
const StartedRunRow = React.memo(function StartedRunRow(
  props: Readonly<{
    run: WorkflowRunSummaryV1;
    scope: ServerAccountScope | null;
    testID: string;
  }>,
) {
  const { theme } = useUnistyles();
  const router = useRouter();
  const body = useWorkflowRun(props.run.id, { scope: props.scope });
  const name =
    body === null
      ? t('workflows.events.someWorkflow')
      : formatWorkflowRunDisplayName(
          resolveWorkflowRunDisplayName(body.metadata),
        );
  const progress =
    props.run.state === 'running'
      ? describeWorkflowRunProgress(props.run.stepProgress)
      : null;
  const state = formatWorkflowRunStateLabel(props.run.state);
  const serverId = props.scope?.serverId ?? null;
  return (
    <Item
      testID={props.testID}
      title={name}
      subtitle={progress === null ? state : `${state} · ${progress}`}
      icon={
        <Icon
          name="tree-structure"
          size={18}
          color={theme.colors.text.secondary}
        />
      }
      onPress={() =>
        router.push(createWorkflowRunRoute(props.run.id, serverId) as never)
      }
    />
  );
});
