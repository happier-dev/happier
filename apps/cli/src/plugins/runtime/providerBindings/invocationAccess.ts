import {
    AgentProviderRequirementsV1Schema,
    type PluginHostAccessRequestV2,
} from '@happier-dev/protocol';

export function composeProviderBindingProcessAccess(params: Readonly<{
    requests: readonly PluginHostAccessRequestV2[];
    providerRequirements: unknown;
    environment?: Readonly<Record<string, string>>;
    providerBindingActive: boolean;
}>): readonly PluginHostAccessRequestV2[] {
    if (!params.providerBindingActive) return params.requests;

    const support = AgentProviderRequirementsV1Schema.parse(params.providerRequirements);
    const activeOwnedEnvKeys = support.authIsolation.ownedEnvKeys.filter((key) => (
        params.environment !== undefined
        && Object.prototype.hasOwnProperty.call(params.environment, key)
    ));
    if (activeOwnedEnvKeys.length === 0) return params.requests;

    let foundProcessAccess = false;
    const requests = params.requests.map((request) => {
        if (request.capability !== 'process') return request;
        foundProcessAccess = true;
        return Object.freeze({
            ...request,
            scope: Object.freeze({
                ...request.scope,
                envKeys: [
                    ...new Set([
                        ...(request.scope.envKeys ?? []),
                        ...activeOwnedEnvKeys,
                    ]),
                ],
            }),
        });
    });
    if (!foundProcessAccess) {
        throw new Error('An active Provider binding requires declared process access');
    }
    return Object.freeze(requests);
}
