import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { t } from '@/text';
import type { TriggerSummarySource } from '../triggers/formatTriggerSummary';

import { resolveTriggerEventGroup } from '../triggers/triggerEventGroups';
import {
  WorkflowSentenceChip,
  WorkflowSentenceUnit,
  WorkflowSentenceWord,
} from './WorkflowSentenceChip';

/** "A pull request opens" reads "a pull request opens" after "When"; a name keeps its capitals. */
function lowerStart(text: string): string {
  return /^\p{Lu}\p{Ll}/u.test(text)
    ? text.charAt(0).toLocaleLowerCase() + text.slice(1)
    : text;
}

/** A trigger's own sentence after the clause's "When": a summary that already opens with the word drops it. */
function readWhenChipLabel(title: string, when: string): string {
  const lead = `${when} `;
  return lowerStart(
    title.toLocaleLowerCase().startsWith(lead.toLocaleLowerCase())
      ? title.slice(lead.length)
      : title,
  );
}

/**
 * A workflow's Sentence view at static props (scene 8 D4, the 11-16 Sentence view): what starts it, then its steps
 * joined by "then", at the card's compact size. It reads only the list header's facts (the trigger summaries and
 * the authored preview step labels), never the definition body, and holds no control: the card is the press target.
 */
export const WorkflowSentencePreview = React.memo(
  function WorkflowSentencePreview(
    props: Readonly<{
      triggers: readonly (TriggerSummarySource & Readonly<{ enabled?: boolean }>)[];
      steps: readonly string[];
      testID?: string;
    }>,
  ) {
    const when = t('workflows.sentence.when');
    return (
      <View
        testID={props.testID}
        style={styles.sentence}
        importantForAccessibility="no-hide-descendants"
      >
        <View style={styles.line}>
          {props.triggers.length === 0 ? (
            <WorkflowSentenceWord size="compact">
              {t('workflows.triggers.card.manualSentence')}
            </WorkflowSentenceWord>
          ) : (
            props.triggers.map((trigger, index) => {
              const group = resolveTriggerEventGroup(trigger);
              return (
                <WorkflowSentenceUnit key={`${group.id}:${index}`}>
                  <View style={styles.unit}>
                    <WorkflowSentenceWord size="compact">
                      {index === 0 ? when : t('workflows.sentence.or')}
                    </WorkflowSentenceWord>
                    <WorkflowSentenceChip
                      kind="option"
                      size="compact"
                      icon={group.glyph}
                      label={readWhenChipLabel(group.title, when)}
                    />
                  </View>
                </WorkflowSentenceUnit>
              );
            })
          )}
        </View>
        {props.steps.length === 0 ? null : (
          <View style={styles.line}>
            {props.steps.map((step, index) => (
              <View key={`${index}:${step}`} style={styles.unit}>
                {index === 0 ? null : (
                  <WorkflowSentenceWord size="compact">
                    {t('workflows.sentence.then')}
                  </WorkflowSentenceWord>
                )}
                <WorkflowSentenceChip kind="step" size="compact" label={step} />
              </View>
            ))}
          </View>
        )}
      </View>
    );
  },
);

const styles = StyleSheet.create((theme) => ({
  sentence: {
    gap: theme.space.s6,
    minWidth: 0,
  },
  line: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: theme.space.s6,
    rowGap: theme.space.s4,
    minWidth: 0,
  },
  // A word and the chip it introduces stay on one line, so no "then" is stranded at a line's end.
  unit: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s6,
    maxWidth: '100%',
    minWidth: 0,
  },
}));
