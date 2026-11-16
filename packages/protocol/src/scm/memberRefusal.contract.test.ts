import { describe, expect, it } from 'vitest';
import { SCM_GIT_ACTION_SPECS, isScmLocalRepositoryRpcMethod, isScmHostingCredentialRpcMethod } from '../actions/scmGitActionSpecs.js';

// Captured from registerScmHandlers: member admission can refuse before Git runs.
const refusal = { success: false, errorCode: 'BACKEND_UNAVAILABLE',
  actionErrorCode: 'agent_isolation_unavailable', error: 'Source control could not run on this Machine' };

describe('member SCM refusal transport', () => {
  for (const spec of SCM_GIT_ACTION_SPECS.filter(spec => {
    const method = spec.bindings && 'rpcMethod' in spec.bindings ? spec.bindings.rpcMethod : undefined;
    return typeof method === 'string' && (isScmLocalRepositoryRpcMethod(method) || isScmHostingCredentialRpcMethod(method));
  })) {
    it(`${spec.id} preserves the native admission refusal`, () => {
      expect(spec.outputSchema.parse(refusal)).toMatchObject(refusal);
    });
  }
  it('keeps the native refusal and log success envelopes closed', () => {
    const spec = SCM_GIT_ACTION_SPECS.find(spec => spec.id === 'scm.log.list');
    expect(spec).toBeDefined();
    if (!spec) return;
    expect(spec.outputSchema.safeParse({ ...refusal, actionErrorCode: 42 }).success).toBe(false);
    expect(spec.outputSchema.safeParse({ ...refusal, authority: 'owner' }).success).toBe(false);
    expect(spec.outputSchema.safeParse({ success: true, entries: [], authority: 'owner' }).success).toBe(false);
    expect(spec.outputSchema.parse({ success: true, entries: [] })).toEqual({ success: true, entries: [] });
    expect(spec.outputSchema.parse({ success: false, errorCode: 'NOT_REPOSITORY' })).toEqual({ success: false, errorCode: 'NOT_REPOSITORY' });
  });
});
