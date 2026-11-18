import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { setWorkflowFinalOutput } from '@happier-dev/protocol/workflows/workflowDefinitionEditV1';

import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { WorkflowEditorDraft } from '@/sync/domains/workflows/workflowEditorDraft';
import { t } from '@/text';

import {
  useWorkflowEditorSelector,
  type WorkflowEditorDraftStore,
} from './workflowEditorDraftStore';
import { WorkflowFinalOutputEditor } from './WorkflowFinalOutputEditor';
import { WorkflowFieldPair } from './WorkflowStepDataEditor';
import {
  useWorkflowDocumentGridStyles,
  workflowEditorStyles,
} from './workflowEditorStyles';

const styles = StyleSheet.create((theme) => ({
  /** One document gap below the root's end row, which the spine crosses to reach the Result mark. */
  foot: {
    paddingTop: theme.space.s20,
  },
  /** The spine's last stretch: from the end row down to the Result mark. */
  spineIn: {
    top: 0,
    height: theme.space.s20,
  },
  body: {
    flex: 1,
    minWidth: 0,
    gap: theme.space.s8,
  },
  /** The title line holds the mark's height, so the mark and "Result" share one line. */
  titleLine: {
    minHeight: ICON_SIZE.lg,
    justifyContent: 'center',
  },
  decides: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: theme.space.s6,
  },
  decidesText: {
    ...Typography.variant('meta'),
    color: theme.colors.text.secondary,
    flex: 1,
    minWidth: 0,
  },
}));

const readWholeDraft = (draft: WorkflowEditorDraft) => draft;

/**
 * The workflow's Result at the page foot (round 1116 `page-proposed`): the spine's last node, and what the
 * workflow reports when it finishes, chosen through the final output owner.
 */
export function WorkflowResultFoot(
  props: Readonly<{
    draftStore: WorkflowEditorDraftStore;
    onChange: (next: WorkflowEditorDraft) => void;
    editable: boolean;
    /** A wait-mode "before an Action" trigger's consequence for this Result (`formatTriggerResultDecides`). */
    decides?: string | null;
    testIDPrefix: string;
  }>,
): React.ReactElement {
  const { theme } = useUnistyles();
  const grid = useWorkflowDocumentGridStyles();
  const draft = useWorkflowEditorSelector(props.draftStore, readWholeDraft);
  const id = `${props.testIDPrefix}-result`;
  return (
    <View testID={id} style={[grid.blockColumn, styles.foot]}>
      <View
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={[workflowEditorStyles.spineSegment, styles.spineIn]}
      />
      <View style={grid.heading}>
        <View
          style={[
            workflowEditorStyles.ordinalColumn,
            workflowEditorStyles.headingLine,
          ]}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          <View style={workflowEditorStyles.ordinalMark}>
            <Icon
              name="check-circle"
              size={ICON_SIZE.xxs}
              color={theme.colors.text.secondary}
            />
          </View>
        </View>
        <View style={styles.body}>
          <View style={styles.titleLine}>
            <Text
              accessibilityRole="header"
              style={workflowEditorStyles.headingName}
            >
              {t('workflows.finalOutput.sectionTitle')}
            </Text>
          </View>
          <View style={workflowEditorStyles.actionFieldRow}>
            <WorkflowFieldPair
              label={t('workflows.finalOutput.reports')}
              trackKey="reports"
            >
              <WorkflowFinalOutputEditor
                draft={draft}
                editable={props.editable}
                onChange={(finalOutput) =>
                  props.onChange(
                    setWorkflowFinalOutput(props.draftStore.get(), finalOutput),
                  )
                }
                testIDPrefix={id}
              />
            </WorkflowFieldPair>
          </View>
          {props.decides ? (
            <View testID={`${id}-decides`} style={styles.decides}>
              <Icon name="sign-in" size={ICON_SIZE.xs} color={theme.colors.text.tertiary} />
              <Text style={styles.decidesText}>{props.decides}</Text>
            </View>
          ) : null}
        </View>
      </View>
    </View>
  );
}
