import { describe, expect, it } from 'vitest';
import type { PluginActionExecution } from '@happier-dev/plugin-ui';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { dispatchFailure as githubFailure } from '../../../plugins/scm-github/src/ui/detail/readBoundary.js';
import { dispatchFailure as gitlabFailure } from '../../../plugins/scm-gitlab/src/ui/detail/readBoundary.js';
import { forgeCiInvocationFailureV1 } from '../../../forge-ci/src/runtime/adapter.js';
import { projectTriageSourceInvocationFailureV1, projectTriageSourceReadFailureV1 } from './failure.js';

describe('native source read host failures', () => {
  it('projects an issued read identity onto a typed source failure without changing the result', () => {
    const failure = Object.freeze({ class: 'rateLimit', code: 'provider-rate-limited' } as const);
    const result = Object.freeze({ kind: 'unavailable', failure });
    expect(projectTriageSourceReadFailureV1({ status: 'success', result, requestId: 'issued-read' }, 'read-failed', 'not-dispatched', failure))
      .toEqual({ ...failure, requestId: 'issued-read' });
    expect(result).toEqual({ kind: 'unavailable', failure: { class: 'rateLimit', code: 'provider-rate-limited' } });
    expect(projectTriageSourceReadFailureV1({ status: 'success', result }, 'read-failed', 'not-dispatched', failure))
      .toEqual(failure);
  });
  it('settles the observed legacy status-only caller without throwing', () => {
    // READY158's Bitbucket diff caller passed the status instead of the execution.
    // @ts-expect-error The regression exercised this invalid runtime input before caller migration.
    expect(projectTriageSourceReadFailureV1('outcomeUnknown', 'timeout', 'not-dispatched'))
      .toEqual({ class: 'unknown', code: 'timeout' });
  });

  const diagnostics = [{ severity: 'error', code: 'plugin_action_permission_denied' }] as const;
  const refusal = {
    status: 'error', code: 'denied', message: 'denied', retryable: false,
    diagnostics, requestId: 'source-read-request',
  } satisfies PluginActionExecution;

  it.each([
    ['GitHub', githubFailure],
    ['GitLab', gitlabFailure],
  ] as const)('%s preserves the canonical refusal and finite-read recovery facts', (_name, project) => {
    expect(project(refusal, 'read-failed')).toEqual({
      class: 'permission', code: 'plugin_action_permission_denied',
      retryable: false, diagnostics, requestId: 'source-read-request',
    });
  });

  it('keeps the Forge raw-error projection consistent with mounted read failures', () => {
    const error = new PluginError({ code: refusal.code, retryable: false, diagnostics });
    expect(forgeCiInvocationFailureV1(error, 'ci-read-failed')).toEqual({
      class: 'permission', code: 'plugin_action_permission_denied',
    });
  });

  it('preserves the originating Request ID when projecting a direct invocation failure', () => {
    const requestId = 'source-invocation-request';
    const error = new PluginError({ code: refusal.code, retryable: false, diagnostics, details: { requestId } });
    expect(projectTriageSourceInvocationFailureV1(error, 'read-failed')).toEqual({
      class: 'permission', code: 'plugin_action_permission_denied', requestId,
    });
  });

  it.each([
    ['GitHub', githubFailure],
    ['GitLab', gitlabFailure],
  ] as const)('%s treats lost finite-read receipts as explicitly retryable', (_name, project) => {
    expect(project({ status: 'outcomeUnknown', code: 'timeout', message: 'No receipt' }, 'read-failed'))
      .toEqual({ class: 'unknown', code: 'timeout', retryable: true });
  });
});
