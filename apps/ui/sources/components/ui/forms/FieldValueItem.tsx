import * as React from 'react';
import {
    resolveHappierFieldKeyboardType,
    useHappierFieldValueDraft,
    type HappierFieldValueKind,
    HappierFieldStepper,
    type HappierFieldStepperBounds,
} from '@happier-dev/plugin-ui/presentation';
import type { TextStyle } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { FIELD_BOX_METRICS, resolveFieldBoxColors } from './fieldBox';

import { Item, type ItemProps } from '@/components/ui/lists/Item';
import { Text, TextInput } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

import { FieldTextInput } from './FieldTextInput';

export type FieldValueKind = HappierFieldValueKind;

export type FieldValueItemProps = Omit<ItemProps, 'rightElement' | 'onPress' | 'showChevron' | 'detail'> & Readonly<{
    /** The saved value, as text. The field follows it whenever it changes. */
    value: string;
    /** A controlled form's acknowledged baseline, when value echoes its unsaved draft. */
    committedValue?: string;
    /** Visible unit beside a numeric draft; it is never included in the stored value. */
    unit?: string;
    stepper?: HappierFieldStepperBounds;
    /**
     * With `stepper`: one compact box holding − value + (a short count beside its label) instead of the
     * value's own field between two buttons. It has no room for a refusal under it.
     */
    compactStepper?: boolean;
    /**
     * Saves the typed value. Called when focus leaves the field or on submit, and only when the draft
     * differs from `value`. Return the text the field should show afterwards (a number moved to its
     * bound, the saved value when the draft was refused); return nothing to keep the draft.
     */
    onCommit: (draft: string) => string | void;
    /** Called with each draft as the field keeps it (e.g. to clear a refusal the user is correcting). */
    onDraftChange?: (draft: string) => void;
    /** `integer` and `decimal` keep the draft to digits and return an empty draft to the saved value. */
    kind?: FieldValueKind;
    /** A number that may be negative: the draft keeps one leading minus. */
    signed?: boolean;
    /** A number that may be left empty ("not set"): an empty draft commits instead of returning. */
    allowEmpty?: boolean;
    placeholder?: string;
    /** Test id of the text input (its error is `<fieldTestID>.error`). */
    fieldTestID?: string;
    /** A bounded value such as a clock time can use the field owner's compact width. */
    fieldStyle?: React.ComponentProps<typeof FieldTextInput>['style'];
    monospace?: boolean;
    /** Masks the draft as it is typed (secrets); pass `value=""` so a saved secret is never echoed. */
    secureTextEntry?: boolean;
    autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
    /** Controls browser/password-manager autofill for values that must come only from this form. */
    autoComplete?: React.ComponentProps<typeof FieldTextInput>['autoComplete'];
    /** Names the field; defaults to the row title. */
    fieldAccessibilityLabel?: string;
    error?: string | null;
    /** Focus the field when it appears (a value the user just asked to type). */
    autoFocus?: boolean;
}>;

/** The compact stepper's value: the field's text step, centred, wide enough for a short count. */
const compactValueStyle: TextStyle = {
    ...Typography.default(),
    width: 40,
    padding: 0,
    margin: 0,
    textAlign: 'center',
    fontSize: FIELD_BOX_METRICS.fontSizePx,
    lineHeight: FIELD_BOX_METRICS.lineHeightPx,
    fontVariant: ['tabular-nums'],
};

/**
 * A setting whose value is typed in place: the row's label on the left and a field on the right
 * (beneath it on narrow rows). The draft is local while typing and commits when focus leaves the
 * field or on submit, so a number or name never goes through a modal prompt.
 */
export const FieldValueItem = React.memo(function FieldValueItem(props: FieldValueItemProps) {
    const {
        value,
        committedValue,
        unit,
        stepper,
        compactStepper,
        onCommit,
        onDraftChange,
        kind = 'text',
        signed = false,
        allowEmpty,
        placeholder,
        fieldTestID,
        fieldStyle,
        monospace,
        secureTextEntry,
        autoCapitalize,
        autoComplete,
        fieldAccessibilityLabel,
        error,
        autoFocus,
        accessoryLayout = 'adaptive',
        ...itemProps
    } = props;
    // The draft, its filtering and the commit rule are the shared owner's (a plugin page field
    // typed in place commits through the same one).
    const field = useHappierFieldValueDraft({ value, committedValue, onCommit, onDraftChange, kind, signed, allowEmpty, stepper });
    const { theme } = useUnistyles();

    const title = typeof itemProps.title === 'string' ? itemProps.title : undefined;
    // The subtitle sits beside the field, so it is attached for a screen reader focused on the field.
    const description = typeof itemProps.subtitle === 'string' ? itemProps.subtitle : undefined;
    const input = (
                <FieldTextInput
                    testID={fieldTestID}
                    value={field.draft}
                    onChangeText={field.change}
                    accessibilityLabel={fieldAccessibilityLabel ?? (unit ? `${title ?? ''} (${unit})` : title ?? '')}
                    trailing={unit ? <Text style={{ fontSize: FIELD_BOX_METRICS.fontSizePx, color: theme.colors.text.secondary }}>{unit}</Text> : undefined}
                    accessibilityHint={description}
                    placeholder={placeholder}
                    keyboardType={resolveHappierFieldKeyboardType(kind, signed)}
                    monospace={monospace}
                    secureTextEntry={secureTextEntry}
                    autoCapitalize={autoCapitalize}
                    autoComplete={autoComplete}
                    editable={itemProps.disabled !== true}
                    error={error}
                    autoFocus={autoFocus}
                    onBlur={field.commit}
                    onSubmitEditing={field.commit}
                    style={[stepper ? { minWidth: 0, width: FIELD_BOX_METRICS.triggerMinWidthPx } : undefined, fieldStyle]}
                    // A number with its unit reads as one phrase ("3 messages"): the digits sit against the unit.
                    textAlign={unit && kind !== 'text' ? 'right' : undefined}
                />
    );
    const compact = stepper !== undefined && compactStepper === true;
    const compactValue = compact ? (
        <TextInput
            testID={fieldTestID}
            value={field.draft}
            onChangeText={field.change}
            accessibilityLabel={fieldAccessibilityLabel ?? (unit ? `${title ?? ''} (${unit})` : title ?? '')}
            accessibilityHint={description}
            keyboardType={resolveHappierFieldKeyboardType(kind, signed)}
            editable={itemProps.disabled !== true}
            onBlur={field.commit}
            onSubmitEditing={field.commit}
            style={[compactValueStyle, { color: theme.colors.text.primary }]}
        />
    ) : null;
    return (
        <Item
            {...itemProps}
            showChevron={false}
            // A compact count is a short value: it stays beside its label on a phone too.
            accessoryLayout={compact ? 'inline' : accessoryLayout}
            rightElement={stepper ? <HappierFieldStepper
                testID={fieldTestID} colors={resolveFieldBoxColors(theme, error ? 'invalid' : 'idle')}
                focusColor={theme.colors.border.focus}
                decreaseLabel={`${t('common.decrease')} ${title ?? ''}`}
                increaseLabel={`${t('common.increase')} ${title ?? ''}`}
                compact={compact} disabled={itemProps.disabled} canDecrement={field.canDecrement} canIncrement={field.canIncrement}
                onStep={field.stepBy} renderSymbol={(symbol) => <Text style={{ color: theme.colors.text.primary }}>{symbol}</Text>}
            >{compactValue ?? input}</HappierFieldStepper> : input}
        />
    );
});
