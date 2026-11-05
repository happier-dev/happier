import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { WorkflowProjectTargetV1 } from '@happier-dev/protocol/workflows';

import {
  RoundButton,
  RoundButtonSizeScope,
} from '@/components/ui/buttons/RoundButton';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { SelectionCheckGlyph } from '@/components/ui/selection/SelectionCheckGlyph';
import { Text } from '@/components/ui/text/Text';
import { presentApprovalProfile } from '@/components/approvals/approvalProfilePresentation';
import { useApprovalProfiles } from '@/hooks/approvals/useApprovalProfiles';
import { formatWorkflowProblemMessage } from '@/components/workflows/presentation/workflowProblemPresentation';
import { addWorkflowTrigger } from '@/sync/domains/workflows/workflowTriggerActions';
import { sync } from '@/sync/sync';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';

import {
  GUIDED_LOOK_AT,
  GUIDED_THEN_MODES,
  buildGuidedAutomationRequest,
  guidedApprovalProfileId,
  describeGuidedAutomation,
  guidedStarterDraft,
  type GuidedAutomationDraft,
  type GuidedStarter,
} from './guidedAutomation';
import { createDefaultWhen, type TriggerWhenValue } from './sessionTriggerForm';
import { TriggerPluginEventRows } from './TriggerPluginEventRows';
import {
  FieldSelect,
  PromptAgentRows,
  ScheduleRows,
  TRIGGER_POPOVER_WIDTH,
  TriggerAnchoredPopoverShell,
} from './TriggerPopover';
import { TriggerRunsOnRow } from './TriggerRunsOnRow';
import { useNotifyMeChannelOptions } from './useTriggerThenOptions';

const STEPS = ['when', 'lookAt', 'then', 'tell', 'review'] as const;
type Step = (typeof STEPS)[number];
const QUESTION_COUNT = 4;

/**
 * "Set up an automation" (OPS-AUTOMATIONS-1102 D3): the four questions one at a time in the trigger
 * popover's frame, then the answers read back in one sentence before Create. It writes the same
 * `workflow.trigger.add` the New trigger popover writes; the answers live only in that trigger.
 */
export function GuidedAutomationSetup(
  props: Readonly<{
    anchorRef: React.RefObject<View | null>;
    onRequestClose: () => void;
    /** The page's own name for its subject ("eadc", "Production"), used in the prompt and the read-back. */
    subjectName: string;
    initialProject: WorkflowProjectTargetV1;
    starter: GuidedStarter | null;
  }>,
): React.ReactElement {
  const testID = 'guided-automation';
  const [draft, setDraft] = React.useState<GuidedAutomationDraft>(() =>
    guidedStarterDraft(props.starter),
  );
  const [project, setProject] = React.useState<WorkflowProjectTargetV1>(
    props.initialProject,
  );
  const [step, setStep] = React.useState<Step>('when');
  const [eventEditing, setEventEditing] = React.useState(false);
  const [pending, setPending] = React.useState(false);
  const [failure, setFailure] = React.useState<string | null>(null);
  const channelOptions = useNotifyMeChannelOptions();
  const change = (next: Partial<GuidedAutomationDraft>) =>
    setDraft((current) => ({ ...current, ...next }));
  const request = buildGuidedAutomationRequest(draft, {
    subjectName: props.subjectName,
    project,
  });
  const index = STEPS.indexOf(step);
  const answered =
    step === 'when'
      ? draft.when.kind !== 'pluginEvent' || draft.when.value !== null
      : step === 'lookAt'
        ? draft.lookAt.length > 0
        : step === 'review'
            ? request !== null
            : true;
  const channelLabels = draft.channels.map(
    (value) =>
      channelOptions.find((option) => option.value === value)?.label ?? value,
  );

  const create = () => {
    if (request === null || pending) return;
    setPending(true);
    setFailure(null);
    addWorkflowTrigger(request)
      .then(() => {
        fireAndForget(sync.refreshAutomations());
        props.onRequestClose();
      })
      .catch((error: unknown) =>
        setFailure(
          `${t('workflows.triggers.section.saveFailed')} ${formatWorkflowProblemMessage(error)}`,
        ),
      )
      .finally(() => setPending(false));
  };

  const question =
    step === 'review'
      ? t('workflows.triggers.guided.reviewQuestion')
      : t(`workflows.triggers.guided.${step}Question`);
  const description =
    step === 'review'
      ? t('workflows.triggers.guided.reviewDescription')
      : t(`workflows.triggers.guided.${step}Description`);

  return (
    <TriggerAnchoredPopoverShell
      key={eventEditing ? 'event' : 'guided'}
      open
      phonePresentation="sheet"
      accessibilityLabel={t('workflows.triggers.guided.title')}
      anchorRef={props.anchorRef}
      maxWidthCap={TRIGGER_POPOVER_WIDTH}
      maxHeightCap={640}
      autoFocusOnOpen
      onRequestClose={props.onRequestClose}
    >
      {({ maxHeight, placement }) =>
        eventEditing && draft.when.kind === 'pluginEvent' ? (
          <TriggerPluginEventRows
            testID={testID}
            when={draft.when}
            onChange={(when) => change({ when: executable(when) })}
            machineId={project.machineId}
            serverId={null}
            editing
            onEditingChange={setEventEditing}
            editorMaxHeight={maxHeight}
          />
        ) : (
          <FloatingOverlay
            maxHeight={maxHeight}
            scrollEnabled
            surfaceChrome="theme"
            arrow={placement ? { placement } : false}
            footer={
              <RoundButtonSizeScope size="small" presentation="uniform">
                <View style={styles.foot}>
                  <RoundButton
                    size="small"
                    display="inverted"
                    testID={`${testID}-back`}
                    title={t(
                      index === 0
                        ? 'common.cancel'
                        : 'workflows.triggers.guided.back',
                    )}
                    onPress={
                      index === 0
                        ? props.onRequestClose
                        : () => setStep(STEPS[index - 1]!)
                    }
                  />
                  <View style={styles.footEnd}>
                    <RoundButton
                      size="small"
                      testID={`${testID}-${step === 'review' ? 'create' : 'next'}`}
                      title={t(
                        step === 'review'
                          ? 'common.create'
                          : 'workflows.triggers.guided.next',
                      )}
                      disabled={!answered}
                      loading={pending}
                      onPress={
                        step === 'review'
                          ? create
                          : () => setStep(STEPS[index + 1]!)
                      }
                    />
                  </View>
                </View>
              </RoundButtonSizeScope>
            }
          >
            <ListPresentationProvider value="page">
              <View testID={testID} style={styles.surface}>
                <ItemGroup
                  testID={`${testID}-${step}`}
                  surface="none"
                  title={question}
                  titleAccessory={
                    step === 'review' ? undefined : (
                      <Text variant="meta" style={styles.meta}>
                        {t('workflows.triggers.guided.stepOf', {
                          step: index + 1,
                          count: QUESTION_COUNT,
                        })}
                      </Text>
                    )
                  }
                  description={description}
                >
                  {step === 'when' ? (
                    <WhenRows
                      testID={testID}
                      when={draft.when}
                      machineId={project.machineId}
                      onChange={(when) => change({ when })}
                      onEditEvent={() => setEventEditing(true)}
                    />
                  ) : null}
                  {step === 'lookAt'
                    ? GUIDED_LOOK_AT.map((entry) => (
                        <CheckRow
                          key={entry}
                          testID={`${testID}-look-at:${entry}`}
                          title={t(
                            `workflows.triggers.guided.lookAtOption.${entry}`,
                          )}
                          checked={draft.lookAt.includes(entry)}
                          onToggle={() =>
                            change({
                              lookAt: draft.lookAt.includes(entry)
                                ? draft.lookAt.filter(
                                    (value) => value !== entry,
                                  )
                                : GUIDED_LOOK_AT.filter(
                                    (value) =>
                                      value === entry ||
                                      draft.lookAt.includes(value),
                                  ),
                            })
                          }
                        />
                      ))
                    : null}
                  {step === 'then' ? (
                    <>
                      {GUIDED_THEN_MODES.map((mode) => (
                        <ChoiceRow
                          key={mode}
                          testID={`${testID}-then:${mode}`}
                          title={t(`workflows.triggers.guided.mode.${mode}`)}
                          subtitle={t(
                            `workflows.triggers.guided.modeDescription.${mode}`,
                          )}
                          selected={draft.mode === mode}
                          onPress={() => change({ mode })}
                        />
                      ))}
                      <ApprovalProfileSelect
                        testID={`${testID}-profile`}
                        value={guidedApprovalProfileId(draft)}
                        onChange={(approvalProfileId) => change({ approvalProfileId })}
                      />
                      {/* A profile limits what an agent does by default; isolation is the hard boundary. */}
                      <Text variant="meta" testID={`${testID}-profile-isolation`} style={styles.note}>
                        {t('workflows.triggers.guided.profile.isolationNotice')}
                      </Text>
                    </>
                  ) : null}
                  {step === 'tell' ? (
                    <>
                      <Item
                        testID={`${testID}-tell:inbox`}
                        title={t('workflows.triggers.guided.tellInbox')}
                        detail={t('workflows.triggers.guided.tellAlways')}
                        mode="info"
                        showChevron={false}
                      />
                      {channelOptions.map((option) => (
                        <CheckRow
                          key={option.value}
                          testID={`${testID}-tell:${option.value}`}
                          title={option.label}
                          checked={draft.channels.includes(option.value)}
                          onToggle={() =>
                            change({
                              channels: draft.channels.includes(option.value)
                                ? draft.channels.filter(
                                    (value) => value !== option.value,
                                  )
                                : [...draft.channels, option.value],
                            })
                          }
                        />
                      ))}
                    </>
                  ) : null}
                  {step === 'review' ? (
                    <>
                      <Text
                        testID={`${testID}-read-back`}
                        variant="reading"
                        style={styles.readBack}
                      >
                        {describeGuidedAutomation(draft, {
                          subjectName: props.subjectName,
                          channelLabels,
                        })}
                      </Text>
                      <TriggerRunsOnRow
                        testID={`${testID}-runs-on`}
                        target={project}
                        onChange={setProject}
                        description={t(
                          'workflows.triggers.editor.runsOnAccountDescription',
                        )}
                      />
                      {/* Who runs it sits with where it runs: the facts the read-back leaves out. */}
                      <PromptAgentRows
                        testID={testID}
                        then={{
                          kind: 'sendPrompt',
                          prompt: '',
                          ...(draft.selection
                            ? { selection: draft.selection }
                            : {}),
                        }}
                        onChange={(next) => {
                          if (next.kind === 'sendPrompt')
                            change({ selection: next.selection });
                        }}
                        machineId={project.machineId}
                        serverId={null}
                        directory={project.directory}
                      />
                    </>
                  ) : null}
                </ItemGroup>
                {failure === null ? null : (
                  <Text
                    testID={`${testID}-failure`}
                    accessibilityLiveRegion="polite"
                    style={styles.failure}
                  >
                    {failure}
                  </Text>
                )}
              </View>
            </ListPresentationProvider>
          </FloatingOverlay>
        )
      }
    </TriggerAnchoredPopoverShell>
  );
}

/** An automation always runs something: an Event's observation-only intent never applies here. */
function executable(when: TriggerWhenValue): TriggerWhenValue {
  if (when.kind !== 'pluginEvent' || when.observationOnly === undefined)
    return when;
  const { observationOnly: _observationOnly, ...rest } = when;
  return rest;
}

function WhenRows(
  props: Readonly<{
    testID: string;
    when: TriggerWhenValue;
    machineId: string;
    onChange: (next: TriggerWhenValue) => void;
    onEditEvent: () => void;
  }>,
) {
  const { when } = props;
  return (
    <>
      <SegmentedChoiceItem<'schedule' | 'pluginEvent'>
        accessoryLayout="stacked"
        labelSize="field"
        testIDPrefix={`${props.testID}-when`}
        title={t('workflows.triggers.popover.when')}
        value={when.kind === 'pluginEvent' ? 'pluginEvent' : 'schedule'}
        onChange={(kind) => {
          if (kind !== when.kind) props.onChange(createDefaultWhen(kind));
        }}
        options={[
          {
            id: 'schedule' as const,
            label: t('workflows.triggers.guided.whenSchedule'),
          },
          {
            id: 'pluginEvent' as const,
            label: t('workflows.triggers.guided.whenEvent'),
          },
        ]}
      />
      {when.kind === 'schedule' ? (
        <ScheduleRows
          testID={props.testID}
          when={when}
          onChange={props.onChange}
        />
      ) : null}
      {when.kind === 'pluginEvent' ? (
        <TriggerPluginEventRows
          testID={props.testID}
          when={when}
          onChange={props.onChange}
          machineId={props.machineId}
          serverId={null}
          onEditingChange={(editing) => {
            if (editing) props.onEditEvent();
          }}
        />
      ) : null}
    </>
  );
}

/** Then's approval profile (D4): the existing Account profiles, built-ins first; the Then picks one until the person does. */
function ApprovalProfileSelect(
  props: Readonly<{ testID: string; value: string; onChange: (id: string) => void }>,
) {
  const { profiles } = useApprovalProfiles();
  const items = React.useMemo(
    () =>
      profiles.map((profile) => {
        const presented = presentApprovalProfile(profile);
        return {
          id: profile.id,
          testID: `${props.testID}:${profile.id}`,
          title: presented.title,
          ...(presented.subtitle ? { subtitle: presented.subtitle } : {}),
        };
      }),
    [profiles, props.testID],
  );
  return (
    <FieldSelect
      testID={props.testID}
      title={t('workflows.triggers.guided.profile.title')}
      subtitle={t('workflows.triggers.guided.profile.description')}
      items={items}
      selectedId={props.value}
      onSelect={props.onChange}
    />
  );
}

function CheckRow(
  props: Readonly<{
    testID: string;
    title: string;
    checked: boolean;
    onToggle: () => void;
  }>,
) {
  return (
    <Item
      testID={props.testID}
      title={props.title}
      accessibilityRole="checkbox"
      accessibilityChecked={props.checked}
      leftElement={
        <SelectionCheckGlyph state={props.checked ? 'checked' : 'unchecked'} />
      }
      showChevron={false}
      onPress={props.onToggle}
    />
  );
}

function ChoiceRow(
  props: Readonly<{
    testID: string;
    title: string;
    subtitle: string;
    selected: boolean;
    onPress: () => void;
  }>,
) {
  const { theme } = useUnistyles();
  return (
    <Item
      testID={props.testID}
      title={props.title}
      subtitle={props.subtitle}
      subtitleLines={0}
      accessibilityRole="radio"
      webRole="radio"
      accessibilityChecked={props.selected}
      rightElement={
        props.selected ? (
          <Icon name="check" size={16} color={theme.colors.text.primary} />
        ) : undefined
      }
      showChevron={false}
      onPress={props.onPress}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  surface: { width: TRIGGER_POPOVER_WIDTH, maxWidth: '100%' },
  meta: { color: theme.colors.text.secondary },
  note: {
    color: theme.colors.text.secondary,
    paddingHorizontal: theme.space.s16,
    paddingBottom: theme.space.s12,
  },
  readBack: {
    color: theme.colors.text.primary,
    paddingHorizontal: theme.space.s16,
    paddingBottom: theme.space.s12,
  },
  foot: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
    paddingHorizontal: theme.space.s16,
    paddingTop: theme.space.s12,
    paddingBottom: theme.space.s16,
  },
  footEnd: { marginLeft: 'auto', flexDirection: 'row', gap: theme.space.s8 },
  failure: {
    color: theme.colors.state.danger.foreground,
    paddingHorizontal: theme.space.s16,
    paddingBottom: theme.space.s8,
  },
}));
