import { describe, expect, it, vi } from 'vitest';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    return createServerScopedMachineRpcBoundaryMock(vi.fn());
});

import { formatResetAtTime } from '@/utils/time/formatResetAtTime';

import { AgentInstallJobRpcError } from './api';
import { presentAgentInstallJobFailure, presentAgentInstallJobRpcFailure } from './presentAgentInstallJobFailure';

describe('agent install failure presentation', () => {
    it('preserves the recovery cause for refused installation changes', () => {
        for (const [code, body] of [
            ['in_use', 'agentInstallJob.inUseBody'],
            ['not_managed', 'agentInstallJob.notManagedBody'],
            ['definition_version_changed', 'agentInstallJob.definitionChangedBody'],
            ['member_install_unavailable', 'errors.agentIsolationMemberSetupAskManager'],
        ]) {
            expect(presentAgentInstallJobRpcFailure(new AgentInstallJobRpcError(code)).body).toBe(body);
        }
        expect(presentAgentInstallJobFailure({ kind: 'failed', code: 'in_use', stepId: 'cli', message: null }))
            .toMatchObject({ body: 'agentInstallJob.inUseBody machineAgents.failedKept', recovery: { kind: 'retry' } });
        expect(presentAgentInstallJobFailure({ kind: 'failed', code: 'not_managed', stepId: 'cli', message: null }))
            .toMatchObject({ body: 'agentInstallJob.notManagedBody machineAgents.failedKept', recovery: { kind: 'chooseAgent' } });
    });

    it('shows the typed refusal code when no specific recovery presentation exists', () => {
        for (const code of ['install_unavailable', 'RPC_FORBIDDEN']) {
            expect(presentAgentInstallJobRpcFailure(new AgentInstallJobRpcError(code)).body).toContain(code);
        }
    });

    it('explains an extraction size refusal without exposing raw paths', () => {
        expect(presentAgentInstallJobFailure({ kind: 'failed', code: 'archive_expanded_byte_limit', stepId: 'cli', message: 'Extraction failed in C:\\private\\install.log.' })).toMatchObject({
            body: 'agentInstallJob.archiveExpandedByteLimitBody machineAgents.failedKept',
        });
    });

    it('distinguishes unavailable job operations from an unreachable machine without inventing an install outcome', () => {
        expect(presentAgentInstallJobRpcFailure(new AgentInstallJobRpcError('unavailable'))).toMatchObject({
            title: 'agentInstallJob.jobUnavailable', body: 'agentInstallJob.jobUnavailableBody',
        });
        expect(presentAgentInstallJobRpcFailure(new AgentInstallJobRpcError('request_failed'))).toMatchObject({
            title: 'agentInstallJob.machineUnreachable', body: 'agentInstallJob.unreachableBody',
        });
        expect(presentAgentInstallJobRpcFailure(new AgentInstallJobRpcError('invalid_response'))).toMatchObject({
            title: 'agentInstallJob.jobUnavailable', body: 'agentInstallJob.jobMissingBody (invalid_response)',
        });
        expect(presentAgentInstallJobRpcFailure(new AgentInstallJobRpcError('server_unreachable'))).toMatchObject({
            title: 'agentInstallJob.jobUnavailable', body: 'agentInstallJob.jobMissingBody (server_unreachable)',
        });
        expect(presentAgentInstallJobRpcFailure(new AgentInstallJobRpcError('install_unavailable'))).toMatchObject({
            title: 'agentInstallJob.jobUnavailable', body: 'agentInstallJob.jobMissingBody (install_unavailable)',
        });
        expect(presentAgentInstallJobRpcFailure(new Error('Unacknowledged request'))).toMatchObject({
            title: 'agentInstallJob.jobUnavailable', body: 'agentInstallJob.jobMissingBody',
        });
        expect(presentAgentInstallJobRpcFailure(new AgentInstallJobRpcError('job_not_found'))).toMatchObject({
            title: 'agentInstallJob.jobMissing', body: 'agentInstallJob.jobMissingBody',
        });
    });

    it('keeps raw vendor diagnostics out of primary copy and offers only an available recovery', () => {
        const failure = { kind: 'failed', code: 'update_not_available', stepId: 'cli', message: 'raw vendor output', guideUrl: 'https://example.com/install' } as const;
        expect(presentAgentInstallJobFailure(failure)).toMatchObject({
            body: 'agentInstallJob.updateBody machineAgents.failedKept', recovery: { kind: 'guide', guideUrl: failure.guideUrl },
        });
        expect(presentAgentInstallJobFailure({ ...failure, guideUrl: undefined }).recovery.kind).toBe('chooseAgent');
    });

    it('says the download source is rate-limited and when to retry, in local time rather than the raw reset', () => {
        const resetIso = '2026-10-19T14:20:00.000Z';
        const failure = {
            kind: 'failed', code: 'rate_limited', stepId: 'download',
            message: `GitHub's API rate limit has been reached. Try again after ${resetIso}.`,
        } as const;
        const presented = presentAgentInstallJobFailure(failure);
        expect(presented).toMatchObject({
            code: 'rate_limited', title: 'agentInstallJob.rateLimited',
            recovery: { kind: 'retry', label: 'agentInstallJob.retry' },
        });
        expect(presented.body).toBe(`agentInstallJob.rateLimitedBody(time=${formatResetAtTime(Date.parse(resetIso))}) machineAgents.failedKept`);
        expect(presented.body).not.toContain(resetIso);
    });

    it('does not invent a retry time when the rate-limit message names none', () => {
        const presented = presentAgentInstallJobFailure({
            kind: 'failed', code: 'rate_limited', stepId: 'download',
            message: 'GitHub\'s API rate limit has been reached. Wait for GitHub to reset it, then try again.',
        });
        expect(presented).toMatchObject({ title: 'agentInstallJob.rateLimited', body: 'agentInstallJob.rateLimitedBodyNoTime machineAgents.failedKept' });
    });
});
