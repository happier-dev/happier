import { isPluginError } from '@happier-dev/plugin-sdk';
import type { ProviderBrokerApplicationFailure } from './providerBrokerApplicationFailure';

import { MANAGED_SERVICE_REQUEST_SIZE_ERROR_CODE } from '@/plugins/runtime/invocation/services/managedServiceRequestSize';

/** Preserve the carrier's typed refusal through Provider adapters without
 * repeating its size decision or exposing request/credential material. */
export function readProviderBrokerTransportFailure(error: unknown): ProviderBrokerApplicationFailure | null {
    if (!isPluginError(error) || error.code !== MANAGED_SERVICE_REQUEST_SIZE_ERROR_CODE) return null;
    return {
        ok: false, reasonCode: 'request_too_large',
    };
}
