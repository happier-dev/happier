import { API_TOKEN_FULL_GRANT_V1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import { describe, expect, it } from 'vitest';

import {
    buildApiTokenAccessSummaryParts,
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

    it('renders required token metadata and derives active, expiring (7 days or less) and expired status', () => {
        const expiring = buildApiTokenRowPresentation({
            token: {
                tokenId: '11111111-1111-4111-8111-111111111111',
                label: 'Release automation',
                displayPrefix: 'hap_v1_11111111',
                createdAt: '2026-08-20T12:00:00.000Z',
                lastUsedAt: null,
                expiresAt: '2026-08-27T12:00:00.000Z',
                hasEncryptionAccess: false,
                hasUnattendedTeamAccess: true,
                grant: API_TOKEN_FULL_GRANT_V1,
                parentTokenId: null,
                activeChildCount: 0,
                embedConfig: null,
            },
            nowMs: NOW,
        });
        expect(expiring).toMatchObject({
            displayPrefix: 'hap_v1_11111111…',
            status: 'expiring',
            embedBacked: false,
            encryptionAccess: 'bearerOnly',
            unattendedTeamAccess: 'authorized',
        });
        expect(buildApiTokenRowPresentation({ token: { ...expiring.token, hasEncryptionAccess: true }, nowMs: NOW }).encryptionAccess).toBe('enabled');
        expect(JSON.stringify(expiring)).not.toContain(
            `hap_v1_${expiring.token.tokenId}_`,
        );

        const expired = buildApiTokenRowPresentation({
            token: { ...expiring.token, expiresAt: '2026-08-21T12:00:00.000Z' },
            nowMs: NOW,
        });
        expect(expired).toMatchObject({ status: 'expired' });
        expect(buildApiTokenRowPresentation({
            token: { ...expiring.token, expiresAt: '2026-08-30T12:00:01.000Z' },
            nowMs: NOW,
        })).toMatchObject({ status: 'active' });
    });

    it('says how soon an expiring token expires, and when that wording next changes', () => {
        const token = buildApiTokenRowPresentation({
            token: {
                tokenId: '11111111-1111-4111-8111-111111111111', label: 'Status widget', displayPrefix: 'hap_v1_11111111',
                createdAt: '2026-08-01T12:00:00.000Z', lastUsedAt: null, expiresAt: '2026-08-27T15:00:00.000Z',
                hasEncryptionAccess: false, hasUnattendedTeamAccess: false, grant: API_TOKEN_FULL_GRANT_V1,
                parentTokenId: null, activeChildCount: 0, embedConfig: null,
            },
            nowMs: NOW,
        }).token;
        const expiresAtMs = Date.parse('2026-08-27T15:00:00.000Z');
        // 5 days 3 hours left: "5d" until 5 days remain, then "4d".
        expect(buildApiTokenRowPresentation({ token, nowMs: NOW }).expiresIn)
            .toEqual({ unit: 'days', count: 5, changesAtMs: expiresAtMs - 5 * 24 * 3_600_000 + 1 });
        expect(buildApiTokenRowPresentation({ token, nowMs: expiresAtMs - 90 * 60_000 }).expiresIn)
            .toEqual({ unit: 'hours', count: 1, changesAtMs: expiresAtMs - 3_600_000 + 1 });
        expect(buildApiTokenRowPresentation({ token, nowMs: expiresAtMs - 30_000 }).expiresIn)
            .toEqual({ unit: 'minutes', count: 1, changesAtMs: expiresAtMs });
        // Outside the last seven days there is nothing to say.
        expect(buildApiTokenRowPresentation({ token, nowMs: expiresAtMs - 8 * 24 * 3_600_000 }).expiresIn).toBeNull();
    });

    it('summarizes access in the fixed order scope, targets, approve, models, websites, content, expiry', () => {
        const names = {
            familyName: (family: string) => ({ messaging: 'Messaging', session_transcripts: 'Session transcripts' })[family] ?? null,
            actionName: (actionId: string) => (actionId === 'session.user_action.answer' ? 'Answer questions' : null),
            modelName: () => 'Claude Sonnet 4.5',
            automationName: (automationId: string) => (automationId === 'brief' ? 'Morning brief' : null),
        };
        const token = {
            expiresAt: '2026-09-21T12:00:00.000Z',
            hasEncryptionAccess: true,
            grant: {
                ...API_TOKEN_FULL_GRANT_V1,
                actions: { families: ['messaging' as const, 'session_transcripts' as const], ids: ['session.user_action.answer'] },
                targets: { sessions: ['session-1'], machines: [] },
                approve: true,
                origins: ['http://localhost:5173', 'https://app.acme.com'],
                models: [{ agentTargetKey: 'agent:claude/claude', providerConnectionId: null, modelId: 'claude-sonnet-4-5' }],
            },
        };
        const parts = buildApiTokenAccessSummaryParts({ token, nowMs: NOW, names });
        expect(parts.map((part) => part.kind)).toEqual(['actions', 'targets', 'approve', 'models', 'websites', 'content', 'expiry']);
        expect(parts[0]).toEqual({ kind: 'actions', names: ['Messaging', 'Session transcripts'], more: 1 });
        expect(parts[1]).toEqual({ kind: 'targets', sessions: 1, machines: 0, environments: 0 });
        expect(parts[3]).toEqual({ kind: 'models', name: 'Claude Sonnet 4.5', count: 1 });
        expect(parts[4]).toEqual({ kind: 'websites', host: null, count: 2 });

        // An Automation restriction reads right after the actions it narrows.
        expect(buildApiTokenAccessSummaryParts({
            token: {
                expiresAt: null,
                hasEncryptionAccess: false,
                grant: { ...API_TOKEN_FULL_GRANT_V1, actions: { families: [], ids: ['workflow.trigger.run_now'] }, automationIds: ['brief'] },
            },
            nowMs: NOW,
            names,
        }).slice(0, 2)).toEqual([
            { kind: 'actions', names: ['workflow.trigger.run_now'], more: 0 },
            { kind: 'automations', name: 'Morning brief', count: 1 },
        ]);

        // Quiet defaults say nothing: a full grant is one scope fact and its expiry.
        expect(buildApiTokenAccessSummaryParts({
            token: { expiresAt: null, hasEncryptionAccess: false, grant: API_TOKEN_FULL_GRANT_V1 },
            nowMs: NOW,
            names,
        })).toEqual([{ kind: 'full' }, { kind: 'expiry', state: 'never', at: null }]);
    });

    it('maps typed auth and transport failures to designed states', () => {
        expect(resolveApiTokenOperationErrorMessageKey('unsupported')).toBe('settingsApiTokens.encryption.unsupported');
        expect(resolveApiTokenOperationErrorMessageKey('api_token_encryption_not_ready')).toBe('settingsApiTokens.encryption.notReady');
        expect(resolveApiTokenOperationErrorMessageKey('api_token_encryption_stale')).toBe('settingsApiTokens.encryption.stale');
        expect(resolveApiTokenOperationErrorMessageKey('api_token_id_conflict')).toBe('settingsApiTokens.encryption.idConflict');
        expect(resolveApiTokenOperationErrorMessageKey('outcome_unknown')).toBe('settingsApiTokens.encryption.outcomeUnknown');
        expect(resolveApiTokenOperationErrorMessageKey('present_user_required')).toBe('settingsApiTokens.errors.presentUserRequired');
        expect(resolveApiTokenOperationErrorMessageKey('invalid_request')).toBe('settingsApiTokens.errors.unavailable');
        expect(resolveApiTokenOperationErrorMessageKey('auth_unavailable')).toBe('settingsApiTokens.errors.unavailable');
        expect(resolveApiTokenOperationErrorMessageKey('account_unavailable')).toBe('settingsApiTokens.errors.unavailable');
        expect(resolveApiTokenOperationErrorMessageKey('network_error')).toBe('settingsApiTokens.errors.offline');
        expect(resolveApiTokenOperationErrorMessageKey('unavailable')).toBe('settingsApiTokens.errors.unavailable');
    });
});
