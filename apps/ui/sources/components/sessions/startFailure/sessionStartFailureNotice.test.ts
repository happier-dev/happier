import { describe, expect, it } from 'vitest';
import type { SessionRuntimeIssueV1 } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';
import { readSessionProviderBindingMetadataV1, type SessionProviderBindingMetadataV1 } from '@happier-dev/protocol/providers/sessions/bindingMetadataV1';

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
    const appliedProviderBinding = {
        connectionId: 'pc_work',
        displaySnapshot: { providerName: 'Gateway', connectionName: 'Work', connectionRole: 'named', connectionDisplayNameMode: 'custom' },
    } satisfies Pick<SessionProviderBindingMetadataV1, 'connectionId' | 'displaySnapshot'>;

    it.each(['pi', 'codex', 'opencode'])('names the applied connection and requires reviewing it for %s authentication failures', agentId => {
        const failed = issue({ code: 'invalid_api_key', source: 'auth_error', agentId,
            failureCause: { phase: 'authentication', failureReason: 'authentication_required', providerErrorCode: 'invalid_api_key' } });
        const notice = resolveSessionStartFailureNotice({ issue: failed, sessionActive: false, appliedProviderBinding });
        expect(notice).toMatchObject({ title: 'Gateway · Work', message: t('errors.authenticationFailed'), retryable: false,
            providerRecovery: { action: 'review_connection', connectionId: 'pc_work' } });
        expect(resolveSessionStartFailureNotice({ issue: failed, sessionActive: false })).toMatchObject({
            message: t('errors.authenticationFailed'), retryable: true,
        });
    });

    it('keeps unknown and native sign-in failures distinct from connection credential recovery', () => {
        expect(resolveSessionStartFailureNotice({ issue: issue({ code: 'vendor_unknown',
            failureCause: { phase: 'turn_start', failureReason: 'unknown' } }), sessionActive: false, appliedProviderBinding })).toBeNull();
        const native = resolveSessionStartFailureNotice({ issue: issue({ code: 'provider_endpoint_auth_required',
            source: 'auth_error', agentId: 'pi', failureCause: { phase: 'authentication', failureReason: 'authentication_required' } }),
            sessionActive: false, appliedProviderBinding });
        expect(native?.message).not.toBe(t('errors.authenticationFailed'));
        expect(native).not.toHaveProperty('providerRecovery');
        expect(native).not.toHaveProperty('title');
    });

    it.each([true, false])('honors producer retryability %s without guessing a connection target', retryable => {
        const failed = issue({ code: 'invalid_api_key', source: 'auth_error', agentId: 'pi',
            failureCause: { phase: 'authentication', failureReason: 'authentication_required', retryable } });
        const notice = resolveSessionStartFailureNotice({ issue: failed, sessionActive: false });
        expect(notice?.retryable).toBe(retryable);
        expect(notice).not.toHaveProperty('providerRecovery');
    });

    it('names the applied binding while the next launch selects another connection', () => {
        const metadata = {
            providerBindingV1: { ...appliedProviderBinding, v: 1, contributionKey: null, connectionRevision: 1,
                protocol: 'openai-responses', materialization: 'engineConfig',
                compatibilityFingerprint: 'compatibility:v1:a', bindingSecurityFingerprint: 'binding-security:v1:a' },
            modelSelectionIntentV2: { v: 2, updatedAt: 1, ref: { source: 'account_provider_connection',
                providerConnectionId: 'pc_next', agentTargetKey: 'agent:pi', modelId: 'next-model' } },
        };
        const failed = issue({ code: 'invalid_api_key', source: 'auth_error', agentId: 'pi',
            failureCause: { phase: 'authentication', failureReason: 'authentication_required' } });
        expect(resolveSessionStartFailureNotice({ issue: failed, sessionActive: false,
            appliedProviderBinding: readSessionProviderBindingMetadataV1(metadata) })).toMatchObject({
            title: 'Gateway · Work', providerRecovery: { action: 'review_connection', connectionId: 'pc_work' },
        });
    });

    it.each(['no_eligible_member', 'no_eligible_group_member'])('retains Connected Account refusal %s after reload', code => {
        const notice = resolveSessionStartFailureNotice({ issue: issue({ code }), sessionActive: false });
        expect(notice?.message).toBe(t('connectedServices.diagnostics.body.no_eligible_group_member'));
    });

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
            issue: startFailure,
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
