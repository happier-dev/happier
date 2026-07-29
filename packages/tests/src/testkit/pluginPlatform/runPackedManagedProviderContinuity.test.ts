import { describe, expect, it } from 'vitest';

import {
  assertPackedManagedProviderContinuityContract,
  type PackedManagedProviderContinuityContractEvidence,
} from '../../plugin-platform/packedManagedProviderComposedRuntime';
import {
  PackedManagedProviderEntrypointError,
  type PackedManagedProviderFailureDiagnostics,
  type PackedManagedProviderHarnessEvidence,
} from '../../plugin-platform/runPackedManagedProviderVertical';
import {
  serializePackedManagedProviderContinuityFailure,
} from '../../plugin-platform/runPackedManagedProviderContinuity';

describe('packed managed Provider continuity failure output', () => {
  it('serializes only secret-safe evidence and omits the raw cause', () => {
    const rawCauseSecret = 'raw-cause-secret-value';
    const failureDiagnostics: PackedManagedProviderFailureDiagnostics = {
      schemaVersion: 1,
      code:
        'packed_managed_provider_candidate_daemon_exited_before_state',
      phase: 'waitForDaemonState',
      process: {
        exitCode: 1,
        signalCode: null,
      },
      daemonState: {
        everWritten: false,
        everRemoved: false,
        lastCandidateCount: 0,
      },
      logs: {
        stdout: {
          byteCount: 0,
          tail: null,
        },
        stderr: {
          byteCount: 24,
          tail: 'candidate daemon failed',
        },
      },
    };
    const evidence: PackedManagedProviderHarnessEvidence = {
      candidateFrozen: true,
      standaloneCliFrozen: true,
      candidateArchiveCensus: {
        sdk: { entryCount: 1 },
        cli: { entryCount: 1 },
      },
      standaloneCliArchiveEntryCount: 1,
      hostTarget: {
        os: 'darwin',
        arch: 'arm64',
      },
      isolation: {
        happyHomeDir: '/private/harness/home',
        databasePath: '/private/harness/database.sqlite',
        workspaceDir: '/private/harness/workspace',
        openCodeStateDir: '/private/harness/opencode',
        ports: {
          server: 41_001,
          daemon: 41_002,
          wrapper: 41_003,
        },
        stockCliProxyApiPort: 8317,
        stockCliProxyApiTouched: false,
      },
      failureDiagnostics,
      cleanup: { disposition: 'removed' },
    };
    const error = new PackedManagedProviderEntrypointError({
      code: failureDiagnostics.code,
      evidence,
      cause: new Error(`unsafe ${rawCauseSecret}`),
    });

    const serialized =
      serializePackedManagedProviderContinuityFailure(error);

    expect(JSON.parse(serialized)).toMatchObject({
      schemaVersion: 1,
      kind: 'packed_managed_provider_daemon_continuity_error',
      status: 'failed',
      code: failureDiagnostics.code,
      evidence: {
        failureDiagnostics,
        cleanup: { disposition: 'removed' },
      },
    });
    expect(serialized).not.toContain(rawCauseSecret);
    expect(serialized).not.toContain('cause');
  });
});

describe('packed managed Provider continuity contract', () => {
  const rotation = {
    managedCapabilityPathStable: true,
    agentCapabilityPathStable: true,
    managedCapabilityRotated: true,
    agentCapabilityRotated: true,
    oldManagedCapabilityStatus: 401,
    freshManagedCapabilityStatus: 200,
    oldAgentCapabilityStatus: 401,
    freshAgentCapabilityStatus: 200,
    capabilityInvalidReadCount: 0,
    currentDaemonTupleRecovered: true,
  } as const;
  const validEvidence: PackedManagedProviderContinuityContractEvidence = {
    gracefulTakeover: rotation,
    preLeaseCrash: {
      replacement: rotation,
      responseStatus: 503,
      managedBrokerAttemptCount: 1,
      managedBrokerUnauthorizedCount: 1,
      agentBrokerAttemptCount: 1,
      agentBrokerUnauthorizedCount: 1,
      agentPendingLocalId: 'pending-during-replacement',
      agentCommittedLocalIdCount: 1,
      agentTurnFailedCount: 1,
      agentLatestTurnStatus: 'failed',
      agentTransportUnavailableObserved: true,
      agentFailedTurnFalselyCompleted: false,
      upstreamEffectCount: 0,
      replayAttemptCount: 0,
      tupleChangedBeforeRefusal: true,
    },
    postLeaseCrash: {
      replacement: rotation,
      upstreamAttemptCount: 1,
      authorizationFingerprintMatched: true,
      responseCompletedAfterCrash: true,
      replayAttemptCount: 0,
    },
    idleNextInput: {
      pendingLocalId: 'pending-after-replacement',
      committedLocalIdCount: 1,
      upstreamAttemptCount: 1,
      agentBrokerStatuses: [200],
      managedBrokerStatuses: [200],
      brokerUnauthorizedCount: 0,
      replayAttemptCount: 0,
      turnFailedCount: 1,
      latestTurnStatus: 'failed',
      failedTurnFalselyCompleted: false,
      currentCapabilityDaemonTupleUsed: true,
    },
  };

  it('accepts only the exact paired-capability and request-effect continuity evidence', () => {
    expect(() =>
      assertPackedManagedProviderContinuityContract(validEvidence)
    ).not.toThrow();
  });

  it.each([
    [
      'an Agent capability left stale',
      {
        ...validEvidence,
        gracefulTakeover: {
          ...rotation,
          agentCapabilityRotated: false,
        },
      },
    ],
    [
      'a publication-gap request reaching the Provider',
      {
        ...validEvidence,
        preLeaseCrash: {
          ...validEvidence.preLeaseCrash,
          upstreamEffectCount: 1,
        },
      },
    ],
    [
      'a post-lease replay',
      {
        ...validEvidence,
        postLeaseCrash: {
          ...validEvidence.postLeaseCrash,
          replayAttemptCount: 1,
        },
      },
    ],
    [
      'a mismatched Pending settlement',
      {
        ...validEvidence,
        idleNextInput: {
          ...validEvidence.idleNextInput,
          committedLocalIdCount: 0,
        },
      },
    ],
    [
      'a hidden failed turn before false completion',
      {
        ...validEvidence,
        idleNextInput: {
          ...validEvidence.idleNextInput,
          latestTurnStatus: 'completed',
          failedTurnFalselyCompleted: true,
        },
      },
    ],
  ])('rejects %s', (_label, evidence) => {
    expect(() =>
      assertPackedManagedProviderContinuityContract(
        evidence as PackedManagedProviderContinuityContractEvidence,
      )
    ).toThrow();
  });
});
