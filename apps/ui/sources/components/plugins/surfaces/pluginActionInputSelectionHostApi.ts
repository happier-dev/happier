import {
    PluginUiLaunchInputV1Schema,
    PluginUiSelectActionInputRequestV1Schema,
    PluginUiSelectActionInputResultV1Schema,
    PluginUiJsonValueV1Schema,
    type PluginUiHostApiErrorCodeV1,
    type PluginUiJsonObjectV1,
    type PluginUiJsonValueV1,
    type PluginUiSelectActionInputRequestV1,
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
import type { SessionNewSessionSeedOutcome } from '@/components/sessions/new/newSessionSeedComposer';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { stableJsonStringify } from '@/utils/json/stableJsonStringify';
import { mergeAbortSignals } from '@/utils/runtime/abortSignals';

import {
    createPluginSurfaceHostApiError,
    type PluginSurfaceHostApiMethodHandler,
    type PluginSurfaceHostApiRequestOptions,
} from './createPluginSurfaceHostApi';
import type { PluginSurfaceContributedActionDescriptorResolver } from './pluginSurfaceActionDispatch';

/**
 * The controller lifetime consumes the same exact daemon facts as target-scoped
 * Action selection. A response refresh reconstructs those JSON objects, so this
 * selector-owned projection retains their semantic identity without pulling
 * unrelated plugin catalog entries into a mounted target's lifetime.
 */
export function projectPluginActionInputSelectionFacts(input: Readonly<{
    pluginProjectionById?: Readonly<Record<string, PluginProjectionEntry>> | null;
    /** Exact mounted projection used only to resolve Action presentation text. */
    pluginUiProjection?: PluginUiProjectionModel | null;
    targetedContributions?: PluginUiTargetedContributionsV1 | null;
    targetPluginId?: string | null;
}>): Readonly<{
    targetedContributions: PluginUiTargetedContributionsV1 | null;
    hasPluginProjection: boolean;
    pluginProjectionById: Readonly<Record<string, PluginProjectionEntry>>;
    pluginUiProjection: PluginUiProjectionModel | null;
}> {
    const targetPluginId = typeof input.targetPluginId === 'string' && input.targetPluginId.length > 0
        ? input.targetPluginId
        : null;
    const targetedContributions = targetPluginId
        && input.targetedContributions?.target.pluginId === targetPluginId
        ? input.targetedContributions
        : null;
    const selectedPluginIds = new Set<string>();
    for (const point of targetedContributions?.points ?? []) {
        for (const protocol of point.protocols) {
            for (const contribution of protocol.contributions) {
                for (const operation of contribution.operations) {
                    selectedPluginIds.add(operation.action.pluginId);
                }
            }
        }
    }
    const pluginProjectionById: Record<string, PluginProjectionEntry> = {};
    for (const pluginId of [...selectedPluginIds].sort()) {
        const plugin = input.pluginProjectionById?.[pluginId];
        if (plugin) pluginProjectionById[pluginId] = plugin;
    }
    return Object.freeze({
        targetedContributions,
        hasPluginProjection: input.pluginProjectionById !== undefined && input.pluginProjectionById !== null,
        pluginProjectionById: Object.freeze(pluginProjectionById),
        pluginUiProjection: input.pluginUiProjection ?? null,
    });
}

/** A bounded semantic dependency for the controller that owns this selector. */
export function serializePluginActionInputSelectionFacts(input: Parameters<
    typeof projectPluginActionInputSelectionFacts
>[0]): string {
    return stableJsonStringify(projectPluginActionInputSelectionFacts(input));
}

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
    const serverId = typeof host.serverId === 'string' ? host.serverId.trim() : '';
    const accountServerId = typeof host.accountLifetime?.scope.serverId === 'string'
        ? host.accountLifetime.scope.serverId.trim()
        : '';
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

export type PluginNewSessionSeeder = (params: Readonly<{
    seed: unknown;
    /**
     * The plugin this mount belongs to. A seeded composer attachment is
     * qualified against it at the New Session composer's own mount, exactly as
     * a live `attachment.add` from the same plugin is.
     */
    pluginId: string | null;
    scope: ServerAccountScope | null;
    signal?: AbortSignal;
    isCurrent: () => boolean;
}>) => Promise<SessionNewSessionSeedOutcome>;

function newSessionSeedFailure(
    outcome: Exclude<SessionNewSessionSeedOutcome, Readonly<{ kind: 'seeded' }>>,
): PluginUiJsonValueV1 {
    if (outcome.kind === 'stale') return errorPayload('stale_surface', outcome.reason);
    return errorPayload(outcome.kind === 'invalid' ? 'invalid_payload' : 'unavailable', outcome.reason);
}

/** Narrows the nested Protocol discriminant without inventing a field-presence fallback. */
function isNewSessionSeedRequest(
    request: PluginUiSelectActionInputRequestV1,
): request is Extract<PluginUiSelectActionInputRequestV1, Readonly<{ hostAction: unknown }>> & Readonly<{ seed: unknown }> {
    return 'hostAction' in request && request.seed !== undefined;
}

async function seedDefaultNewSession(
    params: Parameters<PluginNewSessionSeeder>[0],
): Promise<SessionNewSessionSeedOutcome> {
    // Session-owned seeding and the app router are both loaded only after the
    // literal host request has passed its closed Protocol boundary, for the
    // same reason the draft modal is: neither may be reached by a contributed
    // Action, selector or dispatcher.
    try {
        const [{ seedAndOpenNewSession }, { router }] = await Promise.all([
            import('@/components/sessions/new/newSessionSeedComposer'),
            import('expo-router'),
        ]);
        return seedAndOpenNewSession({
            seed: params.seed,
            ...(params.pluginId === null ? {} : { pluginId: params.pluginId }),
            scope: params.scope,
            ...(params.signal ? { signal: params.signal } : {}),
            isCurrent: params.isCurrent,
            navigateToNewSession: (dataId) => {
                router.push({
                    pathname: '/new',
                    params: dataId === null ? {} : { dataId },
                });
            },
        });
    } catch {
        return { kind: 'unavailable', reason: 'navigation_unavailable' };
    }
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
            present: ({ seed }) => presentSessionServerStartDraftComposer({
                seed,
                target: params.target,
            }),
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
export function createPluginActionInputSelectionHostApiHandler(input: Readonly<{
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
    seedNewSession?: PluginNewSessionSeeder;
}>): PluginSurfaceHostApiMethodHandler {
    const present = input.present ?? presentActionInputForm;
    const selectionFacts = projectPluginActionInputSelectionFacts({
        pluginProjectionById: input.pluginProjectionById,
        pluginUiProjection: input.pluginUiProjection,
        targetedContributions: input.targetedContributions,
        targetPluginId: input.host.targetPluginId,
    });
    return async (request, options?: PluginSurfaceHostApiRequestOptions) => {
        if (request.method !== 'selectActionInput') {
            return errorPayload('unsupported_method', 'select_action_input_method_mismatch');
        }
        const parsed = PluginUiSelectActionInputRequestV1Schema.safeParse(request.payload);
        if (!parsed.success) return errorPayload('invalid_payload', 'select_action_input_request_invalid');
        const mergedSignal = mergeAbortSignals([input.host.signal, options?.signal]);
        const signal = mergedSignal.signal;
        try {
        const hostIsCurrent = () => input.isCurrent()
            && input.host.isCurrent?.() !== false
            && input.host.accountLifetime?.isCurrent() !== false;
        if (signal?.aborted || !hostIsCurrent()) {
            return errorPayload(hostIsCurrent() ? 'unavailable' : 'stale_surface', 'select_action_input_aborted');
        }

        if (isNewSessionSeedRequest(parsed.data)) {
            const seeder = input.seedNewSession ?? seedDefaultNewSession;
            const outcome = await seeder({
                seed: parsed.data.seed,
                pluginId: input.host.targetPluginId ?? null,
                scope: input.host.accountLifetime?.scope ?? null,
                ...(signal ? { signal } : {}),
                isCurrent: hostIsCurrent,
            });
            return outcome.kind === 'seeded'
                ? readBoundedSelectionResult({ kind: 'newSessionSeeded' })
                : newSessionSeedFailure(outcome);
        }

        if ('hostAction' in parsed.data) {
            const target = readSessionServerStartDraftTarget(input.host);
            if (!target) return errorPayload('unavailable', 'host_unavailable');
            const composer = input.composeSessionServerStartDraft ?? composeDefaultSessionServerStartDraft;
            const outcome = await composer({
                ...(parsed.data.draft === undefined ? {} : { draft: parsed.data.draft }),
                ...(signal ? { signal } : {}),
                isCurrent: hostIsCurrent,
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
        if (!input.isCurrent()) {
            selected.form.retire();
            return errorPayload('stale_surface', 'host_retired');
        }
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
                    input.isCurrent() ? 'unavailable' : 'stale_surface',
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
        } finally {
            mergedSignal.dispose();
        }
    };
}
