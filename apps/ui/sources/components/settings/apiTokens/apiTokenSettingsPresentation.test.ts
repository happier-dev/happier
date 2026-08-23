import { describe, expect, it } from 'vitest';

import {
    buildApiTokenRowPresentation,
    resolveApiTokenListPresentation,
    resolveApiTokenOperationErrorMessageKey,
} from './apiTokenSettingsPresentation';

const NOW = Date.parse('2026-08-22T12:00:00.000Z');

describe('API-token Settings presentation', () => {
    it('distinguishes first loading from preserving refresh and list errors', () => {
        expect(resolveApiTokenListPresentation({ phase: 'loading', tokens: [], isRefreshing: false }))
            .toBe('skeleton');
        expect(resolveApiTokenListPresentation({ phase: 'ready', tokens: [{ tokenId: 'a' }], isRefreshing: true }))
            .toBe('list');
        expect(resolveApiTokenListPresentation({ phase: 'ready', tokens: [], isRefreshing: false }))
            .toBe('empty');
        expect(resolveApiTokenListPresentation({ phase: 'error', tokens: [], isRefreshing: false }))
            .toBe('error');
        expect(resolveApiTokenListPresentation({
            phase: 'ready',
            tokens: [{ tokenId: 'a' }],
            isRefreshing: false,
            listError: 'auth_unavailable',
        })).toBe('listWithRetry');
        expect(resolveApiTokenListPresentation({
            phase: 'ready',
            tokens: [],
            isRefreshing: false,
            listError: 'auth_unavailable',
        })).toBe('emptyWithRetry');
    });

    it('renders summaries only and gives expiring/expired tokens truthful non-color status', () => {
        const expiring = buildApiTokenRowPresentation({
            token: {
                tokenId: '11111111-1111-4111-8111-111111111111',
                label: 'Release automation',
                displayPrefix: 'hap_11111111',
                createdAt: '2026-08-20T12:00:00.000Z',
                lastUsedAt: null,
                expiresAt: '2026-08-27T12:00:00.000Z',
            },
            nowMs: NOW,
        });
        expect(expiring).toMatchObject({
            displayPrefix: 'hap_11111111…',
            status: 'expiring',
            statusVariant: 'warning',
        });
        expect(JSON.stringify(expiring)).not.toContain('hap_v1_');

        const expired = buildApiTokenRowPresentation({
            token: { ...expiring.token, expiresAt: '2026-08-21T12:00:00.000Z' },
            nowMs: NOW,
        });
        expect(expired).toMatchObject({ status: 'expired', statusVariant: 'neutral' });
    });

    it('maps typed auth, offline, account-mismatch, and generic failures to designed states', () => {
        expect(resolveApiTokenOperationErrorMessageKey('present_user_required')).toBe('settingsApiTokens.errors.presentUserRequired');
        expect(resolveApiTokenOperationErrorMessageKey('auth_unavailable')).toBe('settingsApiTokens.errors.offline');
        expect(resolveApiTokenOperationErrorMessageKey('account_mismatch')).toBe('settingsApiTokens.errors.accountMismatch');
        expect(resolveApiTokenOperationErrorMessageKey('anything_else')).toBe('settingsApiTokens.errors.unavailable');
    });
});
