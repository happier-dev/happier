import * as React from 'react';
import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import { buildProviderGatewayConfigurationMutation, type ProviderGatewayConfigurationPatch,
    type ProviderGatewayConfigurationConnection } from '@/providers/connection/gatewayConfiguration';
import type { useProviderConnectionMutation } from './useProviderConnectionMutation';

/** Uses the detail's existing mutation lifecycle, including Action approval and Account retirement. */
export function useProviderGatewayConfiguration(input: Readonly<{
    connection: ProviderGatewayConfigurationConnection | null;
    machineId: string | null;
    mutation: ReturnType<typeof useProviderConnectionMutation>;
}>) {
    const run = input.mutation.run;
    const save = React.useCallback(async (patch: ProviderGatewayConfigurationPatch): Promise<boolean> => {
        if (!input.connection) throw createProviderErrorV1('provider_authorization_changed');
        const request = buildProviderGatewayConfigurationMutation({ connection: input.connection, machineId: input.machineId, patch });
        const result = await run(request, 'gateway:configuration');
        return result?.status === 'success';
    }, [input.connection, input.machineId, run]);
    return { save };
}
