import { describe, expect, it } from 'vitest';
import {
  CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV,
} from '@happier-dev/plugin-sdk/connected-accounts';

import type { TrackedSession } from '@/daemon/types';

import {
  isRequestAuthSourceCutoverRequirementCurrent,
  resolveRequestAuthSourceCutoverRequirement,
} from './requestAuthSourceCutover';

function trackedSession(overrides: Partial<TrackedSession> = {}): TrackedSession {
  return {
    startedBy: 'daemon',
    pid: 4242,
    happySessionId: 'sess-1',
    processCommandHash: 'hash-1',
    processStartTimeMs: 12_345,
    spawnOptions: {
      directory: '/tmp/workspace',
      backendTarget: {
        kind: 'backend',
        backendId: 'opencode',
        sourceKind: 'built_in',
      },
      environmentVariables: {},
    },
    ...overrides,
  };
}

describe('request-auth source cutover requirement', () => {
  const currentCapabilityPath =
    '/tmp/materialized/csm-1/request-auth/capability.json';

  it('keeps a same-generation runner that already carries the current V2 capability path', () => {
    const tracked = trackedSession({
      spawnOptions: {
        ...trackedSession().spawnOptions!,
        environmentVariables: {
          [CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV]:
            currentCapabilityPath,
        },
      },
    });

    expect(resolveRequestAuthSourceCutoverRequirement({
      tracked,
      currentCapabilityPath,
    })).toEqual({
      status: 'current',
    });
  });

  it.each([
    [
      'OpenCode',
      'HAPPIER_OPENCODE_BROKER_STATE_PATH',
      'remote_opencode_broker_state',
    ],
    [
      'Pi',
      'HAPPIER_PI_BROKER_STATE_PATH',
      'remote_pi_broker_state',
    ],
  ])(
    'returns an exact typed pre-effect requirement for a retained Remote %s source path',
    (_agent, predecessorStatePathEnv, sourceKind) => {
    const predecessorStatePath =
      '/tmp/materialized/csm-1/connected-service-broker.state.json';
    const tracked = trackedSession({
      spawnOptions: {
        ...trackedSession().spawnOptions!,
        environmentVariables: {
          [predecessorStatePathEnv]:
            predecessorStatePath,
        },
      },
    });

    const resolved = resolveRequestAuthSourceCutoverRequirement({
      tracked,
      currentCapabilityPath,
    });

    expect(resolved).toEqual({
      status: 'required',
      requirement: {
        sessionId: 'sess-1',
        runnerPid: 4242,
        processCommandHash: 'hash-1',
        processStartTimeMs: 12_345,
        source: {
          kind: sourceKind,
          environmentKey: predecessorStatePathEnv,
          path: predecessorStatePath,
        },
        currentCapabilityPath,
      },
    });
    if (resolved.status !== 'required') {
      throw new Error('Expected source cutover requirement');
    }
    expect(isRequestAuthSourceCutoverRequirementCurrent({
      requirement: resolved.requirement,
      tracked,
      currentCapabilityPath,
    })).toBe(true);
    expect(isRequestAuthSourceCutoverRequirementCurrent({
      requirement: resolved.requirement,
      tracked: { ...tracked, pid: 4343 },
      currentCapabilityPath,
    })).toBe(false);
    expect(isRequestAuthSourceCutoverRequirementCurrent({
      requirement: resolved.requirement,
      tracked: {
        ...tracked,
        happySessionId: 'sess-replaced',
      },
      currentCapabilityPath,
    })).toBe(false);
    expect(isRequestAuthSourceCutoverRequirementCurrent({
      requirement: resolved.requirement,
      tracked: {
        ...tracked,
        processCommandHash: 'hash-replaced',
      },
      currentCapabilityPath,
    })).toBe(false);
    expect(isRequestAuthSourceCutoverRequirementCurrent({
      requirement: resolved.requirement,
      tracked: { ...tracked, processStartTimeMs: 12_346 },
      currentCapabilityPath,
    })).toBe(false);
    expect(isRequestAuthSourceCutoverRequirementCurrent({
      requirement: resolved.requirement,
      tracked,
      currentCapabilityPath:
        '/tmp/materialized/csm-2/request-auth/capability.json',
    })).toBe(false);
    expect(isRequestAuthSourceCutoverRequirementCurrent({
      requirement: resolved.requirement,
      tracked: {
        ...tracked,
        spawnOptions: {
          ...tracked.spawnOptions!,
          environmentVariables: {
            [predecessorStatePathEnv]:
              '/tmp/materialized/csm-2/connected-service-broker.state.json',
          },
        },
      },
      currentCapabilityPath,
    })).toBe(false);
    },
  );

  it('fails closed without one exact Remote source witness', () => {
    expect(resolveRequestAuthSourceCutoverRequirement({
      tracked: trackedSession(),
      currentCapabilityPath,
    })).toEqual({
      status: 'unavailable',
      reason: 'remote_source_evidence_unavailable',
    });
    expect(resolveRequestAuthSourceCutoverRequirement({
      tracked: trackedSession({
        spawnOptions: {
          ...trackedSession().spawnOptions!,
          environmentVariables: {
            HAPPIER_UNKNOWN_BROKER_STATE_PATH:
              '/tmp/materialized/csm-1/unknown.state.json',
          },
        },
      }),
      currentCapabilityPath,
    })).toEqual({
      status: 'unavailable',
      reason: 'remote_source_evidence_unavailable',
    });
    expect(resolveRequestAuthSourceCutoverRequirement({
      tracked: trackedSession({
        spawnOptions: {
          ...trackedSession().spawnOptions!,
          environmentVariables: {
            HAPPIER_OPENCODE_BROKER_STATE_PATH:
              '/tmp/materialized/csm-1/opencode.state.json',
            HAPPIER_PI_BROKER_STATE_PATH:
              '/tmp/materialized/csm-1/pi.state.json',
          },
        },
      }),
      currentCapabilityPath,
    })).toEqual({
      status: 'unavailable',
      reason: 'remote_source_evidence_ambiguous',
    });
  });

  it('lets an exact current V2 path win over inert Remote residue', () => {
    expect(resolveRequestAuthSourceCutoverRequirement({
      tracked: trackedSession({
        spawnOptions: {
          ...trackedSession().spawnOptions!,
          environmentVariables: {
            [CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV]:
              currentCapabilityPath,
            HAPPIER_OPENCODE_BROKER_STATE_PATH:
              '/tmp/materialized/csm-1/opencode.state.json',
          },
        },
      }),
      currentCapabilityPath,
    })).toEqual({ status: 'current' });
  });

  it('requires a safe-boundary rematerialization when a retained Dev runner carries an older immutable snapshot capability path', () => {
    const previousCapabilityPath =
      '/tmp/connected-services/homes/openai-codex/account-1/opencode/request-auth/capability.json';
    const tracked = trackedSession({
      spawnOptions: {
        ...trackedSession().spawnOptions!,
        environmentVariables: {
          [CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV]:
            previousCapabilityPath,
        },
      },
    });

    const resolved = resolveRequestAuthSourceCutoverRequirement({
      tracked,
      currentCapabilityPath,
      ownedRetainedDevCapabilityPaths: [
        previousCapabilityPath,
      ],
    });

    expect(resolved).toEqual({
      status: 'required',
      requirement: {
        sessionId: 'sess-1',
        runnerPid: 4242,
        processCommandHash: 'hash-1',
        processStartTimeMs: 12_345,
        source: {
          kind: 'dev_request_auth_capability',
          environmentKey:
            CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV,
          path: previousCapabilityPath,
        },
        currentCapabilityPath,
      },
    });
    if (resolved.status !== 'required') {
      throw new Error('Expected source cutover requirement');
    }
    expect(isRequestAuthSourceCutoverRequirementCurrent({
      requirement: resolved.requirement,
      tracked,
      currentCapabilityPath,
    })).toBe(true);
    expect(isRequestAuthSourceCutoverRequirementCurrent({
      requirement: resolved.requirement,
      tracked: {
        ...tracked,
        spawnOptions: {
          ...tracked.spawnOptions!,
          environmentVariables: {
            [CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV]:
              '/tmp/connected-services/homes/openai-codex/account-2/opencode/request-auth/capability.json',
          },
        },
      },
      currentCapabilityPath,
    })).toBe(false);
  });

  it('compares current capability paths by canonical cross-platform identity', () => {
    const tracked = trackedSession({
      spawnOptions: {
        ...trackedSession().spawnOptions!,
        environmentVariables: {
          [CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV]:
            'c:/Users/Alice/materialized/request-auth/capability.json',
        },
      },
    });

    expect(resolveRequestAuthSourceCutoverRequirement({
      tracked,
      currentCapabilityPath:
        'C:\\Users\\Alice\\materialized\\request-auth\\capability.json',
    })).toEqual({ status: 'current' });
  });

  it('rejects a non-absolute retained Dev capability path as a conflict rather than rematerialization authority', () => {
    expect(resolveRequestAuthSourceCutoverRequirement({
      tracked: trackedSession({
        spawnOptions: {
          ...trackedSession().spawnOptions!,
          environmentVariables: {
            [CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV]:
              'request-auth/capability.json',
          },
        },
      }),
      currentCapabilityPath,
    })).toEqual({
      status: 'unavailable',
      reason: 'current_capability_path_conflict',
    });
  });

  it('rejects an absolute Dev capability path outside the exact historical materialization owner', () => {
    const foreignCapabilityPath =
      '/tmp/foreign/request-auth/capability.json';
    expect(resolveRequestAuthSourceCutoverRequirement({
      tracked: trackedSession({
        spawnOptions: {
          ...trackedSession().spawnOptions!,
          environmentVariables: {
            [CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV]:
              foreignCapabilityPath,
          },
        },
      }),
      currentCapabilityPath,
      ownedRetainedDevCapabilityPaths: [
        '/tmp/connected-services/homes/openai-codex/account-1/opencode/request-auth/capability.json',
      ],
    })).toEqual({
      status: 'unavailable',
      reason: 'current_capability_path_conflict',
    });
  });

  it('fails closed when exact runner identity is unavailable', () => {
    expect(resolveRequestAuthSourceCutoverRequirement({
      tracked: trackedSession({ processCommandHash: undefined }),
      currentCapabilityPath,
    })).toEqual({
      status: 'unavailable',
      reason: 'runner_identity_unavailable',
    });
    expect(resolveRequestAuthSourceCutoverRequirement({
      tracked: trackedSession({ processStartTimeMs: undefined }),
      currentCapabilityPath,
    })).toEqual({
      status: 'unavailable',
      reason: 'runner_identity_unavailable',
    });
  });
});
