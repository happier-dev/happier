import { Modal } from '@/modal';
import { t } from '@/text';

import { presentActionInputForm } from './presentActionInputForm';
import type {
    PluginContributedActionController,
    PluginContributedActionDescriptor,
    PluginContributedActionOpenOutcome,
} from './pluginContributedActionController';

async function presentPluginContributedActionOpen(
    open: () => Promise<PluginContributedActionOpenOutcome>,
    signal: AbortSignal | undefined,
    showUnavailableFeedback = true,
): Promise<PluginContributedActionOpenOutcome> {
    if (signal?.aborted) return { kind: 'stale', reason: 'host_retired' };
    try {
        const opened = await open();
        // The controller returns `direct` only after canonical Action dispatch
        // has settled. A later presentation retirement must not relabel that
        // known effect as stale, because consumers can otherwise retry it.
        if (opened.kind === 'direct') {
            if (showUnavailableFeedback && !opened.outcome.ok && !signal?.aborted) {
                Modal.alert(t('common.error'), t('pluginRuntime.unavailableGeneric'));
            }
            return opened;
        }
        if (signal?.aborted) return { kind: 'stale', reason: 'host_retired' };
        if (opened.kind === 'form') {
            presentActionInputForm({ form: opened.form, signal });
            return opened;
        }
        if (showUnavailableFeedback && (
            opened.kind === 'stale'
            || opened.kind === 'unavailable'
        )) {
            Modal.alert(t('common.error'), t('pluginRuntime.unavailableGeneric'));
        }
        return opened;
    } catch {
        if (signal?.aborted) return { kind: 'stale', reason: 'host_retired' };
        if (showUnavailableFeedback) {
            Modal.alert(t('common.error'), t('pluginRuntime.unavailableGeneric'));
        }
        return { kind: 'unavailable', reason: 'host_unavailable' };
    }
}

/**
 * Presents an already-admitted Action through the controller-owned form and
 * dispatch path. It intentionally owns no Action catalog, retry policy, or
 * transport behavior; failures retain the incumbent generic host feedback.
 */
export async function openPluginContributedAction(params: Readonly<{
    controller: PluginContributedActionController;
    action: PluginContributedActionDescriptor;
    signal?: AbortSignal;
}>): Promise<PluginContributedActionOpenOutcome> {
    return await presentPluginContributedActionOpen(
        () => params.controller.open(params.action),
        params.signal,
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
}>): Promise<PluginContributedActionOpenOutcome> {
    return await presentPluginContributedActionOpen(
        () => params.controller.openSessionReference(params.action, params.input),
        params.signal,
        params.showUnavailableFeedback !== false,
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
    input: unknown;
    signal?: AbortSignal;
}>): Promise<void> {
    if (params.signal?.aborted) return;

    try {
        const outcome = await params.controller.invokeReference(params.action, params.input);
        if (params.signal?.aborted) return;
        if (outcome.kind === 'settled' && !outcome.outcome.ok) {
            Modal.alert(t('common.error'), t('pluginRuntime.unavailableGeneric'));
        }
    } catch {
        if (!params.signal?.aborted) {
            Modal.alert(t('common.error'), t('pluginRuntime.unavailableGeneric'));
        }
    }
}
