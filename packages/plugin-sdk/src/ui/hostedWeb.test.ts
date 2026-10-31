import { describe, expect, it } from 'vitest';

import {
    PluginHostedWebAccountDataBridgeOperationV1Schema as canonicalOperationSchema,
    PluginHostedWebAccountDataBridgeResponseV1Schema as canonicalResponseSchema,
} from '@happier-dev/protocol/plugins/ui/client';

import * as hostedWeb from './hostedWeb';
import * as publicUi from './index.js';
import { defineHostedWebBridgeMessage } from './hostedWeb';

describe('hosted web UI SDK helpers', () => {
    it('defines bridge envelopes without exposing raw host internals', () => {
        const envelope = {
            version: 1 as const,
            identity: { instanceId: 'mount-1', mountNonce: 'nonce-1' },
            sequence: 1,
            kind: 'ready' as const,
            payload: { ready: true },
        };

        expect(defineHostedWebBridgeMessage(envelope)).toEqual(envelope);
        expect(() => defineHostedWebBridgeMessage({ ...envelope, rawHost: {} })).toThrow();
        expect(() => defineHostedWebBridgeMessage({ ...envelope, sequence: -1 })).toThrow();
    });

    it('projects the canonical hosted Collection UI-query bridge schemas for guest UI consumers', () => {
        expect(hostedWeb).toHaveProperty(
            'PluginHostedWebAccountDataBridgeOperationV1Schema',
            canonicalOperationSchema,
        );
        expect(hostedWeb).toHaveProperty(
            'PluginHostedWebAccountDataBridgeResponseV1Schema',
            canonicalResponseSchema,
        );
    });

    it('publishes the hosted Collection UI-query schemas through the public ui entrypoint', () => {
        expect(publicUi).toHaveProperty(
            'PluginHostedWebAccountDataBridgeOperationV1Schema',
            canonicalOperationSchema,
        );
        expect(publicUi).toHaveProperty(
            'PluginHostedWebAccountDataBridgeResponseV1Schema',
            canonicalResponseSchema,
        );
    });
});
