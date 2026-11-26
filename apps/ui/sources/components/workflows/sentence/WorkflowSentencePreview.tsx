import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { t } from '@/text';
import type { IconName } from '@/components/ui/icons/Icon';
import {
  WorkflowSentenceChip,
  WorkflowSentenceUnit,
  WorkflowSentenceWord,
} from './WorkflowSentenceChip';

/**
 * A workflow's Sentence view at static props (scene 8 D4, the 11-16 Sentence view): what starts it, then its steps
 * joined by "then", at the card's compact size. It reads only the list header's facts (the trigger summaries and
 * the authored preview step labels), never the definition body, and holds no control: the card is the press target.
 */
export const WorkflowSentencePreview = React.memo(
  function WorkflowSentencePreview(
    props: Readonly<{
      triggerLine: string | null;
      triggerGlyph?: IconName;
      steps: readonly string[];
      testID?: string;
    }>,
  ) {
    return (
      <View
        testID={props.testID}
        style={styles.sentence}
        importantForAccessibility="no-hide-descendants"
      >
        {props.triggerLine === null ? null : (
          <View style={styles.line}>
            {props.triggerGlyph === undefined ? (
              <WorkflowSentenceWord size="compact">{props.triggerLine}</WorkflowSentenceWord>
            ) : (
              <WorkflowSentenceUnit>
                <View style={styles.unit}>
                  <WorkflowSentenceChip kind="option" size="compact" icon={props.triggerGlyph} label={props.triggerLine} />
                </View>
              </WorkflowSentenceUnit>
            )}
          </View>
        )}
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
