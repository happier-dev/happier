import { describe, expect, it } from 'vitest';

import { buildAuthBootstrapStorageSnapshot } from './buildAuthBootstrapStorageSnapshot';

describe('buildAuthBootstrapStorageSnapshot', () => {
    it('builds a scoped browser auth snapshot that matches the app bootstrap contract', () => {
        const snapshot = buildAuthBootstrapStorageSnapshot({
            serverUrl: 'http://happier-provider-backend-unification-qa-20260412a.localhost:24530',
            credentials: { token: 'stack-token', secret: 'stack-token' },
            storageScope: 'e2e-qa-browser-auth',
        });

        expect(snapshot.sessionStorage).toEqual({
            activeServerId: 'localhost-24530',
        });

        expect(snapshot.localStorage['server-profiles:server-state-v1']).toContain(
            '"activeServerId":"localhost-24530"',
        );
        expect(snapshot.localStorage['server-profiles:server-state-v1']).toContain(
            '"name":"localhost:24530"',
        );
        expect(snapshot.localStorage['server-profiles__e2e-qa-browser-auth:server-state-v1']).toBe(
            snapshot.localStorage['server-profiles:server-state-v1'],
        );
        expect(snapshot.localStorage.auth_credentials).toBe(JSON.stringify({ token: 'stack-token', secret: 'stack-token' }));
        expect(snapshot.localStorage['auth_credentials__srv_localhost-24530']).toBe(
            JSON.stringify({ token: 'stack-token', secret: 'stack-token' }),
        );
        expect(
            snapshot.localStorage['auth_credentials__srv_localhost-24530__e2e-qa-browser-auth'],
        ).toBe(JSON.stringify({ token: 'stack-token', secret: 'stack-token' }));
    });

    it('builds a scoped browser auth snapshot for encryption-backed access keys', () => {
        const snapshot = buildAuthBootstrapStorageSnapshot({
            serverUrl: 'http://happier-provider-backend-unification-qa-20260412a.localhost:24530',
            credentials: {
                token: 'stack-token',
                encryption: {
                    publicKey: 'stack-public-key',
                    machineKey: 'stack-machine-key',
                },
            },
            storageScope: 'e2e-qa-browser-auth',
        });

        expect(snapshot.localStorage.auth_credentials).toBe(
            JSON.stringify({
                token: 'stack-token',
                encryption: {
                    publicKey: 'stack-public-key',
                    machineKey: 'stack-machine-key',
                },
            }),
        );
        expect(snapshot.localStorage['auth_credentials__srv_localhost-24530']).toBe(
            JSON.stringify({
                token: 'stack-token',
                encryption: {
                    publicKey: 'stack-public-key',
                    machineKey: 'stack-machine-key',
                },
            }),
        );
    });
});
