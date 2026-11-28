import { describe, expect, it } from 'vitest';
import { projectPluginActionControlExecutionV1 } from './executeAction.js';
const text = (_key: string, fallback?: string) => fallback ?? _key;
describe('original host control settlement', () => {
  it('preserves success', () => {
    expect(projectPluginActionControlExecutionV1({ ok: true, result: { changed: true } }, text))
      .toEqual({ status: 'success', result: { changed: true } });
  });
  it('retains uncertainty when the host reports an attempted effect', () => {
    expect(projectPluginActionControlExecutionV1({ ok: false, errorCode: 'provider_failed', error: 'Lost result', effectAttempted: true,
      details: { requestId: 'press-3' } }, text)).toMatchObject({ status: 'outcomeUnknown', code: 'provider_failed', requestId: 'press-3' });
  });
  it('projects the author details from a contributed Action refusal', () => {
    const failureCause = { phase: 'resource.binding', errorClass: 'Error', errorCode: 'conflict', httpStatus: null } as const;
    const details = { resourceRef: 'saved-resource', resourceRevision: 3 };
    const error = new PluginError({ code: 'binding_failed', message: 'The resource was saved but not bound.',
      effectAttempted: true, failureCause, details });
    expect(projectPluginActionControlExecutionV1({ ok: false, errorCode: error.code, error: error.message,
      effectAttempted: true, failureCause, requestId: 'press-4', details: error.data }, text))
      .toMatchObject({ status: 'outcomeUnknown', code: error.code, requestId: 'press-4', failureCause, details });
  });
  it('keeps a host confirmation decline quiet in existing presenters', () => {
    expect(projectPluginActionControlExecutionV1({ ok: false, errorCode: 'approval_rejected', error: 'Declined' }, text))
      .toMatchObject({ status: 'error', code: 'plugin_action_current_intent_rejected' });
  });
  it('leaves stale-surface rebinding pending without a settled request identity', () => {
    expect(projectPluginActionControlExecutionV1({ ok: false, errorCode: 'stale_surface', requestId: 'retired', error: 'Rebinding' }, text))
      .toEqual({ status: 'pending' });
  });
  it('preserves typed refusal and request identity', () => {
    expect(projectPluginActionControlExecutionV1({ ok: false, errorCode: 'denied', error: 'Not permitted', details: { requestId: 'press-2' } }, text))
      .toMatchObject({ status: 'error', code: 'denied', message: 'Not permitted', requestId: 'press-2' });
  });
});
