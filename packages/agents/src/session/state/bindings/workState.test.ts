import { describe, expect, it } from 'vitest';

import {
  clearSessionStateFieldFromMetadata,
  createSessionStateFieldMetadataUpdater,
  hasSessionStateFieldMetadataBinding,
} from './publishField.js';
import { readSessionWorkStateSessionState } from './workState.js';

const snapshot = {
  v: 1,
  backendId: 'codex-app-server',
  agentId: 'codex',
  updatedAt: 100,
  items: [
    {
      id: 'goal:vendor-thread',
      kind: 'goal',
      origin: 'vendor',
      status: 'active',
      title: 'Implement work-state substrate',
      updatedAt: 100,
    },
  ],
} as const;

describe('work-state session-state binding', () => {
  it('reads metadata.sessionWorkStateV1 as runtime.workState', () => {
    expect(readSessionWorkStateSessionState({ sessionWorkStateV1: snapshot })).toEqual({
      value: snapshot,
      updatedAt: 100,
    });
  });

  it('writes and clears metadata.sessionWorkStateV1 through the generic updater', () => {
    expect(hasSessionStateFieldMetadataBinding('runtime.workState')).toBe(true);

    const updater = createSessionStateFieldMetadataUpdater('runtime.workState', snapshot);
    expect(updater({ path: '/tmp/project' })).toEqual({
      path: '/tmp/project',
      sessionWorkStateV1: snapshot,
    });

    const clearUpdater = createSessionStateFieldMetadataUpdater('runtime.workState', null);
    expect(clearUpdater({
      path: '/tmp/project',
      sessionWorkStateV1: snapshot,
    })).toEqual({
      path: '/tmp/project',
    });
  });

  it('clears the canonical metadata field by field id', () => {
    expect(clearSessionStateFieldFromMetadata({
      path: '/tmp/project',
      sessionWorkStateV1: snapshot,
    }, 'runtime.workState')).toEqual({
      path: '/tmp/project',
    });
  });
});

const usageLimitRecovery = {
  v: 1,
  status: 'waiting',
  resumePromptMode: 'standard',
  issueFingerprint: 'usage-limit:codex:turn-1',
  armedAtMs: 100,
  resetAtMs: 1_000,
  nextCheckAtMs: 1_000,
  attemptCount: 0,
  maxAttempts: 3,
  lastProbeError: null,
  selectedAuth: {
    kind: 'group',
    serviceId: 'openai-codex',
    groupId: 'group-1',
    profileId: 'profile-1',
  },
} as const;

describe('usage-limit recovery session-state binding', () => {
  it('writes and clears metadata.sessionUsageLimitRecoveryV1 through the generic updater', () => {
    expect(hasSessionStateFieldMetadataBinding('runtime.usageLimitRecovery')).toBe(true);

    const updater = createSessionStateFieldMetadataUpdater(
      'runtime.usageLimitRecovery',
      usageLimitRecovery,
    );
    expect(updater({ path: '/tmp/project' })).toEqual({
      path: '/tmp/project',
      sessionUsageLimitRecoveryV1: usageLimitRecovery,
    });

    const clearUpdater = createSessionStateFieldMetadataUpdater('runtime.usageLimitRecovery', null);
    expect(clearUpdater({
      path: '/tmp/project',
      sessionUsageLimitRecoveryV1: usageLimitRecovery,
    })).toEqual({
      path: '/tmp/project',
    });
  });
});
