import * as React from 'react';
import type { DatabaseStatsObservationV1, DatabaseStatsReadV1 } from '@happier-dev/plugin-sdk/database';
import {
  Collection,
  useHappierCollection,
  type CollectionAnatomy,
  type CollectionField,
} from '@happier-dev/plugin-ui/components';
import { usePluginSurfaceActivity } from '@happier-dev/plugin-ui/hostApi';
import {
  ErrorState,
  FreshnessLine,
  Metric,
  Row,
  Stack,
  Text,
  usePluginTranslation,
  type PluginTranslate,
} from '@happier-dev/plugin-ui';
import { useDatabaseActivity } from '../../hooks.js';
import { WORKBENCH_DISPLAY_PAGE_ROWS } from '../mount.js';
import { formatElapsed } from './format.js';
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

/**
 * Live activity: refreshed by the host's presented-demand owner only while this view is on screen, and stopped
 * when it is hidden or closed (R13, D21). Stop (database.activity.cancel) joins the blocking row once registered.
 */
export function ActivityView(props: Readonly<{ targetKey: string }>) {
  const translate = usePluginTranslation();
  const presented = usePluginSurfaceActivity().active;
  const activity = useDatabaseActivity(
    props.targetKey,
    ACTIVITY_READ,
    presented,
  );
  const observation = activity.observation as
    | DatabaseStatsObservationV1
    | undefined;
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
    return {
      glyph: () => null,
      loadingGlyph: false,
      title: (view) => stateWord(view.session, translate),
      byline: (view) =>
        [
          view.session.shape ?? view.session.omittedTextReason ?? null,
          view.blocking > 0
            ? translate(
                'plugins.database.activity.blocking',
                'Blocking {n} others',
                { n: String(view.blocking) },
              )
            : null,
        ]
          .filter(Boolean)
          .join(' · ') || null,
      fields,
      accessibilityLabel: (view) => stateWord(view.session, translate),
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
      {available && activity.error ? (
        <FreshnessLine
          asOf={available.observedAtMs}
          tone="warning"
          reason={translate(
            'plugins.database.activity.stale',
            'These are the last numbers Happier saw',
          )}
          action={{
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
