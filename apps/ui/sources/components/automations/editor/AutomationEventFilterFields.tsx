import * as React from 'react';
import { Platform, View } from 'react-native';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import { useUnistyles } from 'react-native-unistyles';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { ESCAPE_LAYER_PRIORITIES, useEscapeLayer } from '@/keyboard/escape';
import { restoreFocusToBestTarget, type FocusReturnTarget } from '@/keyboard/focusReturn';
import { t } from '@/text';
import { WORKFLOW_CONDITION_OPERATOR_LABEL_KEYS } from '@/components/workflows/presentation/workflowConditionPresentation';
import type { useAutomationEventFilterDraft } from './useAutomationEventFilterDraft';
import { eventAutomationComposerStyles as styles } from './eventAutomationComposerStyles';

type FilterOperator = ReturnType<typeof useAutomationEventFilterDraft>['filterClauses'][number]['op'];

const filterOperatorLabelKeys = {
    eq: 'settingsPlugins.eventAutomationComposer.filterEquals',
    in: 'settingsPlugins.eventAutomationComposer.filterOneOf',
    contains: 'settingsPlugins.eventAutomationComposer.filterContains',
    gt: WORKFLOW_CONDITION_OPERATOR_LABEL_KEYS.gt,
    gte: WORKFLOW_CONDITION_OPERATOR_LABEL_KEYS.gte,
    lt: WORKFLOW_CONDITION_OPERATOR_LABEL_KEYS.lt,
    lte: WORKFLOW_CONDITION_OPERATOR_LABEL_KEYS.lte,
} as const satisfies Record<FilterOperator, string>;
const scalarFilterOperators = (Object.keys(filterOperatorLabelKeys) as FilterOperator[]).filter(op => op !== 'contains');
const collectionFilterOperators = ['contains'] as const;

const pickerEscapePriority = ESCAPE_LAYER_PRIORITIES.modal + 1;

export function useEventComposerPickerDisclosure(params: Readonly<{
    anyPickerOpen: boolean;
    collapseAllPickers: () => void;
}>) {
    const triggerNodesRef = React.useRef(new Map<string, FocusReturnTarget>());
    const triggerRefCallbacksRef = React.useRef(new Map<string, (node: FocusReturnTarget) => void>());
    const lastExpandedPickerKeyRef = React.useRef<string | null>(null);
    const pendingFocusReturnKeyRef = React.useRef<string | null>(null);
    const collapseAllPickersRef = React.useRef(params.collapseAllPickers);
    collapseAllPickersRef.current = params.collapseAllPickers;

    // A stable callback per picker keeps the trigger ref from detaching and
    // reattaching on every render of the surrounding form.
    const pickerTriggerRef = React.useCallback((pickerKey: string) => {
        const cached = triggerRefCallbacksRef.current.get(pickerKey);
        if (cached) return cached;
        const callback = (node: FocusReturnTarget) => {
            if (node === null || node === undefined) {
                triggerNodesRef.current.delete(pickerKey);
                return;
            }
            triggerNodesRef.current.set(pickerKey, node);
        };
        triggerRefCallbacksRef.current.set(pickerKey, callback);
        return callback;
    }, []);

    /**
     * Arms the return only for a collapse that takes the user's own focused
     * element away. A collateral collapse — another picker closing this one —
     * must not pull focus off the control the user is actually on.
     */
    const notePickerCollapsed = React.useCallback((pickerKey: string) => {
        pendingFocusReturnKeyRef.current = pickerKey;
    }, []);

    const notePickerTriggerPressed = React.useCallback((pickerKey: string, wasExpanded: boolean) => {
        if (wasExpanded) {
            pendingFocusReturnKeyRef.current = pickerKey;
            return;
        }
        lastExpandedPickerKeyRef.current = pickerKey;
    }, []);

    React.useEffect(() => {
        const pickerKey = pendingFocusReturnKeyRef.current;
        if (pickerKey === null) return;
        pendingFocusReturnKeyRef.current = null;
        restoreFocusToBestTarget({ current: triggerNodesRef.current.get(pickerKey) ?? null });
    });

    useEscapeLayer({
        enabled: Platform.OS === 'web' && params.anyPickerOpen,
        priority: pickerEscapePriority,
        onEscape: () => {
            const pickerKey = lastExpandedPickerKeyRef.current;
            lastExpandedPickerKeyRef.current = null;
            if (pickerKey !== null) pendingFocusReturnKeyRef.current = pickerKey;
            collapseAllPickersRef.current();
            return true;
        },
    });

    return { pickerTriggerRef, notePickerCollapsed, notePickerTriggerPressed };
}


export type AutomationEventFilterFieldsModel = Pick<ReturnType<typeof useAutomationEventFilterDraft>, 'payloadBrowser' | 'filterClauses' | 'addFilterClause' | 'setFilterClauseField' | 'setFilterClauseOperator' | 'setFilterClauseValueText' | 'removeFilterClause' | 'filterValid'>;

export type AutomationEventFilterDisclosure = ReturnType<typeof useEventComposerPickerDisclosure> & Readonly<{
    filterFieldPickerOpenFor: string | null;
    filterOperatorPickerOpenFor: string | null;
    setFilterFieldPickerOpenFor: React.Dispatch<React.SetStateAction<string | null>>;
    setFilterOperatorPickerOpenFor: React.Dispatch<React.SetStateAction<string | null>>;
}>;

/** The same bounded filter controls serve plugin Events and native Session lifecycle facts. */
export function AutomationEventFilterFields(props: Readonly<{
    model: AutomationEventFilterFieldsModel;
    disclosure?: AutomationEventFilterDisclosure;
    /** `host`: the host draws "Only when" on its own label track (the When card); otherwise it heads the controls. */
    labelledBy?: 'self' | 'host';
}>) {
    return props.disclosure
        ? <AutomationEventFilterFieldsContent model={props.model} disclosure={props.disclosure} labelledBy={props.labelledBy} />
        : <StandaloneAutomationEventFilterFields model={props.model} labelledBy={props.labelledBy} />;
}

function StandaloneAutomationEventFilterFields({ model, labelledBy }: Readonly<{ model: AutomationEventFilterFieldsModel; labelledBy?: 'self' | 'host' }>) {
    const [filterFieldPickerOpenFor, setFilterFieldPickerOpenFor] = React.useState<string | null>(null);
    const [filterOperatorPickerOpenFor, setFilterOperatorPickerOpenFor] = React.useState<string | null>(null);
    const disclosure = useEventComposerPickerDisclosure({
        anyPickerOpen: filterFieldPickerOpenFor !== null || filterOperatorPickerOpenFor !== null,
        collapseAllPickers: () => { setFilterFieldPickerOpenFor(null); setFilterOperatorPickerOpenFor(null); },
    });
    return <AutomationEventFilterFieldsContent model={model} labelledBy={labelledBy} disclosure={{
        ...disclosure, filterFieldPickerOpenFor, filterOperatorPickerOpenFor,
        setFilterFieldPickerOpenFor, setFilterOperatorPickerOpenFor,
    }} />;
}

function AutomationEventFilterFieldsContent(props: Readonly<{
    model: AutomationEventFilterFieldsModel;
    disclosure: AutomationEventFilterDisclosure;
    labelledBy?: 'self' | 'host';
}>) {
    const { theme } = useUnistyles();
    const { filterFieldPickerOpenFor, filterOperatorPickerOpenFor, setFilterFieldPickerOpenFor,
        setFilterOperatorPickerOpenFor, pickerTriggerRef, notePickerCollapsed, notePickerTriggerPressed } = props.disclosure;
    // "Only when · + Filter" (lab `make-A`): the quiet add follows its label, clauses follow beneath.
    const add = (
        <HappierPressable
            testID="automation-event-filter-add-clause"
            accessibilityRole="button"
            accessibilityLabel={`${t('automations.form.trigger.eventFilter')}: ${t('settingsPlugins.eventAutomationComposer.addFilterClause')}`}
            disabled={props.model.payloadBrowser.fields.length === 0}
            onPress={props.model.addFilterClause}
            style={({ pressed }) => [
                styles.filterAddButton,
                props.model.payloadBrowser.fields.length === 0 ? styles.disabled : null,
                pressed ? styles.pressed : null,
            ]}
        >
            <Icon name="plus" size={14} color={theme.colors.text.secondary} />
            <Text style={styles.filterActionText}>
                {t('settingsPlugins.eventAutomationComposer.addFilterClause')}
            </Text>
        </HappierPressable>
    );
    return <>
                                    {props.labelledBy === 'host' ? null : (
                                        <View style={styles.filterHeader}>
                                            <Text style={styles.fieldLabel}>{t('automations.form.trigger.eventFilter')}</Text>
                                            {add}
                                        </View>
                                    )}
                                    <View style={styles.filterBuilder}>
                                        {props.labelledBy === 'host' ? add : null}
                                        {props.model.filterClauses.map((clause) => (
                                            <View
                                                key={clause.id}
                                                testID={`automation-event-filter-clause-${clause.id}`}
                                                style={styles.filterClause}
                                            >
                                                <View style={styles.filterClauseControls}>
                                                    <HappierPressable
                                                        testID={`automation-event-filter-clause-${clause.id}-field-picker`}
                                                        accessibilityRole="button"
                                                        accessibilityLabel={t('settingsPlugins.eventAutomationComposer.filterField')}
                                                        expanded={filterFieldPickerOpenFor === clause.id}
                                                        controlRef={pickerTriggerRef(`filterField:${clause.id}`)}
                                                        onPress={() => {
                                                            notePickerTriggerPressed(
                                                                `filterField:${clause.id}`,
                                                                filterFieldPickerOpenFor === clause.id,
                                                            );
                                                            setFilterFieldPickerOpenFor((current) => (
                                                                current === clause.id ? null : clause.id
                                                            ));
                                                            setFilterOperatorPickerOpenFor(null);
                                                        }}
                                                        style={({ pressed }) => [styles.filterPicker, pressed ? styles.pressed : null]}
                                                    >
                                                        <Text numberOfLines={1} style={styles.filterPickerText}>{props.model.payloadBrowser.fields.find((field) => field.pointer === clause.field)?.label ?? clause.field}</Text>
                                                        <Icon name="caret-down" size={12} color={theme.colors.text.secondary} />
                                                    </HappierPressable>
                                                    <HappierPressable
                                                        testID={`automation-event-filter-clause-${clause.id}-operator-picker`}
                                                        accessibilityRole="button"
                                                        accessibilityLabel={t('settingsPlugins.eventAutomationComposer.filterOperator')}
                                                        expanded={filterOperatorPickerOpenFor === clause.id}
                                                        controlRef={pickerTriggerRef(`filterOperator:${clause.id}`)}
                                                        onPress={() => {
                                                            notePickerTriggerPressed(
                                                                `filterOperator:${clause.id}`,
                                                                filterOperatorPickerOpenFor === clause.id,
                                                            );
                                                            setFilterOperatorPickerOpenFor((current) => (
                                                                current === clause.id ? null : clause.id
                                                            ));
                                                            setFilterFieldPickerOpenFor(null);
                                                        }}
                                                        style={({ pressed }) => [styles.filterPicker, pressed ? styles.pressed : null]}
                                                    >
                                                        <Text numberOfLines={1} style={styles.filterPickerText}>
                                                            {t(filterOperatorLabelKeys[clause.op])}
                                                        </Text>
                                                        <Icon name="caret-down" size={12} color={theme.colors.text.secondary} />
                                                    </HappierPressable>
                                                    <HappierPressable
                                                        testID={`automation-event-filter-clause-${clause.id}-remove`}
                                                        accessibilityRole="button"
                                                        accessibilityLabel={t('common.remove')}
                                                        onPress={() => props.model.removeFilterClause(clause.id)}
                                                        style={({ pressed }) => [styles.filterRemoveButton, pressed ? styles.pressed : null]}
                                                    >
                                                        <Icon name="trash" size={14} color={theme.colors.text.secondary} />
                                                    </HappierPressable>
                                                </View>
                                                {filterFieldPickerOpenFor === clause.id ? (
                                                    <View
                                                        testID={`automation-event-filter-clause-${clause.id}-field-options`}
                                                        style={styles.filterOptionList}
                                                    >
                                                        {props.model.payloadBrowser.fields.map((field) => (
                                                            <HappierPressable
                                                                key={field.pointer}
                                                                testID={`automation-event-filter-clause-${clause.id}-field-option-${field.pointer}`}
                                                                accessibilityRole="button"
                                                                selected={clause.field === field.pointer}
                                                                onPress={() => {
                                                                    props.model.setFilterClauseField(clause.id, field.pointer);
                                                                    notePickerCollapsed(`filterField:${clause.id}`);
                                                                    setFilterFieldPickerOpenFor(null);
                                                                }}
                                                                style={({ pressed }) => [
                                                                    styles.filterOption,
                                                                    clause.field === field.pointer ? styles.optionRowSelected : null,
                                                                    pressed ? styles.pressed : null,
                                                                ]}
                                                            >
                                                                <Text style={styles.filterOptionText}>{field.label}</Text>
                                                            </HappierPressable>
                                                        ))}
                                                    </View>
                                                ) : null}
                                                {filterOperatorPickerOpenFor === clause.id ? (
                                                    <View
                                                        testID={`automation-event-filter-clause-${clause.id}-operator-options`}
                                                        style={styles.filterOptionList}
                                                    >
                                                        {(props.model.payloadBrowser.fields.find(field => field.pointer === clause.field)?.collection
                                                            ? collectionFilterOperators : scalarFilterOperators).map((op) => (
                                                            <HappierPressable
                                                                key={op}
                                                                testID={`automation-event-filter-clause-${clause.id}-operator-option-${op}`}
                                                                accessibilityRole="button"
                                                                selected={clause.op === op}
                                                                onPress={() => {
                                                                    props.model.setFilterClauseOperator(clause.id, op);
                                                                    notePickerCollapsed(`filterOperator:${clause.id}`);
                                                                    setFilterOperatorPickerOpenFor(null);
                                                                }}
                                                                style={({ pressed }) => [
                                                                    styles.filterOption,
                                                                    clause.op === op ? styles.optionRowSelected : null,
                                                                    pressed ? styles.pressed : null,
                                                                ]}
                                                            >
                                                                <Text style={styles.filterOptionText}>
                                                                    {t(filterOperatorLabelKeys[op])}
                                                                </Text>
                                                            </HappierPressable>
                                                        ))}
                                                    </View>
                                                ) : null}
                                                <FieldTextInput
                                                    testID={`automation-event-filter-clause-${clause.id}-value`}
                                                    accessibilityLabel={t('settingsPlugins.eventAutomationComposer.filterValue')}
                                                    accessibilityHint={!props.model.filterValid
                                                        ? t('automations.form.trigger.eventFilterInvalid')
                                                        : undefined}
                                                    invalid={!props.model.filterValid}
                                                    monospace
                                                    style={styles.fieldInput}
                                                    value={clause.valueText}
                                                    onChangeText={(valueText) => props.model.setFilterClauseValueText(clause.id, valueText)}
                                                    placeholder={t('settingsPlugins.eventAutomationComposer.filterValuePlaceholder')}
                                                />
                                            </View>
                                        ))}
                                    </View>
                                    {!props.model.filterValid ? (
                                        <Text
                                            accessibilityRole="alert"
                                            accessibilityLiveRegion="polite"
                                            style={styles.unavailableText}
                                        >
                                            {t('automations.form.trigger.eventFilterInvalid')}
                                        </Text>
                                    ) : null}

    </>;
}
