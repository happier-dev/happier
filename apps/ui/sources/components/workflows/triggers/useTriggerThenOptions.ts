import * as React from 'react';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import type { AttachedTriggerPage } from './useWorkflowTriggerSets';
import type { WorkflowTriggerSetV1 } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import { isKeepGoingTriggerTargetV1 } from '@happier-dev/protocol/workflows/triggers/triggerTargetV1';

import {
    listBuiltinWorkflowReferenceOptions,
    useWorkflowLibraryReferenceOptions,
    useWorkflowReferenceTitleRead,
} from '@/components/workflows/presentation/workflowReferenceOptions';
import { callWorkflowAction } from '@/sync/domains/workflows/callWorkflowAction';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { useActiveServerAccountScopeLifetime } from '@/sync/domains/state/storage';
import { useWorkflowAccountLifetime } from '../workflowAccountScope';
export { useWorkflowReferenceDefinition as useTriggerWorkflowDefinition } from '@/components/workflows/presentation/useWorkflowReferenceDefinition';

import { NOTIFY_ME_ACTION_ID, readTriggerThen } from './sessionTriggerForm';
import type { TriggerWorkflowOption } from './TriggerPopover';

/**
 * The workflows a trigger's **Run a workflow** can name (07 S16b: Built-in first, then your
 * library), from the existing reference owners: the built-in catalog the Run-a-workflow step lists
 * and the Account's definition list. Rows read a workflow's name through the same resolver.
 */
export function useTriggerThenOptions(options?: Readonly<{ libraryEnabled?: boolean; accountLifetime?: ServerAccountScopeLifetime | null;
    sets?: readonly WorkflowTriggerSetV1[]; attachedPage?: AttachedTriggerPage }>): Readonly<{
    workflowOptions: readonly TriggerWorkflowOption[];
    resolveWorkflowTitle: (ref: string) => string | null;
    /** A named workflow whose header is still being read: its row holds the title slot. */
    isWorkflowTitlePending: (ref: string) => boolean;
}> {
    const libraryEnabled = options?.libraryEnabled ?? true;
    const libraryOptions = useWorkflowLibraryReferenceOptions({ enabled: libraryEnabled,
        ...(options?.accountLifetime === undefined ? {} : { accountLifetime: options.accountLifetime }) });
    const references = React.useMemo(() => [
        ...(options?.sets ?? []).flatMap(set => {
            if (!set.target) return [];
            const then = readTriggerThen(set.target);
            return then.kind === 'runWorkflow' && then.ref !== null ? [then.ref] : [];
        }),
        ...(options?.attachedPage?.attached ?? []).flatMap(row => row.workflowDefinitionId === null ? [] : [row.workflowDefinitionId]),
    ], [options?.sets, options?.attachedPage]);
    const { title: resolveWorkflowTitle, isPending: isWorkflowTitlePending } = useWorkflowReferenceTitleRead(references, true, options?.accountLifetime);
    const workflowOptions = React.useMemo((): readonly TriggerWorkflowOption[] => [
        ...(libraryEnabled ? listBuiltinWorkflowReferenceOptions() : [])
            .filter((option) => !isKeepGoingTriggerTargetV1({ kind: 'workflow', ref: option.ref }))
            .map((option) => ({ ref: option.ref, title: option.title, ...(option.origin === undefined ? {} : { origin: option.origin }) })),
        ...libraryOptions,
    ], [libraryEnabled, libraryOptions]);
    return { workflowOptions, resolveWorkflowTitle, isWorkflowTitlePending };
}

export type SendToOption = Readonly<{ value: string; label: string }>;
type NotifyMeChannelRead =
    | Readonly<{ kind: 'ready'; options: readonly SendToOption[] }>
    | Readonly<{ kind: 'failed'; error: unknown }>;

/**
 * Notify me's **Send to** choices (F2): the Notify me Action's own `channels` options source,
 * resolved through the Action front door only while the row is shown.
 */
export function useNotifyMeChannelOptions(enabled: boolean, explicitLifetime?: ServerAccountScopeLifetime | null) {
    const addressedLifetime = useWorkflowAccountLifetime(explicitLifetime);
    const activeLifetime = useActiveServerAccountScopeLifetime();
    const accountLifetime = addressedLifetime === undefined ? activeLifetime : addressedLifetime;
    const [attempt, setAttempt] = React.useState(0);
    const [read, setRead] = React.useState<Readonly<{
        accountLifetime: typeof accountLifetime;
        attempt: number;
        result: NotifyMeChannelRead;
    }> | null>(null);
    const retry = React.useCallback(() => setAttempt(current => current + 1), []);
    React.useEffect(() => {
        if (!enabled) {
            setRead(null);
            return;
        }
        const controller = new AbortController();
        const outputSchema = getActionSpec('action.options.resolve').outputSchema;
        void callWorkflowAction({
            ...(addressedLifetime === undefined ? {} : { accountLifetime: addressedLifetime }),
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
        }).then(
            options => {
                if (!controller.signal.aborted) setRead({ accountLifetime, attempt, result: { kind: 'ready', options } });
            },
            (error: unknown) => {
                if (!controller.signal.aborted) setRead({ accountLifetime, attempt, result: { kind: 'failed', error } });
            },
        );
        return () => controller.abort();
    }, [accountLifetime, addressedLifetime, attempt, enabled]);
    const result = enabled && read !== null && read.accountLifetime === accountLifetime && read.attempt === attempt
        ? read.result : null;
    return { result, retry };
}
