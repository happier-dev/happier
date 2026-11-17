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

it('projects a typed leaf whose confidential echo was redacted as a schema-valid text value', () => {
  const secret = '9007199254740993';
  const redact = (value: string) => value.replaceAll(secret, '[REDACTED]');
  const result = { status: 'executed' as const, value: { ok: true, results: [{ rows: [{ cells: [
    { type: 'text', value: `marker-${secret}` },
    { type: 'integer', value: secret },
    { type: 'integer', value: '42' },
    { type: 'partial', valueType: 'text', value: secret, encoding: 'utf8', range: { unit: 'utf8_bytes', offset: 0, length: 16, total: 16 } },
  ] }] }] } };
  expect(projectTargetActionFailure(result, redact)).toEqual({ status: 'executed', value: { ok: true, results: [{ rows: [{ cells: [
    { type: 'text', value: 'marker-[REDACTED]' },
    { type: 'text', value: '[REDACTED]' },
    { type: 'integer', value: '42' },
    { type: 'text', value: '[REDACTED]' },
  ] }] }] } });
});
