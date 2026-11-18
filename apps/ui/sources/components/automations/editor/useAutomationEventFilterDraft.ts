import * as React from 'react';
import type { PluginJsonSchemaV2 } from '@happier-dev/protocol/plugins/contributions/jsonSchema';
import type { AutomationEventFilterV1 } from '@happier-dev/protocol/automations/automationEventFilterV1';
import { validateAutomationEventFilterAgainstPayloadSchemaV1 } from '@happier-dev/protocol/automations/event';
import { readPluginEventAutomationFilterClauses, readPluginEventAutomationFilterDraft,
    type PluginEventAutomationFilterClauseDraft } from './pluginEventAutomationFilterBuilder';
import { buildPluginEventAutomationPayloadBrowser } from './pluginEventAutomationPayloadBrowser';

/** Transient editor state for the one Event filter grammar and payload-schema validator. */
export function useAutomationEventFilterDraft(params: Readonly<{
    payloadSchema: PluginJsonSchemaV2 | null | undefined;
    initialFilter?: AutomationEventFilterV1 | null;
    onEdit?: () => void;
}>) {
    const [filterClauses, setFilterClauses] = React.useState(() => readPluginEventAutomationFilterClauses(params.initialFilter ?? null));
    const nextId = React.useRef(0);
    const payloadBrowser = React.useMemo(() => buildPluginEventAutomationPayloadBrowser(params.payloadSchema), [params.payloadSchema]);
    const filter = React.useMemo(() => {
        const drafted = readPluginEventAutomationFilterDraft(filterClauses);
        if (!drafted.valid) return { value: null, valid: false } as const;
        const validation = validateAutomationEventFilterAgainstPayloadSchemaV1({ filter: drafted.filter, payloadSchema: params.payloadSchema });
        return validation.kind === 'valid' ? { value: drafted.filter, valid: true } as const : { value: null, valid: false } as const;
    }, [filterClauses, params.payloadSchema]);
    const update = React.useCallback((apply: (current: readonly PluginEventAutomationFilterClauseDraft[]) => readonly PluginEventAutomationFilterClauseDraft[]) => {
        setFilterClauses(apply);
        params.onEdit?.();
    }, [params.onEdit]);
    const addFilterClause = React.useCallback(() => {
        const first = payloadBrowser.fields[0];
        if (!first) return;
        const id = `draft-${nextId.current++}`;
        update(current => [...current, { id, field: first.pointer, op: 'eq', valueText: JSON.stringify(first.sampleValue) }]);
    }, [payloadBrowser.fields, update]);
    const removeFilterClause = React.useCallback((id: string) => update(current => current.filter(clause => clause.id !== id)), [update]);
    const setFilterClauseField = React.useCallback((id: string, field: string) => {
        if (!payloadBrowser.fields.some(candidate => candidate.pointer === field)) return;
        update(current => current.map(clause => clause.id === id ? { ...clause, field } : clause));
    }, [payloadBrowser.fields, update]);
    const setFilterClauseOperator = React.useCallback((id: string, op: PluginEventAutomationFilterClauseDraft['op']) => {
        update(current => current.map(clause => clause.id === id ? { ...clause, op } : clause));
    }, [update]);
    const setFilterClauseValueText = React.useCallback((id: string, valueText: string) => {
        update(current => current.map(clause => clause.id === id ? { ...clause, valueText } : clause));
    }, [update]);
    return { payloadBrowser, filter, filterValid: filter.valid, filterClauses, setFilterClauses, addFilterClause,
        removeFilterClause, setFilterClauseField, setFilterClauseOperator, setFilterClauseValueText };
}
