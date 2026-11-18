import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { SelectionTiles } from '@/components/ui/forms/SelectionTiles';
import { Icon, ICON_SIZE, type IconName } from '@/components/ui/icons/Icon';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { FieldLayout } from '@/components/ui/lists/FieldRow';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SkeletonTitle } from '@/components/ui/lists/SkeletonRows';
import { Typography } from '@/constants/Typography';
import { useServerScopedMachineLabel } from '@/sync/store/hooks';
import {
  type SetupStep,
} from '@/components/ui/setupBlocks/SetupSteps';
import { PlanChecklistCard } from '@/components/systemTasks/planChecklist/PlanChecklistCard';
import { projectReportedSteps } from '@/components/systemTasks/planChecklist/projectReportedSteps';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import type { InteractionTransientQuestionV1 } from '@happier-dev/protocol/plugins/interactions/transientV1';
import { TransientQuestionFields, useTransientQuestionAnswers, type TransientQuestionAnswerState } from '@/components/appShell/plugins/TransientQuestionForm';

import { NewAppDeploySummary } from '../NewAppDeploySteps';

/** One labelled fact on a suggestion card (lab autoRecs): what it starts from, where it runs, its data. */
export type NewAppAutoFact = Readonly<{
  key: 'startsFrom' | 'runsOn' | 'data';
  value: string;
  /** The identity drawn before the value (a starter's glyph, a platform's mark). */
  mark?: React.ReactNode;
}>;

export type NewAppAutoCard = Readonly<{
  id: string;
  title: string;
  why: string;
  recommended: boolean;
  facts: readonly NewAppAutoFact[];
}>;

/** A Machine that can't run the suggestion right now, in its owner's words, with that reason's next step. */
export type NewAppAutoMachine = Readonly<{
  machineId: string;
  /** The suggestion snapshot's name; null while the Machine owner had none yet (the row then reads the settled name live). */
  title: string | null;
  glyph: IconName;
  status: string;
  /** Offline and other states that need the person speak in the attention colour. */
  attention: boolean;
  action: Readonly<{ label: string; onPress: () => void }> | null;
}>;

/**
 * What the Describe your app step shows, read from the suggestion owner's typed outcome (journey-deploy S1/S2/S!).
 * The step derives nothing itself: each state is the owner's answer, put into words.
 */
export type NewAppAutoView =
  | Readonly<{ kind: 'describe' }>
  | Readonly<{
      kind: 'working';
      steps: readonly SetupStep[];
      runsOn: string | null;
      /**
       * Where Stop stands: asked and not yet confirmed, or refused by the Run's target (the Run may still be going;
       * the step says so and offers Retry, never Describe).
       */
      stop: 'idle' | 'stopping' | Readonly<{ refused: string; machine: string | null; onRetry: () => void }>;
    }>
  | Readonly<{
      kind: 'recommendations';
      cards: readonly NewAppAutoCard[];
      source: string | null;
    }>
  | Readonly<{ kind: 'noAgent'; serverId: string | null; machines: readonly NewAppAutoMachine[] }>
  /** The suggestion owner needs answers first: the canonical questions, asked in the step (journey-deploy F2). */
  | Readonly<{ kind: 'questions'; questions: readonly InteractionTransientQuestionV1[] }>
  | Readonly<{ kind: 'nothing' }>
  /** The suggestion owner's typed failure code, kept for the Details disclosure. */
  | Readonly<{ kind: 'failed'; code: string }>;

export function NewAppAutoStep(
  props: Readonly<{
    view: NewAppAutoView;
    description: string;
    onDescriptionChange: (next: string) => void;
    chosenCardId: string | null;
    onChooseCard: (id: string) => void;
    onEditDescription: () => void;
    onTryAgain: () => void;
    onChooseStarter: () => void;
    /** The open round's answers and whether they are complete, for the dialog footer's Suggest again. */
    onQuestionState?: (state: TransientQuestionAnswerState) => void;
    phone: boolean;
    /** The dialog's inset for content that has no sheet of its own (NewAppScreen `dialogInset`). */
    insetStyle: object | null;
  }>,
) {
  const { theme } = useUnistyles();
  const { view } = props;
  const checklist = React.useMemo(() => view.kind === 'working' ? projectReportedSteps(view.steps) : null, [view]);

  if (view.kind === 'recommendations') {
    return (
      <View testID="newApp.auto.recommendations">
        <NewAppDeploySummary
          phone={props.phone}
          frame={null}
          onChangeSource={props.onEditDescription}
          source={{ title: t('newApp.auto.sourceTitle'), note: view.source }}
        />
        <ItemGroup surface="none">
          <View style={props.insetStyle}>
            <SelectionTiles
              testIdPrefix="newApp.auto.card"
              maximumColumns={1}
              subtitleLines={0}
              accessibilityLabel={t('newApp.auto.recommendationsTitle')}
              value={props.chosenCardId}
              onChange={(id) => {
                if (id) props.onChooseCard(id);
              }}
              options={view.cards.map((card) => ({
                id: card.id,
                title: card.title,
                subtitle: card.why,
                ...(card.recommended
                  ? { badge: t('newApp.auto.recommended') }
                  : {}),
              }))}
              renderOptionFooter={({ option }) => {
                const card = view.cards.find(
                  (candidate) => candidate.id === option.id,
                );
                return card ? (
                  <CardFacts facts={card.facts} phone={props.phone} />
                ) : null;
              }}
            />
          </View>
        </ItemGroup>
      </View>
    );
  }

  if (view.kind === 'failed') {
    // A failure keeps the owner's typed code behind Details (DESIGN.md "Error and recovery copy").
    return (
      <SurfaceStateCard
        testID="newApp.auto.failed"
        kind="error"
        title={t('newApp.auto.nothingTitle')}
        reason={t('newApp.auto.failedBody')}
        diagnosticCode={view.code}
        action={{ label: t('newApp.auto.tryAgain'), onPress: props.onTryAgain, testID: 'newApp.auto.tryAgain' }}
        secondaryAction={{ label: t('newApp.auto.chooseStarter'), onPress: props.onChooseStarter, testID: 'newApp.auto.chooseStarter' }}
      />
    );
  }

  if (view.kind === 'nothing') {
    return (
      <EmptyState
        testID="newApp.auto.nothing"
        layout="centered"
        iconName="sparkle"
        title={t('newApp.auto.nothingTitle')}
        subtitle={t('newApp.auto.nothingBody')}
        primaryAction={{
          label: t('newApp.auto.tryAgain'),
          onPress: props.onTryAgain,
          testID: 'newApp.auto.tryAgain',
        }}
        secondaryAction={{
          label: t('newApp.auto.chooseStarter'),
          onPress: props.onChooseStarter,
          testID: 'newApp.auto.chooseStarter',
        }}
      />
    );
  }

  return (
    <View testID={`newApp.auto.${view.kind}`}>
      <ItemGroup surface="none">
        <View style={props.insetStyle}>
          <FieldTextInput
            testID="newApp.auto.description"
            value={props.description}
            onChangeText={props.onDescriptionChange}
            accessibilityLabel={t('newApp.auto.descriptionLabel')}
            placeholder={t('newApp.auto.descriptionPlaceholder')}
            multiline
            minLines={props.phone ? 5 : 4}
            growWithText
            editable={view.kind !== 'working'}
            autoFocus={view.kind === 'describe' && !props.phone}
          />
        </View>
      </ItemGroup>
      {view.kind === 'questions' ? (
        <ItemGroup surface="none" testID="newApp.auto.questions">
          <View style={props.insetStyle}>
            <AutoQuestions key={view.questions.map((question) => question.id).join('|')} questions={view.questions}
              onState={props.onQuestionState} />
          </View>
        </ItemGroup>
      ) : null}
      {view.kind === 'working' && checklist ? (
        // The checklist is the card under its title (one card, as the Setup tab's run); where the work runs is the
        // section's description, on its inset.
        <ItemGroup
          surface="none"
          title={t('newApp.auto.workingTitle')}
          {...(view.runsOn ? { description: <Text testID="newApp.auto.runsOn" variant="meta">{view.runsOn}</Text> } : {})}
          testID="newApp.auto.steps"
        >
          <PlanChecklistCard
            phase="execute"
            {...checklist}
            testID="newApp.auto.progress"
          />
        </ItemGroup>
      ) : null}
      {view.kind === 'working' && typeof view.stop === 'object' ? (
        <AttentionBanner
          testID="newApp.auto.stopRefused"
          tone="danger"
          announce="alert"
          title={t('newApp.auto.stopRefusedTitle')}
          description={view.stop.machine ? t('newApp.auto.stopRefusedBody', { machine: view.stop.machine }) : undefined}
          details={[view.stop.refused]}
          action={{ label: t('common.retry'), onPress: view.stop.onRetry, testID: 'newApp.auto.stopRefused.retry' }}
        />
      ) : null}
      {view.kind === 'noAgent' ? (
        <>
          <AttentionBanner
            testID="newApp.auto.noAgent.banner"
            tone="warning"
            announce="status"
            title={t('newApp.auto.noAgentTitle')}
            description={t('newApp.auto.noAgentBody')}
          />
          {view.machines.length === 0 ? null : (
          <ItemGroup
            title={t('newApp.auto.whatsMissing')}
            testID="newApp.auto.noAgent.machines"
          >
            {view.machines.map((machine) => (
              <NoAgentMachineRow key={machine.machineId} serverId={view.serverId} machine={machine} />
            ))}
          </ItemGroup>
          )}
        </>
      ) : null}
    </View>
  );
}

/** A Machine the suggestion snapshot couldn't name yet holds the loading bar until the Machine owner settles its name. */
const MACHINE_NAME_PENDING_TITLE = <SkeletonTitle lineHeight={Typography.variant('body').lineHeight as number} testID="newApp.auto.noAgent.namePending" />;

function NoAgentMachineRow(props: Readonly<{ serverId: string | null; machine: NewAppAutoMachine }>) {
  const { theme } = useUnistyles();
  const { machine } = props;
  const settledName = useServerScopedMachineLabel(props.serverId, machine.title === null ? machine.machineId : null);
  return (
    <Item
      testID={`newApp.auto.noAgent.${machine.machineId}`}
      title={machine.title ?? settledName ?? MACHINE_NAME_PENDING_TITLE}
      subtitle={machine.status}
      subtitleLines={0}
      showChevron={false}
      icon={
        <Icon
          name={machine.glyph}
          size={ICON_SIZE.sm}
          color={theme.colors.text.secondary}
        />
      }
      {...(machine.attention
        ? {
            subtitleStyle: {
              color: theme.colors.state.warning.foreground,
            },
          }
        : {})}
      rightElement={
        machine.action ? (
          <RoundButton
            testID={`newApp.auto.noAgent.${machine.machineId}.action`}
            size="small"
            display="inverted"
            title={machine.action.label}
            onPress={machine.action.onPress}
          />
        ) : undefined
      }
    />
  );
}

/** One round of questions: its answers live here, so a new round starts empty; the footer reads them through `onState`. */
function AutoQuestions(props: Readonly<{
  questions: readonly InteractionTransientQuestionV1[];
  onState?: (state: TransientQuestionAnswerState) => void;
}>) {
  const state = useTransientQuestionAnswers(props.questions);
  const { onState } = props;
  const { answers, ready } = state;
  React.useEffect(() => { onState?.(state); }, [onState, answers, ready]); // eslint-disable-line react-hooks/exhaustive-deps
  return <TransientQuestionFields questions={props.questions} state={state} />;
}

const FACT_LABEL_KEY = {
  startsFrom: 'newApp.auto.factStartsFrom',
  runsOn: 'newApp.auto.factRunsOn',
  data: 'newApp.auto.factData',
} as const;

/** The card's floor: its three labelled facts on one label column, the identity before each value. */
function CardFacts(
  props: Readonly<{ facts: readonly NewAppAutoFact[]; phone: boolean }>,
) {
  const { theme } = useUnistyles();
  return (
    <View style={styles.facts}>
      {props.facts.map((fact) => (
        <FieldLayout
          key={fact.key}
          label={t(FACT_LABEL_KEY[fact.key])}
          columns={!props.phone}
        >
          <View style={styles.factValue}>
            {fact.mark ?? null}
            <Text
              variant="body"
              style={{ flexShrink: 1, color: theme.colors.text.primary }}
            >
              {fact.value}
            </Text>
          </View>
        </FieldLayout>
      ))}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  facts: {
    gap: theme.space.s6,
    paddingTop: theme.space.s12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border.default,
  },
  factValue: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
  },
}));
