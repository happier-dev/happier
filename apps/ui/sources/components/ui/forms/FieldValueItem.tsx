import * as React from 'react';
import {
    resolveHappierFieldKeyboardType,
    useHappierFieldValueDraft,
    type HappierFieldValueKind,
    HappierFieldStepper,
    type HappierFieldStepperBounds,
} from '@happier-dev/plugin-ui/presentation';
import { useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { FIELD_BOX_METRICS, resolveFieldBoxColors } from './fieldBox';

import { Item, type ItemProps } from '@/components/ui/lists/Item';
import { Text } from '@/components/ui/text/Text';

import { FieldTextInput } from './FieldTextInput';

export type FieldValueKind = HappierFieldValueKind;

export type FieldValueItemProps = Omit<ItemProps, 'rightElement' | 'onPress' | 'accessoryLayout' | 'showChevron' | 'detail'> & Readonly<{
    /** The saved value, as text. The field follows it whenever it changes. */
    value: string;
    /** Visible unit beside a numeric draft; it is never included in the stored value. */
    unit?: string;
    stepper?: HappierFieldStepperBounds;
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
    monospace?: boolean;
    /** Masks the draft as it is typed (secrets); pass `value=""` so a saved secret is never echoed. */
    secureTextEntry?: boolean;
    autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
    /** Names the field; defaults to the row title. */
    fieldAccessibilityLabel?: string;
    error?: string | null;
    /** Focus the field when it appears (a value the user just asked to type). */
    autoFocus?: boolean;
}>;

/**
 * A setting whose value is typed in place: the row's label on the left and a field on the right
 * (beneath it on narrow rows). The draft is local while typing and commits when focus leaves the
 * field or on submit, so a number or name never goes through a modal prompt.
 */
export const FieldValueItem = React.memo(function FieldValueItem(props: FieldValueItemProps) {
    const {
        value,
        unit,
        stepper,
        onCommit,
        onDraftChange,
        kind = 'text',
        signed = false,
        allowEmpty,
        placeholder,
        fieldTestID,
        monospace,
        secureTextEntry,
        autoCapitalize,
        fieldAccessibilityLabel,
        error,
        autoFocus,
        ...itemProps
    } = props;
    // The draft, its filtering and the commit rule are the shared owner's (a plugin page field
    // typed in place commits through the same one).
    const field = useHappierFieldValueDraft({ value, onCommit, onDraftChange, kind, signed, allowEmpty, stepper });
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
                    editable={itemProps.disabled !== true}
                    error={error}
                    autoFocus={autoFocus}
                    onBlur={field.commit}
                    onSubmitEditing={field.commit}
                    style={stepper ? { minWidth: 0, width: FIELD_BOX_METRICS.triggerMinWidthPx } : undefined}
                />
    );
    return (
        <Item
            {...itemProps}
            showChevron={false}
            accessoryLayout="adaptive"
            rightElement={stepper ? <HappierFieldStepper
                testID={fieldTestID} colors={resolveFieldBoxColors(theme, error ? 'invalid' : 'idle')}
                focusColor={theme.colors.border.focus}
                decreaseLabel={`${t('common.decrease')} ${title ?? ''}`}
                increaseLabel={`${t('common.increase')} ${title ?? ''}`}
                disabled={itemProps.disabled} canDecrement={field.canDecrement} canIncrement={field.canIncrement}
                onStep={field.stepBy} renderSymbol={(symbol) => <Text>{symbol}</Text>}
            >{input}</HappierFieldStepper> : input}
        />
    );
});
