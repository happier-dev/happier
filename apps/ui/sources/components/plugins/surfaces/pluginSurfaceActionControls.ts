import { invokePluginUiActionBinding } from '@happier-dev/cli-common/plugins/ui';
import { mergeAbortSignals } from '@happier-dev/plugin-sdk/async';
import type { PluginUiActionBinding } from '@happier-dev/plugin-sdk/ui';
import {
    PluginUiActionControlRequestV1Schema,
    PluginUiActionControlExecutionV1Schema,
    type PluginUiActionControlEventV1,
    type PluginUiActionControlPresentationV1,
    type PluginUiActionControlPreparationV1,
    type PluginUiActionControlExecutionV1,
    type PluginUiMountedActionReferenceV1,
} from '@happier-dev/protocol/plugins/ui';
import { PluginInvocableActionIdSchema } from '@happier-dev/protocol/actions/actionSpecs';
import { ACTION_INVOKE_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import { DATABASE_EDITS_APPLY_ACTION_ID_V1, DATABASE_PLUGIN_ID_V1 } from '@happier-dev/protocol/actions/actionIdsDatabaseV1';
import { formatQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { normalizePluginUiMountedContributedActionReferenceV1, type PluginUiJsonValueV1 } from '@happier-dev/protocol/plugins/ui';
import { projectNativeJsonValueForTransport, sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { createPluginSurfaceHostApiError, type PluginSurfaceHostApiMethodHandler } from './createPluginSurfaceHostApi';
import type { PluginSurfaceHostActionBinding } from './pluginSurfaceActionDispatch';
import { randomUUID } from '@/platform/randomUUID';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

export type MountedPluginActionControl = Readonly<{
    id: string;
    contributedPluginId?: string;
    presentation: PluginUiActionControlPresentationV1;
    busy: boolean;
}>;

/**
 * Same-realm carrier correlation: the author's control object names the registered subscription, so
 * the host can draw its button where the author declared it. A placement grants nothing; only the
 * host button's physical press reaches `press`.
 */
const actionControlPlacements = new WeakMap<object, string>();

/** Recorded by the same-realm carrier when it returns a bound control to the author tree. */
export function recordPluginActionControlPlacement(control: object, subscriptionId: string): void {
    actionControlPlacements.set(control, subscriptionId);
}

export function readPluginActionControlPlacement(control: object): string | undefined {
    return actionControlPlacements.get(control);
}

/** Host-private presentation and gesture entry. Neither is part of the author Host API. */
export type PluginSurfaceActionControls = Readonly<{
    projectionScope?: ServerAccountScope;
    getSnapshot(): readonly MountedPluginActionControl[];
    /** The controls no author-tree placement draws: the mount's slot for framed carriers. */
    getSlotSnapshot(): readonly MountedPluginActionControl[];
    /** Draw a control at its declaration instead of the mount's slot, until the returned release. */
    placeInline(id: string): () => void;
    subscribe(listener: () => void): () => void;
    press(id: string, reviewedInput?: PluginUiJsonValueV1): Promise<void>;
    /** Private entry used only by host-created inline controls. */
    commit<Value>(binding: PluginUiActionBinding<Value>, value: Value, options?: Readonly<{ signal?: AbortSignal }>): Promise<unknown>;
    invalidatePreparations(): void;
    handleRequest: PluginSurfaceHostApiMethodHandler;
    dispose(): void;
}>;

function resolveMountedControlAction(pluginId: string, action: PluginUiMountedActionReferenceV1) {
    const hostId = typeof action === 'string' ? PluginInvocableActionIdSchema.safeParse(action) : null;
    const contributed = hostId?.success ? null : normalizePluginUiMountedContributedActionReferenceV1({
        callerPluginId: pluginId, action,
    });
    return { hostId, contributed };
}

type Binding = {
    action: ReturnType<typeof resolveMountedControlAction>;
    view: MountedPluginActionControl;
    publish(event: PluginUiActionControlEventV1): void;
    abort: AbortController;
    pending?: {
        requestId: string;
        isCurrent(): boolean;
        resolve(preparation: PluginUiActionControlPreparationV1 | null, signal?: AbortSignal): Promise<PluginUiActionControlExecutionV1 | null>;
    };
};

/**
 * One mounted presentation owner. Author requests can bind, update, or answer a
 * preparation; only the private physical control can create a pending gesture.
 * The existing Account/mount lifetime and canonical Action executor own effect
 * admission. A subscription id and request id correlate replies, never authority.
 */
export function createPluginSurfaceActionControls(input: Readonly<{
    pluginId: string;
    surfaceId: string;
    hostAction: PluginSurfaceHostActionBinding;
    projectionScope?: ServerAccountScope;
    signal: AbortSignal;
    isCurrent(): boolean;
    isActionAvailable?(): boolean;
    captureCurrentBinding(): () => boolean;
}>): PluginSurfaceActionControls {
    const controls = new Map<string, Binding>();
    const listeners = new Set<() => void>();
    const inline = new Map<string, number>();
    let snapshot: readonly MountedPluginActionControl[] = Object.freeze([]);
    let slotSnapshot: readonly MountedPluginActionControl[] = snapshot;
    const emptySnapshot: readonly MountedPluginActionControl[] = Object.freeze([]);
    let disposed = false;
    const current = () => !disposed && !input.signal.aborted && input.isCurrent();
    const publish = () => {
        snapshot = Object.freeze([...controls.values()].map(binding => binding.view));
        slotSnapshot = inline.size === 0 ? snapshot : Object.freeze(snapshot.filter(view => !inline.has(view.id)));
        for (const listener of listeners) listener();
    };
    const placeInline = (id: string) => {
        inline.set(id, (inline.get(id) ?? 0) + 1);
        publish();
        let released = false;
        return () => {
            if (released) return;
            released = true;
            const count = (inline.get(id) ?? 1) - 1;
            if (count > 0) inline.set(id, count);
            else inline.delete(id);
            if (!disposed) publish();
        };
    };
    const release = (id: string, binding: Binding) => {
        if (controls.get(id) !== binding) return;
        controls.delete(id);
        binding.abort.abort();
        binding.pending?.resolve(null);
        binding.pending = undefined;
        publish();
    };
    const live = (id: string, binding: Binding) => current()
        && !binding.abort.signal.aborted && controls.get(id) === binding;
    const invalidatePreparation = (binding: Binding) => {
        const pending = binding.pending;
        if (!pending) return;
        binding.pending = undefined;
        pending.resolve(null);
        binding.publish({ kind: 'settled', requestId: pending.requestId,
            execution: { ok: false, errorCode: 'stale_surface', error: 'stale_surface' } });
    };
    const handleRequest: PluginSurfaceHostApiMethodHandler = (request, options) => {
        const parsed = PluginUiActionControlRequestV1Schema.safeParse(request.payload);
        if (!parsed.success) return createPluginSurfaceHostApiError('invalid_payload');
        if (!current() || options?.signal?.aborted) return createPluginSurfaceHostApiError('stale_surface');
        const payload = parsed.data;
        if (payload.kind === 'bind') {
            const subscription = options?.actionControlSubscription;
            if (!subscription || controls.has(payload.subscriptionId)) return createPluginSurfaceHostApiError('unavailable');
            const action = resolveMountedControlAction(input.pluginId, payload.action);
            const binding: Binding = { action, publish: subscription.publish,
                abort: new AbortController(),
                view: Object.freeze({ id: payload.subscriptionId, presentation: payload.presentation, busy: false,
                    ...(action.contributed ? { contributedPluginId: action.contributed.pluginId } : {}) }) };
            controls.set(payload.subscriptionId, binding);
            subscription.retain(() => release(payload.subscriptionId, binding));
            publish();
            return null;
        }
        const binding = controls.get(payload.subscriptionId);
        if (!binding || !live(payload.subscriptionId, binding)) return createPluginSurfaceHostApiError('stale_surface');
        if (payload.kind === 'update') {
            const previous = binding.view.presentation;
            if (previous.title !== payload.presentation.title || previous.accessibilityLabel !== payload.presentation.accessibilityLabel
                || previous.disabled !== payload.presentation.disabled
                || previous.variant !== payload.presentation.variant) {
                binding.view = Object.freeze({ ...binding.view, presentation: payload.presentation });
                publish();
            }
            return null;
        }
        const pending = binding.pending;
        if (!pending || pending.requestId !== payload.requestId) return createPluginSurfaceHostApiError('invalid_payload');
        if (!pending.isCurrent()) {
            invalidatePreparation(binding);
            return createPluginSurfaceHostApiError('stale_surface');
        }
        // Consume before resolving: a duplicate reply cannot be applied to this
        // invocation or a later physical press, even while execution is pending.
        binding.pending = undefined;
        return pending.resolve(payload.preparation, options?.signal);
    };

    // The one person-admission path, shared by slot buttons and host inline editors.
    const execute = async ({ hostId, contributed }: Binding['action'], preparation: PluginUiActionControlPreparationV1,
        signal: AbortSignal, requestId: string, reviewedInput?: PluginUiJsonValueV1): Promise<PluginUiActionControlExecutionV1> => {
        let execution: PluginUiActionControlExecutionV1;
        if (!hostId?.success && !contributed) execution = { ok: false, errorCode: 'invalid_action', error: 'invalid_action' };
        else {
            const context = { ...input.hostAction.context, signal, actionRequestId: requestId,
                surface: 'ui' as const, authority: 'present_user' as const, actionCaller: { kind: 'host' as const },
                bypassApprovals: false };
            // Only the built-in Database Workbench review presents the exact
            // staged transaction for this supported mounted confirmation.
            const isReview = reviewedInput !== undefined && input.pluginId === DATABASE_PLUGIN_ID_V1 && contributed !== null
                && formatQualifiedPluginActionId(contributed) === DATABASE_EDITS_APPLY_ACTION_ID_V1;
            if (isReview && !sameStrictJsonValue(reviewedInput, preparation.input)) {
                return { ok: false, errorCode: 'approval_stale', error: 'approval_stale', effectAttempted: false };
            }
            const dispatch = isReview ? input.hostAction.execute.confirmed : input.hostAction.execute;
            if (!dispatch) {
                return { ok: false, errorCode: 'action_interactive_review_required', error: 'action_interactive_review_required', effectAttempted: false };
            }
            const result = await dispatch(hostId?.success ? hostId.data : ACTION_INVOKE_ACTION_ID_V1,
                hostId?.success ? preparation.input : { action: contributed!, ...(preparation.input === undefined ? {} : { input: preparation.input }) }, context);
            execution = PluginUiActionControlExecutionV1Schema.parse(projectNativeJsonValueForTransport(result));
        }
        return execution;
    };
    const commit = <Value>(binding: PluginUiActionBinding<Value>, value: Value,
        options?: Readonly<{ signal?: AbortSignal }>): Promise<unknown> => invokePluginUiActionBinding(binding, value, {
        signal: input.signal, preparationSignal: options?.signal,
        available: input.isActionAvailable?.() !== false, isCurrent: current,
        captureCurrentBinding: input.captureCurrentBinding,
        execute: (action, preparation, signal) => execute(resolveMountedControlAction(input.pluginId, action), preparation, signal, randomUUID()),
    });
    const press = async (id: string, reviewedInput?: PluginUiJsonValueV1): Promise<void> => {
        const binding = controls.get(id);
        if (input.isActionAvailable?.() === false || !binding || !live(id, binding) || binding.view.busy || binding.view.presentation.disabled) return;
        const requestId = randomUUID();
        // Optional Machine admission can change without replacing the mounted
        // Account control. Bind authority to this preparation, not its lifetime.
        const isCurrentBinding = input.captureCurrentBinding();
        binding.view = Object.freeze({ ...binding.view, busy: true });
        publish();
        let executionSignal = input.signal;
        let releaseExecutionSignal = () => {};
        let complete!: (execution: PluginUiActionControlExecutionV1 | null) => void;
        const completion = new Promise<PluginUiActionControlExecutionV1 | null>(resolve => { complete = resolve; });
        try {
            const reviewed = reviewedInput === undefined ? undefined : projectNativeJsonValueForTransport(reviewedInput);
            const preparation = await new Promise<PluginUiActionControlPreparationV1 | null>(resolve => {
                binding.pending = { requestId, isCurrent: isCurrentBinding, resolve: (preparation, signal) => {
                    const merged = mergeAbortSignals([input.signal, signal]);
                    executionSignal = merged.signal;
                    releaseExecutionSignal = merged.dispose;
                    resolve(preparation);
                    return completion;
                } };
                binding.publish({ kind: 'prepare', requestId });
            });
            if (!preparation || !live(id, binding)) return;
            if (!isCurrentBinding()) {
                binding.publish({ kind: 'settled', requestId,
                    execution: { ok: false, errorCode: 'stale_surface', error: 'stale_surface' } });
                return;
            }
            const execution = await execute(binding.action, preparation, executionSignal, requestId, reviewed);
            complete(execution);
            if (live(id, binding)) binding.publish({ kind: 'settled', requestId, execution });
        } catch (error) {
            // An exception after dispatch does not establish that no effect ran.
            // Preserve a typed producer code; an untyped lost receipt is unknown.
            const code = error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined;
            const execution: PluginUiActionControlExecutionV1 = { ok: false,
                errorCode: typeof code === 'string' ? code : 'action_outcome_unknown',
                error: typeof code === 'string' ? code : 'action_outcome_unknown' };
            complete(execution);
            if (live(id, binding)) binding.publish({ kind: 'settled', requestId, execution });
        } finally {
            releaseExecutionSignal();
            complete(null);
            if (controls.get(id) === binding) {
                binding.pending = undefined;
                binding.view = Object.freeze({ ...binding.view, busy: false });
                publish();
            }
        }
    };
    const dispose = () => {
        if (disposed) return;
        disposed = true;
        input.signal.removeEventListener('abort', dispose);
        for (const [id, binding] of controls) release(id, binding);
        listeners.clear();
    };
    input.signal.addEventListener('abort', dispose, { once: true });
    return Object.freeze({ projectionScope: input.projectionScope,
        getSnapshot: () => input.isActionAvailable?.() === false ? emptySnapshot : snapshot,
        getSlotSnapshot: () => input.isActionAvailable?.() === false ? emptySnapshot : slotSnapshot, placeInline, subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
    }, handleRequest, press, commit, invalidatePreparations: () => {
        for (const binding of controls.values()) invalidatePreparation(binding);
    }, dispose });
}
