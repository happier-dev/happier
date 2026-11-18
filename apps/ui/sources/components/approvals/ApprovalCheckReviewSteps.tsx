import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type {
  WorkflowBlock,
  WorkflowDefinitionV1,
} from '@happier-dev/protocol/workflows/workflowV1';

import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { Text } from '@/components/ui/text/Text';
import { workflowBlockReferenceLabel } from '@/sync/domains/workflows/workflowBlockLabel';
import { t } from '@/text';

/** What one step does, in a line: an Agent step's own instructions, a wait's note, or the Action it runs. */
function readStepConsequence(
  block: WorkflowBlock,
): Readonly<{ text: string; agent: boolean }> | null {
  if (block.kind === 'step')
    return block.document.text.trim()
      ? { text: block.document.text.trim(), agent: true }
      : null;
  if (block.kind === 'wait')
    return block.document.text.trim()
      ? { text: block.document.text.trim(), agent: false }
      : null;
  // A named Action step says which Action it runs; an unnamed one is already titled by it.
  if (block.kind === 'action' && block.name?.trim())
    return {
      text: workflowBlockReferenceLabel({ ...block, name: undefined }),
      agent: false,
    };
  return null;
}

/**
 * A shared check's steps, opened in place on its consent card (05 S8 Review steps): each top-level step numbered with
 * the one line that says what it does; an Agent step shows its full instructions. When the check asks again because
 * its steps changed, the changed steps are outlined and tagged.
 */
export const ApprovalCheckReviewSteps = React.memo(
  function ApprovalCheckReviewSteps(
    props: Readonly<{
      review: Readonly<{
        definition: WorkflowDefinitionV1 | null;
        status: 'idle' | 'loading' | 'failed' | 'ready';
        retry: () => void;
      }>;
      changedBlockIds: ReadonlySet<string>;
      testID?: string;
    }>,
  ) {
    const styles = stylesheet;
    const { definition, status, retry } = props.review;
    if (status === 'failed' || (status === 'ready' && !definition)) {
      return (
        <View
          style={styles.line}
          testID={props.testID}
        >
          <Text variant="meta" style={styles.secondary}>
            {t('workflows.triggers.checks.reviewStepsFailed')}
          </Text>
          <TextLinkButton
            label={t('common.retry')}
            size="meta"
            onPress={retry}
          />
        </View>
      );
    }
    if (!definition) {
      return (
        <View style={styles.loading} testID={props.testID}>
          <ActivitySpinner size="small" />
        </View>
      );
    }
    return (
      <View style={styles.list} testID={props.testID}>
        {definition.blocks.map((block, index) => {
          const changed = props.changedBlockIds.has(block.id);
          const consequence = readStepConsequence(block);
          return (
            <View
              key={block.id}
              style={[styles.step, changed && styles.changed]}
              testID={
                props.testID
                  ? `${props.testID}:step:${block.id}${changed ? ':changed' : ''}`
                  : undefined
              }
            >
              <Text variant="meta" style={[styles.secondary, styles.ordinal]}>
                {index + 1}
              </Text>
              <View style={styles.stepBody}>
                <View style={styles.titleLine}>
                  <Text variant="body" emphasis="medium" style={styles.title}>
                    {workflowBlockReferenceLabel(block)}
                  </Text>
                  {changed ? (
                    <Text variant="micro" emphasis="medium" style={styles.tag}>
                      {t('workflows.triggers.checks.stepChanged')}
                    </Text>
                  ) : null}
                </View>
                {consequence ? (
                  <Text
                    variant={consequence.agent ? 'body' : 'meta'}
                    style={consequence.agent ? styles.primary : styles.secondary}
                  >
                    {consequence.text}
                  </Text>
                ) : null}
                {consequence?.agent ? (
                  <Text variant="meta" style={styles.secondary}>
                    {t('workflows.triggers.checks.agentStepNote')}
                  </Text>
                ) : null}
              </View>
            </View>
          );
        })}
      </View>
    );
  },
);

const stylesheet = StyleSheet.create((theme) => ({
  list: { gap: theme.space.s6 },
  loading: { alignItems: 'flex-start', paddingVertical: theme.space.s4 },
  line: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    columnGap: theme.space.s8,
  },
  secondary: { color: theme.colors.text.secondary },
  step: {
    flexDirection: 'row',
    gap: theme.space.s10,
    paddingHorizontal: theme.space.s12,
    paddingVertical: theme.space.s8,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface.base,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border.subtle,
  },
  // The step that changed since it was allowed: the stronger ink edge, never a status colour (it asks, it is not failing).
  changed: { borderColor: theme.colors.border.strong },
  ordinal: { fontVariant: ['tabular-nums'] },
  stepBody: { flex: 1, gap: theme.space.s2 },
  titleLine: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    columnGap: theme.space.s8,
  },
  title: { flexShrink: 1, color: theme.colors.text.primary },
  primary: { color: theme.colors.text.primary },
  tag: {
    color: theme.colors.text.secondary,
    paddingHorizontal: theme.space.s6,
    borderRadius: theme.borderRadius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border.strong,
  },
}));
