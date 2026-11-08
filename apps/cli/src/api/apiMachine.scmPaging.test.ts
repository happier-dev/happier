import { describe, expect, it } from 'vitest';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';

import { ApiMachineClient } from './apiMachine';

describe('ApiMachineClient SCM paging capability publication', () => {
    it.each(['scmComparisonIndexPaging', 'scmStatusSnapshotPaging'])('advertises %s only to a Home accepting that operation leaf', async (capability) => {
        // The real publication owner needs no Session RPC constructor registration.
        const client = Object.assign(Object.create(ApiMachineClient.prototype), {
            machine: { id: 'machine-1', metadata: null, daemonState: null },
            lifecycleDependencies: {}, currentIrohMachineEndpoint: null, activeTransportGeneration: 1,
        });
        const internal = client as {
            resolveCurrentMachineOperationProtocolCapabilitiesForPublication(): Promise<Record<string, unknown> | null>;
        };
        for (const support of [undefined, { protocolVersions: [1] }, { protocolVersions: [2] }]) {
            const features = FeaturesResponseSchema.parse({ features: {}, capabilities: { machines: { [capability]: support } } });
            Reflect.set(client, 'lifecycleDependencies', { resolveServerFeaturesSnapshot: async () => ({ status: 'ready', features }) });
            const capabilities = await internal.resolveCurrentMachineOperationProtocolCapabilitiesForPublication();
            expect(capabilities?.[capability]).toEqual(support?.protocolVersions[0] === 1 ? { protocolVersions: [1] } : undefined);
        }
    });
});
