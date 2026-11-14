import { describe, expect, it } from 'vitest';
import type { Message, ToolCall } from '@happier-dev/session-core/messages';
import { SessionWorkStateV1Schema } from '@happier-dev/protocol/sessions/work/state/sessionWorkStateV1';
import { ScmRemoteResponseSchema } from '@happier-dev/protocol/scm';
import { ScmPullRequestSummarySchema, ScmPullRequestOpenOrReuseResponseSchema } from '@happier-dev/protocol/scm/pullRequests';
import { ActionExecuteFailureSchema, UNKNOWN_ACTION_FAILURE_CAUSE_V1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { SessionPullRequestStatusResourceResultV1Schema } from '@happier-dev/triage-protocol/v1';
import { projectDeploymentPreparationRead, readDeploymentPreparationPublication } from './deploymentPreparationRead';

const session = { serverId: 'home', sessionId: 'session' };
const pullRequest = ScmPullRequestSummarySchema.parse({ provider: { id: 'forge', kind: 'github',
    displayName: 'GitHub', baseUrl: 'https://github.com', nameWithOwner: 'org/repo' },
    number: 14, title: 'Actual preparation', url: 'https://github.com/org/repo/pull/14',
    baseBranch: 'main', headBranch: 'prepare', state: 'merged', checks: { state: 'success' } });
function call(id: string, actionId: string, result: unknown, createdAt: number, overrides: Partial<ToolCall> = {}): Message {
    return { kind: 'tool-call', id, localId: null, createdAt, children: [], tool: {
        name: 'mcp__happier__action_execute', input: { actionId, input: {} }, state: 'completed',
        result, createdAt, startedAt: createdAt, completedAt: createdAt + 1, description: null, ...overrides,
    } };
}

describe('Prepare reported state read', () => {
    it('reports the Session owner actual plan without inventing preparation steps or validation', () => {
        const workState = SessionWorkStateV1Schema.parse({ v: 1, backendId: 'agent', updatedAt: 10,
            items: [{ id: 'actual-task', kind: 'task', origin: 'vendor', status: 'active',
                title: 'Inspect the existing worker startup', updatedAt: 10 }] });
        const machine = { machineId: 'reported-machine', basePath: '/reported/repository' };
        const result = projectDeploymentPreparationRead({ session, ownerMetadata: { sessionWorkStateV1: workState },
            messages: [], agentId: 'reported-agent', machine });
        expect(result).toMatchObject({ phase: 'session', workState, agentId: 'reported-agent', machine,
            validation: { kind: 'unreported' } });
    });

    it('reports a structured refused push with owner recovery and ignores newer prose and foreign tools', () => {
        const messages: Message[] = [call('push', 'scm.remote.push', { ok: true, result: ScmRemoteResponseSchema.parse({ success: false,
            error: 'Authentication required', errorCode: 'REMOTE_AUTH_REQUIRED',
            outcome: { v: 1, kind: 'needs_input', errorCode: 'REMOTE_AUTH_REQUIRED',
                nextActions: [{ kind: 'authenticate' }] } }) }, 10),
        { kind: 'agent-text', id: 'prose', localId: null, createdAt: 20, text: 'PR opened and validation passed' },
        call('foreign', 'scm.pullRequest.openOrReuse', { ok: true, result: { success: true } }, 30,
            { name: 'mcp__other__action_execute' })];
        expect(projectDeploymentPreparationRead({ session, ownerMetadata: null, messages })).toMatchObject({
            phase: 'publicationFailed', publication: { messageId: 'push', status: 'failed',
                outcome: { kind: 'needs_input', nextActions: [{ kind: 'authenticate' }] } },
            validation: { kind: 'unreported' },
        });
    });

    it('keeps error-state typed Action refusals and nested publication results, then clears an old refusal on success', () => {
        const refusal = call('refused', 'scm.remote.push', ActionExecuteFailureSchema.parse({
            ok: false, errorCode: 'permission_denied', error: 'Unavailable', details: { requiredFact: 'credential', remedy: 'connect' },
        }), 10, { state: 'error' });
        const nested = call('parent', 'session.work_state.get', null, 1);
        if (nested.kind !== 'tool-call') throw new Error('fixture');
        nested.children.push(refusal);
        expect(readDeploymentPreparationPublication([nested])).toMatchObject({ messageId: 'refused', status: 'failed',
            failure: { errorCode: 'permission_denied', details: { requiredFact: 'credential', remedy: 'connect' } } });
        const succeeded = call('published', 'scm.pullRequest.openOrReuse', { ok: true,
            result: ScmPullRequestOpenOrReuseResponseSchema.parse({ success: true, pullRequest, nextAction: { kind: 'none' } }) }, 20);
        expect(projectDeploymentPreparationRead({ session, ownerMetadata: null, messages: [nested, succeeded] })).toMatchObject({
            phase: 'session', publication: { messageId: 'published', status: 'succeeded', pullRequest },
        });
    });

    it.each([
        { kind: 'outcome_unknown', errorCode: 'COMMAND_OUTCOME_UNKNOWN', reconciliation: { kind: 'remote_ref', remote: 'origin' },
            nextActions: [{ kind: 'refresh' }], status: 'outcomeUnknown' },
        { kind: 'effect_applied_with_warning', errorCode: 'COMMAND_FAILED', effect: { kind: 'remote', remote: 'origin' },
            nextActions: [{ kind: 'refresh' }], status: 'effectAppliedWithWarning' },
    ])('preserves $kind without claiming a definite publication failure', ({ status, ...outcome }) => {
        const result = ScmRemoteResponseSchema.parse({ success: false, error: 'Reported native outcome',
            errorCode: outcome.errorCode, outcome: { v: 1, ...outcome } });
        expect(projectDeploymentPreparationRead({ session, ownerMetadata: null,
            messages: [call('push', 'scm.remote.push', { ok: true, result }, 10)] })).toMatchObject({
            phase: 'session', publication: { status, outcome: { kind: outcome.kind } },
        });
    });

    it('retains the PR owner refusal cause and recovery without inventing a retained worktree or validation', () => {
        const native = ScmPullRequestOpenOrReuseResponseSchema.parse({ success: false,
            error: 'Reported failure', errorCode: 'REMOTE_AUTH_REQUIRED', failureCause: UNKNOWN_ACTION_FAILURE_CAUSE_V1,
            remediation: { kind: 'auth_required' }, stdout: 'native diagnostic' });
        const result = projectDeploymentPreparationRead({ session, ownerMetadata: null,
            messages: [call('pr', 'scm.pullRequest.openOrReuse', { ok: true, result: native }, 10)] });
        expect(result).toMatchObject({ phase: 'publicationFailed', publication: { failure: {
            errorCode: 'REMOTE_AUTH_REQUIRED', failureCause: UNKNOWN_ACTION_FAILURE_CAUSE_V1 },
            remediation: { kind: 'auth_required' }, pullRequest: null }, validation: { kind: 'unreported' } });
        expect(result.publication).not.toHaveProperty('stdout');
        expect(result.publication).not.toHaveProperty('worktree');
    });

    it('reports the actual PR as an applied effect when the Session binding owner refuses attachment', () => {
        const result = projectDeploymentPreparationRead({ session, ownerMetadata: null,
            messages: [call('pr', 'scm.pullRequest.openOrReuse', ActionExecuteFailureSchema.parse({
                ok: false, errorCode: 'target_unavailable', error: 'target_unavailable',
                details: { pullRequest, scmEffectCommitted: true },
            }), 10)] });
        expect(result).toMatchObject({ phase: 'session', publication: {
            status: 'effectAppliedWithWarning', pullRequest,
            outcome: { kind: 'effect_applied_with_warning', effect: { kind: 'pull_request', url: pullRequest.url } },
        } });
    });

    it('keeps the Action owner unknown outcome distinct from a definite refusal', () => {
        expect(projectDeploymentPreparationRead({ session, ownerMetadata: null,
            messages: [call('unknown', 'scm.remote.push', ActionExecuteFailureSchema.parse({
                ok: false, errorCode: 'outcome_unknown', error: 'outcome_unknown',
            }), 10, { state: 'error' })] })).toMatchObject({ phase: 'session',
            publication: { status: 'outcomeUnknown', failure: { errorCode: 'outcome_unknown' } } });
    });

    it('supersedes stale refusal with unreadable newer publication and keeps its key stable through unrelated arrivals', () => {
        const messages = [call('old', 'scm.remote.push', { ok: false, errorCode: 'permission_denied', error: 'Refused' }, 10),
            call('new', 'scm.pullRequest.openOrReuse', { unreadable: true }, 20)];
        const before = readDeploymentPreparationPublication(messages);
        expect(before).toMatchObject({ messageId: 'new', status: 'unknown' });
        expect(before?.failure).toBeUndefined();
        const prose: Message = { kind: 'agent-text', id: 'prose', localId: null, createdAt: 30, text: 'Done' };
        expect(readDeploymentPreparationPublication([...messages, prose])?.key).toBe(before?.key);
    });

    it('keeps every reported Session PR, including merged and closed, without selecting by branch or treating checks as deployment validation', () => {
        const pullRequests = SessionPullRequestStatusResourceResultV1Schema.parse({ kind: 'ready', sessionId: session.sessionId,
            pullRequests: ['merged', 'closed'].map((nativeState, index) => ({ bindingId: `binding-${index}`, revision: 1,
                link: { provider: 'github', repository: 'org/repo', number: 14 + index,
                    url: `https://github.com/org/repo/pull/${14 + index}` },
                watch: { policy: { mode: 'notify', archiveAfterMerge: false }, reason: null,
                    fixAttemptLimit: 3, roundsStarted: 0, watchingMachine: null }, latestUpdate: null,
                nativeStatus: { kind: 'current', checkedAtMs: 200, value: { kind: 'status', observedAtMs: 100,
                    checks: null, review: null, merge: { state: 'unknown', blocker: null, nativeState }, branch: null, facts: [] } },
            })) });
        const result = projectDeploymentPreparationRead({ session, ownerMetadata: null, messages: [],
            pullRequests });
        expect(result).toMatchObject({ phase: 'pullRequest', pullRequests, validation: { kind: 'unreported' } });
        expect(result.pullRequests).toBe(pullRequests);
        expect(projectDeploymentPreparationRead({ session, ownerMetadata: null, messages: [] })).toMatchObject({ phase: 'unknown' });
    });
});
