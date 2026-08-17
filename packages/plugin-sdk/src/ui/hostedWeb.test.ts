import { describe, expect, it } from 'vitest';

import {
    PluginHostedWebCollectionUiQueryBridgeOperationV1Schema as canonicalOperationSchema,
    PluginHostedWebCollectionUiQueryBridgeResponseV1Schema as canonicalResponseSchema,
} from '@happier-dev/protocol/plugins/ui/client';

import * as hostedWeb from './hostedWeb';
import * as publicUi from './index.js';
import { defineHostedWebBridgeMessage } from './hostedWeb';

describe('hosted web UI SDK helpers', () => {
    it('defines bridge envelopes without exposing raw host internals', () => {
        const message = defineHostedWebBridgeMessage({
            version: 1,
            pluginId: 'acme.preview',
            contributionId: 'preview-web',
            surfaceId: 'sessionSurface:acme.preview:preview-pane',
            nonce: 'nonce-1',
            sequence: 1,
            kind: 'ready',
            payload: { ready: true },
        });

        expect(message.kind).toBe('ready');
    });

    it('projects the canonical hosted Collection UI-query bridge schemas for guest UI consumers', () => {
        expect(hostedWeb).toHaveProperty(
            'PluginHostedWebCollectionUiQueryBridgeOperationV1Schema',
            canonicalOperationSchema,
        );
        expect(hostedWeb).toHaveProperty(
            'PluginHostedWebCollectionUiQueryBridgeResponseV1Schema',
            canonicalResponseSchema,
        );
    });

    it('publishes the hosted Collection UI-query schemas through the public ui entrypoint', () => {
        expect(publicUi).toHaveProperty(
            'PluginHostedWebCollectionUiQueryBridgeOperationV1Schema',
            canonicalOperationSchema,
        );
        expect(publicUi).toHaveProperty(
            'PluginHostedWebCollectionUiQueryBridgeResponseV1Schema',
            canonicalResponseSchema,
        );
    });
});
