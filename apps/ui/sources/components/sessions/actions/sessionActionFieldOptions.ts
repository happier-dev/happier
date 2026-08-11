import type { ActionInputFieldHint } from '@happier-dev/protocol';

import {
    buildAvailableReviewEngineOptions,
    type ExecutionRunsBackendSnapshotEntry,
} from '@/sync/domains/reviews/reviewEngineCatalog';

import type { ActionFieldOption } from './ActionInputFields';

/**
 * The option list a field paints, for every field of an action draft.
 *
 * ONE owner. `SessionActionDraftCard` hands this to `ActionInputFields` (which paints one chip per
 * option) and to `resolveSessionActionDraftHeightBearingPaint` (which describes that paint for the
 * transcript row's size key), and `ChatListInternal` hands the height-bearing variant to
 * `transcriptRowShellSignature`. A second implementation of "which options does this field show"
 * would be exactly the drift the descriptor exists to prevent.
 */
export type ResolveSessionActionFieldOptions = (
    field: Pick<ActionInputFieldHint, 'optionsSourceId' | 'options'>,
) => readonly ActionFieldOption[];

const EMPTY_OPTIONS: readonly ActionFieldOption[] = Object.freeze([]);

function readStaticFieldOptions(
    field: Pick<ActionInputFieldHint, 'options'>,
): readonly ActionFieldOption[] {
    const raw = Array.isArray(field?.options) ? field.options : null;
    if (!raw) return EMPTY_OPTIONS;
    const options: ActionFieldOption[] = [];
    for (const entry of raw) {
        const value = typeof (entry as { value?: unknown })?.value === 'string'
            ? String((entry as { value: string }).value)
            : '';
        if (!value) continue;
        const label = typeof (entry as { label?: unknown })?.label === 'string'
            ? String((entry as { label: string }).label)
            : value;
        options.push({ value, label });
    }
    return options;
}

/**
 * Builds the resolver from the facts that decide a dynamic option list.
 *
 * `executionRunsBackends` is the ASYNC machine-capabilities snapshot. **In this repo it reaches
 * `disabled` and nothing else**: `buildAvailableReviewEngineOptions` derives every option's `id`
 * from `enabledAgentIds` + `listNativeReviewEngines()` and every `label` from the caller's
 * `resolveAgentLabel` / the native engine title, all of which are static per id. That invariant is
 * what lets the transcript key the painted option list without subscribing to the snapshot, and it
 * is pinned by `sessionActionFieldOptions.test.ts#the capabilities snapshot cannot change a painted
 * option id or label`. ../dev's catalog is materially different — it adds one discovered option per
 * machine-reported review-capable backend and prefers the snapshot's own title as the label — so
 * that repo's transcript feeds the snapshot in, and this invariant does NOT hold there.
 */
export function buildSessionActionFieldOptionsResolver(params: Readonly<{
    enabledAgentIds: readonly string[];
    executionRunsBackends: Readonly<Record<string, ExecutionRunsBackendSnapshotEntry>> | null;
    resolveAgentLabel: (agentId: string) => string;
}>): ResolveSessionActionFieldOptions {
    const engineOptions: readonly ActionFieldOption[] = buildAvailableReviewEngineOptions({
        enabledAgentIds: params.enabledAgentIds,
        executionRunsBackends: params.executionRunsBackends,
        resolveAgentLabel: params.resolveAgentLabel,
    }).map((option) => ({
        value: option.id,
        label: option.label,
        ...(option.disabled ? { disabled: true as const } : {}),
    }));
    const backendOptions: readonly ActionFieldOption[] = params.enabledAgentIds.map((agentId) => ({
        value: agentId,
        label: params.resolveAgentLabel(agentId),
    }));

    return (field) => {
        const sourceId = typeof field?.optionsSourceId === 'string' ? field.optionsSourceId : '';
        if (sourceId === 'review.engines.available') return engineOptions;
        if (sourceId === 'execution.backends.enabled') return backendOptions;
        return readStaticFieldOptions(field);
    };
}
