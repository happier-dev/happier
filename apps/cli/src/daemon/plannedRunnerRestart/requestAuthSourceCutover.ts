import {
  CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV,
} from '@happier-dev/agents/request-auth';

import type { TrackedSession } from '@/daemon/types';
import { canonicalAbsolutePathsEqual } from '@/utils/path/expandHomeDirPath';

const REMOTE_REQUEST_AUTH_SOURCES = [
  {
    environmentKey: 'HAPPIER_OPENCODE_BROKER_STATE_PATH',
    kind: 'remote_opencode_broker_state',
  },
  {
    environmentKey: 'HAPPIER_PI_BROKER_STATE_PATH',
    kind: 'remote_pi_broker_state',
  },
] as const;

export type RequestAuthSourceCutoverSource =
  | Readonly<{
    kind: 'dev_request_auth_capability';
    environmentKey:
      typeof CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV;
    path: string;
  }>
  | Readonly<{
    kind: 'remote_opencode_broker_state';
    environmentKey: 'HAPPIER_OPENCODE_BROKER_STATE_PATH';
    path: string;
  }>
  | Readonly<{
    kind: 'remote_pi_broker_state';
    environmentKey: 'HAPPIER_PI_BROKER_STATE_PATH';
    path: string;
  }>;

export type RequestAuthSourceCutoverRequirement = Readonly<{
  sessionId: string;
  runnerPid: number;
  processCommandHash: string;
  processStartTimeMs: number;
  source: RequestAuthSourceCutoverSource;
  currentCapabilityPath: string;
}>;

export type RequestAuthSourceCutoverRequirementResolution =
  | Readonly<{ status: 'current' }>
  | Readonly<{
    status: 'unavailable';
    reason:
      | 'current_capability_path_unavailable'
      | 'runner_identity_unavailable'
      | 'current_capability_path_conflict'
      | 'remote_source_evidence_unavailable'
      | 'remote_source_evidence_ambiguous';
  }>
  | Readonly<{
    status: 'required';
    requirement: RequestAuthSourceCutoverRequirement;
  }>;

function normalizeOptionalString(value: unknown): string | null {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized || null;
}

function readTrackedCapabilityPath(
  tracked: TrackedSession,
): string | null {
  return normalizeOptionalString(
    tracked.spawnOptions?.environmentVariables?.[
      CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV
    ],
  );
}

function readRemoteRequestAuthSource(
  tracked: TrackedSession,
):
  | Readonly<{
    status: 'available';
    source: RequestAuthSourceCutoverSource;
  }>
  | Readonly<{
    status: 'unavailable';
    reason:
      | 'remote_source_evidence_unavailable'
      | 'remote_source_evidence_ambiguous';
  }> {
  const environment =
    tracked.spawnOptions?.environmentVariables ?? {};
  const observed: RequestAuthSourceCutoverSource[] = [];
  for (const candidate of REMOTE_REQUEST_AUTH_SOURCES) {
    const path = normalizeOptionalString(
      environment[candidate.environmentKey],
    );
    if (
      !path
      || !canonicalAbsolutePathsEqual(path, path)
    ) {
      continue;
    }
    observed.push(
      candidate.kind === 'remote_opencode_broker_state'
        ? {
            kind: 'remote_opencode_broker_state',
            environmentKey:
              'HAPPIER_OPENCODE_BROKER_STATE_PATH',
            path,
          }
        : {
            kind: 'remote_pi_broker_state',
            environmentKey:
              'HAPPIER_PI_BROKER_STATE_PATH',
            path,
          },
    );
  }
  if (observed.length === 0) {
    return {
      status: 'unavailable',
      reason: 'remote_source_evidence_unavailable',
    };
  }
  if (observed.length !== 1) {
    return {
      status: 'unavailable',
      reason: 'remote_source_evidence_ambiguous',
    };
  }
  return {
    status: 'available',
    source: observed[0]!,
  };
}

function readRetainedRequestAuthSource(
  tracked: TrackedSession,
  ownedRetainedDevCapabilityPaths:
    readonly string[],
):
  | Readonly<{
    status: 'available';
    source: RequestAuthSourceCutoverSource;
  }>
  | Readonly<{
    status: 'unavailable';
    reason:
      | 'current_capability_path_conflict'
      | 'remote_source_evidence_unavailable'
      | 'remote_source_evidence_ambiguous';
  }> {
  const capabilityPath = readTrackedCapabilityPath(tracked);
  if (capabilityPath) {
    if (
      !canonicalAbsolutePathsEqual(capabilityPath, capabilityPath)
      || !ownedRetainedDevCapabilityPaths.some((expectedPath) =>
        canonicalAbsolutePathsEqual(
          capabilityPath,
          expectedPath,
        ))
    ) {
      return {
        status: 'unavailable',
        reason: 'current_capability_path_conflict',
      };
    }
    return {
      status: 'available',
      source: {
        kind: 'dev_request_auth_capability',
        environmentKey:
          CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV,
        path: capabilityPath,
      },
    };
  }
  return readRemoteRequestAuthSource(tracked);
}

/**
 * Compares the reattached runner's retained request-auth contract with the
 * current plugin materialization contract. An exact older Dev capability path
 * or either prospective Remote request-auth source can authorize this cutover.
 * The retained source stays opaque: Dev proves its exact path, but does not
 * parse or reproduce the predecessor contract.
 */
export function resolveRequestAuthSourceCutoverRequirement(
  input: Readonly<{
    tracked: TrackedSession;
    currentCapabilityPath: string;
    ownedRetainedDevCapabilityPaths?: readonly string[];
  }>,
): RequestAuthSourceCutoverRequirementResolution {
  const currentCapabilityPath =
    normalizeOptionalString(input.currentCapabilityPath);
  if (
    !currentCapabilityPath
    || !canonicalAbsolutePathsEqual(
      currentCapabilityPath,
      currentCapabilityPath,
    )
  ) {
    return {
      status: 'unavailable',
      reason: 'current_capability_path_unavailable',
    };
  }

  const sessionId = normalizeOptionalString(input.tracked.happySessionId);
  const processCommandHash =
    normalizeOptionalString(input.tracked.processCommandHash);
  const processStartTimeMs = input.tracked.processStartTimeMs;
  if (
    !sessionId
    || !Number.isInteger(input.tracked.pid)
    || input.tracked.pid <= 0
    || !processCommandHash
    || typeof processStartTimeMs !== 'number'
    || !Number.isInteger(processStartTimeMs)
    || processStartTimeMs < 0
  ) {
    return {
      status: 'unavailable',
      reason: 'runner_identity_unavailable',
    };
  }

  const observedCapabilityPath =
    readTrackedCapabilityPath(input.tracked);
  if (
    observedCapabilityPath
    && canonicalAbsolutePathsEqual(
      observedCapabilityPath,
      currentCapabilityPath,
    )
  ) {
    return { status: 'current' };
  }
  const retainedSource =
    readRetainedRequestAuthSource(
      input.tracked,
      input.ownedRetainedDevCapabilityPaths ?? [],
    );
  if (retainedSource.status === 'unavailable') {
    return retainedSource;
  }

  return {
    status: 'required',
    requirement: {
      sessionId,
      runnerPid: input.tracked.pid,
      processCommandHash,
      processStartTimeMs,
      source: retainedSource.source,
      currentCapabilityPath,
    },
  };
}

export function isRequestAuthSourceCutoverRequirementCurrent(
  input: Readonly<{
    requirement: RequestAuthSourceCutoverRequirement;
    tracked: TrackedSession;
    currentCapabilityPath: string;
  }>,
): boolean {
  const sessionId = normalizeOptionalString(input.tracked.happySessionId);
  const processCommandHash =
    normalizeOptionalString(input.tracked.processCommandHash);
  const retainedSource =
    input.requirement.source.kind
      === 'dev_request_auth_capability'
      ? (() => {
        const capabilityPath =
          readTrackedCapabilityPath(input.tracked);
        return capabilityPath
          && canonicalAbsolutePathsEqual(
            capabilityPath,
            input.requirement.source.path,
          )
          ? {
            status: 'available' as const,
            source: {
              ...input.requirement.source,
              path: capabilityPath,
            },
          }
          : {
            status: 'unavailable' as const,
            reason:
              'current_capability_path_conflict' as const,
          };
      })()
      : readRemoteRequestAuthSource(input.tracked);
  const currentCapabilityPath =
    normalizeOptionalString(input.currentCapabilityPath);
  return sessionId === input.requirement.sessionId
    && input.tracked.pid === input.requirement.runnerPid
    && processCommandHash === input.requirement.processCommandHash
    && input.tracked.processStartTimeMs
      === input.requirement.processStartTimeMs
    && currentCapabilityPath !== null
    && canonicalAbsolutePathsEqual(
      currentCapabilityPath,
      input.requirement.currentCapabilityPath,
    )
    && retainedSource.status === 'available'
    && retainedSource.source.kind === input.requirement.source.kind
    && retainedSource.source.environmentKey
      === input.requirement.source.environmentKey
    && canonicalAbsolutePathsEqual(
      retainedSource.source.path,
      input.requirement.source.path,
    );
}
