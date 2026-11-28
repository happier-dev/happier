import * as React from 'react';
import type { DatabaseStatsObservationV1, DatabaseStatsReadV1, DatabaseTargetV1 } from '@happier-dev/plugin-sdk/database';
import { DATABASE_ACTIVITY_CANCEL_ACTION_ID_V1, databaseActionLocalIdV1 } from '@happier-dev/database-protocol';
import { projectNativeJsonValueForTransport } from '@happier-dev/plugin-sdk/protocol';
import {
  Collection,
  useHappierCollection,
  type CollectionAnatomy,
  type CollectionField,
  type CollectionRowActions,
} from '@happier-dev/plugin-ui/components';
import { isPluginActionConfirmationDeclined, type PluginActionExecution } from '@happier-dev/plugin-ui/hostApi';
import {
  Action,
  ErrorState,
  FreshnessLine,
  Metric,
  Row,
  Stack,
  Text,
  usePluginTranslation,
  type PluginTranslate,
} from '@happier-dev/plugin-ui';
import { type useDatabaseActivity, useWorkbenchInstance } from '../../hooks.js';
import { databaseActionSettlement } from '../../actionSettlement.js';
import { WORKBENCH_DISPLAY_PAGE_ROWS } from '../mount.js';
import { displayDatabaseStatementShape, formatElapsed } from './format.js';
import { InsightsSetup } from './InsightsSetup.js';

type ActivityObservation = Extract<
  DatabaseStatsObservationV1,
  { status: 'available'; group: 'activity' }
>;
type Session = ActivityObservation['data'][number];
type SessionView = Readonly<{
  session: Session;
  runningMs: number | null;
  blocking: number;
  waiting: boolean;
}>;

export const ACTIVITY_READ: Extract<
  DatabaseStatsReadV1,
  { group: 'activity' }
> = {
  kind: 'stats.read',
  group: 'activity',
  selection: { page: { rows: WORKBENCH_DISPLAY_PAGE_ROWS, offset: 0 } },
};
const EMPTY_SET: ReadonlySet<string> = new Set();

/** How long each session has run at the sample's own time, and who it holds up. */
export function projectActivity(
  observation: ActivityObservation,
): readonly SessionView[] {
  const blockedBy = new Map<string, number>();
  for (const session of observation.data) {
    for (const key of session.blockingKeys)
      blockedBy.set(key, (blockedBy.get(key) ?? 0) + 1);
  }
  const views = observation.data.map((session) => {
    const started = session.queryStartedAt ?? session.transactionStartedAt;
    const at = started ? Date.parse(started) : Number.NaN;
    return {
      session,
      runningMs: Number.isFinite(at)
        ? Math.max(0, observation.observedAtMs - at)
        : null,
      blocking: blockedBy.get(session.key) ?? 0,
      waiting: session.blockingKeys.length > 0,
    };
  });
  // Who holds others up leads; then the longest running.
  return views.sort(
    (a, b) =>
      b.blocking - a.blocking || (b.runningMs ?? -1) - (a.runningMs ?? -1),
  );
}

function stateWord(session: Session, translate: PluginTranslate): string {
  switch (session.state) {
    case 'active':
      return translate('plugins.database.activity.working', 'Working');
    case 'idle':
      return translate('plugins.database.activity.idle', 'Idle');
    case 'idle in transaction':
      return translate(
        'plugins.database.activity.idleInTransaction',
        'Idle in a transaction',
      );
    case 'idle in transaction (aborted)':
      return translate(
        'plugins.database.activity.aborted',
        'Idle in a failed transaction',
      );
    default:
      return (
        session.state ??
        translate('plugins.database.activity.unknown', 'Unknown')
      );
  }
}

function waitText(view: SessionView, translate: PluginTranslate): string {
  const lock = view.session.locks?.find((item) => !item.granted);
  if (lock)
    return translate('plugins.database.activity.lockOn', 'lock · {relation}', {
      relation: lock.relation ?? lock.mode,
    });
  return (
    [view.session.waitClass, view.session.waitEvent]
      .filter(Boolean)
      .join(' · ') || '—'
  );
}

/**
 * The Connections metric: how many sessions, and how they split (working, idle, idle in a transaction). Activity and
 * the database Overview draw this one metric.
 */
export function ConnectionsMetric(props: Readonly<{ sessions: readonly Session[] }>) {
  const translate = usePluginTranslation();
  const counts = { working: 0, idle: 0, transaction: 0 };
  for (const session of props.sessions) {
    if (session.state === 'active') counts.working += 1;
    else if (session.state?.startsWith('idle in transaction'))
      counts.transaction += 1;
    else if (session.state === 'idle') counts.idle += 1;
  }
  const breakdown = [
    counts.working
      ? translate('plugins.database.activity.nWorking', '{n} working', {
          n: String(counts.working),
        })
      : null,
    counts.idle
      ? translate('plugins.database.activity.nIdle', '{n} idle', {
          n: String(counts.idle),
        })
      : null,
    counts.transaction
      ? translate(
          'plugins.database.activity.nTransaction',
          '{n} idle in a transaction',
          { n: String(counts.transaction) },
        )
      : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <Metric
      size="stat"
      showLabel
      label={translate(
        'plugins.database.activity.connections',
        'Connections',
      )}
      value={String(props.sessions.length)}
      {...(breakdown ? { caption: breakdown } : {})}
    />
  );
}

function Summary(props: Readonly<{ views: readonly SessionView[] }>) {
  const translate = usePluginTranslation();
  const sessions = React.useMemo(() => props.views.map((view) => view.session), [props.views]);
  const longest = props.views.reduce<SessionView | null>(
    (held, view) =>
      view.runningMs !== null && view.runningMs > (held?.runningMs ?? -1)
        ? view
        : held,
    null,
  );
  const waiting = props.views.filter((view) => view.waiting).length;
  return (
    <Row gap="large" wrap>
      <ConnectionsMetric sessions={sessions} />
      {longest && longest.runningMs !== null ? (
        <Metric
          size="stat"
      showLabel
          label={translate(
            'plugins.database.activity.longest',
            'Longest running',
          )}
          value={formatElapsed(longest.runningMs)}
          caption={stateWord(longest.session, translate)}
        />
      ) : null}
      <Metric
        size="stat"
      showLabel
        label={translate(
          'plugins.database.activity.waitingOnLocks',
          'Waiting on others',
        )}
        value={String(waiting)}
      />
    </Row>
  );
}

function CancelActivity({ target, activityKey, queryStartedAt }: Readonly<{
  target: DatabaseTargetV1;
  activityKey: string;
  queryStartedAt: string;
}>) {
  const t = usePluginTranslation();
  const [notice, setNotice] = React.useState<Readonly<{ text: string; disable?: boolean; execution?: never }>
    | Readonly<{ execution: PluginActionExecution; disable?: never }>
    | null>(null);
  const input = projectNativeJsonValueForTransport({
    target, operation: 'activity.cancel', activityKey, queryStartedAt,
  });
  return <Stack gap="small">
    <Action.Control
      action={databaseActionLocalIdV1(DATABASE_ACTIVITY_CANCEL_ACTION_ID_V1)}
      title={t('plugins.database.activity.cancel', 'Cancel activity')}
      variant="destructive"
      disabled={notice?.disable === true}
      reviewedInput={input}
      controller={{
        prepare: async () => ({ input }),
        onSettled(execution) {
          const settled = databaseActionSettlement(execution, 'activity.cancel');
          if (isPluginActionConfirmationDeclined(settled)) return;
          if (settled.status === 'pending') {
            setNotice({ text: t('plugins.database.activity.cancelPending', 'Waiting for approval.'), disable: true });
          } else if (settled.status === 'success' && settled.result.ok && settled.result.operation === 'activity.cancel') {
            const { status } = settled.result;
            setNotice({
              text: status === 'signal_sent' ? t('plugins.database.activity.cancelSent', 'Cancellation requested.')
                : status === 'activity_ended' ? t('plugins.database.activity.cancelEnded', 'This query has already ended.')
                : t('plugins.database.activity.cancelFailed', 'The database could not cancel this query.'),
              disable: status !== 'signal_failed',
            });
          } else if ('code' in settled) {
            setNotice({ execution: settled });
          } else {
            setNotice({ text: t('plugins.database.activity.cancelUnconfirmed', 'Cancellation could not be confirmed.') });
          }
        },
      }}
    />
    {notice?.execution ? <Action.Failure execution={notice.execution} />
      : notice ? <Text tone="secondary" value={notice.text} /> : null}
  </Stack>;
}

export function ActivityView(props: Readonly<{
  targetKey: string;
  activity: ReturnType<typeof useDatabaseActivity>;
}>) {
  const translate = usePluginTranslation();
  const descriptor = useWorkbenchInstance().target(props.targetKey);
  const canCancel = descriptor.access?.canWrite === true
    && descriptor.capabilities.some(capability => capability.operation === 'activity.cancel' && capability.available);
  const rowActions = React.useCallback(({ session }: SessionView): CollectionRowActions => {
    if (session.state !== 'active' || !session.queryStartedAt) return {};
    return { accessory: <CancelActivity key={session.queryStartedAt}
      target={descriptor.target} activityKey={session.key} queryStartedAt={session.queryStartedAt} /> };
  }, [descriptor.target]);
  const { activity } = props;
  const observation = activity.observation;
  const available =
    observation?.status === 'available' && observation.group === 'activity'
      ? observation
      : null;
  const views = React.useMemo(
    () => (available ? projectActivity(available) : []),
    [available],
  );
  const model = useHappierCollection({
    items: views,
    keyOf: (view) => view.session.key,
    // Nothing opens from a row here; the record is the whole answer.
    openKey: null,
    onOpenChange: () => {},
  });
  const anatomy = React.useMemo<CollectionAnatomy<SessionView>>(() => {
    const fields: CollectionField<SessionView>[] = [
      {
        key: 'running',
        title: translate('plugins.database.activity.runningFor', 'Running for'),
        minWidth: 100,
        priority: 2,
        align: 'end',
        render: (view) => (
          <Text
            variant="body"
            tone={view.blocking > 0 ? 'warning' : 'neutral'}
            value={
              view.runningMs === null ? '—' : formatElapsed(view.runningMs)
            }
          />
        ),
      },
      {
        key: 'waiting',
        title: translate('plugins.database.activity.waitingOn', 'Waiting on'),
        minWidth: 120,
        priority: 1,
        align: 'end',
        render: (view) => (
          <Text
            variant="body"
            tone="secondary"
            value={waitText(view, translate)}
          />
        ),
      },
    ];
    // What the session runs, then who it holds up: the list row's second line, and the rest of the table row's
    // title line, where a table draws no second line (a blocker never reads as a bare "Idle in a transaction").
    const line = (view: SessionView): string | null =>
      [
        (view.session.shape === undefined ? undefined : displayDatabaseStatementShape(view.session.shape))
          ?? view.session.omittedTextReason ?? null,
        view.blocking === 1
          ? translate('plugins.database.activity.blockingOne', 'Blocking 1 other')
          : view.blocking > 1
            ? translate(
                'plugins.database.activity.blocking',
                'Blocking {n} others',
                { n: String(view.blocking) },
              )
            : null,
      ]
        .filter(Boolean)
        .join(' · ') || null;
    return {
      glyph: () => null,
      loadingGlyph: false,
      title: (view) => stateWord(view.session, translate),
      titleSuffix: line,
      byline: line,
      fields,
      accessibilityLabel: (view) => [stateWord(view.session, translate), line(view)].filter(Boolean).join(', '),
      columnTitles: {
        title: translate('plugins.database.activity.session', 'Session'),
      },
    };
  }, [translate]);
  if (observation?.status === 'unavailable')
    return <InsightsSetup observation={observation} />;
  if (!activity.supported) {
    return (
      <Text
        tone="secondary"
        value={translate(
          'plugins.database.activity.unsupported',
          'Live activity isn’t available in this window.',
        )}
      />
    );
  }
  const offlineReason = activity.offline
    ? translate('plugins.database.activity.machineOffline', 'The database’s machine is offline.')
    : undefined;
  if (!available && offlineReason) return <ErrorState kind="unavailable" title={offlineReason} />;
  if (!available && activity.error) {
    return (
      <ErrorState
        kind="unavailable"
        title={translate(
          'plugins.database.activity.failed',
          'Activity could not be read',
        )}
        details={
          activity.error instanceof Error ? activity.error.message : undefined
        }
        onRetry={activity.refresh}
        retryLabel={translate('plugins.database.retry', 'Try again')}
      />
    );
  }
  return (
    <Stack gap="large" grow>
      {available && (offlineReason || activity.error) ? (
        <FreshnessLine
          asOf={available.observedAtMs}
          tone="warning"
          reason={offlineReason ?? translate(
            'plugins.database.activity.stale',
            'These are the last numbers Happier saw',
          )}
          action={offlineReason ? undefined : {
            label: translate('plugins.database.retry', 'Try again'),
            onPress: () => void activity.refresh(),
          }}
        />
      ) : null}
      {available ? <Summary views={views} /> : null}
      <Collection
        accessibilityLabel={translate(
          'plugins.database.activity.runningNow',
          'Running now',
        )}
        title={translate('plugins.database.activity.runningNow', 'Running now')}
        model={model}
        anatomy={anatomy}
        presentation="table"
        {...(canCancel ? { useRowActions: rowActions } : {})}
        collapsedGroups={EMPTY_SET}
        loading={!available}
        empty={
          <Text
            tone="secondary"
            value={translate(
              'plugins.database.activity.none',
              'Nothing is running right now',
            )}
          />
        }
        minListWidth={420}
        minDetailWidth={320}
        preferredListRatio={1}
      />
    </Stack>
  );
}
