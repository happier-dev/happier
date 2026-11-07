import { describe, expect, it } from 'vitest';
import type { SessionRuntimeIssueV1 } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';

import { t } from '@/text';

import { resolveSessionStartFailureNotice } from './sessionStartFailureNotice';

function issue(overrides: Partial<SessionRuntimeIssueV1>): SessionRuntimeIssueV1 {
    return {
        v: 1,
        scope: 'primary_session',
        status: 'failed',
        code: 'agent_session_error',
        source: 'agent_session_error',
        occurredAt: 1_700_000_000_000,
        sanitizedPreview: 'Agent session failed',
        ...overrides,
    };
}

describe('resolveSessionStartFailureNotice', () => {
    it('explains a disabled Agent without offering another resume attempt', () => {
        const notice = resolveSessionStartFailureNotice({ issue: issue({ code: 'plugin_disabled', source: 'dependency_failure' }), sessionActive: false });
        expect(notice).toMatchObject({ code: 'plugin_disabled', retryable: false });
        expect(notice?.message).toBe(t('session.startFailure.cause.plugin_disabled'));
    });

    const startFailure = issue({
        code: 'native_agent_privileged_effect_authority_unavailable',
        source: 'dependency_failure',
        sanitizedPreview: 'Runner daemon authority is unavailable. Check the target Machine, then retry the Session.',
    });

    it('explains an inactive Session whose start failed with the stored cause', () => {
        expect(resolveSessionStartFailureNotice({ issue: startFailure, sessionActive: false })).toEqual({
            code: 'native_agent_privileged_effect_authority_unavailable',
            message: t('session.startFailure.cause.native_agent_privileged_effect_authority_unavailable'),
            retryable: true,
        });
    });

    it.each(['refresh_bridge_unavailable', 'provider_account_identity_unavailable', 'experimental_api_unavailable',
        'workspace_incompatible', 'credential_family_mismatch', 'live_hot_auth_failed'] as const)(
        'does not offer Retry for permanent startup refusal %s', reason => {
            const failed = issue({ code: 'codex_refresh_free_auth_unsupported', agentId: 'codex',
                source: reason === 'refresh_bridge_unavailable' || reason === 'experimental_api_unavailable' ? 'dependency_failure' : 'auth_error',
                failureCause: { phase: 'authentication', failureReason: 'authentication_required', reason } });
            expect(resolveSessionStartFailureNotice({ issue: failed, sessionActive: false })?.retryable).toBe(false);
        },
    );

    it('stays quiet once the Session is running again', () => {
        expect(resolveSessionStartFailureNotice({ issue: startFailure, sessionActive: true })).toBeNull();
    });

    it('leaves runtime failures after a successful start to their own surfaces', () => {
        expect(resolveSessionStartFailureNotice({ issue: issue({}), sessionActive: false })).toBeNull();
        expect(resolveSessionStartFailureNotice({
            issue: issue({ code: 'usage_limit', source: 'usage_limit', sanitizedPreview: 'Usage limit reached' }),
            sessionActive: false,
        })).toBeNull();
        expect(resolveSessionStartFailureNotice({ issue: null, sessionActive: false })).toBeNull();
    });
});
