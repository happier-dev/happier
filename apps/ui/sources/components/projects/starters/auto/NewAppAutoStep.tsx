import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { SelectionTiles } from '@/components/ui/forms/SelectionTiles';
import { Icon, ICON_SIZE, type IconName } from '@/components/ui/icons/Icon';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { FieldLayout } from '@/components/ui/lists/FieldRow';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import {
  SetupSteps,
  type SetupStep,
} from '@/components/ui/setupBlocks/SetupSteps';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

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
  title: string;
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
    }>
  | Readonly<{
      kind: 'recommendations';
      cards: readonly NewAppAutoCard[];
      source: string | null;
    }>
  | Readonly<{ kind: 'noAgent'; machines: readonly NewAppAutoMachine[] }>
  | Readonly<{ kind: 'nothing' }>
  | Readonly<{ kind: 'failed' }>;

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
    phone: boolean;
    /** The dialog's inset for content that has no sheet of its own (NewAppScreen `dialogInset`). */
    insetStyle: object | null;
  }>,
) {
  const { theme } = useUnistyles();
  const { view } = props;

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

  if (view.kind === 'nothing' || view.kind === 'failed') {
    return (
      <EmptyState
        testID={`newApp.auto.${view.kind}`}
        layout="centered"
        iconName="sparkle"
        title={t('newApp.auto.nothingTitle')}
        subtitle={t(
          view.kind === 'nothing'
            ? 'newApp.auto.nothingBody'
            : 'newApp.auto.failedBody',
        )}
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
      {view.kind === 'working' ? (
        <ItemGroup
          title={t('newApp.auto.workingTitle')}
          testID="newApp.auto.steps"
        >
          <View style={styles.steps}>
            <SetupSteps
              variant="checklist"
              steps={view.steps}
              testID="newApp.auto.progress"
            />
          </View>
        </ItemGroup>
      ) : null}
      {view.kind === 'working' && view.runsOn ? (
        <Text
          testID="newApp.auto.runsOn"
          variant="meta"
          style={[
            styles.runsOn,
            props.insetStyle,
            { color: theme.colors.text.secondary },
          ]}
        >
          {view.runsOn}
        </Text>
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
              <Item
                key={machine.machineId}
                testID={`newApp.auto.noAgent.${machine.machineId}`}
                title={machine.title}
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
            ))}
          </ItemGroup>
          )}
        </>
      ) : null}
    </View>
  );
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
  steps: {
    paddingHorizontal: theme.space.s16,
    paddingVertical: theme.space.s12,
  },
  runsOn: { paddingTop: theme.space.s8 },
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
