import { expect, it } from 'vitest';
import { createActionExecuteFailureError, projectActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { readPluginActionError } from '@happier-dev/protocol/plugins/actions/invocation';
import { projectTargetActionFailure } from './actionFailureProjection.js';

it('carries an Action failure cause through the target failure projection', () => {
  const failureCause = projectActionFailureCauseV1(Object.assign(new Error('private'), { code: 'EACCES' }), 'plugins.development.prepare');
  const error = createActionExecuteFailureError({ ok: false, errorCode: 'plugin_change_failed', error: 'Plugin change failed', failureCause });
  const failure = readPluginActionError(error);
  expect(failure).not.toBeNull();
  if (!failure) throw new Error('Expected the canonical Action failure');
  const result = { status: 'failed' as const, ...failure };
  expect(projectTargetActionFailure(result)).toMatchObject({ data: { failureCause } });
});
