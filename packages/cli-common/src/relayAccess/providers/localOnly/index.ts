import type { RelayAccessProvider, RelayAccessProviderDescriptor } from '../../types.js';

const descriptor = {
    id: 'localOnly',
    title: 'Local only',
    exposure: 'private',
    prerequisites: [],
} as const satisfies RelayAccessProviderDescriptor;

export const localOnlyRelayAccessProvider: RelayAccessProvider = {
    descriptor,
    status: () => ({
        state: 'disabled',
    }),
};
