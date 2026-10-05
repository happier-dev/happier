import * as React from 'react';
import type { ActionInputFieldHint } from '@happier-dev/protocol';
import { projectInputOptionsDependencies } from '@happier-dev/protocol/inputs';

import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { resolveUiAccountActionFallbackMachineId } from '@/sync/ops/actions/accountActionDeps';
import type { ResolveSessionActionFieldOptions, InputFieldOptionsContext } from './sessionActionFieldOptions';
import {
    EMPTY_INPUT_OPTIONS, INPUT_OPTIONS_LOADING, readInputFieldOptionsState, subscribeInputFieldOptions,
    retryInputFieldOptions, refreshInputFieldOptions, type InputFieldOptionsState, type InputOptionsRead,
} from './inputFieldOptionsStore';

export type InputFieldOptionsRequest = InputFieldOptionsContext & Readonly<{
    field: Pick<ActionInputFieldHint, 'path' | 'optionsSourceId' | 'options' | 'inputType' | 'connectedAccountOptions'>;
}>;
const NO_READS: readonly InputOptionsRead[] = Object.freeze([]);

function fieldKey(field: Pick<ActionInputFieldHint, 'optionsSourceId' | 'inputType'> & { path?: string }, context?: InputFieldOptionsContext): string {
    return JSON.stringify([field.path, field.optionsSourceId, field.inputType, context?.actionId, context?.consumer,
        projectInputOptionsDependencies(context?.draftInput ?? {})]);
}

/** Demand projection over Action discovery, including cancellation and exact Account/target identity. */
export function useInputFieldOptions(params: Readonly<{
    requests: readonly InputFieldOptionsRequest[];
    enabled: boolean;
    machineId?: string | null;
    sessionId?: string | null;
    serverId?: string | null;
    /** Inventory facts invalidate choices; they never implement a source locally. */
    refreshKey?: string;
}>) {
    const scope = useActiveServerAccountScope();
    // Pin the same incumbent Account relay for the options read and the picker mount.
    // A later transport fallback must not give a field machine-B choices beside machine-A's type.
    const optionServerId = params.serverId ?? scope?.serverId;
    const machineId = params.machineId ?? (!params.sessionId && optionServerId
        && params.requests.some((request) => request.field.inputType !== undefined)
        ? resolveUiAccountActionFallbackMachineId({ serverId: optionServerId }) : null);
    const signature = JSON.stringify([scope?.accountId, optionServerId, machineId,
        params.sessionId, params.requests.map((request) => ({ ...request,
            draftInput: projectInputOptionsDependencies(request.draftInput ?? {}) }))]);
    const { reads, keys, defaultContexts } = React.useMemo(() => {
        const keys = new Map<string, string>();
        const defaultContexts = new Map<string, InputFieldOptionsContext>();
        const reads = new Map<string, InputOptionsRead>();
        for (const request of params.requests) {
            if ((!request.field.optionsSourceId && !request.field.inputType && !request.field.connectedAccountOptions) || request.field.options?.length) continue;
            const input = { ...(request.field.optionsSourceId ? { optionsSourceId: request.field.optionsSourceId } : {}),
                ...(request.actionId ? { actionId: request.actionId, fieldPath: request.field.path } : {}),
                ...(request.consumer ? { consumer: request.consumer, fieldPath: request.field.path } : {}),
                draftInput: { ...projectInputOptionsDependencies(request.draftInput ?? {}),
                    ...(machineId ? { machineId } : {}),
                    ...(params.sessionId ? { sessionId: params.sessionId } : {}) },
            };
            const serverId = params.serverId ?? scope?.serverId;
            const context = { ...(serverId ? { serverId } : {}),
                ...(machineId ? { externalActionTarget: { kind: 'machine' as const, machineId } } : {}),
                ...(scope?.accountId ? { runtimeAccountId: scope.accountId } : {}),
                ...(params.sessionId ? { defaultSessionId: params.sessionId } : {}) };
            const key = JSON.stringify([input, context]);
            reads.set(key, { key, input, context });
            keys.set(fieldKey(request.field, request), key);
            defaultContexts.set(JSON.stringify([request.field.path, request.field.optionsSourceId, request.field.inputType]), request);
        }
        return { reads: [...reads.values()], keys, defaultContexts };
    }, [signature]);
    const activeReads = params.enabled ? reads : NO_READS;
    const refreshKey = React.useRef(params.refreshKey);
    refreshKey.current = params.refreshKey;
    const subscribe = React.useCallback((listener: () => void) => {
        const releases = activeReads.map((read) => subscribeInputFieldOptions(read, listener, refreshKey.current));
        return () => releases.forEach((release) => release());
    }, [activeReads]);
    const retainedSnapshot = React.useRef<readonly InputFieldOptionsState[]>([]);
    const getSnapshot = React.useCallback(() => {
        const states = activeReads.map((read) => readInputFieldOptionsState(read.key));
        if (states.length === retainedSnapshot.current.length && states.every((state, index) => state === retainedSnapshot.current[index])) {
            return retainedSnapshot.current;
        }
        retainedSnapshot.current = states;
        return states;
    }, [activeReads]);
    const snapshot = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    React.useEffect(() => {
        activeReads.forEach((read) => refreshInputFieldOptions(read, params.refreshKey));
    }, [activeReads, params.refreshKey]);
    const state = React.useCallback((field: InputFieldOptionsRequest['field'], context?: InputFieldOptionsContext): InputFieldOptionsState => {
        if (field.options?.length || (!field.optionsSourceId && !field.inputType && !field.connectedAccountOptions)) return { options: field.options ?? EMPTY_INPUT_OPTIONS, status: 'ready' };
        const effectiveContext = context ?? defaultContexts.get(JSON.stringify([field.path, field.optionsSourceId, field.inputType]));
        const key = keys.get(fieldKey(field, effectiveContext));
        const index = activeReads.findIndex((read) => read.key === key);
        return index === -1 ? INPUT_OPTIONS_LOADING : snapshot[index] ?? INPUT_OPTIONS_LOADING;
    }, [activeReads, keys, defaultContexts, snapshot]);
    const retry = React.useCallback(() => activeReads.forEach(retryInputFieldOptions), [activeReads]);
    const resolveOptions: ResolveSessionActionFieldOptions = React.useMemo(() => Object.assign(
        (field: Parameters<ResolveSessionActionFieldOptions>[0], context?: InputFieldOptionsContext) => state({ ...field, path: field.path ?? '' }, context).options,
        { state, retry, pickerContext: { machineId, sessionId: params.sessionId,
            serverId: params.serverId ?? scope?.serverId, contextKey: JSON.stringify([signature, snapshot]) } },
    ), [state, retry, signature, snapshot]);
    return { resolveOptions, state, retry, snapshot };
}
