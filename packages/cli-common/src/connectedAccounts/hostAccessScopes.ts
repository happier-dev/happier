import { createPluginContributionIdentity } from '@happier-dev/protocol/plugins/contribution-identity';
import type {
    ConnectedAccountPurposeDeclarationV1,
    PluginContributionIdentityV1,
    PluginHostAccessRequestV2,
} from '@happier-dev/protocol';

type ConnectedAccountHostAccessRequest = Extract<PluginHostAccessRequestV2, { capability: 'connectedAccounts' }>;

export type ConnectedAccountHostAccessScope = Readonly<{
    purpose: string;
    serviceRefs: readonly PluginContributionIdentityV1[];
    operations: Readonly<ConnectedAccountHostAccessRequest['scope']['operations']>;
    materializationKinds?: Readonly<NonNullable<ConnectedAccountHostAccessRequest['scope']['materializationKinds']>>;
}>;

export function qualifyHostAccessContributionReference(
    ownerPluginId: string,
    reference: ConnectedAccountPurposeDeclarationV1['service'],
): PluginContributionIdentityV1 {
    return Object.freeze(createPluginContributionIdentity(typeof reference === 'string'
        ? { pluginId: ownerPluginId, localId: reference }
        : reference));
}

/** Project admitted declaration metadata; selection and permission remain with their owners. */
export function projectConnectedAccountHostAccessScopes(
    ownerPluginId: string,
    requests: readonly Readonly<{ request: PluginHostAccessRequestV2 }>[],
): readonly ConnectedAccountHostAccessScope[] {
    return Object.freeze(requests.flatMap(({ request }) => (
        request.capability === 'connectedAccounts' ? [Object.freeze({
            purpose: request.id,
            serviceRefs: Object.freeze(request.scope.serviceRefs.map(reference =>
                qualifyHostAccessContributionReference(ownerPluginId, reference))),
            operations: Object.freeze([...request.scope.operations]),
            ...(request.scope.materializationKinds === undefined ? {} : {
                materializationKinds: Object.freeze([...request.scope.materializationKinds]),
            }),
        })] : []
    )));
}
