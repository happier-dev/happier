import { describe, expect, it } from 'vitest';
import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import { readSessionRuntimeIssueNativeAuthAgentId, resolveSessionRuntimeIssueSignInRecovery } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';

import { classifyPrimarySessionRuntimeIssue } from '@/agent/runtime/session/errors/classifyPrimarySessionRuntimeIssue';
import { SESSION_RUNTIME_ISSUE_PREVIEW_BY_SOURCE } from '@/agent/runtime/session/errors/sessionRuntimeIssuePreview';
import { projectRuntimeIssueForServer } from './projectRuntimeIssueForServer';

describe('server runtime issue credential recovery', () => {
    it('keeps Droid native ACP authentication tied to Agent sign-in after public projection', () => {
        const native = classifyPrimarySessionRuntimeIssue({ provider: 'droid', cause: 'session_error',
            startupPhase: 'client_start', occurredAt: 100,
            error: { code: 'acp_session_start_failed', severity: 'error', message: 'Authentication required:',
                details: { requestErrorCode: -32000 } } });
        const published = projectRuntimeIssueForServer(native);

        expect(published).toMatchObject({ code: 'provider_endpoint_auth_required', source: 'auth_error', agentId: 'droid',
            failureCause: { phase: 'client_start', failureReason: 'authentication_required', providerErrorCode: -32000 } });
        expect(published.sanitizedPreview).toBe(SESSION_RUNTIME_ISSUE_PREVIEW_BY_SOURCE.auth_error);
        expect(readSessionRuntimeIssueNativeAuthAgentId(published)).toBe('droid');
        expect(resolveSessionRuntimeIssueSignInRecovery(published, 'qa-machine')).toEqual({
            kind: 'agent_sign_in', machineId: 'qa-machine', agentId: 'droid',
        });
    });

    it('retains Provider credential guidance when the Gateway credential owner refuses authentication', () => {
        const provider = classifyPrimarySessionRuntimeIssue({ provider: 'droid', cause: 'session_error', occurredAt: 100,
            error: createProviderErrorV1('provider_endpoint_auth_required') });
        const published = projectRuntimeIssueForServer(provider);

        expect(published).toMatchObject({ code: 'provider_endpoint_auth_required', source: 'agent_session_error',
            sanitizedPreview: provider.sanitizedPreview });
        expect(readSessionRuntimeIssueNativeAuthAgentId(published)).toBeNull();
        expect(resolveSessionRuntimeIssueSignInRecovery(published, 'qa-machine')).toBeNull();
    });
});
