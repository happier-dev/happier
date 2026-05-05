import type {
    PluginAuthChangeListenerV1,
    PluginAuthIdentityV1,
    PluginAuthMaterializedServiceV1,
    PluginAuthMaterializeRequestV1,
    PluginAuthServiceV1,
    SubscriptionV1,
} from '@happier-dev/plugin-sdk';

export type CreatePluginAuthServiceParams = Readonly<{
    getIdentity?: () => Promise<PluginAuthIdentityV1 | null>;
    materialize?: (request: PluginAuthMaterializeRequestV1) => Promise<PluginAuthMaterializedServiceV1 | null>;
    subscribe?: (listener: PluginAuthChangeListenerV1) => SubscriptionV1;
}>;

export function createPluginAuthService(params: CreatePluginAuthServiceParams = {}): PluginAuthServiceV1 {
    return Object.freeze({
        getIdentity: async () => await (params.getIdentity?.() ?? null),
        onChange: (listener: PluginAuthChangeListenerV1): SubscriptionV1 => (
            params.subscribe?.(listener) ?? Object.freeze({ unsubscribe: () => undefined })
        ),
        services: Object.freeze({
            materialize: async (request: PluginAuthMaterializeRequestV1) => (
                await (params.materialize?.(request) ?? null)
            ),
        }),
    });
}
