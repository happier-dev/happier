import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { parseReleasedServerV021Features } from '@/dev/testkit';

import {
    resolvePendingInputServerWireMode,
    shouldSchedulePendingOutboxTransportRetry,
} from './pendingInputServerWireContract';

function ready(payload: unknown) {
    return { status: 'ready' as const, features: FeaturesResponseSchema.parse(payload) };
}

describe('Pending-input server wire contract', () => {
    it('selects current only from the independent Pending Input v1 capability', () => {
        expect(resolvePendingInputServerWireMode(ready({
            features: {},
            capabilities: {
                session: {
                    pendingInput: { protocolVersion: 1 },
                },
            },
        }))).toBe('pending_input_v1');
    });

    it('selects the released server only from its exact feature shape and absent compatibility', () => {
        expect(resolvePendingInputServerWireMode({
            status: 'ready',
            features: parseReleasedServerV021Features(),
        })).toBe('released_server_v0_2_1');
    });

    it.each([
        { status: 'loading' as const },
        { status: 'unsupported' as const, reason: 'endpoint_missing' as const },
        { status: 'error' as const, reason: 'network' as const },
        ready({ features: {}, capabilities: {} }),
        ready({
            features: { sharing: { pendingQueueV2: { enabled: true }, pendingDeliveryState: { enabled: true } } },
            capabilities: {},
        }),
        ready({
            features: {},
            capabilities: {
                session: {
                    runtimeActivity: { protocolVersion: 2 },
                },
            },
        }),
    ])('keeps unsupported, mixed, and incomplete snapshots indeterminate', (snapshot) => {
        expect(resolvePendingInputServerWireMode(snapshot)).toBe('indeterminate');
    });

    it('allows transport retry only after a concrete wire serializer is selected', () => {
        expect(shouldSchedulePendingOutboxTransportRetry('pending_input_v1')).toBe(true);
        expect(shouldSchedulePendingOutboxTransportRetry('released_server_v0_2_1')).toBe(true);
        expect(shouldSchedulePendingOutboxTransportRetry('indeterminate')).toBe(false);
    });
});
