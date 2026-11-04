import { describe, expect, it } from 'vitest';
import { PluginManifestV2Schema } from '@happier-dev/protocol/plugins/manifest/v2';
import { createReleaseLessDeclarationV1 } from '../availability/currentDeclaration';
import type { Tx } from '@/storage/inTx';
import { resolveCurrentPluginWebhookClaimAuthoritiesTxV1 } from './currentContribution';

describe('current executable webhook contributions', () => {
    it('retains signed handlers when the same admitted manifest has a receipt-only endpoint', async () => {
        const manifest = PluginManifestV2Schema.parse({
            schemaVersion: 2, id: 'example.webhooks', version: '1.0.0', displayName: 'Webhooks',
            runtime: { apiVersion: 1 }, entrypoints: { daemon: './dist/index.js' },
            contributes: {
                actions: [{ id: 'receive', title: 'Receive', scopes: ['global'], surfaces: ['plugin'], dangerLevel: 'safe', execution: { target: 'daemon' } }],
                webhooks: [
                    { id: 'heartbeat', title: 'Heartbeat', verifier: { kind: 'capabilityUrl_v1', routing: 'accountEndpoint' }, delivery: 'recordReceiptOnly' },
                    { id: 'github', title: 'GitHub', verifier: { kind: 'github_hmac_sha256_v1', routing: 'accountEndpoint' }, handlerAction: { localId: 'receive' } },
                ],
            },
        });
        // Database boundary fixture: the real declaration and executable-claim projection run below it.
        const tx = { accountPluginIntent: { findMany: async () => [{ pluginId: manifest.id, enabled: true, desiredVersion: null,
            releaseLessDeclaration: createReleaseLessDeclarationV1(manifest) }] } } as unknown as Tx;
        const authorities = await resolveCurrentPluginWebhookClaimAuthoritiesTxV1({ tx, accountId: 'account-1',
            targets: [{ pluginId: manifest.id, version: manifest.version, materializationId: 'materialization-1' }] });
        expect(authorities.filter(({ contribution }) => typeof contribution.handlerActionLocalId === 'string')
            .map(({ contribution }) => contribution)).toEqual([{
            pluginId: manifest.id, localId: 'github', handlerActionLocalId: 'receive',
            verifierKind: 'github_hmac_sha256_v1', routingKind: 'accountEndpoint',
        }]);
    });
});
