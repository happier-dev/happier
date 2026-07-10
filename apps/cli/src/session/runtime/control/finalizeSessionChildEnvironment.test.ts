import { describe, expect, it } from 'vitest';

import { finalizeSessionChildEnvironment } from './finalizeSessionChildEnvironment';

describe('finalizeSessionChildEnvironment', () => {
  it('removes ambient session controls and restores only trusted canonical values', () => {
    const env = finalizeSessionChildEnvironment({
      environment: {
        PATH: '/bin',
        SAFE_VALUE: 'kept',
        HAPPIER_SESSION_PROFILE_ID: 'ambient-profile',
        HAPPIER_SESSION_ATTACH_FILE: '/tmp/ambient-attach.json',
        HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: 'ambient-selections',
        HAPPIER_STACK_PROCESS_KIND: 'plugin-spoof',
        TMUX_SESSION_NAME: 'ambient-tmux',
      },
      canonicalSessionControlEnvironment: {
        HAPPIER_SESSION_PROFILE_ID: 'canonical-profile',
        HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: 'canonical-selections',
      },
      enableCgroupSelfMigration: false,
      stackProcessKind: 'session',
    });

    expect(env).toMatchObject({
      PATH: '/bin',
      SAFE_VALUE: 'kept',
      HAPPIER_SESSION_PROFILE_ID: 'canonical-profile',
      HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: 'canonical-selections',
      HAPPIER_STACK_PROCESS_KIND: 'session',
    });
    expect(env.HAPPIER_SESSION_ATTACH_FILE).toBeUndefined();
    expect(env.TMUX_SESSION_NAME).toBeUndefined();
  });

  it('rejects non-control values in the trusted control channel', () => {
    expect(() => finalizeSessionChildEnvironment({
      environment: { PATH: '/bin' },
      canonicalSessionControlEnvironment: { OPENAI_API_KEY: 'must-not-pass' },
      enableCgroupSelfMigration: false,
      stackProcessKind: null,
    })).toThrow(/session-control environment key/u);

    expect(() => finalizeSessionChildEnvironment({
      environment: { PATH: '/bin' },
      canonicalSessionControlEnvironment: { happier_session_profile_id: 'wrong-case' },
      enableCgroupSelfMigration: false,
      stackProcessKind: null,
    })).toThrow(/session-control environment key/u);
  });
});
