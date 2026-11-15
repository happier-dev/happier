import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { Text } from '@/components/ui/text/Text';
import { Item } from '@/components/ui/lists/Item';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';
import { useWorkflowExistingSessionOptions } from '@/components/workflows/screens/useWorkflowExistingSessionOptions';
import {
  resolveWorkflowSessionChoice,
  WORKFLOW_SESSION_RETRY_ITEM_ID,
  workflowSessionMenuState,
} from '@/components/workflows/presentation/workflowSessionChoice';
import { workflowSessionOptionRow } from '@/components/workflows/presentation/workflowSessionOptionRow';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { t } from '@/text';

import { formatTriggerSummary } from './formatTriggerSummary';
import type { TriggerWhenValue } from './sessionTriggerForm';
import {
  FieldSelect,
  ScheduleRows,
  useStoredSessionItem,
} from './TriggerPopover';
import { TriggerPluginEventRows } from './TriggerPluginEventRows';
import {
  createWorkflowTriggerStartWhen,
  readWorkflowTriggerStart,
  WORKFLOW_SESSION_EVENT_KINDS,
  WORKFLOW_TRIGGER_START_KINDS,
  type WorkflowTriggerStartKind,
} from './workflowTriggerStarts';

const styles = StyleSheet.create((theme) => ({
  foot: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: theme.space.s16,
    paddingHorizontal: PAGE_LIST_METRICS.rowPaddingHorizontalPx,
    paddingBottom: theme.space.s12,
  },
  note: { color: theme.colors.text.secondary, flexBasis: '100%' },
}));

type SessionEventKind = Extract<
  TriggerWhenValue['kind'],
  'turnEnds' | 'needsYou' | 'sessionArchived' | 'sessionStarts'
>;
type SessionEventWhen = Extract<
  TriggerWhenValue,
  Readonly<{ kind: SessionEventKind }>
>;

/**
 * One way this workflow starts, edited in place in the "When it runs" card (lab round-1115
 * `trigger-card-*`): **Starts** (the kind, with its description), then only the rows that kind needs,
 * through the owners the trigger popover uses (schedule rows, the plugin Event editor). Edits go
 * straight to the editor's draft; Save writes them.
 */
export function WorkflowTriggerStartRows(
  props: Readonly<{
    testID: string;
    /** `null` while the workflow has no trigger: Starts reads "Only when you run it". */
    when: TriggerWhenValue | null;
    enabled: boolean;
    /** The When is not complete yet, so Save does not include it. */
    incomplete: boolean;
    /** A new way to start whose kind is not chosen yet ("Another way to start"). */
    unchosen?: boolean;
    onChangeWhen: (next: TriggerWhenValue) => void;
    /** Choosing "Only when you run it" removes this way to start. */
    onRemove?: () => void;
    onToggleEnabled?: () => void;
    onToggleHistory?: () => void;
    history?: React.ReactNode;
    machineId: string | null;
    serverId: string | null;
    eventEdit?: Readonly<{ automationId: string; triggerId: string }>;
    onEditSeedApplied?: React.ComponentProps<
      typeof TriggerPluginEventRows
    >['onEditSeedApplied'];
  }>,
): React.ReactElement {
  const { when } = props;
  const start = when === null ? 'manual' : readWorkflowTriggerStart(when);
  const [eventEditing, setEventEditing] = React.useState(false);
  const items = WORKFLOW_TRIGGER_START_KINDS.filter((kind) => !props.unchosen || kind !== 'manual').map((kind) => ({
    id: kind,
    testID: `${props.testID}-starts:${kind}`,
    title: t(`workflows.triggers.card.start.${kind}`),
    subtitle: t(`workflows.triggers.card.startDescription.${kind}`),
  }));
  // The Starts select shows the chosen kind's description; state that needs saying sits in the foot.
  const subtitle = when !== null && !props.enabled && !props.incomplete ? t('workflows.triggers.row.off') : undefined;
  return (
    <View testID={props.testID}>
      {start === 'runEvent' || start === 'sessionPullRequest' ? (
        // Created from the run it follows, or from the Session whose pull request it watches; here it
        // is listed, turned off or removed.
        <Item
          testID={`${props.testID}-starts`}
          title={t('workflows.triggers.card.starts')}
          detail={when?.kind === 'runLifecycle' ? formatTriggerSummary(when)
            : when?.kind === 'prComment' || when?.kind === 'ciFailed'
              ? formatTriggerSummary({ kind: when.kind, ...(when.pullRequest ? { pullRequest: when.pullRequest } : {}) }) : undefined}
          {...(subtitle === undefined ? {} : { subtitle })}
          mode="info"
        />
      ) : (
        <FieldSelect
          testID={`${props.testID}-starts`}
          title={t('workflows.triggers.card.starts')}
          {...(subtitle === undefined ? {} : { subtitle })}
          items={items}
          selectedId={props.unchosen ? null : start}
          onSelect={(id) => {
            const kind = WORKFLOW_TRIGGER_START_KINDS.find(
              (candidate): candidate is WorkflowTriggerStartKind =>
                candidate === id,
            );
            if (kind === undefined || kind === start) return;
            if (kind === 'manual') {
              props.onRemove?.();
              return;
            }
            props.onChangeWhen(
              createWorkflowTriggerStartWhen(kind, when ?? undefined),
            );
          }}
        />
      )}
      {when?.kind === 'schedule' ? (
        <ScheduleRows
          testID={props.testID}
          when={when}
          onChange={props.onChangeWhen}
        />
      ) : null}
      {when?.kind === 'pluginEvent' ? (
        <TriggerPluginEventRows
          testID={props.testID}
          when={when}
          onChange={props.onChangeWhen}
          machineId={props.machineId}
          serverId={props.serverId}
          eventEdit={props.eventEdit}
          onEditSeedApplied={props.onEditSeedApplied}
          editing={eventEditing}
          onEditingChange={setEventEditing}
        />
      ) : null}
      {when !== null && start === 'sessionEvent' ? (
        <SessionEventRows
          testID={props.testID}
          when={when as SessionEventWhen}
          serverId={props.serverId}
          onChange={props.onChangeWhen}
        />
      ) : null}
      {(when === null && !props.unchosen) || eventEditing ? null : (
        <View style={styles.foot}>
          {props.incomplete ? <Text testID={`${props.testID}-incomplete`} variant="meta" style={styles.note}>
            {t('workflows.triggers.card.incomplete')}</Text> : null}
          {props.onToggleHistory ? (
            <TextLinkButton
              testID={`${props.testID}-history`}
              tone="quiet"
              label={t('workflows.destination.history.title')}
              onPress={props.onToggleHistory}
            />
          ) : null}
          {props.onToggleEnabled ? (
            <TextLinkButton
              testID={`${props.testID}-toggle`}
              tone="quiet"
              label={t(
                props.enabled
                  ? 'workflows.triggers.popover.turnOff'
                  : 'workflows.triggers.popover.turnOn',
              )}
              onPress={props.onToggleEnabled}
            />
          ) : null}
          {props.onRemove ? (
            <TextLinkButton
              testID={`${props.testID}-remove`}
              tone="quiet"
              label={t('workflows.triggers.card.remove')}
              onPress={props.onRemove}
            />
          ) : null}
        </View>
      )}
      {props.history ?? null}
    </View>
  );
}

/**
 * A session event: what happens (a turn ends, it needs you, it's archived) in which of your
 * sessions. The workflow itself runs where the editor's Where says, in its own session.
 */
function SessionEventRows(
  props: Readonly<{
    testID: string;
    when: SessionEventWhen;
    serverId: string | null;
    onChange: (next: TriggerWhenValue) => void;
  }>,
) {
  const { when } = props;
  const sourceSessionId = when.sourceSessionId;
  const [open, setOpen] = React.useState(false);
  // The editor's Home, or the active one when the host names none (as "A session…" reads it).
  const activeServerId = useActiveServerAccountScope()?.serverId ?? null;
  const serverId = props.serverId ?? activeServerId;
  // Any of your sessions, on any machine; read only while the chooser is open.
  const { existingSessions, sessionOptionsStatus, retrySessionOptions } =
    useWorkflowExistingSessionOptions({
      serverId,
      machineId: null,
      enabled: open,
      // A lifecycle source is only listened to: any visible Session, whatever its Agent.
      purpose: 'listen',
    });
  const choice = resolveWorkflowSessionChoice(
    sessionOptionsStatus,
    existingSessions.length > 0,
  );
  const menu = workflowSessionMenuState(
    choice,
    t('workflows.triggers.card.noSession'),
  );
  const stored = useStoredSessionItem({
    sessionId: sourceSessionId ?? '',
    serverId,
    offered: existingSessions.some(
      (option) => option.sessionId === sourceSessionId,
    ),
    settled: open && sessionOptionsStatus === 'ready',
  });
  const kinds: readonly SessionEventKind[] =
    when.kind === 'sessionStarts'
      ? [...WORKFLOW_SESSION_EVENT_KINDS, 'sessionStarts']
      : WORKFLOW_SESSION_EVENT_KINDS;
  const withSource = (
    kind: SessionEventKind,
    sessionId: string | undefined,
  ): TriggerWhenValue =>
    sessionId === undefined ? { kind } : { kind, sourceSessionId: sessionId };
  return (
    <>
      <SegmentedChoiceItem<SessionEventKind>
        testID={`${props.testID}-session-event`}
        testIDPrefix={`${props.testID}-session-event`}
        title={t('workflows.triggers.card.sessionWhen')}
        options={kinds.map((kind) => ({
          id: kind,
          label: t(`workflows.triggers.card.sessionKind.${kind}`),
        }))}
        value={when.kind}
        onChange={(kind) => props.onChange(withSource(kind, sourceSessionId))}
      />
      <FieldSelect
        testID={`${props.testID}-session`}
        onOpenChange={setOpen}
        title={t('workflows.triggers.card.session')}
        subtitle={t('workflows.triggers.card.sessionDescription')}
        items={[
          ...menu.leadingItems,
          ...(stored === null ? [] : [stored]),
          ...existingSessions.map((option) => ({
            id: option.sessionId,
            title: option.label,
            ...workflowSessionOptionRow(option),
          })),
        ]}
        {...(menu.emptyLabel === undefined
          ? {}
          : { emptyLabel: menu.emptyLabel })}
        selectedId={sourceSessionId ?? null}
        keepsOpen={(id) => id === WORKFLOW_SESSION_RETRY_ITEM_ID}
        invalid={stored?.disabled === true}
        onSelect={(sessionId) => {
          if (sessionId === WORKFLOW_SESSION_RETRY_ITEM_ID) {
            retrySessionOptions();
            return;
          }
          if (existingSessions.some((option) => option.sessionId === sessionId))
            props.onChange(withSource(when.kind, sessionId));
        }}
      />
    </>
  );
}
