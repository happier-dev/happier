import {
    PluginUiResourceSubscriptionEventV1Schema,
    type PluginUiResourceSubscriptionEventV1,
    type PluginUiSurfaceContextV1,
} from '@happier-dev/protocol/plugins/ui';

export type PluginUiHostSubscriptionAuditEvent =
    | Readonly<{
        type: 'subscriptionRegistered';
        subscriptionId: string;
        surface: PluginUiSurfaceContextV1;
    }>
    | Readonly<{
        type: 'subscriptionDisposed';
        subscriptionId: string;
        surface: PluginUiSurfaceContextV1;
    }>
    | Readonly<{
        type: 'subscriptionEventDelivered';
        subscriptionId: string;
        surface: PluginUiSurfaceContextV1;
    }>
    | Readonly<{
        type: 'subscriptionEventSuppressed';
        subscriptionId: string;
        surface: PluginUiSurfaceContextV1;
        reason: 'disposed' | 'unknown' | 'invalid_event';
    }>;

function createSurfaceKey(surface: PluginUiSurfaceContextV1): string {
    return [
        surface.pluginId,
        surface.contributionId,
        surface.surfaceId,
        surface.sessionId ?? '',
    ].join('\u001f');
}

export function createPluginUiHostSubscriptionRegistry(options: Readonly<{
    deliverSubscriptionEvent?: (event: PluginUiResourceSubscriptionEventV1) => void;
    /**
     * Composer snapshots use the same acknowledged subscription lifecycle but
     * are snapshots rather than Resource invalidation envelopes. The mounted
     * transport remains the schema owner for this value.
     */
    deliverSubscriptionValue?: (input: Readonly<{
        subscriptionId: string;
        value: unknown;
    }>) => void;
    audit?: (event: PluginUiHostSubscriptionAuditEvent) => void;
}> = {}) {
    const activeSubscriptionKeys = new Map<string, PluginUiSurfaceContextV1>();
    const disposedSubscriptionKeys = new Set<string>();

    function createSubscriptionKey(
        surface: PluginUiSurfaceContextV1,
        subscriptionId: string,
    ): string {
        return `${createSurfaceKey(surface)}\u001f${subscriptionId}`;
    }

    function register(input: Readonly<{
        surface: PluginUiSurfaceContextV1;
        subscriptionId: string;
    }>): void {
        const key = createSubscriptionKey(input.surface, input.subscriptionId);
        activeSubscriptionKeys.set(key, input.surface);
        disposedSubscriptionKeys.delete(key);
        options.audit?.({
            type: 'subscriptionRegistered',
            subscriptionId: input.subscriptionId,
            surface: input.surface,
        });
    }

    function dispose(input: Readonly<{
        surface: PluginUiSurfaceContextV1;
        subscriptionId: string;
    }>): boolean {
        const key = createSubscriptionKey(input.surface, input.subscriptionId);
        const hadActiveSubscription = activeSubscriptionKeys.delete(key);
        disposedSubscriptionKeys.add(key);
        options.audit?.({
            type: 'subscriptionDisposed',
            subscriptionId: input.subscriptionId,
            surface: input.surface,
        });
        return hadActiveSubscription;
    }

    function publishKnown(
        surface: PluginUiSurfaceContextV1,
        subscriptionId: string,
        value: unknown,
    ): boolean {
        const key = createSubscriptionKey(surface, subscriptionId);
        if (!activeSubscriptionKeys.has(key)) {
            options.audit?.({
                type: 'subscriptionEventSuppressed',
                subscriptionId,
                surface,
                reason: disposedSubscriptionKeys.has(key) ? 'disposed' : 'unknown',
            });
            return false;
        }

        options.deliverSubscriptionValue?.({ subscriptionId, value });
        options.audit?.({
            type: 'subscriptionEventDelivered',
            subscriptionId,
            surface,
        });
        return true;
    }

    function publish(
        surface: PluginUiSurfaceContextV1,
        event: unknown,
    ): boolean {
        const parsed = PluginUiResourceSubscriptionEventV1Schema.safeParse(event);
        if (!parsed.success) {
            options.audit?.({
                type: 'subscriptionEventSuppressed',
                subscriptionId: '',
                surface,
                reason: 'invalid_event',
            });
            return false;
        }

        const subscriptionEvent = parsed.data;
        const published = publishKnown(surface, subscriptionEvent.subscriptionId, subscriptionEvent);
        if (!published) return false;

        options.deliverSubscriptionEvent?.(subscriptionEvent);
        if (subscriptionEvent.kind === 'complete' || subscriptionEvent.kind === 'error') {
            const key = createSubscriptionKey(surface, subscriptionEvent.subscriptionId);
            activeSubscriptionKeys.delete(key);
            disposedSubscriptionKeys.add(key);
        }
        return true;
    }

    function publishValue(
        surface: PluginUiSurfaceContextV1,
        input: Readonly<{ subscriptionId: string; value: unknown }>,
    ): boolean {
        const subscriptionId = input.subscriptionId.trim();
        if (!subscriptionId) {
            options.audit?.({
                type: 'subscriptionEventSuppressed',
                subscriptionId: '',
                surface,
                reason: 'invalid_event',
            });
            return false;
        }
        return publishKnown(surface, subscriptionId, input.value);
    }

    function disposeSurface(surface: PluginUiSurfaceContextV1): void {
        const surfaceKey = createSurfaceKey(surface);
        for (const key of [...activeSubscriptionKeys.keys()]) {
            if (key.startsWith(`${surfaceKey}\u001f`)) {
                activeSubscriptionKeys.delete(key);
                disposedSubscriptionKeys.add(key);
            }
        }
    }

    return Object.freeze({
        register,
        dispose,
        publish,
        publishValue,
        disposeSurface,
    });
}
