import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { describe, expect, it, vi } from 'vitest';

import { externalSessionOperationTranslations } from '@/text/translations/externalSessionOperationTranslations';
import { HappyError } from '@/utils/errors/errors';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

import {
    resolveExternalSessionBrowseRpcErrorMessage,
    resolveExternalSessionBrowseThrownErrorMessage,
} from './externalSessionBrowseErrorPresentation';

describe('externalSessionBrowseErrorPresentation', () => {
    it('gives an invalid source request an actionable listing diagnosis instead of a generic load failure', () => {
        expect(resolveExternalSessionBrowseRpcErrorMessage('invalid_request', 'list', { retryable: false }))
            .toBe('externalSessions.browseSourceInvalid');
        expect(resolveExternalSessionBrowseRpcErrorMessage('invalid_request', 'link'))
            .toBe('externalSessions.browseLinkFailed');
    });
    it('gives an untyped listing transport failure the retryable failure owner’s next step', () => {
        expect(resolveExternalSessionBrowseThrownErrorMessage(new Error('connection reset'), 'list'))
            .toBe(resolveExternalSessionBrowseRpcErrorMessage('internal_error', 'list', { retryable: true }));
    });
    it('reports a response timeout as unfinished Agent work, not daemon unreachability', () => {
        expect(resolveExternalSessionBrowseThrownErrorMessage({ code: 'MACHINE_RPC_TIMEOUT' }, 'list'))
            .toBe('externalSessions.browseAgentTimedOut');
    });
    it('retains daemon-unavailable classification after the Action front door preserves its typed code', () => {
        expect(resolveExternalSessionBrowseThrownErrorMessage(new HappyError(RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
            false, { code: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE }), 'list'))
            .toBe('newSession.daemonRpcUnavailableBody');
    });
    it('says what to do next for an Agent fault, and never says "try again" for one that cannot be retried', () => {
        expect(resolveExternalSessionBrowseRpcErrorMessage('agent_error', 'list', { retryable: true }))
            .toBe('externalSessions.browseAgentFailed');
        expect(resolveExternalSessionBrowseRpcErrorMessage('agent_error', 'list', { retryable: false }))
            .toBe('externalSessions.browseAgentFailedNoRetry');
        expect(externalSessionOperationTranslations.en.browseAgentFailedNoRetry).not.toMatch(/try again/i);
        // A host fault while listing is the same next step; it is not a generic "failed to load".
        expect(resolveExternalSessionBrowseRpcErrorMessage('internal_error', 'list', { retryable: true }))
            .toBe('externalSessions.browseAgentFailed');
        expect(resolveExternalSessionBrowseRpcErrorMessage('internal_error', 'link'))
            .toBe('externalSessions.browseLinkFailed');
    });
    it('distinguishes an unavailable selected Agent or source from machine and daemon connectivity failures', () => {
        expect(resolveExternalSessionBrowseRpcErrorMessage('agent_unavailable', 'list'))
            .toBe('externalSessions.browseAgentUnavailable');
        expect(resolveExternalSessionBrowseRpcErrorMessage('agent_timeout', 'list'))
            .toBe('externalSessions.browseAgentTimedOut');
        expect(resolveExternalSessionBrowseRpcErrorMessage('agent_error', 'list'))
            .toBe('externalSessions.browseAgentFailed');
        expect(resolveExternalSessionBrowseRpcErrorMessage('machine_offline', 'list'))
            .toBe('newSession.machineOfflineInlineBody');
        expect(resolveExternalSessionBrowseThrownErrorMessage(
            Object.assign(new Error('RPC method not available'), {
                rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
            }),
            'list',
        )).toBe('newSession.daemonRpcUnavailableBody');

        // Browsing no longer waits for a Session runner to happen to be
        // running, so "retry once it becomes available" is no longer a real
        // remedy. What genuinely remains is a missing or unstartable Agent CLI
        // on that machine, and the message has to name that action.
        expect(externalSessionOperationTranslations.en.browseAgentUnavailable)
            .toContain('selected Agent');
        expect(externalSessionOperationTranslations.en.browseAgentUnavailable)
            .toContain('CLI is installed');
        expect(externalSessionOperationTranslations.en.browseAgentUnavailable)
            .not.toContain('daemon');
    });
});
