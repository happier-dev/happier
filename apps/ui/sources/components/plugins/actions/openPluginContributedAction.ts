import { Modal } from '@/modal';
import { formatQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import type { PopoverAnchor } from '@/components/ui/popover';

import { t } from '@/text';
import { resolveReasonCopy } from '@/sync/domains/surfaces/copy/resolveReasonCopy';
import { alertActionFailure } from '@/utils/errors/alertActionFailure';
import { presentActionExecutionFailure } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import type { PluginSurfaceActionDispatchOutcome } from '../surfaces/actionFailure';

import { presentActionInputForm } from './presentActionInputForm';
import type {
    PluginContributedActionController,
    PluginContributedActionDescriptor,
    PluginContributedActionOpenOutcome,
} from './pluginContributedActionController';

function presentPluginActionFailure(kind: 'failed' | 'stale' | 'unavailable' | 'thrown', reasonCode?: string,
    failure?: Extract<PluginSurfaceActionDispatchOutcome, { ok: false }>,
    executionTarget?: PluginContributedActionDescriptor['executionTarget']): void {
    const message = reasonCode ? resolveReasonCopy({ kind: 'pluginRuntime', reasonCode, executionTarget }).body
        : kind === 'failed' ? t('pluginRuntime.actionFailed')
        : kind === 'stale' ? t('pluginRuntime.actionStale')
            : kind === 'unavailable' ? t('pluginRuntime.actionUnavailable')
                : t('pluginRuntime.actionOpenFailed');
    if (failure) {
        const details = typeof failure.details === 'object' && failure.details !== null
            ? failure.details as Readonly<Record<string, unknown>> : null;
        const presentation = presentActionExecutionFailure({ ...failure, errorCode: failure.code }, message);
        alertActionFailure({
            reason: presentation.reason,
            code: failure.code,
            requestId: failure.requestId ?? (typeof details?.requestId === 'string' ? details.requestId : undefined),
            context: Object.fromEntries(presentation.technicalDetails.filter(line => line.key !== 'code' && line.key !== 'requestId')
                .map(line => [line.key, line.value])),
        });
        return;
    }
    Modal.alert(t('common.error'), message);
}

async function presentPluginContributedActionOpen(
    open: () => Promise<PluginContributedActionOpenOutcome>,
    signal: AbortSignal | undefined,
    showUnavailableFeedback = true,
    anchor?: PopoverAnchor,
): Promise<PluginContributedActionOpenOutcome> {
    if (signal?.aborted) return { kind: 'stale', reason: 'host_retired' };
    try {
        const opened = await open();
        // The controller returns `direct` only after canonical Action dispatch
        // has settled. A later presentation retirement must not relabel that
        // known effect as stale, because consumers can otherwise retry it.
        if (opened.kind === 'direct') {
            if (showUnavailableFeedback && !opened.outcome.ok && !signal?.aborted) {
                presentPluginActionFailure('failed', opened.outcome.layer ? opened.outcome.code : undefined, opened.outcome,
                    opened.action.executionTarget);
            }
            return opened;
        }
        if (signal?.aborted) return { kind: 'stale', reason: 'host_retired' };
        if (opened.kind === 'form') {
            presentActionInputForm({ form: opened.form, signal, pickerContext: opened.form.pickerContext,
                actionId: formatQualifiedPluginActionId(opened.form.action.identity), anchor });
            return opened;
        }
        if (showUnavailableFeedback && (
            opened.kind === 'stale'
            || opened.kind === 'unavailable'
        )) {
            presentPluginActionFailure(opened.kind);
        }
        return opened;
    } catch {
        if (signal?.aborted) return { kind: 'stale', reason: 'host_retired' };
        if (showUnavailableFeedback) {
            presentPluginActionFailure('thrown');
        }
        return { kind: 'unavailable', reason: 'host_unavailable' };
    }
}

/**
 * Presents an already-admitted Action through the controller-owned form and
 * dispatch path. It intentionally owns no Action catalog, retry policy, or
 * transport behavior; typed failures share the host's single feedback presenter.
 */
export async function openPluginContributedAction(params: Readonly<{
    controller: PluginContributedActionController;
    action: PluginContributedActionDescriptor;
    signal?: AbortSignal;
    anchor?: PopoverAnchor;
}>): Promise<PluginContributedActionOpenOutcome> {
    return await presentPluginContributedActionOpen(
        () => params.controller.open(params.action, params.anchor),
        params.signal,
        true,
        params.anchor,
    );
}

/**
 * Runs one current session-scoped Action through the controller's
 * session-reference admission. The helper shares the catalog action's form,
 * stale, and generic host-feedback handling rather than creating a second
 * command executor in a Session consumer.
 */
export async function openPluginContributedActionSessionReference(params: Readonly<{
    controller: PluginContributedActionController;
    action: Readonly<{ pluginId: string; localId: string }>;
    input?: unknown;
    signal?: AbortSignal;
    /** Callers with their own unavailable state can suppress generic feedback. */
    showUnavailableFeedback?: boolean;
    anchor?: PopoverAnchor;
}>): Promise<PluginContributedActionOpenOutcome> {
    return await presentPluginContributedActionOpen(
        () => params.controller.openSessionReference(params.action, params.input, params.anchor),
        params.signal,
        params.showUnavailableFeedback !== false,
        params.anchor,
    );
}

/**
 * Opens an immutable presentation Action whose input was already admitted with
 * the historical record. Unlike a catalog control, it never reconstructs a
 * form from a current declaration; it asks the shared controller to recheck
 * the exact current reference and dispatch the snapshot input as-is.
 */
export async function openPluginContributedActionReference(params: Readonly<{
    controller: PluginContributedActionController;
    action: Readonly<{ pluginId: string; localId: string }>;
    input?: unknown;
    signal?: AbortSignal;
}>): Promise<void> {
    if (params.signal?.aborted) return;

    try {
        const outcome = await params.controller.invokeReference(params.action, params.input);
        if (params.signal?.aborted) return;
        if (outcome.kind === 'settled' && !outcome.outcome.ok) {
            presentPluginActionFailure('failed', outcome.outcome.layer ? outcome.outcome.code : undefined, outcome.outcome);
        }
    } catch {
        if (!params.signal?.aborted) {
            presentPluginActionFailure('thrown');
        }
    }
}
