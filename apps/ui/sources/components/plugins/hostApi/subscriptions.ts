import {
    PluginUiResourceSubscriptionEventV1Schema,
    type PluginUiResourceSubscriptionEventV1,
    type PluginUiSurfaceContextV1,
} from '@happier-dev/protocol/plugins/ui';

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
}> = {}) {
    const activeSubscriptionKeys = new Map<string, Readonly<{ surface: PluginUiSurfaceContextV1; release?: () => void; deliverValue?: (value: unknown) => void }>>();

    function createSubscriptionKey(
        surface: PluginUiSurfaceContextV1,
        subscriptionId: string,
    ): string {
        return `${createSurfaceKey(surface)}\u001f${subscriptionId}`;
    }

    function register(input: Readonly<{
        surface: PluginUiSurfaceContextV1;
        subscriptionId: string;
        release?: () => void;
        deliverValue?: (value: unknown) => void;
    }>): void {
        const key = createSubscriptionKey(input.surface, input.subscriptionId);
        activeSubscriptionKeys.set(key, input);
    }

    function dispose(input: Readonly<{
        surface: PluginUiSurfaceContextV1;
        subscriptionId: string;
    }>): boolean {
        const key = createSubscriptionKey(input.surface, input.subscriptionId);
        const previous = activeSubscriptionKeys.get(key);
        const hadActiveSubscription = activeSubscriptionKeys.delete(key);
        previous?.release?.();
        return hadActiveSubscription;
    }

    function publishKnown(
        surface: PluginUiSurfaceContextV1,
        subscriptionId: string,
        value: unknown,
    ): boolean {
        const key = createSubscriptionKey(surface, subscriptionId);
        if (!activeSubscriptionKeys.has(key)) {
            return false;
        }

        activeSubscriptionKeys.get(key)?.deliverValue?.(value);
        options.deliverSubscriptionValue?.({ subscriptionId, value });
        return true;
    }

    function publish(
        surface: PluginUiSurfaceContextV1,
        event: unknown,
    ): boolean {
        const parsed = PluginUiResourceSubscriptionEventV1Schema.safeParse(event);
        if (!parsed.success) {
            return false;
        }

        const subscriptionEvent = parsed.data;
        const published = publishKnown(surface, subscriptionEvent.subscriptionId, subscriptionEvent);
        if (!published) return false;

        options.deliverSubscriptionEvent?.(subscriptionEvent);
        if (subscriptionEvent.kind === 'complete' || subscriptionEvent.kind === 'error') {
            const key = createSubscriptionKey(surface, subscriptionEvent.subscriptionId);
            activeSubscriptionKeys.delete(key);
        }
        return true;
    }

    function publishValue(
        surface: PluginUiSurfaceContextV1,
        input: Readonly<{ subscriptionId: string; value: unknown }>,
    ): boolean {
        const subscriptionId = input.subscriptionId.trim();
        if (!subscriptionId) {
            return false;
        }
        return publishKnown(surface, subscriptionId, input.value);
    }

    function disposeSurface(surface: PluginUiSurfaceContextV1): void {
        const surfaceKey = createSurfaceKey(surface);
        for (const key of [...activeSubscriptionKeys.keys()]) {
            if (key.startsWith(`${surfaceKey}\u001f`)) {
                const previous = activeSubscriptionKeys.get(key);
                activeSubscriptionKeys.delete(key);
                previous?.release?.();
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
