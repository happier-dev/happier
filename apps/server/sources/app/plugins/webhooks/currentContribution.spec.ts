import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PluginManifestV2Schema } from '@happier-dev/protocol/plugins/manifest/v2';
import { createReleaseLessDeclarationV1 } from '../availability/currentDeclaration';
import { inTx } from '@/storage/inTx';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { resolveCurrentPluginWebhookClaimAuthoritiesTxV1 } from './currentContribution';

describe('current executable webhook contributions', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'webhook-contributions-' });
        await db.account.create({ data: { id: 'account-1', encryptionMode: 'plain' } });
    }, 120_000);
    afterAll(async () => await harness.close());
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
        await db.accountPluginIntent.create({ data: { accountId: 'account-1', pluginId: manifest.id,
            enabled: true, desiredVersion: null, writableCollections: [], releaseLessDeclaration: createReleaseLessDeclarationV1(manifest) } });
        const authorities = await inTx(tx => resolveCurrentPluginWebhookClaimAuthoritiesTxV1({ tx, accountId: 'account-1',
            targets: [{ pluginId: manifest.id, version: manifest.version, materializationId: 'materialization-1',
                machineId: 'machine-1', machineInstallationId: 'installation-1' }] }));
        expect(authorities.filter(({ contribution }) => typeof contribution.handlerActionLocalId === 'string')
            .map(({ contribution }) => contribution)).toEqual([{
            pluginId: manifest.id, localId: 'github', handlerActionLocalId: 'receive',
            verifierKind: 'github_hmac_sha256_v1', routingKind: 'accountEndpoint',
        }]);
    });
});
