import * as React from 'react';
import type { HomeSettingEntryV1 } from '@happier-dev/protocol/home/governance';

import { SchemaFieldControl, resolveSchemaFieldKind } from '@/components/settings/schemaFields/SchemaFieldControl';
import {
    SCHEMA_FIELD_INPUT_STYLE,
    SchemaFieldRow,
    SchemaFieldValueSlot,
} from '@/components/settings/schemaFields/SchemaFieldRow';
import { StringListField } from '@/components/ui/forms/StringListField';
import { CopyIconButton } from '@/components/ui/copy/CopyIconButton';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { t } from '@/text';

import { HomeDeploymentFixedNote } from './HomeDeploymentFixedNote';
import { homeSettingText } from './homeEmailSettingsForm';
import { isHomeSettingWritable } from './homeSettingDeclaration';
import type { HomeSettingDraftValue } from './homeSettingDraft';
import { homeServerSettingUnit, homeSettingChoiceLabel } from './homeServerSettingLabels';
import { homeSettingShownValue } from './HomeSettingRowState';
import { homeSettingFieldError, homeSettingTextRefusal } from './useHomeSettingsWrite';

export type HomeSettingStage = (key: string, value: HomeSettingDraftValue | null) => void;

/** A list value is edited as comma-separated text, which the registry codec parses back. */
function fieldText(entry: HomeSettingEntryV1): string {
    return Array.isArray(entry.value) ? entry.value.join(', ') : homeSettingText(entry);
}

function listItems(entry: HomeSettingEntryV1, staged: HomeSettingDraftValue | undefined): string[] {
    if (staged?.kind === 'text') return staged.text.split(',').map((item) => item.trim()).filter(Boolean);
    return Array.isArray(entry.value) ? entry.value.map(String) : [];
}

/** The list's text for the one draft model: its filled entries, each once, comma-separated. */
function listText(items: readonly string[]): string {
    return [...new Set(items.map((item) => item.trim()).filter(Boolean))].join(', ');
}

/**
 * A list setting, one field per entry with remove beside each and Add below (the shared
 * `StringListField`). Edits are staged as the list's comma-separated text, so the registry codec
 * parses them on the one draft path. Each entry is checked on its own once the list has been
 * committed, so a refusal names the entry it is about; a duplicate says so.
 */
const HomeSettingListControl = React.memo(function HomeSettingListControl(props: Readonly<{
    entry: HomeSettingEntryV1;
    title: string;
    staged: HomeSettingDraftValue | undefined;
    disabled: boolean;
    error: string | null;
    onStage: HomeSettingStage;
    onCommit?: (key: string) => void;
    testID: string;
}>) {
    const { entry, staged, onStage, onCommit } = props;
    const savedText = fieldText(entry);
    const [items, setItems] = React.useState(() => listItems(entry, staged));
    const [checked, setChecked] = React.useState(false);
    // A saved or reloaded value replaces the local entries.
    const latest = React.useRef(entry);
    latest.current = entry;
    React.useEffect(() => {
        setItems(listItems(latest.current, undefined));
        setChecked(false);
    }, [savedText]);
    const change = React.useCallback((next: string[]) => {
        setItems(next);
        const text = listText(next);
        onStage(entry.key, text === savedText ? null : { kind: 'text', text });
    }, [entry.key, onStage, savedText]);
    // Removing an entry stages and commits in one press: the commit waits for that render, so the
    // page's draft already holds the shorter list when it is written.
    const [commitRequest, setCommitRequest] = React.useState(0);
    const commit = React.useCallback(() => {
        setChecked(true);
        setCommitRequest((count) => count + 1);
    }, []);
    const commitRef = React.useRef(onCommit);
    commitRef.current = onCommit;
    React.useEffect(() => {
        if (commitRequest > 0) commitRef.current?.(entry.key);
    }, [commitRequest, entry.key]);
    // Each entry's own refusal (a duplicate, or one the registry codec refuses), once committed.
    const entryRefusals = React.useMemo(() => items.map((raw, index) => {
        const item = raw.trim();
        if (!checked || !item) return null;
        if (items.slice(0, index).some((earlier) => earlier.trim() === item)) return t('homeSettings.row.listDuplicate');
        const refusal = homeSettingTextRefusal(entry, item);
        return refusal ? homeSettingFieldError(entry, refusal) : null;
    }), [checked, entry, items]);
    // A refusal for the whole list is said on the first entry only when no entry already says why.
    const listRefusalShown = entryRefusals.some((refusal) => refusal !== null);
    const itemError = React.useCallback((index: number): string | null => {
        if (!items[index]?.trim()) return null;
        return entryRefusals[index] ?? (index === 0 && !listRefusalShown ? props.error : null);
    }, [entryRefusals, items, listRefusalShown, props.error]);
    return (
        <StringListField
            testID={`${props.testID}.list`}
            values={items}
            onChange={change}
            onCommit={commit}
            itemError={itemError}
            disabled={props.disabled}
            itemLabel={(position) => t('homeSettings.row.listItem', { title: props.title, position })}
            removeLabel={(position) => t('homeSettings.row.listRemove', { position })}
            addLabel={t('homeSettings.row.listAdd')}
            itemPlaceholder={entry.declaration?.bounds?.scheme === 'https' ? 'https://' : undefined}
        />
    );
});

/**
 * One registry-declared Home setting rendered from its declaration (plan §3.14 "Console
 * rendering"): boolean → switch; enum of up to four → segmented; longer enum → menu; int/float →
 * number field; string/url/email → text field; list → one field per entry; anything
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
    /**
     * What this Home expects an unset text key to hold (an address it answers at), shown where
     * "Not set" would be: the empty field's placeholder, or the read-only value. Never staged or saved.
     */
    emptyValue?: string;
    /** A Copy control beside the value: it copies the typed or saved text, else `emptyValue`. */
    copyable?: boolean;
}>) {
    const { entry, staged, onStage, onCommit, testID } = props;
    const declaration = entry.declaration;
    const choiceLabel = props.choiceLabel ?? homeSettingChoiceLabel;
    const [menuOpen, setMenuOpen] = React.useState(false);
    const value = fieldText(entry);
    const shownText = (staged?.kind === 'text' ? staged.text : value).trim();
    const copyText = shownText || props.emptyValue || '';
    const copy = props.copyable && copyText ? (
        <CopyIconButton testID={`${testID}.copy`} text={copyText} />
    ) : undefined;
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
        return (
            <SchemaFieldRow
                {...row}
                layout="inline"
                value={value.trim() === '' && props.emptyValue ? props.emptyValue : homeSettingShownValue(entry)}
                control={copy}
            />
        );
    }
    if (declaration?.type === 'list') {
        return (
            <SchemaFieldRow
                {...row}
                layout="stacked"
                control={(
                    <HomeSettingListControl
                        entry={entry}
                        title={props.title}
                        staged={staged}
                        disabled={props.disabled}
                        error={props.error}
                        onStage={onStage}
                        onCommit={onCommit}
                        testID={testID}
                    />
                )}
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
                                // An empty field says what empty means: the default it falls back to, or not set.
                                placeholder: props.emptyValue ?? (fallback === undefined || fallback === null || fallback === ''
                                    ? t('homeSettings.row.notSet')
                                    : Array.isArray(fallback) ? fallback.join(', ') : String(fallback)),
                                editable: !props.disabled,
                                autoCapitalize: 'none',
                                keyboardType: numeric ? 'number-pad' : undefined,
                                error: props.error,
                                onChangeText: stageText,
                                ...(onCommit ? { onBlur: commit, onSubmitEditing: commit } : {}),
                                style: SCHEMA_FIELD_INPUT_STYLE,
                            }} />
                            {copy}
                        </SchemaFieldValueSlot>
                    )}
                />
            );
        }
    }
});
