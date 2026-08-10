import { describe, expect, it } from 'vitest';

import {
    PENDING_INPUT_PROTOCOL_VERSION_V1,
    type FeaturesResponse,
} from '@happier-dev/protocol';
import { parseReleasedServerV021Features } from '@/dev/testkit';
import { buildServerFeaturesResponse } from '@/hooks/server/serverFeaturesTestUtils';
import type { ServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';

import { resolvePendingInputServerWireMode } from './pendingInputServerWireContract';

function ready(features: FeaturesResponse): ServerFeaturesSnapshot {
    return { status: 'ready', features };
}

function currentFeatures(params: Readonly<{ includePendingInput?: boolean }> = {}): FeaturesResponse {
    const base = buildServerFeaturesResponse();
    return {
        ...base,
        features: {
            ...base.features,
            sharing: {
                ...base.features.sharing,
                pendingQueueV2: { enabled: true },
                pendingDeliveryState: { enabled: true },
            },
        },
        capabilities: {
            ...base.capabilities,
            session: {
                ...base.capabilities.session,
                runtimeActivity: { protocolVersion: 2 },
                pendingInput: params.includePendingInput === false
                    ? undefined
                    : { protocolVersion: PENDING_INPUT_PROTOCOL_VERSION_V1 },
            },
        },
    };
}

describe('Pending input server HTTP wire contract', () => {
    it('selects the current Pending wire only from the explicit Pending-input protocol minimum', () => {
        expect(resolvePendingInputServerWireMode(ready(currentFeatures())))
            .toBe('pending_input_v1');
        expect(resolvePendingInputServerWireMode(ready(currentFeatures({ includePendingInput: false }))))
            .toBe('indeterminate');
    });

    it('selects only the immutable released server from positive old feature evidence', () => {
        expect(resolvePendingInputServerWireMode(ready(parseReleasedServerV021Features())))
            .toBe('released_server_v0_2_1');
    });

    it('fails closed when a ready feature snapshot omits session capabilities', () => {
        const features = currentFeatures();
        const snapshot = ready({
            ...features,
            capabilities: {
                ...features.capabilities,
                session: undefined,
            },
        } as unknown as FeaturesResponse);

        expect(resolvePendingInputServerWireMode(snapshot)).toBe('indeterminate');
    });

    it.each([
        { status: 'unsupported' as const, reason: 'endpoint_missing' as const },
        { status: 'unsupported' as const, reason: 'invalid_payload' as const },
        { status: 'error' as const, reason: 'network' as const },
        { status: 'error' as const, reason: 'timeout' as const },
        { status: 'error' as const, reason: 'response_status' as const },
    ])('fails closed for feature result %# without an authentication pseudo-mode', (snapshot) => {
        expect(resolvePendingInputServerWireMode(snapshot)).toBe('indeterminate');
    });
});
