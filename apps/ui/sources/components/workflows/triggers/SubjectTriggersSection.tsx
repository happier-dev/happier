import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { DeploymentEnvironmentRefV1 } from '@happier-dev/protocol/deployments/deploymentEnvironmentRefV1';

import { useMachineServicesList } from '@/components/machines/services/useMachineServicesList';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { t } from '@/text';

import {
  projectAccountTriggerRows,
  type AccountTriggerRow,
  type TriggerSubject,
} from './accountTriggerRows';
import {
  NewAccountTriggerPopover,
  useAccountWorkflowEditor,
} from './AccountTriggersSection';
import { GuidedAutomationSetup } from './GuidedAutomationSetup';
import { DeploymentPushTriggerSetup } from './DeploymentPushTriggerSetup';
import type { DeploymentPushSetupConfig } from './deploymentPushSetup';
import { ScheduledServiceJobSetup } from './ScheduledServiceJobSetup';
import { guidedStarterEventSeed, type GuidedStarter } from './guidedAutomation';
import {
  SUBJECT_TRIGGER_PERSISTENT_STARTERS,
  SUBJECT_TRIGGER_STARTER_GLYPH,
  SUBJECT_TRIGGER_STARTERS,
  type SubjectTriggerStarter,
} from './subjectTriggerStarters';
import { TriggerRow } from './TriggerRow';
import { useWorkflowTriggerSets } from './useWorkflowTriggerSets';

const ACCOUNT_TRIGGER_QUERY = { scope: 'account_inline' } as const;

type Opening =
  | Readonly<{ kind: 'custom' }>
  | Readonly<{ kind: 'scheduledJob' | 'deployOnPush'; anchor: React.RefObject<View | null> }>
  /** Add a check: the New trigger editor opened at the subject's own health form (the bound health-setup seed). */
  | Readonly<{ kind: 'check'; anchor: React.RefObject<View | null> }>
  | Readonly<{
      kind: 'guided';
      starter: GuidedStarter | null;
      anchor: React.RefObject<View | null>;
    }>;

/**
 * A subject page's Triggers (OPS-AUTOMATIONS-1102 D2/D3): the Account's triggers that run on this
 * subject's Machine, read from the same `account_inline` list the Workflows column shows and edited in
 * the same popover. "Set up an automation" asks the four questions; "Custom trigger" opens the
 * column's New trigger. Both start with Runs on at the subject. Empty, the section suggests starters.
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
      active?: boolean;
    }>,
  ) {
    const { binding } = useServerCredentialAccountScopeBinding(props.deploymentEnvironment?.serverId);
    const accountLifetime = props.deploymentEnvironment ? binding : undefined;
    const read = useWorkflowTriggerSets(ACCOUNT_TRIGGER_QUERY, accountLifetime);
    const editor = useAccountWorkflowEditor({ read, accountLifetime });
    const services = useMachineServicesList({ serverId: props.deploymentEnvironment?.serverId ?? '',
      machineId: props.subject.machineId, environmentId: props.deploymentEnvironment?.environmentId,
      active: props.active !== false && props.subject.kind === 'environment' && props.deploymentEnvironment !== undefined });
    const environmentServices = React.useMemo(() => services.rows?.map(service => ({
      machineId: props.subject.machineId, serviceId: service.serviceId,
    })), [services.rows, props.subject.machineId]);
    const { sets, status } = read;
    const rows = React.useMemo(
      () =>
        projectAccountTriggerRows({
          sets,
          resolveWorkflowTitle: editor.resolveWorkflowTitle,
          subject: props.subject,
          services: environmentServices,
        }),
      [sets, editor.resolveWorkflowTitle, props.subject, environmentServices],
    );
    const addAnchor = React.useRef<View>(null);
    const [opening, setOpening] = React.useState<Opening | null>(null);
    const project = React.useMemo(
      () => ({ machineId: props.subject.machineId, directory: '~' }),
      [props.subject.machineId],
    );
    const starterAvailable = (starter: SubjectTriggerStarter) => starter === 'scheduledJob'
      ? props.deploymentEnvironment !== undefined : starter !== 'deployOnPush' || props.pushSetup !== undefined;
    const empty = rows.length === 0;
    const close = () => setOpening(null);
    const section = rows.length === 0 && status !== 'ready' ? null : (
      <ItemGroup
        testID="subject-triggers"
        title={t('workflows.triggers.section.title')}
        description={t(
          `workflows.triggers.section.${props.subject.kind}${empty ? 'Empty' : 'Info'}`,
        )}
        action={
          <View ref={addAnchor} collapsable={false} style={styles.actions}>
            <RoundButton
              testID="subject-triggers-add"
              size="small"
              display="inverted"
              title={t('workflows.triggers.section.custom')}
              onPress={() => setOpening({ kind: 'custom' })}
            />
            <RoundButton
              testID="subject-triggers-set-up"
              size="small"
              display="secondary"
              title={t('workflows.triggers.section.setUp')}
              onPress={() =>
                setOpening({ kind: 'guided', starter: null, anchor: addAnchor })
              }
            />
          </View>
        }
      >
        {empty
          ? SUBJECT_TRIGGER_STARTERS[props.subject.kind].filter(starterAvailable).map((starter) => (
              <StarterRow key={starter} starter={starter} onOpen={(anchor) => setOpening(openStarter(starter, anchor))} />
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
              />
            ))}
        {empty ? null : SUBJECT_TRIGGER_PERSISTENT_STARTERS[props.subject.kind].filter(starterAvailable).map((starter) => (
          <StarterRow key={starter} starter={starter} onOpen={(anchor) => setOpening(openStarter(starter, anchor))} />
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
        {opening?.kind === 'custom' ? (
          <NewAccountTriggerPopover
            anchorRef={addAnchor}
            onRequestClose={close}
            initialProject={project}
            accountLifetime={accountLifetime}
          />
        ) : null}
        {opening?.kind === 'check' ? (
          <NewAccountTriggerPopover
            anchorRef={opening.anchor}
            onRequestClose={close}
            initialProject={project}
            accountLifetime={accountLifetime}
            eventSeed={guidedStarterEventSeed('healthFailed', { subject: props.subject, controllerMachineId: props.controllerMachineId })}
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
        {opening?.kind === 'guided' ? (
          <GuidedAutomationSetup
            anchorRef={opening.anchor}
            onRequestClose={close}
            subjectName={props.subjectName}
            subject={props.subject}
            initialProject={project}
            starter={opening.starter}
            deploymentEnvironment={props.deploymentEnvironment}
            deploymentSourceName={props.deploymentSourceName}
            controllerMachineId={props.controllerMachineId}
          />
        ) : null}
      </>
    );
  },
);

function openStarter(starter: SubjectTriggerStarter, anchor: React.RefObject<View | null>): Opening {
  if (starter === 'scheduledJob' || starter === 'deployOnPush') return { kind: starter, anchor };
  return starter === 'addCheck' ? { kind: 'check', anchor } : { kind: 'guided', starter, anchor };
}

/** A suggested entry: a row that opens the four questions already answered for it, or Add a check's health form. */
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
  }>,
) {
  const anchorRef = React.useRef<View>(null);
  const { row } = props;
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
