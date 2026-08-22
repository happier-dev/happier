import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
    deriveAccountMachineKeyFromRecoverySecret,
} from '@happier-dev/protocol';
import tweetnacl from 'tweetnacl';

import type { TestAuth } from '../auth';
import { buildAuthBootstrapStorageSnapshot } from './buildAuthBootstrapStorageSnapshot';

function hashScope(raw: string): string {
    return createHash('sha256').update(raw).digest('base64url');
}

describe('buildAuthBootstrapStorageSnapshot', () => {
    const accountSigningSeed = new Uint8Array(32).fill(0x51);
    const auth: TestAuth = {
        token: 'stack-token',
        publicKeyBase64: 'unused-by-browser-auth-bootstrap',
        accountSigningSeed,
        accountMachineKey: deriveAccountMachineKeyFromRecoverySecret(accountSigningSeed),
    };

    it('builds a scoped browser auth snapshot that matches the app bootstrap contract', () => {
        const snapshot = buildAuthBootstrapStorageSnapshot({
            serverUrl: 'http://happier-provider-backend-unification-qa-20260412a.localhost:24530',
            auth,
            mode: 'legacy',
            storageScope: 'e2e-qa-browser-auth',
        });

        const credentialPayload = JSON.stringify({
            token: auth.token,
            secret: Buffer.from(auth.accountSigningSeed).toString('base64'),
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
        expect(snapshot.localStorage.auth_credentials).toBe(credentialPayload);
        expect(snapshot.localStorage['auth_credentials__srv_localhost-24530']).toBe(
            credentialPayload,
        );
        expect(
            snapshot.localStorage['auth_credentials__srv_localhost-24530__e2e-qa-browser-auth'],
        ).toBe(credentialPayload);
    });

    it('builds a scoped browser auth snapshot for encryption-backed access keys', () => {
        const snapshot = buildAuthBootstrapStorageSnapshot({
            serverUrl: 'http://happier-provider-backend-unification-qa-20260412a.localhost:24530',
            auth,
            mode: 'dataKey',
            storageScope: 'e2e-qa-browser-auth',
        });

        const credentialPayload = JSON.stringify({
            token: auth.token,
            encryption: {
                publicKey: Buffer.from(
                    tweetnacl.box.keyPair.fromSecretKey(
                        auth.accountMachineKey,
                    ).publicKey,
                ).toString('base64'),
                machineKey: Buffer.from(auth.accountMachineKey).toString('base64'),
            },
        });
        expect(snapshot.localStorage.auth_credentials).toBe(
            credentialPayload,
        );
        expect(snapshot.localStorage['auth_credentials__srv_localhost-24530']).toBe(
            credentialPayload,
        );
    });

    it('seeds token-only auth into identity and URL-hash credential scopes', () => {
        const snapshot = buildAuthBootstrapStorageSnapshot({
            serverUrl: 'http://127.0.0.1:53288/',
            auth,
            mode: 'tokenOnly',
            storageScope: 'repo-dev-a1cc5e0671',
            serverIdentityId: 'srv_niq4j8b2',
            legacyServerIds: ['legacy-relay'],
        });

        const credentialPayload = JSON.stringify({ token: auth.token });
        const canonicalHash = hashScope('http://localhost:53288');
        const loopbackHash = hashScope('http://127.0.0.1:53288');

        expect(snapshot.sessionStorage.activeServerId).toBe('localhost-53288');
        expect(snapshot.localStorage['server-profiles:server-state-v1']).toContain('"serverIdentityId":"srv_niq4j8b2"');
        expect(snapshot.localStorage['server-profiles:server-state-v1']).toContain('"legacyServerIds":["legacy-relay","localhost-53288"]');
        expect(snapshot.localStorage['auth_credentials__srv_srv_niq4j8b2']).toBe(credentialPayload);
        expect(snapshot.localStorage['auth_credentials__srv_srv_niq4j8b2__repo-dev-a1cc5e0671']).toBe(credentialPayload);
        expect(snapshot.localStorage['auth_credentials__srv_legacy-relay']).toBe(credentialPayload);
        expect(snapshot.localStorage[`auth_credentials__srv_${canonicalHash}`]).toBe(credentialPayload);
        expect(snapshot.localStorage[`auth_credentials__srv_${canonicalHash}__repo-dev-a1cc5e0671`]).toBe(credentialPayload);
        expect(snapshot.localStorage[`auth_credentials__srv_${loopbackHash}`]).toBe(credentialPayload);
    });
});
