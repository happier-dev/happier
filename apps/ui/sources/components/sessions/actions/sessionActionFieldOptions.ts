import { buildBackendTargetKey, type ActionInputFieldHint } from '@happier-dev/protocol';

import {
    buildAvailableReviewEngineOptions,
    type ExecutionRunsBackendSnapshotEntry,
} from '@/sync/domains/reviews/reviewEngineCatalog';

import type { ActionFieldOption } from './ActionInputFields';

/**
 * The option list a field paints, for every field of an action draft.
 *
 * ONE owner. `SessionActionDraftCard` hands this to `ActionInputFields` (which maps each option into
 * a `HappierSelect` row) and to `resolveSessionActionDraftHeightBearingPaint` (which describes that
 * paint for the transcript row's size key), and `ChatListInternal` hands the height-bearing variant
 * to `transcriptRowShellSignature`. A second implementation of "which options does this field show"
 * would be exactly the drift the descriptor exists to prevent — and the card DID hold one until F-4.
 */
export type ResolveSessionActionFieldOptions = (
    field: Pick<ActionInputFieldHint, 'optionsSourceId' | 'options'>,
) => readonly ActionFieldOption[];

/**
 * The two dynamic option lists, resolved once.
 *
 * This repo resolves the lists FIRST and builds the resolver from them, which is where it diverges
 * from remote-dev's single `buildSessionActionFieldOptionsResolver(params)` entry point. The reason
 * is the one measured difference between the repos: here the option lists are a function of the
 * ASYNC machine-capabilities snapshot as well as the synced setting (see
 * {@link buildSessionActionFieldOptionLists}), so the transcript has to hold the resolver's identity
 * still across snapshot churn that cannot move a painted row — and it can only do that by comparing
 * the resolved lists, not the inputs.
 */
export type SessionActionFieldOptionLists = Readonly<{
    engineOptions: readonly ActionFieldOption[];
    backendOptions: readonly ActionFieldOption[];
}>;

const EMPTY_OPTIONS: readonly ActionFieldOption[] = Object.freeze([]);

/** Static Protocol descriptors already match the shared Action-form option contract. */
function readStaticFieldOptions(
    field: Pick<ActionInputFieldHint, 'options'>,
): readonly ActionFieldOption[] {
    return field.options ?? EMPTY_OPTIONS;
}

/**
 * Resolves the two dynamic option lists from the facts that decide them.
 *
 * `executionRunsBackends` is the ASYNC machine-capabilities snapshot, and **in this repo it decides
 * the painted option SET, not just an interaction flag**. `buildAvailableReviewEngineOptions` adds
 * one `discoveredReviewOptions` entry per machine-reported backend that is not already an enabled
 * agent, and prefers the snapshot's own `title` / `label` / `displayName` over the agent label — so a
 * capabilities RPC resolving can add, remove or rename a whole `HappierSelect` row while the
 * transcript row that paints it is offscreen. That is why this repo's transcript feeds the snapshot
 * in, and remote-dev's (whose catalog composes enabled agents with the static native review engines
 * and lets the snapshot reach only `disabled`) deliberately does not.
 */
export function buildSessionActionFieldOptionLists(params: Readonly<{
    enabledAgentIds: readonly string[];
    executionRunsBackends: Readonly<Record<string, ExecutionRunsBackendSnapshotEntry>> | null | undefined;
    resolveAgentLabel: (agentId: string) => string;
}>): SessionActionFieldOptionLists {
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
        value: buildBackendTargetKey({ kind: 'builtInAgent', agentId }),
        label: params.resolveAgentLabel(agentId),
    }));
    return { engineOptions, backendOptions };
}

export function buildSessionActionFieldOptionsResolver(
    lists: SessionActionFieldOptionLists,
): ResolveSessionActionFieldOptions {
    return (field) => {
        const sourceId = typeof field?.optionsSourceId === 'string' ? field.optionsSourceId : '';
        if (sourceId === 'review.engines.available') return lists.engineOptions;
        if (sourceId === 'execution.backends.enabled') return lists.backendOptions;
        return readStaticFieldOptions(field);
    };
}

/**
 * A string that changes exactly when the painted option rows do — the ONE height-bearing projection
 * of the resolved lists.
 *
 * `disabled` is not projected, exactly as `draft.status` is dropped from the row key in F-P3: it
 * reaches `HappierPressable`'s `opacity` and its press handler and nothing that adds, removes or
 * reflows a box. That exclusion lives HERE and only here, which is what lets the transcript hold ONE
 * resolver identity across every capabilities change that cannot repaint a row — the difference
 * between the option subscription costing one re-render and costing every row's size version.
 *
 * V-3 (2026-08-11): a second `stripNonHeightBearingOptionState` pass used to rebuild the lists
 * without `disabled` before this ran, and was credited with holding that identity. It could not — it
 * fed a projection that already ignored `disabled`, and the only consumer of the stabilised lists
 * (`resolveSessionActionDraftHeightBearingPaint`) reads `option.label`. A minimal mutant that made it
 * preserve `disabled` survived the whole lane, so it was deleted rather than kept behind a docblock
 * that overstated it. The consequence is worth stating: the stabilised lists a caller gets back are
 * literally the value this signature was computed from, so any field the signature does not project
 * — `disabled` today — may be one snapshot stale. Height-bearing state must be projected here.
 *
 * `JSON.stringify` rather than a joined delimiter on purpose: an option label is arbitrary
 * machine-supplied text (`entry.title`), so any separator character is a label a machine can send.
 */
export function buildSessionActionFieldOptionsHeightSignature(
    lists: SessionActionFieldOptionLists,
): string {
    const project = (options: readonly ActionFieldOption[]) =>
        options.map((option) => [String(option.value), option.label]);
    return JSON.stringify([project(lists.engineOptions), project(lists.backendOptions)]);
}
