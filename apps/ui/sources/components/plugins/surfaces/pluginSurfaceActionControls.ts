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
import { normalizePluginUiMountedContributedActionReferenceV1 } from '@happier-dev/protocol/plugins/ui';
import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';
import { createPluginSurfaceHostApiError, type PluginSurfaceHostApiMethodHandler } from './createPluginSurfaceHostApi';
import type { PluginSurfaceHostActionBinding } from './pluginSurfaceActionDispatch';

export type MountedPluginActionControl = Readonly<{
    id: string;
    presentation: PluginUiActionControlPresentationV1;
    busy: boolean;
}>;

/** Host-private presentation and gesture entry. Neither is part of the author Host API. */
export type PluginSurfaceActionControls = Readonly<{
    getSnapshot(): readonly MountedPluginActionControl[];
    subscribe(listener: () => void): () => void;
    press(id: string): Promise<void>;
    invalidatePreparations(): void;
    handleRequest: PluginSurfaceHostApiMethodHandler;
    dispose(): void;
}>;

type Binding = {
    action: PluginUiMountedActionReferenceV1;
    view: MountedPluginActionControl;
    publish(event: PluginUiActionControlEventV1): void;
    abort: AbortController;
    pending?: {
        requestId: string;
        isCurrent(): boolean;
        resolve(preparation: PluginUiActionControlPreparationV1 | null): void;
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
    signal: AbortSignal;
    isCurrent(): boolean;
    captureCurrentBinding(): () => boolean;
}>): PluginSurfaceActionControls {
    const controls = new Map<string, Binding>();
    const listeners = new Set<() => void>();
    let snapshot: readonly MountedPluginActionControl[] = Object.freeze([]);
    let sequence = 0;
    let disposed = false;
    const current = () => !disposed && !input.signal.aborted && input.isCurrent();
    const publish = () => {
        snapshot = Object.freeze([...controls.values()].map(binding => binding.view));
        for (const listener of listeners) listener();
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
            const binding: Binding = { action: payload.action, publish: subscription.publish,
                abort: new AbortController(),
                view: Object.freeze({ id: payload.subscriptionId, presentation: payload.presentation, busy: false }) };
            controls.set(payload.subscriptionId, binding);
            subscription.retain(() => release(payload.subscriptionId, binding));
            publish();
            return null;
        }
        const binding = controls.get(payload.subscriptionId);
        if (!binding || !live(payload.subscriptionId, binding)) return createPluginSurfaceHostApiError('stale_surface');
        if (payload.kind === 'update') {
            const previous = binding.view.presentation;
            if (previous.title !== payload.presentation.title || previous.disabled !== payload.presentation.disabled
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
        pending.resolve(payload.preparation);
        return null;
    };

    const press = async (id: string): Promise<void> => {
        const binding = controls.get(id);
        if (!binding || !live(id, binding) || binding.view.busy || binding.view.presentation.disabled) return;
        const requestId = `${input.surfaceId}:actionControl:${++sequence}`;
        // Optional Machine admission can change without replacing the mounted
        // Account control. Bind authority to this preparation, not its lifetime.
        const isCurrentBinding = input.captureCurrentBinding();
        binding.view = Object.freeze({ ...binding.view, busy: true });
        publish();
        try {
            const preparation = await new Promise<PluginUiActionControlPreparationV1 | null>(resolve => {
                binding.pending = { requestId, isCurrent: isCurrentBinding, resolve };
                binding.publish({ kind: 'prepare', requestId });
            });
            if (!preparation || !live(id, binding)) return;
            if (!isCurrentBinding()) {
                binding.publish({ kind: 'settled', requestId,
                    execution: { ok: false, errorCode: 'stale_surface', error: 'stale_surface' } });
                return;
            }
            const hostId = typeof binding.action === 'string' ? PluginInvocableActionIdSchema.safeParse(binding.action) : null;
            const contributed = hostId?.success ? null : normalizePluginUiMountedContributedActionReferenceV1({
                callerPluginId: input.pluginId, action: binding.action,
            });
            let execution: PluginUiActionControlExecutionV1;
            if (!hostId?.success && !contributed) execution = { ok: false, errorCode: 'invalid_action', error: 'invalid_action' };
            else {
                const context = { ...input.hostAction.context, signal: binding.abort.signal, actionRequestId: requestId,
                    surface: 'ui' as const, authority: 'present_user' as const, actionCaller: { kind: 'host' as const },
                    bypassApprovals: false };
                const result = await input.hostAction.execute(hostId?.success ? hostId.data : 'action.invoke',
                    hostId?.success ? preparation.input : { action: contributed!, ...(preparation.input === undefined ? {} : { input: preparation.input }) }, context);
                execution = PluginUiActionControlExecutionV1Schema.parse(projectNativeJsonValueForTransport(result));
            }
            if (live(id, binding)) binding.publish({ kind: 'settled', requestId, execution });
        } catch (error) {
            // An exception after dispatch does not establish that no effect ran.
            // Preserve a typed producer code; an untyped lost receipt is unknown.
            const code = error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined;
            if (live(id, binding)) binding.publish({ kind: 'settled', requestId,
                execution: { ok: false, errorCode: typeof code === 'string' ? code : 'action_outcome_unknown',
                    error: typeof code === 'string' ? code : 'action_outcome_unknown' } });
        } finally {
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
    return Object.freeze({ getSnapshot: () => snapshot, subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
    }, handleRequest, press, invalidatePreparations: () => {
        for (const binding of controls.values()) invalidatePreparation(binding);
    }, dispose });
}
