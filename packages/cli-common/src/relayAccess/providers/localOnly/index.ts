import type { RelayAccessProvider } from '../../types.js';

import { relayAccessProviderDescriptorsById } from '../../catalog.js';

const descriptor = relayAccessProviderDescriptorsById.localOnly;

export const localOnlyRelayAccessProvider: RelayAccessProvider = {
    descriptor,
    status: () => ({
        state: 'disabled',
    }),
};
