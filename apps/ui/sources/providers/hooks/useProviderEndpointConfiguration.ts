import * as React from 'react';
import type { DaemonProviderConnectionMutationRequestV1, DaemonProviderConnectionViewV1 } from '@happier-dev/protocol/rpc/providers';

import type { useProviderConnectionMutation } from './useProviderConnectionMutation';

type EndpointMutation = Extract<DaemonProviderConnectionMutationRequestV1, { action: 'setEndpointOverride' }>;
export type ProviderEndpointConfigurationPatch = Pick<EndpointMutation,
    'endpointTemplateId' | 'scope' | 'baseUrl' | 'publicHeaders'>;

const EMPTY_ENDPOINTS: DaemonProviderConnectionViewV1['endpoints'] = [];

/** Address and policy edits share the detail's Action approval, refresh and Account lifetime. */
export function useProviderEndpointConfiguration(input: Readonly<{
    connection: Pick<DaemonProviderConnectionViewV1, 'connectionId' | 'revision' | 'endpoints'> | null;
    machineId: string | null;
    mutation: ReturnType<typeof useProviderConnectionMutation>;
    onChange: () => void;
}>) {
    const run = input.mutation.run;
    const patch = React.useCallback(async (change: ProviderEndpointConfigurationPatch, options?: Parameters<typeof run>[2]): Promise<boolean> => {
        if (!input.connection || change.scope === 'machine' && !input.machineId) return false;
        input.onChange();
        const result = await run({
            action: 'setEndpointOverride',
            connectionId: input.connection.connectionId,
            expectedRevision: input.connection.revision,
            ...(input.machineId ? { machineId: input.machineId } : {}),
            ...change,
        }, `endpoint:${change.scope}:${change.endpointTemplateId}`, options);
        return result?.status === 'success';
    }, [input.connection, input.machineId, input.onChange, run]);
    return { endpoints: input.connection?.endpoints ?? EMPTY_ENDPOINTS, patch };
}
