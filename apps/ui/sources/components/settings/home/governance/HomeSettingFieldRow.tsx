import * as React from 'react';
import type { HomeSettingEntryV1 } from '@happier-dev/protocol/home/governance';

import { SchemaFieldControl, resolveSchemaFieldKind } from '@/components/settings/schemaFields/SchemaFieldControl';
import {
    SCHEMA_FIELD_INPUT_STYLE,
    SchemaFieldRow,
    SchemaFieldValueSlot,
} from '@/components/settings/schemaFields/SchemaFieldRow';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';

import { HomeDeploymentFixedNote } from './HomeDeploymentFixedNote';
import { homeSettingText } from './homeEmailSettingsForm';
import { isHomeSettingWritable } from './homeSettingDeclaration';
import type { HomeSettingDraftValue } from './homeSettingDraft';
import { homeServerSettingNumberWords, homeServerSettingUnit, homeSettingChoiceLabel } from './homeServerSettingLabels';

export type HomeSettingStage = (key: string, value: HomeSettingDraftValue | null) => void;

/** A value as the row shows it when it cannot be edited: its text, else the declared default. */
export function homeSettingDisplayValue(entry: HomeSettingEntryV1): string | undefined {
    const value = entry.value;
    if (Array.isArray(value)) return value.join(', ');
    const text = homeSettingText(entry);
    if (text) return text;
    const fallback = entry.declaration?.default;
    if (fallback === undefined || fallback === null) return undefined;
    return Array.isArray(fallback) ? fallback.join(', ') : String(fallback);
}

/** A list value is edited as comma-separated text, which the registry codec parses back. */
function fieldText(entry: HomeSettingEntryV1): string {
    return Array.isArray(entry.value) ? entry.value.join(', ') : homeSettingText(entry);
}

/**
 * One registry-declared Home setting rendered from its declaration (plan §3.14 "Console
 * rendering"): boolean → switch; enum of up to four → segmented; longer enum → menu; int/float →
 * number field; string/url/email/list → text field (a list as comma-separated text); anything
 * else, a fixed key, or a read-only viewer → the value in words; a fixed key also carries the shared
 * `HomeDeploymentFixedNote`. Every change is staged through
 * `onStage`; a page that saves field by field commits on `onCommit` (focus leaves or submit).
 * The caller owns the words around the control (`title`, `subtitle`, `titleAccessory`).
 */
export const HomeSettingFieldRow = React.memo(function HomeSettingFieldRow(props: Readonly<{
    entry: HomeSettingEntryV1;
    title: string;
    subtitle?: string;
    titleAccessory?: React.ReactNode;
    staged: HomeSettingDraftValue | undefined;
    readOnly: boolean;
    disabled: boolean;
    /** The field's refusal in words, when the last write or parse refused it. */
    error: string | null;
    onStage: HomeSettingStage;
    onCommit?: (key: string) => void;
    showDivider?: boolean;
    testID: string;
    /** The facts under the label; replaces the default (the deployment-fixed note when fixed). */
    subtitleAccessory?: React.ReactNode;
    /** A status mark before the subtitle (a missing or ignored value). */
    subtitleLeading?: React.ReactNode;
    /** Labels an enum value; defaults to its translated choice label. */
    choiceLabel?: (value: string) => string;
}>) {
    const { entry, staged, onStage, onCommit, testID } = props;
    const declaration = entry.declaration;
    const choiceLabel = props.choiceLabel ?? homeSettingChoiceLabel;
    const [menuOpen, setMenuOpen] = React.useState(false);
    const value = fieldText(entry);
    const stageValue = React.useCallback((next: unknown) => {
        onStage(entry.key, next === entry.value ? null : { kind: 'value', value: next });
    }, [entry.key, entry.value, onStage]);
    const stageText = React.useCallback((text: string) => {
        onStage(entry.key, text.trim() === value ? null : { kind: 'text', text });
    }, [entry.key, onStage, value]);
    const commit = React.useCallback(() => onCommit?.(entry.key), [entry.key, onCommit]);
    // A number is said in its registry unit wherever this row renders it (DR-15).
    const unit = homeServerSettingUnit(entry.key, declaration?.type) ?? undefined;

    const kind = !props.readOnly && isHomeSettingWritable(entry)
        ? resolveSchemaFieldKind({ type: declaration?.type, optionCount: declaration?.bounds?.values?.length })
        : null;
    // A key the deployment fixed says so through the one shared note, the key as a chip.
    const fixedNote = props.subtitleAccessory
        ?? (entry.fixed ? <HomeDeploymentFixedNote keys={[entry.key]} testID={testID} /> : undefined);
    // The shared schema-field row draws the label, the hint and the slot; this adapter picks the control.
    const row = {
        testID,
        title: props.title,
        hint: props.subtitle,
        hintAccessory: fixedNote,
        hintLeading: props.subtitleLeading,
        titleAccessory: props.titleAccessory,
        showDivider: props.showDivider,
    } as const;

    // An enum with one allowed value is not a choice (a reserved capability): nothing is offered.
    if (declaration?.type === 'enum' && declaration.bounds?.values?.length === 1) return null;
    if (kind === null) {
        const shown = homeSettingDisplayValue(entry);
        const numeric = declaration?.type === 'int' || declaration?.type === 'float';
        return (
            <SchemaFieldRow
                {...row}
                layout="inline"
                value={shown !== undefined && numeric ? homeServerSettingNumberWords(entry.key, declaration?.type, shown) : shown}
            />
        );
    }
    const stagedValue = staged?.kind === 'value' ? staged.value : undefined;
    const values = declaration?.bounds?.values ?? [];
    switch (kind) {
        case 'switch':
            return (
                <SchemaFieldRow
                    {...row}
                    layout="inline"
                    control={(
                        <SchemaFieldControl control="switch" inputProps={{
                            testID: `${testID}.switch`,
                            accessibilityLabel: props.title,
                            value: (stagedValue ?? entry.value) === true,
                            disabled: props.disabled,
                            onValueChange: stageValue,
                        }} />
                    )}
                />
            );
        case 'segmented':
        case 'select': {
            const active = typeof stagedValue === 'string'
                ? stagedValue
                : typeof entry.value === 'string' ? entry.value : String(declaration?.default ?? values[0]);
            if (kind === 'select') {
                return (
                    <SchemaFieldControl control="select" inputProps={{
                        open: menuOpen,
                        onOpenChange: setMenuOpen,
                        selectedId: active,
                        items: values.map((id) => ({ id, title: choiceLabel(id) })),
                        onSelect: (id) => {
                            stageValue(id);
                            setMenuOpen(false);
                        },
                        itemTrigger: {
                            title: props.title,
                            subtitle: props.subtitle,
                            showSelectedSubtitle: false,
                            itemProps: {
                                testID,
                                titleAccessory: props.titleAccessory,
                                subtitleLines: 0,
                                showDivider: props.showDivider,
                                disabled: props.disabled,
                            },
                        },
                    }} />
                );
            }
            // Two to four choices are the one segmented-choice row, as everywhere else in settings.
            return (
                <SegmentedChoiceItem<string>
                    testID={testID}
                    testIDPrefix={testID}
                    title={props.title}
                    titleAccessory={props.titleAccessory}
                    subtitle={props.subtitle}
                    subtitleLines={0}
                    subtitleLeading={props.subtitleLeading}
                    subtitleAccessory={fixedNote}
                    mode="info"
                    showDivider={props.showDivider}
                    options={values.map((id) => ({ id, label: choiceLabel(id) }))}
                    value={active}
                    onChange={stageValue}
                    disabled={props.disabled}
                />
            );
        }
        case 'number':
        case 'text': {
            const numeric = kind === 'number';
            const fallback = declaration?.default;
            return (
                <SchemaFieldRow
                    {...row}
                    layout="adaptive"
                    control={(
                        <SchemaFieldValueSlot kind={numeric ? 'number' : 'text'} unit={unit}>
                            <SchemaFieldControl control="text" inputProps={{
                                testID: `${testID}.input`,
                                accessibilityLabel: props.title,
                                value: staged?.kind === 'text' ? staged.text : value,
                                placeholder: fallback === undefined || fallback === null
                                    ? undefined
                                    : Array.isArray(fallback) ? fallback.join(', ') : String(fallback),
                                editable: !props.disabled,
                                autoCapitalize: 'none',
                                keyboardType: numeric ? 'number-pad' : undefined,
                                error: props.error,
                                onChangeText: stageText,
                                ...(onCommit ? { onBlur: commit, onSubmitEditing: commit } : {}),
                                style: SCHEMA_FIELD_INPUT_STYLE,
                            }} />
                        </SchemaFieldValueSlot>
                    )}
                />
            );
        }
    }
});
