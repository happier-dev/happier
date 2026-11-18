import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import {
  Timeline,
  type TimelineItemContent,
} from '@happier-dev/plugin-ui/components';
import type { DeploymentActivityItemV1 } from '@happier-dev/deployments';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useDiscussionParticipantProfiles } from '@/components/discussions/useDiscussionParticipantProfiles';
import {
  describeActionOperationStatusLabel,
  resolveActionOperationStatus,
} from '@/components/inbox/actionOperations/actionOperationPresentation';
import { openActionOperationDetail } from '@/components/inbox/actionOperations/openActionOperationDetail';
import { CorePluginUiPresentationScope } from '@/components/plugins/surfaces/CorePluginUiPresentationScope';
import { deploymentEnvironmentRoute } from '@/components/projects/deployments/deploymentNavigation';
import {
  deploymentRevisionLabel,
  deploymentStateLabel,
  deploymentWorkStatus,
} from '@/components/projects/deployments/deploymentPresentation';
import { useDeploymentInventory } from '@/components/projects/deployments/useDeploymentProject';
import { useDeploymentActorPresentations } from '@/components/projects/deployments/useDeploymentActorPresentations';
import { MainScreenHeader } from '@/components/navigation/shell/MainScreenHeader';
import { Avatar } from '@/components/ui/avatar/Avatar';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { Icon } from '@/components/ui/icons/Icon';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { SkeletonRows } from '@/components/ui/lists/SkeletonRows';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { SelectionListFilterChips } from '@/components/ui/selectionList/SelectionListFilterChips';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { resolveWorkStatusTone } from '@/components/work/status/resolveWorkStatusTone';
import { WorkStatusGlyph } from '@/components/work/status/WorkStatusGlyph';
import { resolveAccountActorPresentation } from '@/sync/domains/account/accountActorPresentation';
import type { ServerAccountScope, ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { buildSessionListDateGroups } from '@/sync/domains/session/listing/sessionListDateGroups';
import {
  useActiveServerAccountScopeLifetime,
  useMachineListForServerSelection,
} from '@/sync/domains/state/storage';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { useServerScopedMachineLabel } from '@/sync/store/hooks';
import { getPreferredLanguage, t } from '@/text';
import { formatWithCachedDateTimeFormatter } from '@/utils/datetime/cachedIntlFormatters';
import { useOptionalScreenIsFocused } from '@/utils/navigation/useOptionalScreenIsFocused';
import { getSettledMachineDisplayName } from '@/utils/sessions/machineDisplayNames';

import { activityActorView, activityHeadingWithoutActor, activityItemActor, type ActivityActorView } from './machineFleetActivityRows';
import { FLEET_ACTIVITY_WHEN, fleetActivityWhenRange, type FleetActivityWhen } from './fleetActivityFilters';
import { useFleetActivityPage } from './useFleetActivityPage';

const s = 'machineFleetActivity' as const;
const NO_TITLES: ReadonlyMap<string, string> = new Map();
/** The actor's mark on the rail: an avatar for a person, the same size as the rail's glyphs. */
const MARK_PX = 18;
const ALL_MACHINES = '__all__';
const ANYONE = '__anyone__';
const EVERYTHING = '__everything__';
const ANY_TIME = Object.freeze({ choice: 'any' as FleetActivityWhen, range: Object.freeze({}) });
const NO_SCOPE = Object.freeze({ serverId: '', accountId: '' });
const UNKNOWN_ACTOR: ActivityActorView = Object.freeze({ kind: null, name: null, avatar: null });

function whenLabel(choice: FleetActivityWhen): string {
  switch (choice) {
    case 'any':
      return t(`${s}.whenAny`);
    case 'today':
      return t(`${s}.whenToday`);
    case '7d':
      return t(`${s}.when7d`);
    case '30d':
      return t(`${s}.when30d`);
  }
}

type MachineChoice = Readonly<{ id: string; label: string }>;

const selectMachines = (() => {
  let previous: readonly MachineChoice[] = [];
  return (machines: readonly Machine[]): readonly MachineChoice[] => {
    const next = machines.map((machine) => ({
      id: machine.id,
      label: getSettledMachineDisplayName(machine) ?? machine.id,
    }));
    if (
      next.length === previous.length &&
      next.every(
        (choice, index) =>
          choice.id === previous[index]!.id &&
          choice.label === previous[index]!.label,
      )
    )
      return previous;
    previous = next;
    return next;
  };
})();

const formatClock = (ms: number) =>
  formatWithCachedDateTimeFormatter(ms, getPreferredLanguage(), {
    hour: 'numeric',
    minute: '2-digit',
  });

/**
 * Machines → Activity (pfc-redesign fAct): what people, agents and workflows did on this Home's Machines and services,
 * newest first, one card of day-grouped Timeline rows (the actor first, the object in ink, the time right). Deploy
 * receipts and Machine Action operations come from the one activity read, narrowed by Machine through that read.
 * History only; what needs you stays in Inbox. A row opens its receipt or its operation.
 */
export function MachineFleetActivityView() {
  const router = useRouter();
  const lifetime = useActiveServerAccountScopeLifetime();
  const serverId = lifetime?.scope.serverId ?? '';
  const layoutPresented = useLayoutPresentationActive();
  const focused = useOptionalScreenIsFocused() !== false;
  const presented = layoutPresented && focused;
  const machines = useMachineListForServerSelection(serverId, selectMachines);
  const machineIds = React.useMemo(
    () => machines.map((machine) => machine.id),
    [machines],
  );
  const [machineId, setMachineId] = React.useState<string | null>(null);
  const [actorAccountId, setActorAccountId] = React.useState<string | null>(null);
  const [kind, setKind] = React.useState<'receipt' | 'operation' | null>(null);
  const [when, setWhen] = React.useState<Readonly<{ choice: FleetActivityWhen; range: ReturnType<typeof fleetActivityWhenRange> }>>(ANY_TIME);
  const filter = React.useMemo(
    () => ({
      machineId,
      ...(actorAccountId ? { actorAccountId } : {}),
      ...(kind ? { kind } : {}),
      ...when.range,
    }),
    [actorAccountId, kind, machineId, when],
  );
  const { state, loadMore, retry } = useFleetActivityPage(
    lifetime,
    machineIds,
    presented,
    filter,
  );
  const demand = React.useMemo(
    () => ({ mounted: true, visible: presented, focused: presented }),
    [presented],
  );
  const inventory = useDeploymentInventory(lifetime, demand);
  const inventoryItems = inventory.snapshot.value?.items;
  const titles = React.useMemo(
    () =>
      inventoryItems
        ? new Map(
            inventoryItems.map((item) => [item.environment.id, item.title]),
          )
        : NO_TITLES,
    [inventoryItems],
  );
  const days = React.useMemo(
    () =>
      buildSessionListDateGroups({
        items: state.items,
        readMeaningfulActivityAt: (item) => item.requestedAtMs,
      }),
    [state.items],
  );
  // People are named by the one profile owner, read once for the Accounts this page shows (and the chosen one).
  const accountIds = React.useMemo(
    () => [
      ...new Set([
        ...(actorAccountId ? [actorAccountId] : []),
        // Person actors' avatars come from the same profile read.
        ...state.items.flatMap((item) => {
          const actor = activityItemActor(item);
          return actor?.actorKind === 'person' ? [actor.accountId] : [];
        }),
        ...state.items.flatMap((item) =>
          item.kind === 'receipt'
            ? [item.receipt.requestedByAccountId]
            : item.operation.scope.sessionId
              ? []
              : [item.operation.scope.accountId],
        ),
      ]),
    ],
    [actorAccountId, state.items],
  );
  const profiles = useDiscussionParticipantProfiles({
    scope: lifetime?.scope ?? NO_SCOPE,
    roster: null,
    accountIds,
    enabled: presented && lifetime !== null,
    accountLifetime: lifetime,
  });
  const people = React.useMemo(
    () =>
      accountIds.flatMap((id) => {
        const actor = profiles.accounts.get(id);
        if (!actor || !lifetime) return [];
        const presentation = resolveAccountActorPresentation(actor, lifetime.scope);
        return [{ id, label: presentation.name, self: presentation.isSelf }];
      }).sort((a, b) => Number(b.self) - Number(a.self)),
    [accountIds, lifetime, profiles.accounts],
  );
  // Who did each row is its captured actor through the one actor display owner (owner ruling 11-15 05:14Z); the
  // requester only feeds the Who filter above. Unknown history stays unknown.
  const itemActors = React.useMemo(() => state.items.map(activityItemActor), [state.items]);
  const actorPresentations = useDeploymentActorPresentations({ actors: itemActors, scope: lifetime?.scope ?? NO_SCOPE,
    accountLifetime: lifetime, active: presented && lifetime !== null });
  const actors = React.useMemo(() => new Map(state.items.map((item, index) => [item.id,
    activityActorView(itemActors[index], actorPresentations[index], lifetime, profiles.accounts)] as const)),
  [actorPresentations, itemActors, lifetime, profiles.accounts, state.items]);
  const openReceipt = React.useCallback(
    (environmentId: string, projectSourceId: string, deploymentId: string) =>
      router.push(
        deploymentEnvironmentRoute({
          serverId,
          projectSourceId,
          environmentId,
          deploymentId,
        }) as never,
      ),
    [router, serverId],
  );
  // Every filter narrows the activity read itself (FleetActivityFilter); the page never filters rows it holds.
  const filters = React.useMemo(
    () => [
      {
        id: 'machines.activity.who',
        testID: 'machines.activity.filter.who',
        label: t(`${s}.filterWho`),
        showLabel: true,
        active: actorAccountId !== null,
        selectedId: actorAccountId ?? ANYONE,
        options: [{ id: ANYONE, label: t(`${s}.whoAnyone`) }, ...people.map((person) => ({ id: person.id, label: person.label }))],
        onChange: (id: string) => setActorAccountId(id === ANYONE ? null : id),
      },
      {
        id: 'machines.activity.what',
        testID: 'machines.activity.filter.what',
        label: t(`${s}.filterWhat`),
        showLabel: true,
        active: kind !== null,
        selectedId: kind ?? EVERYTHING,
        options: [
          { id: EVERYTHING, label: t(`${s}.whatEverything`) },
          { id: 'receipt', label: t(`${s}.whatDeploys`) },
          { id: 'operation', label: t(`${s}.whatActions`) },
        ],
        onChange: (id: string) => setKind(id === 'receipt' || id === 'operation' ? id : null),
      },
      {
        id: 'machines.activity.machine',
        testID: 'machines.activity.filter.machine',
        label: t(`${s}.filterMachine`),
        showLabel: true,
        active: machineId !== null,
        selectedId: machineId ?? ALL_MACHINES,
        options: [
          { id: ALL_MACHINES, label: t(`${s}.filterAll`) },
          ...machines.map((machine) => ({
            id: machine.id,
            label: machine.label,
          })),
        ],
        onChange: (id: string) => setMachineId(id === ALL_MACHINES ? null : id),
      },
      {
        id: 'machines.activity.when',
        testID: 'machines.activity.filter.when',
        label: t(`${s}.filterWhen`),
        showLabel: true,
        active: when.choice !== 'any',
        selectedId: when.choice,
        options: FLEET_ACTIVITY_WHEN.map((choice) => ({ id: choice, label: whenLabel(choice) })),
        onChange: (id: string) => {
          const choice = FLEET_ACTIVITY_WHEN.find((candidate) => candidate === id) ?? 'any';
          setWhen(choice === 'any' ? ANY_TIME : { choice, range: fleetActivityWhenRange(choice, Date.now()) });
        },
      },
    ],
    [actorAccountId, kind, machineId, machines, people, when.choice],
  );

  return (
    // The fleet pages (Machines, Updates, Activity) share the wide page column (lab fAct beside fUpd).
    <ItemList pageColumn="wide">
      <MainScreenHeader
        testID="machines.activity.header"
        title={t(`${s}.title`)}
        alwaysShowTitle
        description={t(`${s}.description`)}
        // The chips are the header's band: the first one stands on the title's edge (lab fAct). A narrow page
        // scrolls the four chips sideways rather than squeezing them (lab fActp).
        band={lifetime ? <SelectionListFilterChips placement="row" edge="page" filters={filters} testID="machines.activity.filters" /> : null}
      />
      {state.status === 'loading' ? (
        <ItemGroup surface="none" testID="machines.activity.loading">
          <SkeletonRows rows={5} />
        </ItemGroup>
      ) : state.status === 'failed' ? (
        <ItemGroup surface="none">
          <SurfaceStateCard
            testID="machines.activity.error"
            kind="error"
            size="line"
            title={t('projects.deployments.unavailableTitle')}
            diagnosticCode={state.failureCode}
            action={{ label: t('common.retry'), onPress: retry }}
          />
        </ItemGroup>
      ) : state.items.length === 0 ? (
        // An incomplete read never claims nothing happened: it says what it could not read and offers to read again.
        state.coverage === 'partial' ? (
          <EmptyState
            testID="machines.activity.partialEmpty"
            layout="page"
            scene="homeOffline"
            title={t(`${s}.partialEmptyTitle`)}
            subtitle={t(`${s}.partial`)}
            primaryAction={{ label: t('common.retry'), onPress: retry, testID: 'machines.activity.partialEmpty.retry' }}
          />
        ) : (
          <EmptyState
            testID="machines.activity.empty"
            layout="page"
            scene="shipped"
            title={t(`${s}.emptyTitle`)}
            subtitle={t(`${s}.emptyBody`)}
          />
        )
      ) : (
        <ItemGroup testID="machines.activity.card">
          {lifetime ? (
            <ActivityDays
              days={days}
              lifetime={lifetime}
              titles={titles}
              onOpenReceipt={openReceipt}
              actors={actors}
            />
          ) : null}
          {state.coverage === 'partial' ? (
            <SurfaceStateCard
              testID="machines.activity.partial"
              kind="warning"
              size="line"
              title={t(`${s}.partial`)}
              action={{ label: t('common.retry'), onPress: retry }}
            />
          ) : null}
        </ItemGroup>
      )}
      {state.status === 'ready' && state.nextCursor ? (
        <ItemGroup surface="none" header="none">
          <SectionActionButton
            testID="machines.activity.older"
            title={t('projects.deployments.pageOlder')}
            icon="caret-right"
            loading={state.loadingMore}
            onPress={loadMore}
          />
        </ItemGroup>
      ) : null}
    </ItemList>
  );
}

type ActivityDay = ReturnType<typeof buildSessionListDateGroups<DeploymentActivityItemV1>>[number];

/** The card's day groups. People are named by the one profile owner, read once for the Accounts on this page. */
function ActivityDays(props: Readonly<{
  days: readonly ActivityDay[];
  lifetime: ServerAccountScopeLifetime;
  titles: ReadonlyMap<string, string>;
  onOpenReceipt: RowProps['onOpenReceipt'];
  actors: RowProps['actors'];
}>) {
  const scope = props.lifetime.scope;
  return (
    <CorePluginUiPresentationScope>
      <View style={styles.card}>
        {props.days.map((day) => (
          <View
            key={day.dateKey}
            testID={`machines.activity.day.${day.dateKey}`}
            style={styles.day}
          >
            <Timeline
              inline
              timeAlign="end"
              accessibilityLabel={day.title}
              header={
                <Text variant="meta" style={styles.dayTitle}>
                  {day.title}
                </Text>
              }
              items={day.items}
              keyForItem={(item) => item.id}
              renderItem={(item) =>
                activityRowContent({
                  item,
                  scope,
                  actors: props.actors,
                  environmentTitle:
                    item.kind === 'receipt'
                      ? (props.titles.get(item.environment.id) ?? null)
                      : null,
                  onOpenReceipt: props.onOpenReceipt,
                })
              }
            />
          </View>
        ))}
      </View>
    </CorePluginUiPresentationScope>
  );
}

type RowProps = Readonly<{
  item: DeploymentActivityItemV1;
  scope: ServerAccountScope;
  /** Each row's actor, resolved once for the page (keyed by item id). */
  actors: ReadonlyMap<string, ActivityActorView>;
  environmentTitle: string | null;
  onOpenReceipt: (
    environmentId: string,
    projectSourceId: string,
    deploymentId: string,
  ) => void;
}>;

type ReceiptOutcome = 'done' | 'failed' | 'running' | 'requested';

function receiptOutcome(
  state: Extract<
    DeploymentActivityItemV1,
    { kind: 'receipt' }
  >['receipt']['state'],
): ReceiptOutcome {
  switch (state) {
    case 'succeeded':
    case 'running_unverified':
      return 'done';
    case 'failed':
      return 'failed';
    case 'queued':
    case 'running':
      return 'running';
    default:
      // Cancelled, or an outcome nobody saw: say what was asked, and let the state word say the rest.
      return 'requested';
  }
}

/** Timeline asks for row content; each part is a leaf that reads only the fact it shows (actor, Machine). */
function activityRowContent(props: RowProps): TimelineItemContent {
  return {
    glyph: <ActivityMark {...props} />,
    heading: <ActivitySentence {...props} />,
    time: (
      <Text variant="meta" style={styles.time}>
        {formatClock(props.item.requestedAtMs)}
      </Text>
    ),
    body: <ActivitySecondary {...props} />,
  };
}

function useActivityActor(props: RowProps): ActivityActorView {
  return props.actors.get(props.item.id) ?? UNKNOWN_ACTOR;
}

function ActivityMark(props: RowProps) {
  const { item } = props;
  const actor = useActivityActor(props);
  // Without a known actor the row's mark is its outcome, like a deploy at work or stopped.
  const unknown = actor.kind === null;
  if (item.kind === 'receipt') {
    const outcome = receiptOutcome(item.receipt.state);
    if (outcome !== 'done' || unknown)
      return (
        <WorkStatusGlyph
          status={deploymentWorkStatus(item.receipt.state)}
          testIDSuffix={`activity-${item.receipt.id}`}
        />
      );
  } else {
    const status = resolveActionOperationStatus(item.operation, 'available');
    if (item.operation.state !== 'succeeded' || unknown)
      return (
        <WorkStatusGlyph
          status={resolveWorkStatusTone({
            kind: 'action_operation',
            facts: {
              state: item.operation.state,
              observation: 'available',
              setupReview: item.operation.setupReview,
              word: describeActionOperationStatusLabel(status.label),
            },
          })}
          testIDSuffix={`activity-${item.operation.operationId}`}
        />
      );
  }
  if (actor.kind === 'agent') return <Icon name="robot" size={14} />;
  if (actor.kind === 'workflow') return <Icon name="tree-structure" size={14} />;
  return actor.avatar ? (
    <Avatar
      id={actor.avatar.id}
      imageUrl={actor.avatar.imageUrl ?? null}
      size={MARK_PX}
      monogram={actor.name ?? undefined}
    />
  ) : (
    <Icon name="person" size={14} />
  );
}

function ActivitySentence(props: RowProps) {
  const { item } = props;
  const actor = useActivityActor(props);
  if (item.kind === 'receipt') {
    const { receipt, environment } = item;
    const revision = receipt.source
      ? deploymentRevisionLabel(receipt.source)
      : null;
    return (
      <Text
        variant="reading"
        testID={`machines.activity.receipt.${receipt.id}`}
        onPress={() =>
          props.onOpenReceipt(
            environment.id,
            environment.projectSourceId,
            receipt.id,
          )
        }
        accessibilityRole="link"
      >
        {actor.name === null ? (
          activityHeadingWithoutActor({ kind: 'receipt', receipt, revision,
            environmentTitle: props.environmentTitle ?? receipt.title ?? environment.id })
        ) : (
          <>
            <Text variant="reading" emphasis="medium">
              {actor.name}
            </Text>
            <Text variant="reading" style={styles.verb}>
              {` ${t(`${s}.receiptVerb`, { operation: receipt.operation, outcome: receiptOutcome(receipt.state) })} `}
            </Text>
            {revision ? <Text variant="reading">{`${revision} `}</Text> : null}
            <Text variant="reading" style={styles.verb}>{`${t(receipt.operation === 'teardown' ? `${s}.from` : `${s}.to`)} `}</Text>
            <Text variant="reading">
              {props.environmentTitle ?? receipt.title ?? environment.id}
            </Text>
          </>
        )}
      </Text>
    );
  }
  const { operation } = item;
  return (
    <Text
      variant="reading"
      testID={`machines.activity.operation.${operation.operationId}`}
      onPress={() =>
        openActionOperationDetail({
          serverId: props.scope.serverId,
          operationId: operation.operationId,
        })
      }
      accessibilityRole="link"
    >
      {actor.name === null ? (
        activityHeadingWithoutActor({ kind: 'operation', title: operation.title })
      ) : (
        <>
          <Text variant="reading" emphasis="medium">
            {actor.name}
          </Text>
          <Text variant="reading" style={styles.verb}>{` ${t(`${s}.ran`)} `}</Text>
          <Text variant="reading">{operation.title}</Text>
        </>
      )}
    </Text>
  );
}

function ActivitySecondary(props: RowProps) {
  const { item } = props;
  const machineId =
    item.kind === 'operation'
      ? item.operation.scope.machineId
      : (item.receipt.machineIds?.[0] ?? null);
  const machine = useServerScopedMachineLabel(
    props.scope.serverId,
    machineId,
  );
  const where = machine ? t(`${s}.onMachine`, { machine }) : null;
  const state =
    item.kind === 'receipt'
      ? receiptOutcome(item.receipt.state) === 'done'
        ? null
        : deploymentStateLabel(item.receipt.state)
      : item.operation.state === 'succeeded'
        ? null
        : describeActionOperationStatusLabel(
            resolveActionOperationStatus(item.operation, 'available').label,
          );
  const line = [where, state].filter(Boolean).join(' · ');
  return line ? (
    <Text variant="meta" style={styles.secondary} numberOfLines={2}>
      {line}
    </Text>
  ) : null;
}

const styles = StyleSheet.create((theme) => ({
  card: {
    paddingHorizontal: theme.space.s16,
    paddingVertical: theme.space.s12,
    gap: theme.space.s16,
  },
  day: { gap: theme.space.s4 },
  dayTitle: { color: theme.colors.text.secondary },
  verb: { color: theme.colors.text.secondary },
  secondary: { color: theme.colors.text.secondary },
  time: {
    ...Typography.tabular(),
    color: theme.colors.text.secondary,
  },
}));
