import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { HappierPressable, HAPPIER_PRESS_FEEDBACK_V1 } from '@happier-dev/plugin-ui/presentation';
import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { WorkflowAuthoredResultReference } from '@happier-dev/protocol/workflows/workflowReferenceV1';

import { Text, TextInput } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { listWorkflowFinalOutputOptions } from '@/sync/domains/workflows/workflowAuthoring';
import type { WorkflowEditorDraft } from '@/sync/domains/workflows/workflowEditorDraft';
import { t } from '@/text';

import { workflowEditorStyles } from './workflowEditorStyles';

const styles = StyleSheet.create((theme) => ({
    root: { gap: theme.margins.sm },
    title: { ...Typography.default('semiBold'), color: theme.colors.text.primary },
    help: { ...Typography.default('regular'), color: theme.colors.text.secondary },
    options: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: theme.margins.sm },
    option: { ...Typography.default('regular'), color: theme.colors.text.secondary },
    selected: { ...Typography.default('semiBold'), color: theme.colors.text.link },
    path: { ...Typography.default('regular'), color: theme.colors.text.primary, minWidth: 180 },
}));

function formatPath(path: WorkflowAuthoredResultReference['path']): string {
    return path.join('.');
}

function parsePath(value: string): WorkflowAuthoredResultReference['path'] {
    if (value.trim().length === 0) return [];
    return value.split('.').filter(Boolean).map((part) => (/^(0|[1-9][0-9]*)$/u.test(part) ? Number(part) : part));
}

export function WorkflowFinalOutputEditor(props: Readonly<{
    draft: WorkflowEditorDraft;
    onChange: (value: WorkflowAuthoredResultReference | null) => void;
    testIDPrefix: string;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const options = React.useMemo(() => listWorkflowFinalOutputOptions(props.draft), [props.draft]);
    const selected = props.draft.finalOutput;
    return (
        <View testID={`${props.testIDPrefix}-final-output-editor`} style={styles.root}>
            <Text style={styles.title}>{t('workflows.finalOutput.title')}</Text>
            <Text style={styles.help}>{t('workflows.finalOutput.explain')}</Text>
            <View
                style={styles.options}
                accessibilityRole="radiogroup"
                accessibilityLabel={t('workflows.finalOutput.title')}
            >
                <HappierPressable
                    testID={`${props.testIDPrefix}-final-output-clear`}
                    accessibilityRole="radio"
                    checked={selected === undefined}
                    onPress={() => props.onChange(null)}
                    style={(state) => [workflowEditorStyles.actionTarget, state.pressed ? { opacity: HAPPIER_PRESS_FEEDBACK_V1.opacitySubtle } : null, focusRingStyle({ focused: state.focused, color: theme.colors.border.focus })]}
                >
                    <Text style={selected === undefined ? styles.selected : styles.option}>
                        {t('workflows.finalOutput.none')}
                    </Text>
                </HappierPressable>
                {options.map((option) => (
                    <HappierPressable
                        key={option.blockId}
                        testID={`${props.testIDPrefix}-final-output-option-${option.blockId}`}
                        accessibilityRole="radio"
                        checked={selected?.producer.blockId === option.blockId}
                        onPress={() => props.onChange({
                            kind: 'result',
                            producer: { blockId: option.blockId, scope: { kind: 'current' } },
                            path: selected?.producer.blockId === option.blockId ? selected.path : [],
                        })}
                        style={(state) => [workflowEditorStyles.actionTarget, state.pressed ? { opacity: HAPPIER_PRESS_FEEDBACK_V1.opacitySubtle } : null, focusRingStyle({ focused: state.focused, color: theme.colors.border.focus })]}
                    >
                        <Text style={selected?.producer.blockId === option.blockId ? styles.selected : styles.option}>
                            {option.label}
                        </Text>
                    </HappierPressable>
                ))}
            </View>
            {selected === undefined ? null : (
                <TextInput
                    testID={`${props.testIDPrefix}-final-output-path`}
                    style={styles.path}
                    value={formatPath(selected.path)}
                    autoCapitalize="none"
                    autoCorrect={false}
                    placeholder={t('workflows.finalOutput.fieldPath')}
                    accessibilityLabel={t('workflows.finalOutput.fieldPath')}
                    onChangeText={(value) => props.onChange({ ...selected, path: parsePath(value) })}
                />
            )}
        </View>
    );
}
