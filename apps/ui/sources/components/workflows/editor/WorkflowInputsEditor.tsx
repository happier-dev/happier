import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { HappierPressable, HAPPIER_PRESS_FEEDBACK_V1 } from '@happier-dev/plugin-ui/presentation';
import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { sameStrictJsonValue, type JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { WorkflowInputDefinition } from '@happier-dev/protocol/workflows/workflowV1';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { FIELD_BOX_METRICS } from '@/components/ui/forms/fieldBox';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Switch } from '@/components/ui/forms/Switch';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { Popover } from '@/components/ui/popover';
import { Text, TextInput } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import {
    describeWorkflowInputRepair,
    describeWorkflowInputValueType,
} from '@/components/workflows/presentation/workflowBlockedReasonText';

import { WorkflowDocumentGridContext } from './workflowEditorStyles';

/**
 * Workflow inputs as one compact table (WF-REDESIGN-1116 change d): Name, Type, Default, Description
 * and Required edited in place, a "…" per row and "Add an input" at its foot. A phone keeps Name, Type
 * and Required; Default and Description move into the row's "…".
 */
const WEB_TEXT_OVERFLOW = { textOverflow: 'ellipsis' };

const styles = StyleSheet.create((theme) => ({
    root: { gap: theme.space.s8 },
    title: { ...Typography.variant('label', 'semiBold'), color: theme.colors.text.primary },
    table: {
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.default,
        borderRadius: theme.borderRadius.md,
        overflow: 'hidden',
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        columnGap: theme.space.s8,
        paddingHorizontal: theme.space.s8,
        minHeight: FIELD_BOX_METRICS.minHeightPx + theme.space.s8,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.border.default,
    },
    headRow: {
        flexDirection: 'row',
        alignItems: 'center',
        columnGap: theme.space.s8,
        paddingHorizontal: theme.space.s8,
        paddingVertical: theme.space.s6,
    },
    head: { ...Typography.variant('meta', 'semiBold'), color: theme.colors.text.tertiary, paddingHorizontal: theme.space.s4 },
    nameCol: { flexGrow: 3, flexShrink: 1, flexBasis: 0, minWidth: 0 },
    typeCol: { flexGrow: 2, flexShrink: 1, flexBasis: 0, minWidth: 0 },
    defaultCol: { flexGrow: 2, flexShrink: 1, flexBasis: 0, minWidth: 0 },
    descriptionCol: { flexGrow: 3, flexShrink: 1, flexBasis: 0, minWidth: 0 },
    requiredCol: { width: 72, alignItems: 'flex-start' },
    moreCol: { width: 32, alignItems: 'center' },
    cell: {
        ...Typography.variant('body'),
        color: theme.colors.text.primary,
        paddingHorizontal: theme.space.s6,
        paddingVertical: theme.space.s4,
        borderWidth: 1,
        borderColor: 'transparent',
        borderRadius: FIELD_BOX_METRICS.radiusPx,
        minWidth: 0,
        // A cell longer than its column ends in an ellipsis instead of a clipped word (WF-ACCEPT-1118B item 10);
        // react-native-web draws it on the single-line input through this web-only property.
        ...WEB_TEXT_OVERFLOW,
    },
    cellMono: { ...Typography.mono() },
    cellFocused: { borderColor: theme.colors.border.strong, backgroundColor: theme.colors.input.background },
    cellInvalid: { borderColor: theme.colors.state.danger.foreground },
    quiet: { ...Typography.variant('body'), color: theme.colors.text.tertiary, paddingHorizontal: theme.space.s6 },
    typeTrigger: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s2, paddingHorizontal: theme.space.s6, alignSelf: 'flex-start' },
    typeText: { ...Typography.variant('body'), color: theme.colors.text.primary },
    foot: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        columnGap: theme.space.s12,
        rowGap: theme.space.s4,
        paddingHorizontal: theme.space.s8,
        paddingVertical: theme.space.s8,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.border.default,
    },
    add: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s4, paddingHorizontal: theme.space.s4 },
    addLabel: { ...Typography.variant('label'), color: theme.colors.text.secondary },
    note: { ...Typography.variant('meta'), color: theme.colors.text.tertiary, flexShrink: 1, marginLeft: 'auto' },
    sheet: { gap: theme.space.s12, padding: theme.space.s16 },
    sheetLabel: { ...Typography.variant('label'), color: theme.colors.text.secondary },
    remove: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s6, alignSelf: 'flex-start', paddingVertical: theme.space.s4 },
    removeLabel: { ...Typography.variant('label'), color: theme.colors.state.danger.textForeground },
}));

const VALUE_TYPES = ['string', 'number', 'boolean', 'json'] as const;
const PARTICIPANT_TYPE = 'agentParticipant';
const PARTICIPANT_LIST_TYPE = 'agentParticipantList';

function nextInputName(inputs: readonly WorkflowInputDefinition[]): string {
    const taken = new Set(inputs.map((input) => input.name));
    if (!taken.has('input')) return 'input';
    let ordinal = 2;
    while (taken.has(`input${ordinal}`)) ordinal += 1;
    return `input${ordinal}`;
}

/** A default that is not yet a value of its type is held as the unresolved number the canonical validator rejects. */
function isUnresolvedDefault(value: JsonValue | undefined): boolean {
    return typeof value === 'number' && Number.isNaN(value);
}

function formatDefault(value: JsonValue | undefined): string {
    if (value === undefined || isUnresolvedDefault(value)) return '';
    return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * The value the typed text means for the declared type. Empty text is no
 * default. Text that is not a value of that type is kept as the unresolved
 * number rather than dropped or read as another type, so the draft — and every
 * command that consumes its canonical validation — knows the default is not
 * yet usable while the exact text stays visible for repair.
 */
function parseDefault(type: WorkflowInputDefinition['valueType'], text: string): JsonValue | undefined {
    if (text.trim().length === 0) return undefined;
    if (type === 'string') return text;
    if (type === 'number') {
        const value = Number(text);
        return Number.isFinite(value) ? value : Number.NaN;
    }
    if (type === 'boolean') {
        if (text.trim() === 'true') return true;
        if (text.trim() === 'false') return false;
        return Number.NaN;
    }
    try {
        return JSON.parse(text) as JsonValue;
    } catch {
        return Number.NaN;
    }
}

const TYPE_ITEMS = (rowId: string): DropdownMenuItem[] => [
    ...VALUE_TYPES.map((valueType) => ({
        id: valueType, testID: `${rowId}-type-${valueType}`, title: describeWorkflowInputValueType(valueType),
    })),
    { id: PARTICIPANT_TYPE, testID: `${rowId}-type-${PARTICIPANT_TYPE}`, title: t('workflows.inputs.typeParticipant') },
    { id: PARTICIPANT_LIST_TYPE, testID: `${rowId}-type-${PARTICIPANT_LIST_TYPE}`, title: t('workflows.inputs.typeParticipants') },
];

/** A table cell edited in place: its value as text, the field box only while it has the caret. */
function InputCell(props: Readonly<{
    value: string;
    onChangeText: (text: string) => void;
    accessibilityLabel: string;
    placeholder?: string;
    monospace?: boolean;
    invalid?: boolean;
    testID: string;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const [focused, setFocused] = React.useState(false);
    return (
        <TextInput
            testID={props.testID}
            value={props.value}
            onChangeText={props.onChangeText}
            accessibilityLabel={props.accessibilityLabel}
            {...(props.placeholder === undefined ? {} : { placeholder: props.placeholder })}
            placeholderTextColor={theme.colors.input.placeholder}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            autoCapitalize="none"
            autoCorrect={false}
            numberOfLines={1}
            style={[styles.cell, props.monospace ? styles.cellMono : null, focused ? styles.cellFocused : null,
                props.invalid ? styles.cellInvalid : null]}
        />
    );
}

function WorkflowInputRow(props: Readonly<{
    input: WorkflowInputDefinition;
    index: number;
    compact: boolean;
    onChange: (next: WorkflowInputDefinition) => void;
    onRemove: () => void;
    testIDPrefix: string;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const { input } = props;
    const [defaultText, setDefaultText] = React.useState(() => formatDefault(input.default));
    // The draft is the source of truth; the typed text survives only while it
    // still means the draft's default, so an unresolved default keeps the exact
    // text on screen and an external change (undo, reopen) replaces it.
    const defaultTextRef = React.useRef(defaultText);
    defaultTextRef.current = defaultText;
    React.useEffect(() => {
        const meant = parseDefault(input.valueType, defaultTextRef.current);
        const stillMeant = isUnresolvedDefault(meant)
            ? isUnresolvedDefault(input.default)
            : sameStrictJsonValue(meant, input.default);
        if (stillMeant) return;
        setDefaultText(formatDefault(input.default));
    }, [input.default, input.valueType]);
    const defaultInvalid = !input.required && isUnresolvedDefault(input.default);
    const defaultRepair = defaultInvalid ? describeWorkflowInputRepair({ valueType: input.valueType, errorCode: 'invalid_input' }) : null;
    const rowId = `${props.testIDPrefix}-input-${props.index}`;
    const [typeOpen, setTypeOpen] = React.useState(false);
    const [moreOpen, setMoreOpen] = React.useState(false);
    const moreAnchorRef = React.useRef<React.ComponentRef<typeof View> | null>(null);
    const typeItems = React.useMemo(() => TYPE_ITEMS(rowId), [rowId]);
    const typeId = input.inputType && 'hostType' in input.inputType && input.inputType.hostType === 'agentParticipant'
        ? input.multiple ? PARTICIPANT_LIST_TYPE : PARTICIPANT_TYPE : input.valueType;
    const selectType = (id: string) => {
        setTypeOpen(false);
        if (id === PARTICIPANT_TYPE || id === PARTICIPANT_LIST_TYPE) {
            const { inputType: _inputType, multiple: _multiple, enum: _enum,
                optionsSourceId: _optionsSourceId, default: _default, defaultFrom: _defaultFrom, ...base } = input;
            setDefaultText('');
            props.onChange({ ...base, valueType: 'json', inputType: { hostType: 'agentParticipant' },
                ...(id === PARTICIPANT_LIST_TYPE ? { multiple: true } : {}) });
            return;
        }
        const valueType = VALUE_TYPES.find((candidate) => candidate === id);
        if (valueType === undefined) return;
        const nextDefault = parseDefault(valueType, defaultText);
        const { inputType: _inputType, multiple: _multiple, defaultFrom: _defaultFrom, ...base } = input;
        props.onChange({ ...base, valueType, ...(nextDefault === undefined ? { default: undefined } : { default: nextDefault }) });
    };
    const changeDefault = (text: string) => {
        setDefaultText(text);
        const value = parseDefault(input.valueType, text);
        props.onChange({ ...input, ...(value === undefined ? { default: undefined } : { default: value }) });
    };
    const changeDescription = (description: string) => props.onChange({
        ...input,
        ...(description.length === 0 ? { description: undefined } : { description }),
    });
    // A required input has no fallback: a run must supply it, so its Default cell says so quietly.
    const defaultCell = input.required
        ? <Text style={styles.quiet} accessibilityLabel={t('workflows.inputs.defaultValue')}>{'\u2014'}</Text>
        : <InputCell testID={`${rowId}-default`} value={defaultText} onChangeText={changeDefault}
            accessibilityLabel={defaultRepair ?? t('workflows.inputs.defaultValue')} placeholder={t('workflows.inputs.defaultValue')}
            invalid={defaultInvalid} />;
    const descriptionCell = <InputCell testID={`${rowId}-description`} value={input.description ?? ''} onChangeText={changeDescription}
        accessibilityLabel={t('workflows.inputs.descriptionPlaceholder')} placeholder={t('workflows.inputs.descriptionPlaceholder')} />;
    return (
        <View testID={rowId} style={styles.row} accessibilityRole="summary">
            <View style={styles.nameCol}>
                <InputCell testID={`${rowId}-name`} value={input.name} monospace onChangeText={(name) => props.onChange({ ...input, name })}
                    accessibilityLabel={t('workflows.inputs.namePlaceholder')} placeholder={t('workflows.inputs.namePlaceholder')} />
            </View>
            <View style={styles.typeCol}>
                <DropdownMenu
                    testID={`${rowId}-type`}
                    open={typeOpen}
                    onOpenChange={setTypeOpen}
                    items={typeItems}
                    selectedId={typeId}
                    matchTriggerWidth={false}
                    onSelect={selectType}
                    trigger={({ toggle, selectedItem }) => (
                        <HappierPressable
                            testID={`${rowId}-type-trigger`}
                            accessibilityRole="button"
                            accessibilityLabel={`${t('workflows.inputs.typeLabel')}: ${selectedItem?.title ?? ''}`}
                            hasPopup="menu"
                            expanded={typeOpen}
                            onPress={toggle}
                            style={(state) => [styles.typeTrigger, state.pressed ? { opacity: HAPPIER_PRESS_FEEDBACK_V1.opacitySubtle } : null,
                                focusRingStyle({ focused: state.focused, color: theme.colors.border.focus })]}
                        >
                            <Text numberOfLines={1} style={styles.typeText}>{selectedItem?.title ?? ''}</Text>
                            <Icon name={typeOpen ? 'caret-up' : 'caret-down'} size={ICON_SIZE.xs} color={theme.colors.text.secondary} />
                        </HappierPressable>
                    )}
                />
            </View>
            {props.compact ? null : <View style={styles.defaultCol}>{defaultCell}</View>}
            {props.compact ? null : <View style={styles.descriptionCol}>{descriptionCell}</View>}
            <View style={styles.requiredCol}>
                <Switch
                    testID={`${rowId}-required`}
                    accessibilityLabel={t('workflows.inputs.required')}
                    value={input.required}
                    onValueChange={(required) => props.onChange(required
                        ? { ...input, required: true, default: undefined }
                        : { ...input, required: false })}
                />
            </View>
            <View style={styles.moreCol} ref={moreAnchorRef} collapsable={false}>
                <IconButton
                    testID={`${rowId}-more`}
                    iconName="dots-three"
                    variant="plain"
                    accessibilityLabel={t('common.moreActions')}
                    accessibilityHint={input.name}
                    onPress={() => setMoreOpen((current) => !current)}
                    expanded={moreOpen}
                    hasPopup="dialog"
                />
            </View>
            {moreOpen ? (
                <Popover
                    open
                    anchorRef={moreAnchorRef}
                    boundaryRef={null}
                    placement="auto-vertical"
                    phonePresentation="sheet"
                    sheetHeader="none"
                    accessibilityLabel={input.name}
                    edgePadding={{ horizontal: 12, vertical: 12 }}
                    portal={{ web: { target: 'body' }, native: true, matchAnchorWidth: false }}
                    maxWidthCap={360}
                    onRequestClose={() => setMoreOpen(false)}
                >
                    {({ maxHeight, maxWidth }) => (
                        <FloatingOverlay maxHeight={maxHeight} surfaceChrome="theme" containerStyle={{ width: Math.min(maxWidth, 360) }}>
                            <View style={styles.sheet}>
                                {/* A phone's table keeps three columns; the rest of the input is edited here. */}
                                {props.compact ? (
                                    <>
                                        <Text style={styles.sheetLabel}>{t('workflows.inputs.defaultColumn')}</Text>
                                        {input.required ? <Text style={styles.quiet}>{t('workflows.inputs.required')}</Text> : (
                                            <FieldTextInput testID={`${rowId}-default-sheet`} value={defaultText} onChangeText={changeDefault}
                                                placeholder={t('workflows.inputs.defaultValue')} accessibilityLabel={t('workflows.inputs.defaultValue')}
                                                error={defaultRepair} />
                                        )}
                                        <Text style={styles.sheetLabel}>{t('workflows.inputs.descriptionColumn')}</Text>
                                        <FieldTextInput testID={`${rowId}-description-sheet`} value={input.description ?? ''} onChangeText={changeDescription}
                                            placeholder={t('workflows.inputs.descriptionPlaceholder')} accessibilityLabel={t('workflows.inputs.descriptionPlaceholder')} />
                                    </>
                                ) : null}
                                <HappierPressable
                                    testID={`${rowId}-remove`}
                                    accessibilityRole="button"
                                    accessibilityLabel={t('workflows.editor.remove')}
                                    onPress={() => { setMoreOpen(false); props.onRemove(); }}
                                    style={(state) => [styles.remove, state.pressed ? { opacity: HAPPIER_PRESS_FEEDBACK_V1.opacitySubtle } : null,
                                        focusRingStyle({ focused: state.focused, color: theme.colors.border.focus })]}
                                >
                                    <Icon name="trash" size={ICON_SIZE.xs} color={theme.colors.state.danger.foreground} />
                                    <Text style={styles.removeLabel}>{t('workflows.editor.remove')}</Text>
                                </HappierPressable>
                            </View>
                        </FloatingOverlay>
                    )}
                </Popover>
            ) : null}
        </View>
    );
}

export function WorkflowInputsEditor(props: Readonly<{
    inputs: readonly WorkflowInputDefinition[];
    onChange: (inputs: readonly WorkflowInputDefinition[]) => void;
    /** The heading in its host's words ("Workflow inputs" in How and where it runs). */
    title?: string;
    /** What the inputs are for, at the table's foot. */
    note?: string;
    testIDPrefix: string;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const compact = React.useContext(WorkflowDocumentGridContext) !== 'wide';
    return (
        <View testID={`${props.testIDPrefix}-inputs`} style={styles.root}>
            <Text style={styles.title}>{props.title ?? t('workflows.inputs.title')}</Text>
            <View style={styles.table} accessibilityRole="list">
                {props.inputs.length === 0 ? null : (
                    <View style={styles.headRow} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                        <Text style={[styles.head, styles.nameCol]}>{t('workflows.inputs.nameColumn')}</Text>
                        <Text style={[styles.head, styles.typeCol]}>{t('workflows.inputs.typeLabel')}</Text>
                        {compact ? null : <Text style={[styles.head, styles.defaultCol]}>{t('workflows.inputs.defaultColumn')}</Text>}
                        {compact ? null : <Text style={[styles.head, styles.descriptionCol]}>{t('workflows.inputs.descriptionColumn')}</Text>}
                        <Text style={[styles.head, styles.requiredCol]}>{t('workflows.inputs.required')}</Text>
                        <View style={styles.moreCol} />
                    </View>
                )}
                {props.inputs.map((input, index) => (
                    <WorkflowInputRow
                        key={index}
                        input={input}
                        index={index}
                        compact={compact}
                        onChange={(next) => props.onChange(props.inputs.map((current, candidate) => (
                            candidate === index ? next : current
                        )))}
                        onRemove={() => props.onChange(props.inputs.filter((_current, candidate) => candidate !== index))}
                        testIDPrefix={props.testIDPrefix}
                    />
                ))}
                <View style={[styles.foot, props.inputs.length === 0 ? { borderTopWidth: 0 } : null]}>
                    <HappierPressable
                        testID={`${props.testIDPrefix}-inputs-add`}
                        accessibilityRole="button"
                        accessibilityLabel={t('workflows.inputs.addInput')}
                        onPress={() => props.onChange([...props.inputs, {
                            name: nextInputName(props.inputs),
                            valueType: 'string',
                            required: false,
                        }])}
                        style={(state) => [styles.add, state.pressed ? { opacity: HAPPIER_PRESS_FEEDBACK_V1.opacitySubtle } : null, focusRingStyle({ focused: state.focused, color: theme.colors.border.focus })]}
                    >
                        <Icon name="plus" size={ICON_SIZE.xs} color={theme.colors.text.secondary} />
                        <Text style={styles.addLabel}>{t('workflows.inputs.addInput')}</Text>
                    </HappierPressable>
                    {props.note === undefined ? null : <Text style={styles.note}>{props.note}</Text>}
                </View>
            </View>
        </View>
    );
}
