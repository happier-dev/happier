import { describe, expect, it } from 'vitest';

import { evaluateSessionSyncCompatibility } from './decision';
import {
    SESSION_SYNC_COMPATIBILITY_ENV_KEYS,
    resolveSessionSyncCompatibilityPolicy,
} from './policy';

const providerHostDeclaration = {
    v: 1 as const,
    clientKind: 'daemon' as const,
    appVersion: '0.2.10',
    sessionSyncProtocolVersion: 2,
};

function requiredEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    return {
        [SESSION_SYNC_COMPATIBILITY_ENV_KEYS.enforcement]: 'required',
        [SESSION_SYNC_COMPATIBILITY_ENV_KEYS.minimumProtocolVersion]: '2',
        [SESSION_SYNC_COMPATIBILITY_ENV_KEYS.minimumVersionsByClientKind]: JSON.stringify({
            daemon: '0.2.10',
            'session-runner': '0.2.10',
        }),
        ...overrides,
    };
}

describe('provider-host minimum policy', () => {
    it('keeps the source default observe-only', () => {
        const policy = resolveSessionSyncCompatibilityPolicy({});

        expect(policy.valid).toBe(true);
        expect(policy.requirements.enforcement).toBe('observe');
        expect(evaluateSessionSyncCompatibility({ status: 'missing' }, policy).accepted).toBe(true);
    });

    it('rejects provider-host activation when explicitly required policy input is malformed', () => {
        const policy = resolveSessionSyncCompatibilityPolicy(requiredEnv({
            [SESSION_SYNC_COMPATIBILITY_ENV_KEYS.minimumVersionsByClientKind]: '{not-json',
        }));

        expect(policy.valid).toBe(false);
        expect(evaluateSessionSyncCompatibility({
            status: 'valid',
            declaration: providerHostDeclaration,
        }, policy)).toMatchObject({
            accepted: false,
            outcome: 'reject-policy-invalid',
            upgradeRequired: { error: 'client-upgrade-required' },
        });
    });

    it.each(['daemon', 'session-runner'] as const)(
        'rejects %s activation when required policy omits its configured app-version floor',
        (clientKind) => {
            const otherKind = clientKind === 'daemon' ? 'session-runner' : 'daemon';
            const policy = resolveSessionSyncCompatibilityPolicy(requiredEnv({
                [SESSION_SYNC_COMPATIBILITY_ENV_KEYS.minimumVersionsByClientKind]: JSON.stringify({
                    [otherKind]: '0.2.10',
                }),
            }));

            expect(evaluateSessionSyncCompatibility({
                status: 'valid',
                declaration: { ...providerHostDeclaration, clientKind },
            }, policy)).toMatchObject({
                accepted: false,
                outcome: 'reject-policy-invalid',
                upgradeRequired: {
                    error: 'client-upgrade-required',
                    requirement: {
                        clientKind,
                        minimumAppVersion: null,
                    },
                },
            });
        },
    );
});
