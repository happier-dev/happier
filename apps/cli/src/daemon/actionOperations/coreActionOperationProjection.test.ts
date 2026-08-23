import { describe, expect, it } from 'vitest';

import {
  projectCoreActionOperationDomainRef,
} from './coreActionOperationProjection';

describe('core Action operation projection', () => {
  it('projects known core request identities without treating them as operation ids', () => {
    expect(projectCoreActionOperationDomainRef('session.fork', 'fork-request', { strategy: 'replay' })).toEqual({
      kind: 'forkRequest',
      id: 'fork-request',
      strategy: 'replay',
    });
    expect(projectCoreActionOperationDomainRef('session.spawn_new', 'correlation-only', {
      spawnNonce: 'spawn-attempt',
    })).toEqual({
      kind: 'spawnAttempt',
      id: 'spawn-attempt',
    });
    expect(projectCoreActionOperationDomainRef('session.spawn_new', 'correlation-only', {})).toBeUndefined();
    expect(projectCoreActionOperationDomainRef('session.handoff', 'unrelated-request')).toBeUndefined();
  });
});
