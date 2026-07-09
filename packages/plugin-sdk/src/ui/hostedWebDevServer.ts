import type { PluginHostedWebContributionV1 } from '@happier-dev/protocol';
import type { PluginHostedWebRuntimeModeV1 } from '@happier-dev/protocol/plugins/ui';

import {
    defineLocalService,
    type LocalServiceDeclarationV1,
} from '../localServices.js';

export type HostedWebDevServerBindingV1<TService extends LocalServiceDeclarationV1> = Readonly<{
    contributionId: string;
    localService: TService;
    hostedWebServiceRef: Extract<PluginHostedWebContributionV1['service'], { kind: 'managedService' }>;
    runtimeMode: Extract<PluginHostedWebRuntimeModeV1, { kind: 'managedLocalService' }>;
}>;

export function defineHostedWebDevServer<const TService extends LocalServiceDeclarationV1>(
    input: Readonly<{
        contributionId: string;
        service: TService;
    }>,
): HostedWebDevServerBindingV1<TService> {
    const localService = defineLocalService(input.service);
    return Object.freeze({
        contributionId: input.contributionId,
        localService,
        hostedWebServiceRef: Object.freeze({
            kind: 'managedService',
            serviceId: localService.id,
        }),
        runtimeMode: Object.freeze({
            kind: 'managedLocalService',
            localServiceId: localService.id,
        }),
    });
}
