import * as React from 'react';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';

import {
    listBuiltinWorkflowReferenceOptions,
    useWorkflowLibraryReferenceOptions,
} from '@/components/workflows/presentation/workflowReferenceOptions';
import { callWorkflowAction } from '@/sync/domains/workflows/callWorkflowAction';
export { useWorkflowReferenceDefinition as useTriggerWorkflowDefinition } from '@/components/workflows/presentation/useWorkflowReferenceDefinition';

import { NOTIFY_ME_ACTION_ID } from './sessionTriggerForm';
import type { TriggerWorkflowOption } from './TriggerPopover';

/** Keep going until done has one attach, the Goal control (04 §5.5, S16c); no trigger picker offers it. */
const KEEP_GOING_REF = 'builtin:keep-going';

/**
 * The workflows a trigger's **Run a workflow** can name (07 S16b: Built-in first, then your
 * library), from the existing reference owners: the built-in catalog the Run-a-workflow step lists
 * and the Account's definition list. Rows read a workflow's name through the same resolver.
 */
export function useTriggerThenOptions(options?: Readonly<{ libraryEnabled?: boolean }>): Readonly<{
    workflowOptions: readonly TriggerWorkflowOption[];
    resolveWorkflowTitle: (ref: string) => string | null;
}> {
    const libraryEnabled = options?.libraryEnabled ?? true;
    const libraryOptions = useWorkflowLibraryReferenceOptions({ enabled: libraryEnabled });
    const workflowOptions = React.useMemo((): readonly TriggerWorkflowOption[] => [
        ...listBuiltinWorkflowReferenceOptions()
            .filter((option) => option.ref !== KEEP_GOING_REF)
            .map((option) => ({ ref: option.ref, title: option.title })),
        ...libraryOptions,
    ], [libraryOptions]);
    const resolveWorkflowTitle = React.useCallback((ref: string) => {
        if (ref === KEEP_GOING_REF) return listBuiltinWorkflowReferenceOptions().find((option) => option.ref === ref)?.title ?? null;
        return workflowOptions.find((option) => option.ref === ref)?.title ?? null;
    }, [workflowOptions]);
    return { workflowOptions, resolveWorkflowTitle };
}

export type SendToOption = Readonly<{ value: string; label: string }>;

/**
 * Notify me's **Send to** choices (F2): the Notify me Action's own `channels` options source,
 * resolved through the Action front door only while the row is shown.
 */
export function useNotifyMeChannelOptions(): readonly SendToOption[] {
    const [options, setOptions] = React.useState<readonly SendToOption[]>([]);
    React.useEffect(() => {
        const controller = new AbortController();
        const outputSchema = getActionSpec('action.options.resolve').outputSchema;
        void callWorkflowAction({
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
    }, []);
    return options;
}
