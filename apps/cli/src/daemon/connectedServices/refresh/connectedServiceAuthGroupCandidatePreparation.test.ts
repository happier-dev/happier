import { describe, expect, it } from 'vitest';

import { resolveConnectedServiceAuthGroupCandidatePreparation } from './ConnectedServiceRefreshCoordinator';

function refreshResult(input: Readonly<{
    status: 'refreshed' | 'refresh_failed';
    category?: 'invalid_grant' | 'network_error';
}>) {
    return {
        status: input.status,
        credential: null,
        diagnostic: {
            serviceId: 'claude-subscription' as const,
            profileId: 'backup',
            reason: 'spawn_preflight' as const,
            status: input.status,
            ...(input.category ? { category: input.category } : {}),
            expiresAt: null,
            expiryAgeMs: null,
            refreshWindowMs: 60_000,
        },
    };
}

describe('resolveConnectedServiceAuthGroupCandidatePreparation', () => {
    it('excludes permanently invalid credentials from auth recovery', () => {
        expect(resolveConnectedServiceAuthGroupCandidatePreparation({
            reason: 'auth_expired',
            refreshResult: refreshResult({
                status: 'refresh_failed',
                category: 'invalid_grant',
            }),
        })).toEqual({
            status: 'ineligible',
            memberState: { credentialHealthStatus: 'needs_reauth' },
        });
    });

    it('rejects an unusable quota candidate after ordinary preflight', () => {
        expect(resolveConnectedServiceAuthGroupCandidatePreparation({
            reason: 'usage_limit',
            refreshResult: refreshResult({
                status: 'refresh_failed',
                category: 'invalid_grant',
            }),
        })).toEqual({
            status: 'ineligible',
            memberState: { credentialHealthStatus: 'needs_reauth' },
        });
    });
});
