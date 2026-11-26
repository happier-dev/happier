import * as React from 'react';
import { Pressable, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { useWorkflowSourcePeople } from '@/components/workflows/useWorkflowSourcePeople';
import { resolveWorkflowProblemPresentation } from '@/components/workflows/presentation/workflowProblemPresentation';
import { readWorkflowRunWorkStatusFacts } from '@/components/work/status/workflowWorkStatusFacts';
import {
  resolveWorkStatusTone,
  WORK_STATUS_PILL_VARIANT,
} from '@/components/work/status/resolveWorkStatusTone';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { StatusPill } from '@/components/ui/status/StatusPill';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { useSessionListRuntimeDeadlineNowMs } from '@/hooks/session/sessionListRuntimeClock';
import { useMountedShouldContinue } from '@/hooks/ui/useMountedShouldContinue';
import { Modal } from '@/modal';
import { formatAccountDisplayName } from '@/sync/domains/account/formatAccountDisplayName';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { isActionApprovalDeclinedErrorCode } from '@happier-dev/protocol/actions/actionExecutionResult';
import { WorkflowActionError } from '@/sync/domains/workflows/workflowActionError';
import {
  listMachineControlWorkflowRuns,
  stopWorkflowRunAsMachineOwner,
  type WorkflowMachineControlRun,
} from '@/sync/domains/workflows/workflowRunListActions';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';
import {
  formatRelativeTime,
  readRelativeTimeShortRefreshAtMs,
} from '@/utils/time/formatShortRelativeTime';

type SharedRunsState = Readonly<{
  runs: readonly WorkflowMachineControlRun[];
  nextCursor: string | undefined;
}>;
const EMPTY: SharedRunsState = Object.freeze({
  runs: Object.freeze([]),
  nextCursor: undefined,
});

/**
 * Other people's Workflow and Automation Runs on a Machine this Account owns, each stoppable by
 * the owner (owner decision 2026-11-26). The server returns rows only to the Machine owner and only
 * four facts per Run, so a row names who started it, when, and its state, and opens nothing.
 * Absent while there are none.
 */
export const MachineSharedWorkflowRunsSection = React.memo(
  function MachineSharedWorkflowRunsSection(
    props: Readonly<{
      machineId: string;
      lifetime: ServerAccountScopeLifetime | null;
      /** Bumped by the page's refresh. */
      refreshKey: number;
    }>,
  ) {
    const { machineId, lifetime } = props;
    const shouldContinue = useMountedShouldContinue();
    const [state, setState] = React.useState<SharedRunsState>(EMPTY);
    const [stoppingRunId, setStoppingRunId] = React.useState<string | null>(
      null,
    );
    const [loadingMore, setLoadingMore] = React.useState(false);

    const readFirstPage = React.useCallback(
      async (signal?: AbortSignal) => {
        const page = await listMachineControlWorkflowRuns({
          machineId,
          accountLifetime: lifetime,
          ...(signal ? { signal } : {}),
        });
        if (signal?.aborted || !shouldContinue()) return;
        setState({ runs: page.runs, nextCursor: page.nextCursor });
      },
      [lifetime, machineId, shouldContinue],
    );

    React.useEffect(() => {
      if (!lifetime) return;
      const controller = new AbortController();
      // A failed read keeps what the section already shows; a Machine without such Runs shows nothing.
      fireAndForget(readFirstPage(controller.signal), {
        tag: 'MachineSharedWorkflowRunsSection.read',
      });
      return () => controller.abort();
    }, [lifetime, readFirstPage, props.refreshKey]);

    const sources = React.useMemo(
      () =>
        state.runs.map((run) => ({
          kind: 'person' as const,
          accountId: run.ownerAccountId,
        })),
      [state.runs],
    );
    const { profiles } = useWorkflowSourcePeople(sources, lifetime);

    const loadMore = React.useCallback(() => {
      const cursor = state.nextCursor;
      if (cursor === undefined || loadingMore) return;
      setLoadingMore(true);
      fireAndForget(
        (async () => {
          try {
            const page = await listMachineControlWorkflowRuns({
              machineId,
              cursor,
              accountLifetime: lifetime,
            });
            if (!shouldContinue()) return;
            setState((previous) => ({
              runs: [...previous.runs, ...page.runs],
              nextCursor: page.nextCursor,
            }));
          } finally {
            if (shouldContinue()) setLoadingMore(false);
          }
        })(),
        { tag: 'MachineSharedWorkflowRunsSection.loadMore' },
      );
    }, [lifetime, loadingMore, machineId, shouldContinue, state.nextCursor]);

    const stop = React.useCallback(
      async (run: WorkflowMachineControlRun, name: string) => {
        if (stoppingRunId !== null) return;
        const confirmed = await Modal.confirm(
          t('machineDetailPage.sharedRunStopTitle', { name }),
          t('machineDetailPage.sharedRunStopBody', { name }),
          { confirmText: t('common.stop'), destructive: true },
        );
        if (!confirmed || !shouldContinue()) return;
        setStoppingRunId(run.id);
        try {
          await stopWorkflowRunAsMachineOwner({
            runId: run.id,
            machineId,
            accountLifetime: lifetime,
          });
        } catch (error) {
          if (error instanceof WorkflowActionError && isActionApprovalDeclinedErrorCode(error.rawCode)) return;
          // A Run that ended or left this Machine since the read answers with the owner's typed refusal.
          if (shouldContinue()) {
            const problem = resolveWorkflowProblemPresentation(error, 'run');
            Modal.alert(problem.title, problem.message);
          }
        } finally {
          if (shouldContinue()) setStoppingRunId(null);
        }
        // The server decides which Runs remain: one re-read after the receipt or the refusal.
        if (shouldContinue()) await readFirstPage().catch(() => undefined);
      },
      [lifetime, machineId, readFirstPage, shouldContinue, stoppingRunId],
    );

    if (state.runs.length === 0) return null;
    return (
      <ItemGroup
        title={t('machineDetailPage.sharedRunsTitle')}
        description={t('machineDetailPage.sharedRunsDescription')}
      >
        {state.runs.map((run) => {
          const profile = profiles.get(run.ownerAccountId)?.profile;
          const name =
            (profile && formatAccountDisplayName(profile)) ||
            t('accountDisplay.unnamed');
          return (
            <SharedRunRow
              key={run.id}
              run={run}
              name={name}
              stopping={stoppingRunId === run.id}
              onStop={() => {
                void stop(run, name);
              }}
            />
          );
        })}
        {state.nextCursor !== undefined ? (
          <Item
            testID="machine-shared-runs-more"
            title={t('machineDetailPage.sharedRunsShowMore')}
            showChevron={false}
            onPress={loadMore}
            disabled={loadingMore}
          />
        ) : null}
      </ItemGroup>
    );
  },
);

const SharedRunRow = React.memo(function SharedRunRow(
  props: Readonly<{
    run: WorkflowMachineControlRun;
    name: string;
    stopping: boolean;
    onStop: () => void;
  }>,
) {
  const { theme } = useUnistyles();
  const startedAtMs = Date.parse(props.run.createdAt);
  const readNextRefresh = React.useCallback(
    (nowMs: number) => readRelativeTimeShortRefreshAtMs(startedAtMs, nowMs),
    [startedAtMs],
  );
  const nowMs = useSessionListRuntimeDeadlineNowMs(
    readNextRefresh,
    Number.isFinite(startedAtMs),
  );
  const status = resolveWorkStatusTone({
    kind: 'workflow_run',
    facts: readWorkflowRunWorkStatusFacts({ state: props.run.state }),
  });
  return (
    <Item
      testID={`machine-shared-run:${props.run.id}`}
      title={props.name}
      subtitle={
        Number.isFinite(startedAtMs)
          ? t('machineDetailPage.sharedRunStarted', {
              time: formatRelativeTime(startedAtMs, nowMs),
            })
          : undefined
      }
      subtitleLines={1}
      icon={<Icon name="person" size={20} color={theme.colors.text.secondary} />}
      mode="info"
      showChevron={false}
      rightElementOutsidePressable
      rightElement={
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: theme.space.s8,
          }}
        >
          <StatusPill
            variant={WORK_STATUS_PILL_VARIANT[status.tone]}
            label={status.word}
            labelVariant="micro"
            hideDot
          />
          <Pressable
            testID={`machine-shared-run-stop:${props.run.id}`}
            accessibilityRole="button"
            accessibilityLabel={t('machineDetailPage.sharedRunStopA11y', {
              name: props.name,
            })}
            onPress={props.onStop}
            disabled={props.stopping}
            style={({ pressed }) => ({
              opacity: pressed ? motionTokens.press.opacity : 1,
            })}
          >
            {props.stopping ? (
              <ActivitySpinner
                size="small"
                color={theme.colors.text.secondary}
              />
            ) : (
              <Icon
                name="stop-circle"
                size={20}
                color={theme.colors.text.secondary}
              />
            )}
          </Pressable>
        </View>
      }
    />
  );
});
