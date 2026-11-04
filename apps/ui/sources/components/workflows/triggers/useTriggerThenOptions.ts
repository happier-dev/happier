import * as React from 'react';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import type { WorkflowTriggerSetV1 } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';

import {
    listBuiltinWorkflowReferenceOptions,
    useWorkflowLibraryReferenceOptions,
    useWorkflowReferenceTitles,
} from '@/components/workflows/presentation/workflowReferenceOptions';
import { callWorkflowAction } from '@/sync/domains/workflows/callWorkflowAction';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { useWorkflowAccountLifetime } from '../workflowAccountScope';
export { useWorkflowReferenceDefinition as useTriggerWorkflowDefinition } from '@/components/workflows/presentation/useWorkflowReferenceDefinition';

import { NOTIFY_ME_ACTION_ID, readTriggerThen } from './sessionTriggerForm';
import type { TriggerWorkflowOption } from './TriggerPopover';

/** Keep going until done has one attach, the Goal control (04 §5.5, S16c); no trigger picker offers it. */
const KEEP_GOING_REF = 'builtin:keep-going';

/**
 * The workflows a trigger's **Run a workflow** can name (07 S16b: Built-in first, then your
 * library), from the existing reference owners: the built-in catalog the Run-a-workflow step lists
 * and the Account's definition list. Rows read a workflow's name through the same resolver.
 */
export function useTriggerThenOptions(options?: Readonly<{ libraryEnabled?: boolean; accountLifetime?: ServerAccountScopeLifetime | null;
    sets?: readonly WorkflowTriggerSetV1[] }>): Readonly<{
    workflowOptions: readonly TriggerWorkflowOption[];
    resolveWorkflowTitle: (ref: string) => string | null;
}> {
    const libraryEnabled = options?.libraryEnabled ?? true;
    const libraryOptions = useWorkflowLibraryReferenceOptions({ enabled: libraryEnabled,
        ...(options?.accountLifetime === undefined ? {} : { accountLifetime: options.accountLifetime }) });
    const references = React.useMemo(() => (options?.sets ?? []).flatMap(set => {
        if (!set.target) return [];
        const then = readTriggerThen(set.target);
        return then.kind === 'runWorkflow' && then.ref !== null ? [then.ref] : [];
    }), [options?.sets]);
    const resolveWorkflowTitle = useWorkflowReferenceTitles(references, true, options?.accountLifetime);
    const workflowOptions = React.useMemo((): readonly TriggerWorkflowOption[] => [
        ...(libraryEnabled ? listBuiltinWorkflowReferenceOptions() : [])
            .filter((option) => option.ref !== KEEP_GOING_REF)
            .map((option) => ({ ref: option.ref, title: option.title })),
        ...libraryOptions,
    ], [libraryEnabled, libraryOptions]);
    return { workflowOptions, resolveWorkflowTitle };
}

export type SendToOption = Readonly<{ value: string; label: string }>;

/**
 * Notify me's **Send to** choices (F2): the Notify me Action's own `channels` options source,
 * resolved through the Action front door only while the row is shown.
 */
export function useNotifyMeChannelOptions(): readonly SendToOption[] {
    const accountLifetime = useWorkflowAccountLifetime();
    const [options, setOptions] = React.useState<readonly SendToOption[]>([]);
    React.useEffect(() => {
        const controller = new AbortController();
        const outputSchema = getActionSpec('action.options.resolve').outputSchema;
        void callWorkflowAction({
            ...(accountLifetime === undefined ? {} : { accountLifetime }),
            actionId: 'action.options.resolve',
            input: { actionId: NOTIFY_ME_ACTION_ID, fieldPath: 'channels' },
            parseResult: (value) => {
                const parsed = outputSchema?.safeParse(value);
                const resolved: unknown = parsed?.success ? parsed.data : null;
                return resolved !== null && typeof resolved === 'object' && 'options' in resolved && Array.isArray(resolved.options)
                    ? resolved.options
                        .filter((option): option is { value: string; label: string } => (
                            typeof option === 'object' && option !== null
                            && typeof option.value === 'string' && typeof option.label === 'string'))
                        .map((option) => ({ value: option.value, label: option.label }))
                    : [];
            },
            signal: controller.signal,
        }).then((resolved) => {
            if (!controller.signal.aborted) setOptions(resolved);
        }).catch(() => undefined);
        return () => controller.abort();
    }, [accountLifetime]);
    return options;
}
