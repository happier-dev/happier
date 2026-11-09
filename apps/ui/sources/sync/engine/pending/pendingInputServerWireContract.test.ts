import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
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
    it('preserves the existing V5 informational-input support instead of downgrading it', () => {
        expect(resolvePendingInputServerWireMode(ready({ features: {},
            capabilities: { session: { pendingInput: { protocolVersion: 5 } } } }))).toBe('pending_input_v5');
    });
    it('selects reset-capable V4 independently of target-aware V3', () => {
        expect(resolvePendingInputServerWireMode(ready({
            features: {}, capabilities: { session: { pendingInput: { protocolVersion: 4 } } },
        }))).toBe('pending_input_v4');
    });
    it('selects target-aware V3 without treating the main-only V2 epoch as target-capable', () => {
        expect(resolvePendingInputServerWireMode(ready({
            features: {},
            capabilities: { session: { pendingInput: { protocolVersion: 3 } } },
        }))).toBe('pending_input_v3');
        expect(resolvePendingInputServerWireMode(ready({
            features: {},
            capabilities: { session: { pendingInput: { protocolVersion: 2 } } },
        }))).toBe('pending_input_v1');
    });

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
