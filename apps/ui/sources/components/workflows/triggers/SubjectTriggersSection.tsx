import * as React from 'react';
import { useRouter } from 'expo-router';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { DeploymentEnvironmentRefV1 } from '@happier-dev/protocol/deployments/deploymentEnvironmentRefV1';

import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { ItemLoadStateRows } from '@/components/ui/lists/ItemLoadStateRows';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { t } from '@/text';
import { prepareWorkflowSentenceEditorEntry } from '@/components/workflows/authoring/workflowSentenceAuthoring';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';

import type { AccountTriggerRow, TriggerSubject } from './accountTriggerRows';
import { NewAccountTriggerPopover } from './AccountTriggersSection';
import { DeploymentPushTriggerSetup } from './DeploymentPushTriggerSetup';
import type { DeploymentPushSetupConfig } from './deploymentPushSetup';
import { ScheduledServiceJobSetup } from './ScheduledServiceJobSetup';
import { subjectStarterWhen, subjectStarterEventSeed, type SubjectSentenceStarter } from './subjectTriggerStarters';
import { buildTriggerDefinition } from './sessionTriggerForm';
import {
  SUBJECT_TRIGGER_PERSISTENT_STARTERS,
  SUBJECT_TRIGGER_STARTER_GLYPH,
  SUBJECT_TRIGGER_STARTERS,
  type SubjectTriggerStarter,
} from './subjectTriggerStarters';
import { TriggerRow } from './TriggerRow';
import { useResourceAutomationsSection } from './useResourceAutomationsSection';

type Opening =
  | Readonly<{ kind: 'scheduledJob' | 'deployOnPush'; anchor: React.RefObject<View | null> }>
  /** Add a check: the New trigger editor opened at the subject's own health form (the bound health-setup seed). */
  | Readonly<{ kind: 'check'; anchor: React.RefObject<View | null> }>;

/**
 * A subject page's Triggers (OPS-AUTOMATIONS-1102 D2/D3): the Account's triggers that run on this
 * subject's Machine, read from the same `account_inline` list the Workflows column shows and edited in
 * the same popover. Creation opens the ordinary sentence editor with the subject's project and
 * any source setup intent. Empty, the section suggests starters.
 * The section waits for the first read instead of drawing a loading line between the page's sections.
 */
export const SubjectTriggersSection = React.memo(
  function SubjectTriggersSection(
    props: Readonly<{
      subject: TriggerSubject;
      /** The page's own name for its subject, used in the agent's prompt and the read-back. */
      subjectName: string;
      deploymentEnvironment?: DeploymentEnvironmentRefV1;
      deploymentSourceName?: string;
      controllerMachineId?: string;
      pushSetup?: DeploymentPushSetupConfig;
    }>,
  ) {
    const { accountLifetime, read, editor, rows, project } = useResourceAutomationsSection(props);
    const router = useRouter();
    const { status } = read;
    const addAnchor = React.useRef<View>(null);
    const [opening, setOpening] = React.useState<Opening | null>(null);
    const starterAvailable = (starter: SubjectTriggerStarter) => starter === 'scheduledJob'
      ? props.deploymentEnvironment !== undefined : starter !== 'deployOnPush' || props.pushSetup !== undefined;
    const empty = rows.length === 0;
    const close = () => setOpening(null);
    const openSentence = (starter: SubjectSentenceStarter | null) => {
      const lifetime = accountLifetime === undefined ? captureActiveServerAccountScopeLifetime() : accountLifetime;
      if (!lifetime) return;
      const eventSeed = starter === null ? undefined : subjectStarterEventSeed(starter, {
        subject: props.subject, deploymentEnvironment: props.deploymentEnvironment,
        controllerMachineId: props.controllerMachineId,
      });
      const trigger = starter === 'nightly' ? buildTriggerDefinition({
        when: subjectStarterWhen('nightly'), enabled: true, sessionId: null,
      }) : null;
      const entry = prepareWorkflowSentenceEditorEntry({ name: props.subjectName, project,
        ...(eventSeed ? { eventSeed } : {}), ...(trigger ? { trigger } : {}),
      }, lifetime);
      if (entry) router.push(entry);
    };
    const openStarter = (starter: SubjectTriggerStarter, anchor: React.RefObject<View | null>) => {
      if (starter === 'scheduledJob' || starter === 'deployOnPush') setOpening({ kind: starter, anchor });
      else if (starter === 'addCheck') setOpening({ kind: 'check', anchor });
      else openSentence(starter);
    };
    // Nothing known yet: the section keeps its place with its header and two placeholder rows, so the
    // page does not move when the rows land. With nothing retained, a failed read says so in place, with Retry.
    const unsettled = empty && status !== 'ready';
    const section = (
      <ItemGroup
        testID="subject-triggers"
        title={t('workflows.triggers.section.title')}
        description={t(
          `workflows.triggers.section.${props.subject.kind}${empty && !unsettled ? 'Empty' : 'Info'}`,
        )}
        action={
          <View ref={addAnchor} collapsable={false} style={styles.actions}>
            <SectionActionButton
              testID="subject-triggers-add"
              icon="plus"
              title={t('workflows.triggers.section.automate')}
              onPress={() => openSentence(null)}
            />
          </View>
        }
      >
        {unsettled ? (
          <ItemLoadStateRows testID="subject-triggers-read" rows={2} accessibilityLabel={t('workflows.triggers.section.title')}
            state={status === 'failed' ? { kind: 'failed', reason: t('workflows.triggers.section.accountLoadFailed'), onRetry: read.retry }
              : { kind: 'loading' }} />
        ) : empty
          ? SUBJECT_TRIGGER_STARTERS[props.subject.kind].filter(starterAvailable).map((starter) => (
              <StarterRow key={starter} starter={starter} onOpen={(anchor) => openStarter(starter, anchor)} />
            ))
          : rows.map((row) => (
              <SubjectTriggerRowView
                key={`${row.automationId}:${row.triggerId ?? 'manual'}`}
                row={row}
                pending={editor.pending.has(row.automationId)}
                onOpen={(anchor) => {
                  void editor.open(row, anchor);
                }}
                onToggle={(next) => {
                  void editor.toggle(row, next);
                }}
                onRemove={editor.remove}
              />
            ))}
        {empty ? null : SUBJECT_TRIGGER_PERSISTENT_STARTERS[props.subject.kind].filter(starterAvailable).map((starter) => (
          <StarterRow key={starter} starter={starter} onOpen={(anchor) => openStarter(starter, anchor)} />
        ))}
        {rows.length > 0 && status === 'failed' ? (
          <SurfaceFreshnessLine
            testID="subject-triggers-read"
            tone="warning"
            reason={t('workflows.triggers.section.accountLoadFailed')}
            action={{
              label: t('workflows.triggers.popover.tryAgain'),
              onPress: read.retry,
            }}
          />
        ) : null}
      </ItemGroup>
    );
    // An open editor owns its draft independently of the row read's availability.
    return (
      <>
        {section}
        {editor.popover}
        {opening?.kind === 'check' ? (
          <NewAccountTriggerPopover
            anchorRef={opening.anchor}
            onRequestClose={close}
            initialProject={project}
            accountLifetime={accountLifetime}
            eventSeed={subjectStarterEventSeed('healthFailed', { subject: props.subject, controllerMachineId: props.controllerMachineId })}
          />
        ) : null}
        {opening?.kind === 'deployOnPush' && props.pushSetup ? (
          <DeploymentPushTriggerSetup anchorRef={opening.anchor} onRequestClose={close}
            config={props.pushSetup} accountLifetime={accountLifetime} />
        ) : null}
        {opening?.kind === 'scheduledJob' && props.deploymentEnvironment ? (
          <ScheduledServiceJobSetup anchorRef={opening.anchor} onRequestClose={close}
            serverId={props.deploymentEnvironment.serverId} environmentId={props.deploymentEnvironment.environmentId}
            machineId={props.subject.machineId} project={project} />
        ) : null}
      </>
    );
  },
);

/** A suggested entry opens a sentence draft or the subject's specialized setup. */
const StarterRow = React.memo(function StarterRow(
  props: Readonly<{
    starter: SubjectTriggerStarter;
    onOpen: (anchor: React.RefObject<View | null>) => void;
  }>,
) {
  const { theme } = useUnistyles();
  const anchorRef = React.useRef<View>(null);
  return (
    <View ref={anchorRef} collapsable={false}>
      <Item
        testID={`subject-triggers-starter:${props.starter}`}
        title={props.starter === 'deployOnPush' ? t('workflows.examples.deployOnPush.title')
          : props.starter === 'scheduledJob' ? t('workflows.examples.runJobOnSchedule.title')
          : t(`workflows.triggers.guided.starter.${props.starter}`)}
        icon={
          <Icon
            name={SUBJECT_TRIGGER_STARTER_GLYPH[props.starter]}
            size={18}
            color={theme.colors.text.secondary}
          />
        }
        onPress={() => props.onOpen(anchorRef)}
      />
    </View>
  );
});

const SubjectTriggerRowView = React.memo(function SubjectTriggerRowView(
  props: Readonly<{
    row: AccountTriggerRow;
    pending: boolean;
    onOpen: (anchor: React.RefObject<View | null>) => void;
    onToggle: (next: boolean) => void;
    /** The editor's stable remover; the Action owns its confirmation. */
    onRemove: (row: AccountTriggerRow) => unknown;
  }>,
) {
  const anchorRef = React.useRef<View>(null);
  const { row } = props;
  const { onRemove } = props;
  const menuActions = React.useMemo(() => [{ id: 'remove', title: t('workflows.triggers.row.removeTrigger'),
    icon: 'trash' as const, destructive: true, onPress: () => { void onRemove(row); } }], [onRemove, row]);
  // A page sheet names a trigger by what it runs, its event the quiet line (the column leads with the event).
  const manual = row.triggerId === null;
  return (
    <View ref={anchorRef} collapsable={false}>
      <TriggerRow
        testID={`subject-triggers:${row.automationId}${row.triggerId ? `:${row.triggerId}` : ''}`}
        title={row.legacy?.title ?? (manual ? row.title : row.subtitle)}
        qualifier={row.legacy?.qualifier ?? (manual ? row.subtitle : row.title)}
        enabled={!row.off}
        multiline={!!row.legacy}
        glyph={row.sourceGone ? 'warning' : row.glyph}
        menuActions={row.sourceGone ? undefined : menuActions}
        toggleDisabled={props.pending || props.row.sourceGone === true}
        onToggle={props.onToggle}
        onPress={() => props.onOpen(anchorRef)}
      />
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  actions: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 },
}));
