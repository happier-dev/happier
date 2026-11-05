import {
    PluginUiLaunchInputV1Schema,
    PluginUiSelectActionInputRequestV1Schema,
    PluginUiSelectActionInputResultV1Schema,
    PluginUiJsonValueV1Schema,
    type PluginUiHostApiErrorCodeV1,
    type PluginUiJsonObjectV1,
    type PluginUiJsonValueV1,
    type PluginUiTargetedContributionsV1,
} from '@happier-dev/protocol/plugins/ui';

import type { PluginProjectionEntry } from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import {
    createPluginContributedActionController,
    type PluginContributedActionHostFacts,
    type PluginContributedActionConnectedAccountOptionsTransport,
    type PluginContributedActionSelectionOutcome,
} from '@/components/plugins/actions/pluginContributedActionController';
import { presentActionInputForm } from '@/components/plugins/actions/presentActionInputForm';
import {
    composeSessionServerStartDraft,
    type SessionServerStartDraftTarget,
    type SessionServerStartDraftComposerOutcome,
} from '@/components/sessions/new/serverStartDraftComposer';
import { mergeAbortSignals } from '@/utils/runtime/abortSignals';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';

import {
    createPluginSurfaceHostApiError,
    type PluginSurfaceHostApiMethodHandler,
    type PluginSurfaceHostApiRequestOptions,
} from './createPluginSurfaceHostApi';
import type { PluginSurfaceContributedActionDescriptorResolver } from './pluginSurfaceActionDispatch';
import { projectPluginActionInputSelectionFacts } from './pluginActionInputSelectionFacts';
export { projectPluginActionInputSelectionFacts } from './pluginActionInputSelectionFacts';

function errorPayload(
    code: PluginUiHostApiErrorCodeV1,
    diagnostic: string,
): PluginUiJsonValueV1 {
    return createPluginSurfaceHostApiError(code, [diagnostic]);
}

function selectionFailure(
    outcome: Exclude<PluginContributedActionSelectionOutcome, Readonly<{ kind: 'direct' | 'form' }>>,
): PluginUiJsonValueV1 {
    if (outcome.kind === 'stale') return errorPayload('stale_surface', outcome.reason);
    switch (outcome.reason) {
        case 'invalid_input':
        case 'invalid_draft':
            return errorPayload('invalid_payload', outcome.reason);
        case 'action_not_found':
        case 'action_ambiguous':
        case 'secret_input_unsupported':
        case 'connected_account_ambiguous':
        case 'host_unavailable':
        case 'submission_in_flight':
            return errorPayload('unavailable', outcome.reason);
    }
}

function readBoundedSelectionResult(value: unknown): PluginUiJsonValueV1 {
    const parsed = PluginUiSelectActionInputResultV1Schema.safeParse(value);
    if (!parsed.success) {
        return errorPayload('invalid_payload', 'select_action_input_result_invalid');
    }
    if (
        parsed.data.kind === 'submitted'
        && !PluginUiLaunchInputV1Schema.safeParse(parsed.data.input).success
    ) {
        return errorPayload('invalid_payload', 'select_action_input_result_invalid');
    }
    // The selector result is schema-valid but its TypeScript projection keeps
    // optional draft fields as `undefined`. Reparse through the actual Host API
    // JSON boundary so the generic handler never leaks a non-JSON shape.
    const json = PluginUiJsonValueV1Schema.safeParse(parsed.data);
    return json.success
        ? json.data
        : errorPayload('invalid_payload', 'select_action_input_result_invalid');
}

export type PluginSessionServerStartDraftComposer = (params: Readonly<{
    draft?: PluginUiJsonObjectV1;
    signal?: AbortSignal;
    isCurrent: () => boolean;
    target: SessionServerStartDraftTarget;
}>) => Promise<SessionServerStartDraftComposerOutcome>;

function readSessionServerStartDraftTarget(
    host: PluginContributedActionHostFacts,
): SessionServerStartDraftTarget | null {
    const machineId = typeof host.machineId === 'string' ? host.machineId.trim() : '';
    const serverId = resolveServerProfileScopeIdForIdentifier(host.serverId);
    const accountServerId = resolveServerProfileScopeIdForIdentifier(host.accountLifetime?.scope.serverId);
    return machineId && serverId && serverId === accountServerId
        ? { machineId, serverId }
        : null;
}

function sessionComposerFailure(
    outcome: Exclude<SessionServerStartDraftComposerOutcome, Readonly<{ kind: 'submitted' | 'cancelled' }>>,
): PluginUiJsonValueV1 {
    if (outcome.kind === 'stale') return errorPayload('stale_surface', outcome.reason);
    return errorPayload(outcome.kind === 'invalid' ? 'invalid_payload' : 'unavailable', outcome.reason);
}

async function composeDefaultSessionServerStartDraft(params: Parameters<PluginSessionServerStartDraftComposer>[0]): Promise<SessionServerStartDraftComposerOutcome> {
    // The modal is Session-owned and loaded only after the literal host request
    // has passed its closed Protocol boundary. It cannot receive a contributed
    // Action, selector, or dispatcher.
    try {
        const { presentSessionServerStartDraftComposer } = await import(
            '@/components/sessions/new/serverStartDraftComposerPresentation'
        );
        return await composeSessionServerStartDraft({
            draft: params.draft,
            signal: params.signal,
            isCurrent: params.isCurrent,
            target: params.target,
            // The machine the composition is FOR, which the seed may have
            // named — not the one this surface is mounted on.
            present: ({ seed, target }) => presentSessionServerStartDraftComposer({ seed, target }),
        });
    } catch {
        return { kind: 'unavailable', reason: 'presentation_unavailable' };
    }
}

/**
 * Producer for target-scoped Host API `selectActionInput`.
 *
 * The handler borrows the one target-filtered cold-admission snapshot together
 * with already-bound machine/Account facts and normalized Action metadata. It
 * opens the incumbent host form and returns only the selected input; it never
 * reaches the Action dispatcher or falls back to a global Action lookup.
 */
type PluginActionInputSelectionBinding = Readonly<{
    pluginProjectionById?: Readonly<Record<string, PluginProjectionEntry>>;
    /** Exact mounted projection used only to resolve Action presentation text. */
    pluginUiProjection?: PluginUiProjectionModel | null;
    targetedContributions?: PluginUiTargetedContributionsV1 | null;
    /**
     * The mount's current raw V2 Action resolver. The generic controller needs
     * it to read an admitted operation's declared execution realm: without it
     * an unknown target reads as daemon-owned and a client Action's form is
     * presented before its executable registration has committed.
     */
    resolveContributedAction?: PluginSurfaceContributedActionDescriptorResolver;
    host: PluginContributedActionHostFacts;
    isCurrent: () => boolean;
    present?: typeof presentActionInputForm;
    resolveConnectedAccountOptions?: PluginContributedActionConnectedAccountOptionsTransport;
    composeSessionServerStartDraft?: PluginSessionServerStartDraftComposer;
}>;

/** Semantic input-selection owner, also borrowed by unmounted client Actions. */
export function createPluginActionInputSelector(input: PluginActionInputSelectionBinding) {
    const present = input.present ?? presentActionInputForm;
    const selectionFacts = projectPluginActionInputSelectionFacts({
        pluginProjectionById: input.pluginProjectionById,
        pluginUiProjection: input.pluginUiProjection,
        targetedContributions: input.targetedContributions,
        targetPluginId: input.host.targetPluginId,
    });
    return async (payload: unknown, options?: PluginSurfaceHostApiRequestOptions) => {
        const parsed = PluginUiSelectActionInputRequestV1Schema.safeParse(payload);
        if (!parsed.success) return errorPayload('invalid_payload', 'select_action_input_request_invalid');
        const mergedSignal = mergeAbortSignals([input.host.signal, options?.signal]);
        const signal = mergedSignal.signal;
        try {
            const result = await (async (): Promise<PluginUiJsonValueV1> => {
                if (signal?.aborted) return errorPayload('unavailable', 'select_action_input_aborted');
                if ('hostAction' in parsed.data) {
                    if (parsed.data.hostAction.action === 'session.transcript.get') {
                        const lifetime = input.host.accountLifetime;
                        const serverId = resolveServerProfileScopeIdForIdentifier(lifetime?.scope.serverId);
                        if (!lifetime || !serverId
                            || resolveServerProfileScopeIdForIdentifier(input.host.serverId) !== serverId) {
                            return errorPayload('unavailable', 'host_unavailable');
                        }
                        const { presentSessionAddressSelection } = await import(
                            '@/components/sessions/transcript/messageSelection/presentSessionAddressSelection'
                        );
                        const presentation = presentSessionAddressSelection(serverId);
                        const cancel = () => presentation.close();
                        signal?.addEventListener('abort', cancel, { once: true });
                        if (signal?.aborted) cancel();
                        try {
                            const selected = await presentation.result;
                            if (!selected || selected.kind !== 'existingSession') return { kind: 'cancelled' };
                            return readBoundedSelectionResult({ kind: 'sessionAddress', session: {
                                serverId: selected.serverId, sessionId: selected.sessionId,
                            } });
                        } finally {
                            signal?.removeEventListener('abort', cancel);
                        }
                    }
                    if (parsed.data.hostAction.action === 'review.start' && 'sessionId' in parsed.data) {
                        if (!input.host.accountLifetime) return errorPayload('unavailable', 'host_unavailable');
                        const serverId = parsed.data.serverId ?? input.host.accountLifetime?.scope.serverId;
                        if (!serverId) return errorPayload('unavailable', 'host_unavailable');
                        const { presentReviewExecutionRunLaunchSelection } = await import(
                            '@/components/sessions/runs/launcher/reviewExecutionRunLaunchSelection'
                        );
                        const presentation = presentReviewExecutionRunLaunchSelection({ sessionId: parsed.data.sessionId,
                            serverId, draft: parsed.data.draft, isCurrent: input.isCurrent });
                        const cancel = () => presentation.close();
                        signal?.addEventListener('abort', cancel, { once: true });
                        if (signal?.aborted) cancel();
                        try {
                            const selected = await presentation.result;
                            if (!selected) return { kind: 'cancelled' };
                            return readBoundedSelectionResult(selected);
                        } finally {
                            signal?.removeEventListener('abort', cancel);
                        }
                    }
                    const target = readSessionServerStartDraftTarget(input.host);
                    if (!target) return errorPayload('unavailable', 'host_unavailable');
                    const composer = input.composeSessionServerStartDraft ?? composeDefaultSessionServerStartDraft;
                    const draft = 'draft' in parsed.data ? parsed.data.draft : undefined;
                    const outcome = await composer({
                        ...(draft === undefined ? {} : { draft }),
                        ...(signal ? { signal } : {}),
                        isCurrent: input.isCurrent,
                        target,
                    });
                    if (outcome.kind === 'submitted') {
                        return readBoundedSelectionResult({ kind: 'serverStartDraft', draft: outcome.draft });
                    }
                    if (outcome.kind === 'cancelled') return outcome;
                    return sessionComposerFailure(outcome);
                }

                if (
                    parsed.data.draft !== undefined
                    && !PluginUiLaunchInputV1Schema.safeParse(parsed.data.draft).success
                ) return errorPayload('invalid_payload', 'select_action_input_request_invalid');
                const pluginProjectionById = selectionFacts.pluginProjectionById;
                const targetedContributions = selectionFacts.targetedContributions;
                if (!selectionFacts.hasPluginProjection || !targetedContributions) {
                    return errorPayload('unavailable', 'host_unavailable');
                }
                const controller = createPluginContributedActionController({
                    resolveCurrent: () => ({
                        pluginProjectionById,
                        targetedContributions,
                        pluginUiProjection: selectionFacts.pluginUiProjection,
                        ...(input.resolveContributedAction
                            ? { resolveContributedAction: input.resolveContributedAction }
                            : {}),
                        host: {
                            ...input.host,
                            ...(signal ? { signal } : {}),
                            isCurrent: input.isCurrent,
                        },
                    }),
                    ...(input.resolveConnectedAccountOptions
                        ? { resolveConnectedAccountOptions: input.resolveConnectedAccountOptions }
                        : {}),
                });
                const selected = await controller.selectActionInput(parsed.data);
                if (selected.kind !== 'form' && selected.kind !== 'direct') {
                    return selectionFailure(selected);
                }
                if (selected.kind === 'direct') {
                    return readBoundedSelectionResult(selected.result);
                }

                present({ form: selected.form, ...(signal ? { signal } : {}) });
                const readSelectionResult = async (): Promise<PluginUiJsonValueV1> => {
                    const result = await selected.result;
                    if (result.kind === 'unavailable' || result.kind === 'stale') {
                        return selectionFailure(result);
                    }
                    return readBoundedSelectionResult(result);
                };
                if (!signal) return await readSelectionResult();
                let detachAbort: () => void = () => undefined;
                const aborted = new Promise<PluginUiJsonValueV1>((resolve) => {
                    const onAbort = () => {
                        selected.form.retire();
                        resolve(errorPayload(
                            'unavailable',
                            'select_action_input_aborted',
                        ));
                    };
                    if (signal.aborted) {
                        onAbort();
                    } else {
                        signal.addEventListener('abort', onAbort, { once: true });
                        detachAbort = () => signal.removeEventListener('abort', onAbort);
                    }
                });
                try {
                    return await Promise.race([readSelectionResult(), aborted]);
                } finally {
                    detachAbort();
                    selected.form.retire();
                }
            })();
            const hostIsCurrent = input.isCurrent()
                && input.host.isCurrent?.() !== false
                && input.host.accountLifetime?.isCurrent() !== false;
            if (!hostIsCurrent) return errorPayload('stale_surface', signal?.aborted ? 'select_action_input_aborted' : 'host_retired');
            return signal?.aborted ? errorPayload('unavailable', 'select_action_input_aborted') : result;
        } finally {
            mergedSignal.dispose();
        }
    };
}

/** The mounted transport borrows the same selector without creating an executor. */
export function createPluginActionInputSelectionHostApiHandler(input: PluginActionInputSelectionBinding): PluginSurfaceHostApiMethodHandler {
    const select = createPluginActionInputSelector(input);
    return (request, options) => request.method === 'selectActionInput'
        ? select(request.payload, options)
        : errorPayload('unsupported_method', 'select_action_input_method_mismatch');
}
