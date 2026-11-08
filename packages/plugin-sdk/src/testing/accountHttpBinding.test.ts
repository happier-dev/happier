import { describe, expect, it } from 'vitest';
import { activateAccount, manifest } from '../../fixtures/account-actions/src/index.js';
import { derivePluginAccountContributionRegistrationRights } from '@happier-dev/protocol/plugins/contributions/catalog';
import type { PluginAccountActionHandler } from '../actions/contracts.js';
import { createPluginRegistrationScope } from '../registration/scope.js';
import { createPluginHttpFixture } from './http.js';

describe('Account-purpose authored HTTP binding', () => {
    it.each(['read', 'wrong-method', 'stream'])('carries the issued GET independently of the %s request', async (key) => {
        const scope = createPluginRegistrationScope({ pluginId: manifest.id,
            target: { realm: 'account', artifactId: 'account-runtime', exportName: 'activateAccount' },
            rights: derivePluginAccountContributionRegistrationRights(manifest.contributes,
                { artifactId: 'account-runtime', exportName: 'activateAccount' }),
        });
        const requests: unknown[] = [];
        // Only the HTTP transport is replaced; authored activation, parsing and registration stay real.
        const http = createPluginHttpFixture({
            async request(input) {
                requests.push(input);
                return { status: 200, headers: {}, body: new Uint8Array() };
            },
            async requestStream(input) {
                requests.push(input);
                return { status: 200, finalUrl: input.url, headers: {},
                    chunks: (async function* () { yield new Uint8Array(); })(), async dispose() {} };
            },
        });
        const unavailable = (): never => { throw new Error('Unexpected non-HTTP host service'); };
        try {
            await activateAccount(scope.api);
            const registration = scope.commit().find(entry => entry.family === 'actions' && entry.localId === 'purpose-request');
            if (!registration || registration.family !== 'actions') throw new Error('Missing authored purpose Action');
            // Captured callbacks are opaque until their admitted realm restores the public handler type.
            const handler = registration.value as unknown as PluginAccountActionHandler;
            await handler({ key, link: { credentialRef: {
                service: { pluginId: manifest.id, localId: 'platform' }, accountId: 'fixture-account',
            } } }, {
                plugin: { id: manifest.id, version: manifest.version },
                contribution: { id: 'purpose-request', qualifiedId: `${manifest.id}/purpose-request` },
                surface: 'cli', invokedAtMs: 1, signal: new AbortController().signal,
                services: { http, get storage() { return unavailable(); }, get settings() { return unavailable(); },
                    get actions() { return unavailable(); }, get targetedContributions() { return unavailable(); },
                    get machineProvisioners() { return unavailable(); }, get secrets() { return unavailable(); },
                    get connectedAccounts() { return unavailable(); } },
            });
            expect(requests).toEqual([expect.objectContaining({
                method: key === 'wrong-method' ? 'POST' : 'GET',
                credentialBinding: { kind: 'connectedAccountPurpose', purpose: 'deploy-manage',
                    origin: 'https://purpose-provider.example', method: 'GET', headerNames: ['authorization'] },
            })]);
        } finally { await scope.dispose(); }
    });
});
