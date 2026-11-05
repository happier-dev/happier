import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
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
import type { GuidedStarter } from './guidedAutomation';
import { TriggerRow } from './TriggerRow';
import { useWorkflowTriggerSets } from './useWorkflowTriggerSets';

const ACCOUNT_TRIGGER_QUERY = { scope: 'account_inline' } as const;

/** The starters an empty section suggests for its subject: what usually needs watching there. */
const STARTERS: Readonly<
  Record<TriggerSubject['kind'], readonly GuidedStarter[]>
> = {
  machine: ['healthFailed', 'nightly'],
  environment: ['deploymentFailed', 'healthFailed', 'nightly'],
  service: ['healthFailed', 'nightly'],
};
const STARTER_GLYPH: Readonly<Record<GuidedStarter, IconName>> = {
  healthFailed: 'pulse',
  deploymentFailed: 'rocket-launch',
  nightly: 'moon',
};

type Opening =
  | Readonly<{ kind: 'custom' }>
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
    }>,
  ) {
    const read = useWorkflowTriggerSets(ACCOUNT_TRIGGER_QUERY);
    const editor = useAccountWorkflowEditor({ read });
    const { sets, status } = read;
    const rows = React.useMemo(
      () =>
        projectAccountTriggerRows({
          sets,
          resolveWorkflowTitle: editor.resolveWorkflowTitle,
          subject: props.subject,
        }),
      [sets, editor.resolveWorkflowTitle, props.subject],
    );
    const addAnchor = React.useRef<View>(null);
    const [opening, setOpening] = React.useState<Opening | null>(null);
    const project = React.useMemo(
      () => ({ machineId: props.subject.machineId, directory: '~' }),
      [props.subject.machineId],
    );
    if (rows.length === 0 && status !== 'ready') return null;
    const empty = rows.length === 0;
    const close = () => setOpening(null);
    return (
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
          ? STARTERS[props.subject.kind].map((starter) => (
              <StarterRow
                key={starter}
                starter={starter}
                onOpen={(anchor) =>
                  setOpening({ kind: 'guided', starter, anchor })
                }
              />
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
        {editor.popover}
        {opening?.kind === 'custom' ? (
          <NewAccountTriggerPopover
            anchorRef={addAnchor}
            onRequestClose={close}
            initialProject={project}
          />
        ) : null}
        {opening?.kind === 'guided' ? (
          <GuidedAutomationSetup
            anchorRef={opening.anchor}
            onRequestClose={close}
            subjectName={props.subjectName}
            initialProject={project}
            starter={opening.starter}
          />
        ) : null}
      </ItemGroup>
    );
  },
);

/** A suggested automation: a row that opens the four questions already answered for it. */
const StarterRow = React.memo(function StarterRow(
  props: Readonly<{
    starter: GuidedStarter;
    onOpen: (anchor: React.RefObject<View | null>) => void;
  }>,
) {
  const { theme } = useUnistyles();
  const anchorRef = React.useRef<View>(null);
  return (
    <View ref={anchorRef} collapsable={false}>
      <Item
        testID={`subject-triggers-starter:${props.starter}`}
        title={t(`workflows.triggers.guided.starter.${props.starter}`)}
        icon={
          <Icon
            name={STARTER_GLYPH[props.starter]}
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
        toggleDisabled={props.pending}
        onToggle={props.onToggle}
        onPress={() => props.onOpen(anchorRef)}
      />
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  actions: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 },
}));
