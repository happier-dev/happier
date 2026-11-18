import * as React from 'react';
import { AUTOMATION_SESSION_LIFECYCLE_FILTER_PAYLOAD_SCHEMA_V1 } from '@happier-dev/protocol/automations/automationSessionLifecycle';
import { AutomationEventFilterFields, useEventComposerPickerDisclosure } from '@/components/automations/editor/AutomationEventFilterFields';
import { useAutomationEventFilterDraft } from '@/components/automations/editor/useAutomationEventFilterDraft';
import { readPluginEventAutomationFilterClauses } from '@/components/automations/editor/pluginEventAutomationFilterBuilder';
import type { SessionLifecycleWhen } from './sessionTriggerForm';

/** Native lifecycle Events share the Event filter grammar, validator and controls. */
export function SessionLifecycleFilterFields(props: Readonly<{
    when: SessionLifecycleWhen;
    onChange: (when: SessionLifecycleWhen) => void;
}>) {
    const edited = React.useRef(false);
    const onEdit = React.useCallback(() => { edited.current = true; }, []);
    const model = useAutomationEventFilterDraft({ payloadSchema: AUTOMATION_SESSION_LIFECYCLE_FILTER_PAYLOAD_SCHEMA_V1,
        initialFilter: props.when.filter, onEdit });
    const reportedFilter = React.useRef({ value: props.when.filter, invalid: props.when.filterInvalid });
    // Undo and restored Sentence snapshots replace the editable clauses. Our own published edit
    // already has those clauses, so it must preserve the person's operand text and focus.
    React.useEffect(() => {
        if (props.when.filter === reportedFilter.current.value && props.when.filterInvalid === reportedFilter.current.invalid) return;
        reportedFilter.current = { value: props.when.filter, invalid: props.when.filterInvalid };
        model.setFilterClauses(readPluginEventAutomationFilterClauses(props.when.filter ?? null));
    }, [props.when.filter, props.when.filterInvalid, model.setFilterClauses]);
    React.useEffect(() => {
        if (!edited.current) return;
        edited.current = false;
        const { filter: _filter, filterInvalid: _invalid, ...when } = props.when;
        reportedFilter.current = { value: model.filter.valid ? model.filter.value ?? undefined : undefined,
            invalid: model.filter.valid ? undefined : true };
        props.onChange({ ...when, ...(model.filter.valid
            ? model.filter.value === null ? {} : { filter: model.filter.value }
            : { filterInvalid: true }) });
    }, [model.filter, props.when, props.onChange]);
    const [filterFieldPickerOpenFor, setFilterFieldPickerOpenFor] = React.useState<string | null>(null);
    const [filterOperatorPickerOpenFor, setFilterOperatorPickerOpenFor] = React.useState<string | null>(null);
    const disclosure = useEventComposerPickerDisclosure({
        anyPickerOpen: filterFieldPickerOpenFor !== null || filterOperatorPickerOpenFor !== null,
        collapseAllPickers: () => { setFilterFieldPickerOpenFor(null); setFilterOperatorPickerOpenFor(null); },
    });
    return <AutomationEventFilterFields model={model} disclosure={{ ...disclosure, filterFieldPickerOpenFor,
        filterOperatorPickerOpenFor, setFilterFieldPickerOpenFor, setFilterOperatorPickerOpenFor }} />;
}
