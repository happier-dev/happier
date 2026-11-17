import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { scanInlineReferenceTokensV1 } from '@happier-dev/protocol/runtime/input/inlineReferenceTokenV1';
import { MENTION_KIND_V1 } from '@happier-dev/protocol/runtime/input/mentionRefV1';
import type {
  WorkflowActionFieldBindingV1,
  WorkflowActionValueReferenceV1,
} from '@happier-dev/protocol/workflows/workflowLeafV1';

import type { ComposerEditorReference } from '@/components/ui/forms/composerEditor/composerEditorTypes';
import { MultiTextInput } from '@/components/ui/forms/MultiTextInput';
import { Text } from '@/components/ui/text/Text';
import { resolveFieldBoxColors } from '@/components/ui/forms/fieldBox';
import type { WorkflowEditorDraft } from '@/sync/domains/workflows/workflowEditorDraft';
import { t } from '@/text';

import { formatWorkflowValueReference } from '../presentation/workflowValuePresentation';
import {
  insertWorkflowActionFieldValue,
  readWorkflowActionFieldText,
  writeWorkflowActionFieldText,
} from './workflowActionTextField';
import { workflowEditorStyles } from './workflowEditorStyles';
import { WorkflowValuePicker } from './WorkflowValuePicker';
import { WorkflowInsertButton } from './workflowInsertChip';

/**
 * A text Action field with workflow values inside it (owner 2026-11-15, WF-SUBST's seam): the field
 * is its words with each value as a chip, typed into directly; Insert opens the same value list a
 * prompt's '@' opens and puts the value at the caret. Every write goes through the seam, so a field
 * with no value inside stays a plain value and a lone value stays that value.
 *
 * `null` for a field whose current value is not text (a number, a list, an object): its caller keeps
 * the value editor that owns that shape.
 */
export function WorkflowActionTextFieldEditor(
  props: Readonly<{
    draft: WorkflowEditorDraft;
    consumerBlockId: string;
    binding: WorkflowActionFieldBindingV1 | undefined;
    onChange: (next: WorkflowActionFieldBindingV1) => void;
    label: string;
    /** Marks the label line while the field still needs a value. */
    required?: boolean;
    placeholder: string;
    testID: string;
  }>,
): React.ReactElement | null {
  const { theme } = useUnistyles();
  const { draft } = props;
  const labelFor = React.useCallback(
    (reference: WorkflowActionValueReferenceV1) =>
      formatWorkflowValueReference(draft, reference),
    [draft],
  );
  const field = React.useMemo(
    () => readWorkflowActionFieldText(props.binding, labelFor),
    [props.binding, labelFor],
  );
  const selectionRef = React.useRef<{ start: number; end: number } | null>(
    null,
  );
  const [focused, setFocused] = React.useState(false);
  const references = React.useMemo((): readonly ComposerEditorReference[] => {
    if (field === null) return [];
    const bound = new Set(
      field.document.references.map((mention) => mention.token),
    );
    return scanInlineReferenceTokensV1(field.document.text).flatMap((token) => {
      const text = field.document.text.slice(token.start, token.end);
      return bound.has(text)
        ? [
            {
              ref: token.ref,
              token: text,
              start: token.start,
              end: token.end,
              kind: MENTION_KIND_V1.workflowInput,
              label: token.label,
            },
          ]
        : [];
    });
  }, [field]);
  if (field === null) return null;
  const { onChange } = props;
  const colors = resolveFieldBoxColors(theme, focused ? 'focused' : 'idle');
  return (
    <View style={workflowEditorStyles.textFieldStack}>
      {/* The label line (round 1116b g): the field's name, then Insert at its end. */}
      <View style={workflowEditorStyles.textFieldLabelLine}>
        <Text style={workflowEditorStyles.actionFieldLabel}>{props.label}</Text>
        {props.required === true && field.document.text.trim().length === 0 ? (
          <Text testID={`${props.testID}-required`} style={workflowEditorStyles.actionFieldMarker}>
            {t('workflows.page.blocks.required')}
          </Text>
        ) : null}
        <View style={workflowEditorStyles.textFieldLabelEnd}>
          <WorkflowValuePicker
            draft={draft}
            consumerBlockId={props.consumerBlockId}
            reference={null}
            label={t('workflows.editor.insertValue')}
            onChange={(reference) =>
              onChange(
                insertWorkflowActionFieldValue(field, {
                  reference: reference as WorkflowActionValueReferenceV1,
                  label: labelFor(reference as WorkflowActionValueReferenceV1),
                  ...(selectionRef.current === null
                    ? {}
                    : { selection: selectionRef.current }),
                }),
              )
            }
            renderTrigger={({ toggle }) => (
              <WorkflowInsertButton
                testID={`${props.testID}-insert`}
                target={props.label}
                onPress={toggle}
              />
            )}
            testID={`${props.testID}-insert-list`}
          />
        </View>
      </View>
      <View
        style={[
          workflowEditorStyles.textFieldBox,
          {
            borderColor: colors.borderColor,
            backgroundColor: colors.backgroundColor,
          },
        ]}
      >
        <MultiTextInput
          testID={`${props.testID}-text`}
          value={field.document.text}
          references={references}
          placeholder={props.placeholder}
          accessibilityLabel={props.label}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onSelectionChange={(selection) => {
            selectionRef.current = selection;
          }}
          onChangeText={(text) =>
            onChange(
              writeWorkflowActionFieldText(field, {
                text,
                // A value whose chip was deleted with its words leaves the document with them.
                references: field.document.references.filter((mention) =>
                  text.includes(mention.token),
                ),
              }),
            )
          }
        />
      </View>
    </View>
  );
}
