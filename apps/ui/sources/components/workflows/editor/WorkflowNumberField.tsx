import * as React from 'react';
import { View } from 'react-native';

import { Text, TextInput } from '@/components/ui/text/Text';
import { t } from '@/text';

import { workflowEditorStyles } from './workflowEditorStyles';

/**
 * One authored whole-number field for the workflow editor: maximum concurrent
 * branches/items, maximum rounds and a step's result-wait timeout.
 *
 * It keeps the exact text being typed and hands the draft the number that text
 * means. Text that is not a numeral becomes the unresolved number (`NaN`) the
 * canonical validator rejects at that field's path, so "1x" or "1.5" never
 * silently turns into 1, "0" never turns into "no limit", and the page-level
 * command reason names the repair. An empty optional field is omission — the
 * precise meaning "no authored value" — and an empty required field is the
 * same unresolved number. No default, minimum or maximum is invented here:
 * the only constraint is the canonical schema's positive safe integer, echoed
 * inline so the repair is visible where it is typed.
 */

/** Empty text is no value; anything else is the number the text means, `NaN` when it is not a numeral. */
export function parseAuthoredNumber(text: string): number | undefined {
    const trimmed = text.trim();
    if (trimmed.length === 0) return undefined;
    return Number(trimmed);
}

function formatAuthoredNumber(value: number | undefined): string {
    return value === undefined || Number.isNaN(value) ? '' : String(value);
}

/** Display predicate for the canonical `int().positive().safe()` constraint; the validator remains the gate. */
export function isAuthoredPositiveInteger(value: number): boolean {
    return Number.isSafeInteger(value) && value > 0;
}

export function WorkflowNumberField(props: Readonly<{
    label: string;
    value: number | undefined;
    onChange: (value: number | undefined) => void;
    /** A required field has no "omitted" reading: clearing it leaves an unresolved number. */
    required?: boolean;
    /** Shown in the empty optional field, naming what omission means. */
    placeholder?: string;
    /** Words after the field when the label reads as a sentence around it ("Stop after [4] rounds"). */
    suffix?: string;
    /** The field's spoken name when the visible label is only the start of that sentence. */
    accessibilityLabel?: string;
    testID: string;
}>): React.ReactElement {
    const { onChange, required, value } = props;
    // What the draft holds for a given text: a required field has no omitted
    // reading, so its empty text is the unresolved number.
    const valueMeant = React.useCallback((candidate: string): number | undefined => {
        const parsed = parseAuthoredNumber(candidate);
        return parsed === undefined && required === true ? Number.NaN : parsed;
    }, [required]);
    const [text, setText] = React.useState(() => formatAuthoredNumber(value));
    // The draft is the source of truth; the typed text is kept only while it
    // still means the draft's value, so an external change (undo, reopen)
    // replaces it and an in-progress edit is never overwritten mid-keystroke.
    const textRef = React.useRef(text);
    textRef.current = text;
    React.useEffect(() => {
        if (Object.is(valueMeant(textRef.current), value)) return;
        setText(formatAuthoredNumber(value));
    }, [value, valueMeant]);

    const invalid = value !== undefined && !isAuthoredPositiveInteger(value);
    const invalidMessage = t('workflows.editor.wholeNumberRequired');

    return (
        <View>
            <View style={workflowEditorStyles.inlineControl}>
                <Text style={workflowEditorStyles.metaText}>{props.label}</Text>
                <TextInput
                    testID={props.testID}
                    style={[workflowEditorStyles.inlineValue, workflowEditorStyles.numberValue]}
                    value={text}
                    keyboardType="number-pad"
                    accessibilityLabel={props.accessibilityLabel ?? props.label}
                    // The repair reaches assistive technology on the field itself,
                    // not only as nearby text.
                    {...(invalid ? { accessibilityHint: invalidMessage } : {})}
                    {...(props.placeholder === undefined ? {} : { placeholder: props.placeholder })}
                    onChangeText={(next) => {
                        setText(next);
                        onChange(valueMeant(next));
                    }}
                />
                {props.suffix !== undefined ? (
                    <Text style={workflowEditorStyles.metaText}>{props.suffix}</Text>
                ) : null}
                {value === undefined && props.placeholder !== undefined ? (
                    <Text testID={`${props.testID}-omitted`} style={workflowEditorStyles.groupSummary}>
                        {props.placeholder}
                    </Text>
                ) : null}
            </View>
            {invalid ? (
                <Text
                    testID={`${props.testID}-error`}
                    accessibilityRole="alert"
                    style={workflowEditorStyles.issueText}
                >
                    {invalidMessage}
                </Text>
            ) : null}
        </View>
    );
}
