import { describe, expect, it } from 'vitest';
import type { PluginActionExecution } from '@happier-dev/plugin-ui';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { dispatchFailure as githubFailure } from '../../../plugins/scm-github/src/ui/detail/readBoundary.js';
import { dispatchFailure as gitlabFailure } from '../../../plugins/scm-gitlab/src/ui/detail/readBoundary.js';
import { forgeCiInvocationFailureV1 } from '../../../forge-ci/src/runtime/adapter.js';

describe('native source read host failures', () => {
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

  it.each([
    ['GitHub', githubFailure],
    ['GitLab', gitlabFailure],
  ] as const)('%s treats lost finite-read receipts as explicitly retryable', (_name, project) => {
    expect(project({ status: 'outcomeUnknown', code: 'timeout', message: 'No receipt' }, 'read-failed'))
      .toEqual({ class: 'unknown', code: 'timeout', retryable: true });
  });
});
