import { describe, expect, it } from 'vitest';

import { isPluginActionApprovalRequestCreated, parsePluginHostActionInvocation } from './service.js';
import type { ActionApprovalRequestCreatedResult } from './service.js';

type DomainResultWithoutKind = Readonly<{ success: true; targetPath: string }>;
type DomainResultWithKind = Readonly<{ kind: 'page'; revision: string }>;

describe('plugin Action approval deferral', () => {
  it('validates dynamic host requests through the canonical plugin input before dispatch', () => {
    expect(parsePluginHostActionInvocation('session.status.get', { sessionId: 'session-a' })).toMatchObject({
      actionId: 'session.status.get', input: { sessionId: 'session-a' },
    });
    expect(() => parsePluginHostActionInvocation('not.an.action', {})).toThrow();
    expect(() => parsePluginHostActionInvocation('session.status.get', { sessionId: 42 })).toThrow();
  });
  it('recognizes the canonical policy-deferral result', () => {
    expect(isPluginActionApprovalRequestCreated({
      kind: 'approval_request_created',
      artifactId: 'artifact-1',
      actionId: 'scm.reviewWorkspace.materializePrepared',
    })).toBe(true);
  });

  it('does not treat another domain arm that carries `kind` as a deferral', () => {
    expect(isPluginActionApprovalRequestCreated({ kind: 'page', revision: 'r1' })).toBe(false);
    expect(isPluginActionApprovalRequestCreated({ success: true, targetPath: '/tmp/x' })).toBe(false);
    expect(isPluginActionApprovalRequestCreated({ kind: 'approval_request_created' })).toBe(false);
  });

  it('narrows a union whose remaining arms do not share the discriminant', () => {
    const executed: DomainResultWithoutKind | ActionApprovalRequestCreatedResult = {
      success: true,
      targetPath: '/tmp/x',
    };
    if (isPluginActionApprovalRequestCreated(executed)) {
      expect.unreachable('The domain arm must not be classified as a deferral.');
    }
    // A compound `'kind' in value && value.kind === ...` test cannot narrow this
    // union, so the guard's predicate is what keeps the domain arm usable.
    const settled: DomainResultWithoutKind = executed;
    expect(settled.targetPath).toBe('/tmp/x');
  });

  it('narrows a union whose remaining arms share the discriminant', () => {
    const executed: DomainResultWithKind | ActionApprovalRequestCreatedResult = {
      kind: 'page',
      revision: 'r1',
    };
    if (isPluginActionApprovalRequestCreated(executed)) {
      expect.unreachable('The domain arm must not be classified as a deferral.');
    }
    const page: DomainResultWithKind = executed;
    expect(page.revision).toBe('r1');
  });
});
