import { describe, expect, it } from 'vitest';
import { CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION } from '@happier-dev/protocol';

import {
    buildCurrentCliClientCompatibilityHttpHeaders,
    buildCurrentCliClientCompatibilitySocketAuth,
    readCliClientUpgradeRequired,
} from './cliClientCompatibility';

describe('CLI compatibility declarations', () => {
    it.each(['daemon', 'session-runner'] as const)(
        'declares only the independently negotiated account-storage contract for %s',
        (clientKind) => {
            const headers = buildCurrentCliClientCompatibilityHttpHeaders(clientKind);
            const socketAuth = buildCurrentCliClientCompatibilitySocketAuth(clientKind);

            expect(headers).toEqual({
                'x-happier-account-stored-content-protocol':
                    String(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION.protocolVersion),
            });
            expect(headers).not.toHaveProperty('x-happier-client-kind');
            expect(headers).not.toHaveProperty('x-happier-session-sync-protocol');
            expect(socketAuth).toEqual({
                accountStoredContentCompatibility: {
                    v: 1,
                    protocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION.protocolVersion,
                },
            });
            expect(socketAuth).not.toHaveProperty('clientCompatibility');
        },
    );

    it('reads the strict account-stored-content upgrade-required result', () => {
        expect(readCliClientUpgradeRequired({
            error: 'client-upgrade-required',
            requirement: {
                v: 1,
                kind: 'account-stored-content',
                minimumProtocolVersion: 1,
            },
        })).toEqual({
            error: 'client-upgrade-required',
            requirement: {
                v: 1,
                kind: 'account-stored-content',
                minimumProtocolVersion: 1,
            },
        });
    });
});
