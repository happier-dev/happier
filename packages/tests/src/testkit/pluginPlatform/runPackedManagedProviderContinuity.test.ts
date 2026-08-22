import { readFile, rm, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  AgentExternalSessionTranscriptRawRecordSchema,
  resolveTranscriptBodySemanticEvent,
} from '@happier-dev/protocol';

import {
  assertPackedCandidatePublicExternalSessionsPrivacy,
  assertPackedManagedProviderCandidateHandoffContract,
  assertPackedManagedProviderSafeRestartContract,
  assertPackedManagedProviderContinuityContract,
  countCandidateHandoffRevokedSentinelEffects,
  derivePackedCandidatePublicGeneration,
  isPackedCandidateMaterializeActionResult,
  isPackedCandidateOperationActionResult,
  isPackedCandidatePublicListPage,
  isPackedCandidateRetiredFollowCursorEvidence,
  isPackedCandidateRetiredListCursorEvidence,
  sameCandidateRunnerIdentity,
  writeCandidateHandoffAgentSource,
  type PackedManagedProviderCandidateHandoffContractEvidence,
  type PackedManagedProviderSafeRestartContractEvidence,
  type PackedManagedProviderContinuityContractEvidence,
} from '../../plugin-platform/packedManagedProviderComposedRuntime';
import * as packedManagedProviderComposedRuntime from '../../plugin-platform/packedManagedProviderComposedRuntime';
import {
  projectRetainedPluginLifecycleEvidence,
} from '../providers/harness/daemonRunnerContinuity';
import {
  PackedManagedProviderEntrypointError,
  type PackedManagedProviderEntrypointResult,
  type PackedManagedProviderFailureDiagnostics,
  type PackedManagedProviderHarnessEvidence,
} from '../../plugin-platform/runPackedManagedProviderVertical';
import {
  runPackedExternalSessionsCandidateContinuity,
  serializePackedManagedProviderContinuitySuccess,
  serializePackedManagedProviderContinuityFailure,
} from '../../plugin-platform/runPackedManagedProviderContinuity';

describe('packed managed Provider continuity failure output', () => {
  it('does not retain the packed Channel lifecycle as a deferred outcome', () => {
    expect((packedManagedProviderComposedRuntime as {
      PackedChannelProviderLoadedLifecycleDeferredError?: unknown;
    }).PackedChannelProviderLoadedLifecycleDeferredError).toBeUndefined();
  });

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
          tail:
            'candidate daemon failed at /private/harness/home with credential-secret',
        },
      },
    };
    const evidence: PackedManagedProviderHarnessEvidence = {
      candidateFrozen: true,
      standaloneCliFrozen: true,
      candidateArchiveCensus: {
        sdk: { entryCount: 1 },
        pluginUi: { entryCount: 1 },
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
          upstreamProxy: 41_003,
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
        candidateFrozen: true,
        standaloneCliFrozen: true,
        candidateArchiveCensus: {
          sdk: { entryCount: 1 },
          pluginUi: { entryCount: 1 },
          cli: { entryCount: 1 },
        },
        standaloneCliArchiveEntryCount: 1,
        hostTarget: { os: 'darwin', arch: 'arm64' },
        stockCliProxyApiTouched: false,
        failureDiagnostics: {
          schemaVersion: 1,
          code: failureDiagnostics.code,
          phase: 'waitForDaemonState',
          process: { exitCode: 1, signalCode: null },
          daemonState: {
            everWritten: false,
            everRemoved: false,
            lastCandidateCount: 0,
          },
          logs: {
            stdout: { byteCount: 0 },
            stderr: { byteCount: 24 },
          },
        },
        cleanup: { disposition: 'removed' },
      },
    });
    expect(serialized).not.toContain(rawCauseSecret);
    expect(serialized).not.toContain('cause');
    expect(serialized).not.toContain('/private/harness');
    expect(serialized).not.toContain('credential-secret');
    expect(serialized).not.toContain('41001');
  });

  it('converts an unexpected failure into a bounded code without a raw stack', () => {
    const serialized = serializePackedManagedProviderContinuityFailure(
      new Error(
        'unexpected failure at /private/harness/home with credential-secret',
      ),
    );

    expect(JSON.parse(serialized)).toEqual({
      schemaVersion: 1,
      kind: 'packed_managed_provider_daemon_continuity_error',
      status: 'failed',
      code: 'packed_managed_provider_execution_failed',
      evidence: null,
    });
    expect(serialized).not.toContain('/private/harness');
    expect(serialized).not.toContain('credential-secret');
    expect(serialized).not.toContain('stack');
  });

  it('reports the bounded first current-source phase without exposing its cause', () => {
    const CurrentSourceExecutionError = (packedManagedProviderComposedRuntime as {
      PackedCurrentSourceExternalSessionsExecutionError?: new (input: Readonly<{
        stage: 'sdk-registry';
        cause: unknown;
      }>) => Error;
    }).PackedCurrentSourceExternalSessionsExecutionError;

    expect(CurrentSourceExecutionError).toBeTypeOf('function');
    if (!CurrentSourceExecutionError) return;

    const serialized = serializePackedManagedProviderContinuityFailure(
      new CurrentSourceExecutionError({
        stage: 'sdk-registry',
        cause: new AggregateError(
          [
            new Error(
              'packed_current_source_external_sessions_sdk_pack_identity_invalid:credential-secret:/private/harness:stdout:stderr',
            ),
            new Error('cleanup-secret:/private/cleanup'),
          ],
          'aggregate-secret',
        ),
      }),
    );

    expect(JSON.parse(serialized)).toEqual({
      schemaVersion: 1,
      kind: 'packed_managed_provider_daemon_continuity_error',
      status: 'failed',
      code: 'packed_current_source_external_sessions_execution_failed',
      stage: 'sdk-registry',
      causeCode:
        'packed_current_source_external_sessions_sdk_pack_identity_invalid',
      evidence: null,
    });
    expect(serialized).not.toContain('credential-secret');
    expect(serialized).not.toContain('cleanup-secret');
    expect(serialized).not.toContain('aggregate-secret');
    expect(serialized).not.toContain('/private/');
    expect(serialized).not.toContain('stdout');
    expect(serialized).not.toContain('stderr');
    expect(serialized).not.toContain('stack');
  });

  it('strips dynamic suffixes from internal failure codes', () => {
    const serialized = serializePackedManagedProviderContinuityFailure(
      new Error(
        'packed_managed_provider_public_session_spawn_failed:500:credential-secret',
      ),
    );

    expect(JSON.parse(serialized)).toMatchObject({
      code: 'packed_managed_provider_public_session_spawn_failed',
      evidence: null,
    });
    expect(serialized).not.toContain('credential-secret');
  });

  it('binds the packed Channel fixture source and manifest to one private TLS loopback origin', async () => {
    const createArchiveBoundPackedChannelProviderFixture = (
      packedManagedProviderComposedRuntime as {
        createArchiveBoundPackedChannelProviderFixture?: (input: Readonly<{
          source: string;
          manifest: unknown;
          origin: string;
        }>) => Readonly<{
          source: string;
          manifest: unknown;
        }>;
      }
    ).createArchiveBoundPackedChannelProviderFixture;
    expect(createArchiveBoundPackedChannelProviderFixture).toBeTypeOf('function');
    if (!createArchiveBoundPackedChannelProviderFixture) return;

    const fixtureRoot = fileURLToPath(new URL(
      '../../../fixtures/plugin-platform/out-of-tree-channel-socket-provider/',
      import.meta.url,
    ));
    const source = await readFile(join(fixtureRoot, 'src', 'index.mjs'), 'utf8');
    const manifest = JSON.parse(await readFile(
      join(fixtureRoot, '.happier-plugin', 'plugin.json'),
      'utf8',
    )) as unknown;
    const origin = 'https://127.0.0.1:43123';

    const staged = createArchiveBoundPackedChannelProviderFixture({
      source,
      manifest,
      origin,
    });

    expect(staged.source).toContain(
      "const FIXTURE_ORIGIN = 'https://127.0.0.1:43123';",
    );
    expect(staged.source).toContain('privateNetwork: true,');
    expect(staged.source).not.toContain('channels-fixture.invalid');
    expect(staged.manifest).toMatchObject({
      hostAccess: {
        required: [{
          id: 'fixture-network-client',
          capability: 'network.client',
          scope: {
            targets: [{ kind: 'fixedOrigin', origin }],
            transports: ['websocket'],
            privateNetwork: true,
          },
        }],
      },
    });
    expect(JSON.stringify(staged.manifest)).not.toContain(
      'channels-fixture.invalid',
    );
    expect(source).toContain('channels-fixture.invalid');
  });
});

describe('packed managed Provider continuity success output', () => {
  it('reaches the External Sessions handoff without a deferred Channel probe', async () => {
    const calls: string[] = [];
    const sentinel = new Error('packed-external-sessions-handoff-reached');

    await expect(runPackedExternalSessionsCandidateContinuity({
      candidateManifestPath: '/candidate/candidate.json',
      enableOpenCodeLive: false,
    }, {
      composed: {
        probePublicProviderActivation: async () => {
          throw new Error('packed-external-sessions-wrapper-not-needed');
        },
        probeFreshManagedSpawn: async () => {
          calls.push('fresh');
          return {
            publicActivationReason: 'sessionDemand',
            spawnRequestIncludedSessionId: false,
            returnedSessionId: 'session-1',
            publicSessionId: 'session-1',
            upstreamRequestsBeforeCanonicalSession: 0,
            managedPurpose: 'openai-upstream',
            agentPurpose: 'openai-codex-model-request',
            connectionRevision: 1,
            credentialRevision: 'revision-1',
            upstreamAuthorizationFingerprint: `sha256:${'a'.repeat(64)}`,
            managedRequestAuthOrigin: 'https://chatgpt.com',
            upstreamConnectTarget: 'chatgpt.com:443',
            currentAccessTokenFingerprint: `sha256:${'a'.repeat(64)}`,
            promptSentinelObserved: true,
            upstreamRequestPath: '/backend-api/codex/responses',
            timeline: {
              freshSpawnStartedAtMs: 1,
              canonicalSessionRegisteredAtMs: 2,
              spawnAcknowledgedAtMs: 3,
              providerAttemptAtMs: 4,
            },
            observedPorts: {
              server: 41_001,
              serverProxy: 41_002,
              daemon: 41_003,
              upstreamProxy: 41_004,
            },
            stockPortRequestCount: 0,
            stockPortOsConnectionAttemptCount: 0,
            stockListenerIdentityBefore: `sha256:${'b'.repeat(64)}`,
            stockListenerIdentityAfter: `sha256:${'b'.repeat(64)}`,
            providerProcess: {
              pid: 41,
              executablePath: '/candidate/happier',
              executableMatchedCandidate: true,
            },
            providerProcessCountForSessionDemand: 1,
          };
        },
        probeManagedDaemonContinuity: async () => {
          calls.push('continuity');
          return {
            contract: validContinuityContract,
            sessionP: {
              sessionId: 'session-p',
              providerPid: 42,
              providerExecutablePath: '/candidate/happier',
            },
            daemonPids: [1, 2, 3],
            sessionQ: {
              sessionId: 'session-q',
              providerPid: 43,
              providerExecutablePath: '/candidate/happier',
            },
          };
        },
        probeCandidateExternalAgentProviderHandoff: async () => {
          calls.push('external-handoff');
          return { contract: validCandidateHandoffContract };
        },
        probeManagedRecoveryRefusal: async () => {
          calls.push('recovery');
          return {
            publicActivationReason: 'sessionDemand',
            activationRefused: true,
            spawnAcknowledged: false,
            providerStarted: false,
            upstreamAttempted: false,
            activeSessionPreserved: true,
          };
        },
        probeActivationFailureCleanup: async () => {
          throw new Error('packed-external-sessions-activation-cleanup-not-needed');
        },
        cleanup: async () => undefined,
      },
      runEntrypoint: async (_input, deps) => {
        await deps.scenario.runFreshManagedSequence(
          {} as Parameters<typeof deps.scenario.runFreshManagedSequence>[0],
        );
        throw sentinel;
      },
    })).rejects.toBe(sentinel);

    expect(calls).toEqual([
      'fresh',
      'recovery',
      'external-handoff',
      'continuity',
    ]);
  });

  it('emits a bounded contract summary without path-bearing local observations', () => {
    const harnessEvidence: PackedManagedProviderHarnessEvidence = {
      candidateFrozen: true,
      standaloneCliFrozen: true,
      candidateArchiveCensus: {
        sdk: { entryCount: 11 },
        pluginUi: { entryCount: 22 },
        cli: { entryCount: 22 },
      },
      standaloneCliArchiveEntryCount: 33,
      hostTarget: { os: 'darwin', arch: 'arm64' },
      isolation: {
        happyHomeDir: '/private/harness/home',
        databasePath: '/private/harness/database.sqlite',
        workspaceDir: '/private/harness/workspace',
        openCodeStateDir: '/private/harness/opencode',
        ports: { server: 41_001, daemon: 41_002, upstreamProxy: 41_003 },
        stockCliProxyApiPort: 8317,
        stockCliProxyApiTouched: false,
      },
      failureDiagnostics: null,
      cleanup: { disposition: 'removed' },
    };
    const result: PackedManagedProviderEntrypointResult = {
      schemaVersion: 1,
      kind: 'packed_managed_provider_vertical',
      status: 'passed',
      candidate: {
        runId: 'private-candidate-run-id',
        sdk: {
          packageName: '@happier-dev/plugin-sdk',
          version: '0.0.0',
          integrity: 'sha512-sdk-fingerprint',
          tarballPath: '/private/candidate/sdk.tgz',
        },
        cli: {
          packageName: '@happier-dev/cli',
          version: '0.2.10',
          integrity: 'sha512-cli-fingerprint',
          tarballPath: '/private/candidate/cli.tgz',
          entrypoint: '/private/candidate/package/bin/happier.mjs',
        },
      },
      standaloneCliArtifact: {
        product: 'happier',
        version: '0.2.10',
        os: 'darwin',
        arch: 'arm64',
        archivePath: '/private/candidate/happier.tar.gz',
        sha256: 'a'.repeat(64),
        executablePath: '/private/extract/happier',
        wrapperExecutable: '/private/extract/happier-cliproxyapi-managed',
      },
      stages: [{
        id: 'standalone-cli-private-extract',
        status: 'passed',
        evidence: { entrypoint: '/private/extract/happier' },
      }],
      blockers: [],
      harnessEvidence,
    };
    const continuity = {
      contract: validContinuityContract,
      sessionP: {
        sessionId: 'private-session-p',
        providerPid: 53_001,
        providerExecutablePath: '/private/extract/happier-cliproxyapi-managed',
      },
      daemonPids: [54_001, 54_002, 54_003] as const,
      sessionQ: {
        sessionId: 'private-session-q',
        providerPid: 53_002,
        providerExecutablePath: '/private/extract/happier-cliproxyapi-managed',
      },
    };
    const serialized = serializePackedManagedProviderContinuitySuccess({
      result,
      continuity,
      candidateHandoff: {
        contract: validCandidateHandoffContract,
      },
      recoveryRefusal: {
        publicActivationReason: 'sessionDemand',
        activationRefused: true,
        spawnAcknowledged: false,
        providerStarted: false,
        upstreamAttempted: false,
        activeSessionPreserved: true,
      },
    });

    expect(JSON.parse(serialized)).toMatchObject({
      schemaVersion: 1,
      kind: 'packed_managed_provider_daemon_continuity',
      status: 'passed',
      candidate: {
        identityFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
        sdk: {
          packageName: '@happier-dev/plugin-sdk',
          version: '0.0.0',
          integrity: 'sha512-sdk-fingerprint',
        },
        cli: {
          packageName: '@happier-dev/cli',
          version: '0.2.10',
          integrity: 'sha512-cli-fingerprint',
        },
      },
      standaloneCliArtifact: {
        product: 'happier',
        version: '0.2.10',
        os: 'darwin',
        arch: 'arm64',
        sha256: 'a'.repeat(64),
      },
      freshBootstrapStages: [{
        id: 'standalone-cli-private-extract',
        status: 'passed',
      }],
      harnessEvidence: {
        candidateFrozen: true,
        standaloneCliFrozen: true,
        candidateArchiveCensus: {
          sdk: { entryCount: 11 },
          pluginUi: { entryCount: 22 },
          cli: { entryCount: 22 },
        },
        standaloneCliArchiveEntryCount: 33,
        hostTarget: { os: 'darwin', arch: 'arm64' },
        stockCliProxyApiTouched: false,
        cleanup: { disposition: 'removed' },
      },
      continuityContract: validContinuityContract,
      candidateHandoffStages: [
        { id: 'candidate-external-agent-provider-author', status: 'passed' },
        { id: 'candidate-external-agent-provider-pack', status: 'passed' },
        {
          id: 'candidate-external-agent-provider-reviewed-install',
          status: 'passed',
        },
        { id: 'candidate-generation-handoff', status: 'passed' },
        { id: 'candidate-exactly-once-turns', status: 'passed' },
        { id: 'candidate-provider-hard-revoke', status: 'passed' },
        { id: 'candidate-handoff-cleanup', status: 'passed' },
      ],
      candidateHandoffContract: validCandidateHandoffContract,
      recoveryRefusal: {
        activationRefused: true,
        activeSessionPreserved: true,
      },
    });
    for (const forbidden of [
      '/private/',
      'private-candidate-run-id',
      'private-session-p',
      'private-session-q',
      '41001',
      '53001',
      '54001',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(serialized).not.toContain('"stockCliProxyApiPort":8317');
  });
});

const validSafeRestartContract:
PackedManagedProviderSafeRestartContractEvidence = {
  busy: {
    statusVersionState: 'stale',
    plannedRestartEligible: false,
    plannedRestartDisabledReason: 'turn_in_progress',
    restartStatus: 'busy',
    restartReasonCode: 'turn_in_progress',
    agentRuntimeUnchanged: true,
    runnerIdentityUnchangedAfterBusyResult: true,
    runnerIdentityUnchangedAfterHeldTurn: true,
    providerProcessUnchanged: true,
    providerProcessStartCountBefore: 1,
    providerProcessStartCountAfter: 1,
    noDeferredRestartAfterTurn: true,
  },
  idle: {
    statusVersionStateBefore: 'stale',
    plannedRestartEligibleBefore: true,
    restartStatus: 'restarted',
    movedToCurrentAgentRuntime: true,
    providerProcessReplaced: true,
    laterTurn: {
      expectedAgentGeneration: 'H',
      observedAgentGeneration: 'H',
      effectCount: 1,
      outputCount: 1,
      terminalCount: 1,
    },
  },
  removed: {
    statusVersionState: 'stale',
    plannedRestartEligible: false,
    plannedRestartDisabledReason: 'unsupported_backend',
    restartStatus: 'ineligible',
    restartReasonCode: 'unsupported_backend',
    agentRuntimeUnchanged: true,
    providerProcessUnchanged: true,
    providerProcessStartCountBefore: 3,
    providerProcessStartCountAfter: 3,
    retainedRuntimeContinued: true,
    laterTurn: {
      expectedAgentGeneration: 'H',
      observedAgentGeneration: 'H',
      effectCount: 1,
      outputCount: 1,
      terminalCount: 1,
    },
  },
};

const validCandidateHandoffContract:
PackedManagedProviderCandidateHandoffContractEvidence = {
  authoring: {
    exactCandidateSdk: true,
    exactCandidateCli: true,
    exactCandidateStandaloneCli: true,
    externalAgentPublicOnly: true,
    externalProviderPublicOnly: true,
    providerPackageHasNoAgentLocator: true,
  },
  lifecycle: projectRetainedPluginLifecycleEvidence({
    agent: {
      generations: {
        retainedSessionBeforeUpdate: 'agent-g',
        retainedSessionAfterUpdate: 'agent-g',
        newSessionAfterUpdate: 'agent-h',
      },
      retainedLaterTurn: 'completed',
      newSessionFirstTurn: 'completed',
    },
    provider: {
      generations: {
        retainedHandleBeforeUpdate: 'provider-p',
        retainedHandleAfterUpdate: 'provider-p',
        newClaimAfterUpdate: 'provider-q',
      },
      retainedHandleUse: 'continued',
      newClaim: 'admitted',
    },
  }),
  custody: {
    retainedProviderSameProcessAfterUpdate: true,
    newProviderDistinctProcess: true,
    newProviderExitedWhileRetainedAlive: true,
    providerProcessStartCountBeforeFreshDemand: 2,
    providerProcessStartCountAfterFreshDemand: 3,
    providerProcessIdentityFingerprints: {
      retainedBeforeUpdate: `sha256:${'1'.repeat(64)}`,
      retainedAfterUpdate: `sha256:${'1'.repeat(64)}`,
      newSessionAfterUpdate: `sha256:${'2'.repeat(64)}`,
    },
    distinctProviderProcessCount: 3,
  },
  turns: {
    retainedInitialTurn: {
      expectedAgentGeneration: 'G',
      observedAgentGeneration: 'G',
      effectCount: 1,
      outputCount: 1,
      terminalCount: 1,
    },
    retainedLaterTurn: {
      expectedAgentGeneration: 'G',
      observedAgentGeneration: 'G',
      effectCount: 1,
      outputCount: 1,
      terminalCount: 1,
    },
    newSessionFirstTurn: {
      expectedAgentGeneration: 'H',
      observedAgentGeneration: 'H',
      effectCount: 1,
      outputCount: 1,
      terminalCount: 1,
    },
  },
  cumulativeNoReplay: {
    afterGenerationAdoption: {
      retainedInitialTurn: {
        expectedAgentGeneration: 'G',
        observedAgentGeneration: 'G',
        effectCount: 1,
        outputCount: 1,
        terminalCount: 1,
      },
    },
    afterIdleRestart: {
      retainedInitialTurn: {
        expectedAgentGeneration: 'G',
        observedAgentGeneration: 'G',
        effectCount: 1,
        outputCount: 1,
        terminalCount: 1,
      },
      retainedUpdateTurn: {
        expectedAgentGeneration: 'G',
        observedAgentGeneration: 'G',
        effectCount: 1,
        outputCount: 1,
        terminalCount: 1,
      },
    },
    afterNewProviderAdmission: {
      retainedInitialTurn: {
        expectedAgentGeneration: 'G',
        observedAgentGeneration: 'G',
        effectCount: 1,
        outputCount: 1,
        terminalCount: 1,
      },
      retainedUpdateTurn: {
        expectedAgentGeneration: 'G',
        observedAgentGeneration: 'G',
        effectCount: 1,
        outputCount: 1,
        terminalCount: 1,
      },
      restartedCurrentTurn: {
        expectedAgentGeneration: 'H',
        observedAgentGeneration: 'H',
        effectCount: 1,
        outputCount: 1,
        terminalCount: 1,
      },
      newSessionFirstTurn: {
        expectedAgentGeneration: 'H',
        observedAgentGeneration: 'H',
        effectCount: 1,
        outputCount: 1,
        terminalCount: 1,
      },
    },
  },
  externalSessions: {
    publicFlow: {
      capabilities: true,
      list: true,
      attach: true,
      backgroundFollowEnabled: true,
      backgroundFollowDisabled: true,
      read: true,
      followAcknowledged: true,
      followListenerSettled: true,
      followDisposed: true,
      followDisposedTerminalAcknowledged: true,
      publicOutputPrivateMetadataAbsent: true,
      takeover: true,
      materialize: true,
      recipientSafeStatus: true,
      recipientSafeRecovery: true,
    },
    generationHandoff: {
      newPublicOperationsObservedGeneration: 'H',
      newPublicSnapshotObservedGeneration: 'H',
      publicGCursorRetired: true,
      publicGFollowCursorRetired: true,
      publicGRefRoutedToH: true,
      publicGFollowRetiredOnHReplacement: true,
      publicGFollowRetiredExactlyOnce: true,
      publicGFollowNoPostRetirementEvents: true,
      hReinstalledAndRetrusted: true,
      reinstalledHFollowReacquired: true,
    },
    artifacts: {
      agentGArchiveSha256: `sha256:${'a'.repeat(64)}`,
      agentHArchiveSha256: `sha256:${'b'.repeat(64)}`,
      providerPArchiveSha256: `sha256:${'c'.repeat(64)}`,
      providerQArchiveSha256: `sha256:${'d'.repeat(64)}`,
      installedArchivesMatchPackedBytes: true,
    },
  },
  safeRestart: validSafeRestartContract,
  hardRevoke: {
    retainedProviderExited: true,
    daemonTakeoverCount: 1,
    reenabledAndRetrusted: true,
    retainedProviderResurrectionCount: 0,
    retainedProviderAuthorityResurrectionCount: 0,
    revokeWindowProviderProcessStartCount: 0,
  },
  cleanup: {
    sessionsPresent: 0,
    descendantProcessesAlive: 0,
    providerProcessesAlive: 0,
    authorityFilesPresent: 0,
    capabilityFilesPresent: 0,
  },
};

type GeneratedPackedExternalSessionsAction = (
  context: unknown,
) => Promise<unknown>;

async function withGeneratedPackedExternalSessionsAction(
  verify: (run: GeneratedPackedExternalSessionsAction) => Promise<void>,
): Promise<void> {
  await withGeneratedPackedExternalSessionsActionForGeneration('H', verify);
}

async function withGeneratedPackedExternalSessionsActionForGeneration(
  generation: 'G' | 'H',
  verify: (run: GeneratedPackedExternalSessionsAction) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'packed-candidate-external-action-'));
  try {
    await writeFile(join(root, 'package.json'), JSON.stringify({
      name: 'packed-candidate-action-fixture',
      version: '0.0.0',
      files: [],
    }), 'utf8');
    await writeCandidateHandoffAgentSource({
      pluginRoot: root,
      version: '1.0.0',
      generation,
    });
    const generated = await import(
      pathToFileURL(join(root, 'src', 'index.ts')).href,
    );
    const run = Reflect.get(
      generated,
      'runPackedExternalSessionsAcceptance',
    );
    expect(run).toBeTypeOf('function');
    await verify(run as GeneratedPackedExternalSessionsAction);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function createGeneratedPackedExternalSessionsContext(input: Readonly<{
  calls: string[];
  capabilities?: Record<string, unknown>;
  enableFailure?: Error | null;
  disableFailure?: Error | null;
}>): Readonly<{
  context: unknown;
  capabilities: Record<string, unknown>;
  takeoverRequests: unknown[];
}> {
  const capabilities = input.capabilities ?? {
    list: { status: 'available' },
    attach: { status: 'available' },
    takeover: {
      status: 'available',
      storageModes: ['external-linked', 'persisted'],
    },
    transcript: { status: 'available' },
    follow: { status: 'available' },
  };
  const operation = {
    sessionId: 'session-1',
    operationId: 'operation-1',
    revision: 1,
  };
  const takeoverRequests: unknown[] = [];
  return {
    capabilities,
    takeoverRequests,
    context: {
      services: {
        storage: {
          daemon: {
            get: async () => {
              input.calls.push('phase:get');
              return {
                ref: {
                  agentId: 'packed-managed-public-agent',
                  sourceId: 'packed-source',
                  remoteSessionId: 'packed-logical-session',
                },
                listCursor: 'g-list-cursor',
                followCursor: 'g-follow-cursor',
                publicGFollow: {
                  dataEventCount: 1,
                  terminalAcknowledgements: 1,
                  postTerminalEventCount: 0,
                },
              };
            },
            set: async () => {
              input.calls.push('phase:set');
            },
          },
        },
        sessions: {
          external: {
            capabilities: async () => {
              input.calls.push('capabilities');
              return capabilities;
            },
            list: async (query: { cursor?: unknown }) => {
              input.calls.push('list');
              if (typeof query.cursor === 'string') {
                throw { code: 'plugin_external_cursor_invalid' };
              }
              return {
                items: [{
                  ref: {
                    agentId: 'packed-managed-public-agent',
                    sourceId: 'packed-source',
                    remoteSessionId: 'packed-logical-session',
                  },
                }],
                nextCursor: 'list-cursor',
              };
            },
            readTranscript: async () => {
              input.calls.push('readTranscript');
              return {
                mode: 'page',
                items: [{ id: 'page-1', data: { text: 'public transcript' } }],
                nextCursor: null,
                tailCursor: 'tail-cursor',
              };
            },
            followTranscript: async (
              _ref: unknown,
              options: { cursor?: unknown },
              listener: (event: unknown) => Promise<void>,
            ) => {
              input.calls.push('followTranscript');
              if (typeof options.cursor === 'string'
                && options.cursor === 'g-follow-cursor') {
                return {
                  status: 'unavailable',
                  code: 'plugin_external_cursor_invalid',
                };
              }
              await listener({
                kind: 'data',
                items: [{ id: 'follow-1', data: { text: 'public follow' } }],
              });
              let disposed = false;
              return {
                status: 'following',
                startingCursor: 'tail-cursor',
                subscription: {
                  dispose: async () => {
                    if (disposed) return;
                    disposed = true;
                    await listener({ kind: 'terminated', reason: 'disposed' });
                  },
                },
              };
            },
            attach: async () => {
              input.calls.push('attach');
              return { sessionId: operation.sessionId };
            },
            takeover: async (_ref: unknown, request: Readonly<{
              targetStorageMode?: unknown;
              idempotencyKey?: unknown;
            }>) => {
              input.calls.push(`takeover:${String(request.targetStorageMode)}`);
              takeoverRequests.push({ ...request });
              return operation;
            },
          },
        },
        actions: {
          execute: async (actionId: string, value: { enabled?: boolean }) => {
            if (actionId === 'sessions.external.backgroundFollow.set') {
              input.calls.push(`background-follow:${value.enabled}`);
              if (value.enabled && input.enableFailure) throw input.enableFailure;
              if (!value.enabled && input.disableFailure) throw input.disableFailure;
              return {
                ok: true,
                enabled: value.enabled,
                leaseActive: value.enabled,
              };
            }
            if (actionId === 'sessions.external.materialize.start') {
              return { ok: true, operation };
            }
            return {
              ok: true,
              operation,
              presentation: {
                v: 1,
                operationId: operation.operationId,
                revision: operation.revision,
                kind: 'takeover_external_linked',
                status: 'running',
                phase: 'validating',
              },
            };
          },
        },
      },
    },
  };
}

describe('packed managed Provider composed cleanup', () => {
  it('continues cleanup after a stopPublicSession failure and reports every inner failure', async () => {
    const cleanup = Reflect.get(
      packedManagedProviderComposedRuntime,
      'cleanupPackedManagedProviderTasks',
    );
    expect(cleanup).toBeTypeOf('function');
    if (typeof cleanup !== 'function') return;

    const stopFailure = new Error('stopPublicSession failed');
    const collectorFailure = new Error('collector stop failed');
    const registryFailure = new Error('registry close failed');
    const calls: string[] = [];

    let thrown: unknown = null;
    try {
      await cleanup([
        {
          run: async () => {
            calls.push('stopPublicSession');
            throw stopFailure;
          },
        },
        {
          run: async () => {
            calls.push('collector.stop');
            throw collectorFailure;
          },
        },
        {
          run: async () => {
            calls.push('registry.close');
            throw registryFailure;
          },
        },
      ]);
    } catch (error) {
      thrown = error;
    }

    expect(calls).toEqual([
      'stopPublicSession',
      'collector.stop',
      'registry.close',
    ]);
    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors).toEqual([
      stopFailure,
      collectorFailure,
      registryFailure,
    ]);
  });

  it('flattens nested cleanup aggregation after every task has run', async () => {
    const cleanup = Reflect.get(
      packedManagedProviderComposedRuntime,
      'cleanupPackedManagedProviderTasks',
    );
    expect(cleanup).toBeTypeOf('function');
    if (typeof cleanup !== 'function') return;

    const firstFailure = new Error('first cleanup failure');
    const nestedFailure = new Error('nested cleanup failure');
    const finalFailure = new Error('final cleanup failure');
    const calls: string[] = [];
    let thrown: unknown = null;

    try {
      await cleanup([
        {
          run: async () => {
            calls.push('first');
            throw firstFailure;
          },
        },
        {
          run: async () => {
            calls.push('nested');
            throw new AggregateError([nestedFailure], 'nested cleanup');
          },
        },
        {
          run: async () => {
            calls.push('final');
            throw finalFailure;
          },
        },
      ]);
    } catch (error) {
      thrown = error;
    }

    expect(calls).toEqual(['first', 'nested', 'final']);
    expect(thrown).toBeInstanceOf(AggregateError);
    expect([...(thrown as AggregateError).errors]).toEqual([
      firstFailure,
      nestedFailure,
      finalFailure,
    ]);
  });
});

describe('packed candidate Agent/Provider generation handoff contract', () => {
  it('constructs External Sessions evidence from the live packed public command phases', async () => {
    const source = await readFile(new URL(
      '../../plugin-platform/packedManagedProviderComposedRuntime.ts',
      import.meta.url,
    ), 'utf8');

    expect(source).toContain('invokeCandidateHandoffExternalSessionsPublicPhase({');
    expect(source).toContain('externalSessions: externalSessionsEvidence,');
    expect(source).toContain("args: ['packed-candidate', 'external-sessions', '--json']");
  });

  it('keeps exact-G follow lifecycle in the existing archive replacement and reviewed-reinstall scenario', async () => {
    const source = await readFile(new URL(
      '../../plugin-platform/packedManagedProviderComposedRuntime.ts',
      import.meta.url,
    ), 'utf8');

    expect(source).not.toContain('targetDirectory: input.authoring.targetDirectory,');
    expect(source).toContain("expectedPublicGFollow: 'retired'");
    expect(source).not.toContain("expectedPublicGFollow: 'active'");
    expect(source).toContain('agentRetirementUninstall');
    expect(source).toContain('agentHReinstall');
    expect(source).toContain('publicGFollowRetiredOnHReplacement:');
    expect(source).toContain('publicGFollowRetiredExactlyOnce:');
    expect(source).toContain('publicGFollowNoPostRetirementEvents:');
    expect(source).toContain('reinstalledHFollowReacquired:');
  });

  it('authors the exact G/H package with the final public External Sessions service and same-module private companion', async () => {
    const root = await mkdtemp(join(tmpdir(), 'packed-candidate-external-source-'));
    try {
      await writeFile(join(root, 'package.json'), JSON.stringify({
        name: 'packed-candidate-fixture',
        version: '0.0.0',
        files: [],
      }), 'utf8');
      await writeCandidateHandoffAgentSource({
        pluginRoot: root,
        version: '1.0.0',
        generation: 'G',
      });
      const [runtimeSource, activationSource] = await Promise.all([
        readFile(join(root, 'src', 'agentRuntime.ts'), 'utf8'),
        readFile(join(root, 'src', 'index.ts'), 'utf8'),
      ]);

      expect(runtimeSource).toContain(
        "from '@happier-dev/plugin-sdk/sessions/external'",
      );
      expect(runtimeSource).toContain(
        'export const externalSessions =',
      );
      expect(runtimeSource).toContain('surfaces: {');
      expect(runtimeSource).toContain('terminal: {');
      expect(runtimeSource).toContain('resolveLaunch()');
      expect(activationSource).toContain(
        '"surfaces":["terminal","externalSessions"]',
      );
      expect(activationSource).toContain(
        '"sourceKind":"packedCandidate"',
      );
      expect(activationSource).toContain(
        'externalSessionObservation,',
      );
      expect(activationSource).toContain('externalSessionsExport: \'externalSessions\'');
      expect(runtimeSource).toContain(
        "linkData: { scope: 'shared', generation: packedAgentGeneration }",
      );
      expect(runtimeSource).toContain(
        "raw: { role: 'agent', content: { type: 'output', data: { type: 'message', message: `Packed ${packedAgentGeneration} transcript` } } }",
      );
      expect(runtimeSource).toContain(
        "raw: { role: 'agent', content: { type: 'output', data: { type: 'message', message: `Packed ${packedAgentGeneration} follow` } } }",
      );
      for (const raw of [
        {
          role: 'agent' as const,
          content: { type: 'output', data: { type: 'message', message: 'Packed G transcript' } },
        },
        {
          role: 'agent' as const,
          content: { type: 'output', data: { type: 'message', message: 'Packed G follow' } },
        },
      ]) {
        expect(AgentExternalSessionTranscriptRawRecordSchema.safeParse(raw).success)
          .toBe(true);
        expect(resolveTranscriptBodySemanticEvent({
          protocol: 'acp',
          body: raw.content,
        })).toMatchObject({ role: 'agent' });
        expect(Object.keys(raw)).toEqual(['role', 'content']);
        expect(Object.keys(raw.content)).toEqual(['type', 'data']);
        expect(Object.keys(raw.content.data)).toEqual(['type', 'message']);
        expect(JSON.stringify(raw)).not.toMatch(
          /generation|source|linkData|claim|custody|path|runtime/u,
        );
      }
      expect(activationSource).toContain('listPage: listed');
      expect(activationSource).toContain(
        'context.services.sessions.external.capabilities()',
      );
      expect(activationSource).toContain('transcriptPage: transcript');
      expect(activationSource).toContain('dataEvent: followDataEvent');
      expect(activationSource).not.toContain('packedExternalSessionsTargetDirectory');
      expect(activationSource).toContain(
        "publicGCursorRetirementCode !== 'plugin_external_cursor_invalid'",
      );
      expect(activationSource).toContain(
        "publicGFollowCursorRetirementCode !== 'plugin_external_cursor_invalid'",
      );
      for (const publicOperation of [
        '.list(',
        '.attach(',
        '.readTranscript(',
        '.followTranscript(',
        '.takeover(',
        "actions.execute('sessions.external.materialize.start'",
        "actions.execute('sessions.external.operation.status.get'",
        "actions.execute('sessions.external.operation.resume'",
      ]) {
        expect(activationSource).toContain(publicOperation);
      }
      for (const privateField of [
        'operationClaimId',
        'expectedRevision',
        'custodyPath',
        'sourcePath',
        'progressPath',
      ]) {
        expect(activationSource).not.toContain(privateField);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('executes the generated public action through capabilities before list and preserves only its recipient-safe evidence', async () => {
    await withGeneratedPackedExternalSessionsAction(async (run) => {
      const calls: string[] = [];
      const { context, capabilities, takeoverRequests } = createGeneratedPackedExternalSessionsContext({
        calls,
      });

      const result = await run(context) as Record<string, unknown>;

      expect(calls[0]).toBe('capabilities');
      expect(calls).toContain('list');
      expect(calls.indexOf('capabilities')).toBeLessThan(calls.indexOf('list'));
      expect(calls.indexOf('list')).toBeLessThan(calls.indexOf('attach'));
      expect(calls.indexOf('attach')).toBeLessThan(calls.indexOf('readTranscript'));
      expect(calls.indexOf('readTranscript'))
        .toBeLessThan(calls.indexOf('followTranscript'));
      expect(calls.lastIndexOf('followTranscript')).toBeLessThan(
        calls.indexOf('takeover:external-linked'),
      );
      expect(calls).toContain('takeover:external-linked');
      expect(calls).not.toContain('takeover:persisted');
      expect(takeoverRequests).toEqual([{
        targetStorageMode: 'external-linked',
        idempotencyKey: 'packed-takeover-H',
      }]);
      expect(result.capabilities).toEqual(capabilities);
      expect(Object.keys(result.capabilities as Record<string, unknown>).sort())
        .toEqual(['attach', 'follow', 'list', 'takeover', 'transcript']);
      expect(result).not.toHaveProperty('generation');
      expect(result.publicRef).toEqual({
        agentId: 'packed-managed-public-agent',
        sourceId: 'packed-source',
        remoteSessionId: 'packed-logical-session',
      });
      expect(result.follow).toMatchObject({
        listenerSettled: true,
        disposedTerminalAcknowledgements: 1,
        disposed: true,
      });
      expect(() => assertPackedCandidatePublicExternalSessionsPrivacy(result))
        .not.toThrow();
    });
  });

  it('retires the public G follow exactly once on H replacement and reacquires H after retrust', async () => {
    const ref = {
      agentId: 'packed-managed-public-agent',
      sourceId: 'packed-source',
      remoteSessionId: 'packed-logical-session',
    };
    const operation = {
      sessionId: 'session-1',
      operationId: 'operation-1',
      revision: 1,
    };
    let activeGeneration: 'G' | 'H' = 'G';
    let phase: Record<string, unknown> | null = null;
    let gSubscription: Readonly<{ dispose(): Promise<void> }> | null = null;
    let gDisposeCount = 0;
    let hFollowAcquisitionCount = 0;
    const context = {
      services: {
        storage: {
          daemon: {
            get: async () => phase,
            set: async (_key: string, value: unknown) => {
              if (!value || typeof value !== 'object' || Array.isArray(value)) {
                throw new Error('expected retained follow phase record');
              }
              phase = value as Record<string, unknown>;
            },
          },
        },
        sessions: {
          external: {
            capabilities: async () => {
              if (activeGeneration === 'H') await gSubscription?.dispose();
              return {
                list: { status: 'available' },
                attach: { status: 'available' },
                takeover: {
                  status: 'available',
                  storageModes: ['external-linked', 'persisted'],
                },
                transcript: { status: 'available' },
                follow: { status: 'available' },
              };
            },
            list: async (query: { cursor?: unknown }) => {
              if (typeof query.cursor === 'string') {
                throw { code: 'plugin_external_cursor_invalid' };
              }
              return { items: [{ ref }], nextCursor: 'g-list-cursor' };
            },
            attach: async () => ({ sessionId: operation.sessionId }),
            readTranscript: async () => ({
              mode: 'page',
              items: [{ id: 'page-1', data: { text: 'public transcript' } }],
              nextCursor: null,
              tailCursor: activeGeneration === 'G'
                ? 'g-follow-cursor'
                : 'h-follow-cursor',
            }),
            followTranscript: async (
              _ref: unknown,
              options: { cursor?: unknown },
              listener: (event: unknown) => Promise<void>,
            ) => {
              if (activeGeneration === 'H' && options.cursor === 'g-follow-cursor') {
                return {
                  status: 'unavailable' as const,
                  code: 'plugin_external_cursor_invalid',
                };
              }
              const generation = activeGeneration;
              await listener({
                kind: 'data',
                items: [{
                  id: `packed-follow-${generation}`,
                  data: { text: `Packed ${generation} follow` },
                }],
              });
              let disposed = false;
              const subscription = {
                dispose: async () => {
                  if (disposed) return;
                  disposed = true;
                  if (generation === 'G') gDisposeCount += 1;
                  await listener({ kind: 'terminated', reason: 'disposed' });
                },
              };
              if (generation === 'G') {
                gSubscription = subscription;
              } else {
                hFollowAcquisitionCount += 1;
              }
              return {
                status: 'following' as const,
                startingCursor: 'g-follow-cursor',
                subscription,
              };
            },
            takeover: async () => operation,
          },
        },
        actions: {
          execute: async (actionId: string, value: { enabled?: boolean }) => {
            if (actionId === 'sessions.external.backgroundFollow.set') {
              return {
                ok: true,
                enabled: value.enabled,
                leaseActive: value.enabled,
              };
            }
            if (actionId === 'sessions.external.materialize.start') {
              return { ok: true, operation };
            }
            return {
              ok: true,
              operation,
              presentation: {
                v: 1,
                operationId: operation.operationId,
                revision: operation.revision,
                kind: 'takeover_external_linked',
                status: 'running',
                phase: 'validating',
              },
            };
          },
        },
      },
    };

    await withGeneratedPackedExternalSessionsActionForGeneration('G', async (runG) => {
      await withGeneratedPackedExternalSessionsActionForGeneration('H', async (runH) => {
        await runG(context);

        expect(gSubscription).not.toBeNull();
        expect(gDisposeCount).toBe(0);
        expect(phase).toMatchObject({
          publicGFollow: {
            dataEventCount: 1,
            terminalAcknowledgements: 0,
            postTerminalEventCount: 0,
          },
        });

        activeGeneration = 'H';
        await expect(runH(context)).resolves.toMatchObject({
          handoff: {
            publicGFollow: {
              dataEventCount: 1,
              terminalAcknowledgements: 1,
              postTerminalEventCount: 0,
            },
          },
        });
        const hFollowAcquisitionsAfterReplacement = hFollowAcquisitionCount;

        if (!gSubscription) throw new Error('generated G follow subscription missing');
        await gSubscription.dispose();
        expect(gDisposeCount).toBe(1);

        const retiredPhase = phase;
        if (!retiredPhase) throw new Error('retired G follow phase missing');
        phase = {
          ...retiredPhase,
          publicGFollow: {
            dataEventCount: 1,
            terminalAcknowledgements: 1,
            postTerminalEventCount: 1,
          },
        };
        await expect(runH(context)).rejects.toThrow(
          'packed_external_public_g_follow_invalid',
        );
        phase = retiredPhase;

        const hFollowAcquisitionsBeforeReacquisition = hFollowAcquisitionCount;
        await expect(runH(context)).resolves.toMatchObject({
          follow: {
            listenerSettled: true,
            disposedTerminalAcknowledgements: 1,
            disposed: true,
          },
          handoff: {
            publicGFollow: {
              dataEventCount: 1,
              terminalAcknowledgements: 1,
              postTerminalEventCount: 0,
            },
          },
        });
        expect(hFollowAcquisitionsAfterReplacement).toBe(1);
        expect(hFollowAcquisitionCount).toBe(
          hFollowAcquisitionsBeforeReacquisition + 1,
        );
      });
    });
  });

  it('rejects private metadata from the packed public External Sessions result while preserving public ids', () => {
    expect(() => assertPackedCandidatePublicExternalSessionsPrivacy({
      candidate: {
        ref: {
          agentId: 'packed-agent',
          sourceId: 'opaque-source-id',
          remoteSessionId: 'remote-session',
        },
      },
      status: {
        operationId: 'operation-id',
        revision: 1,
      },
      transcript: {
        data: { text: 'public transcript body' },
      },
    })).not.toThrow();
    for (const privateKey of [
      'source',
      'machineId',
      'generation',
      'path',
      'claim',
      'fence',
      'operationRecord',
      'raw',
    ]) {
      expect(() => assertPackedCandidatePublicExternalSessionsPrivacy({
        transcript: { data: { [privateKey]: 'private' } },
      })).toThrow(/packed managed public External Sessions leaked private metadata/u);
    }
  });

  it.each([
    ['missing public capabilities', () => ({})],
    ['an unavailable public capability', () => ({
      list: { status: 'unavailable', code: 'plugin_external_list_unavailable' },
      attach: { status: 'available' },
      takeover: { status: 'available', storageModes: ['external-linked', 'persisted'] },
      transcript: { status: 'available' },
      follow: { status: 'available' },
    })],
    ['an extra non-recipient-safe capability field', () => ({
      list: { status: 'available', generation: 'G' },
      attach: { status: 'available' },
      takeover: { status: 'available', storageModes: ['external-linked', 'persisted'] },
      transcript: { status: 'available' },
      follow: { status: 'available' },
    })],
  ])('rejects %s before list', async (_label, capabilitiesFactory) => {
    await withGeneratedPackedExternalSessionsAction(async (run) => {
      const calls: string[] = [];
      const { context } = createGeneratedPackedExternalSessionsContext({
        calls,
        capabilities: capabilitiesFactory(),
      });

      await expect(run(context)).rejects.toThrow(
        'packed_external_capabilities_unavailable',
      );
      expect(calls).toEqual(['capabilities']);
    });
  });

  it.each([
    ['enable failure', new Error('enable failed'), null],
    ['disable failure', null, new Error('disable failed')],
    ['both failures', new Error('enable failed'), new Error('disable failed')],
  ])('executes generated background-follow cleanup for %s', async (
    _label,
    enableFailure,
    disableFailure,
  ) => {
    await withGeneratedPackedExternalSessionsAction(async (run) => {
      const calls: string[] = [];
      const { context } = createGeneratedPackedExternalSessionsContext({
        calls,
        enableFailure,
        disableFailure,
      });

      let thrown: unknown = null;
      try {
        await run(context);
      } catch (error) {
        thrown = error;
      }

      expect(calls.filter((call) => call === 'background-follow:true')).toHaveLength(1);
      expect(calls.filter((call) => call === 'background-follow:false')).toHaveLength(1);
      if (enableFailure && disableFailure) {
        expect(thrown).toBeInstanceOf(AggregateError);
        expect((thrown as AggregateError).errors).toEqual([
          enableFailure,
          disableFailure,
        ]);
      } else {
        expect(thrown).toBe(enableFailure ?? disableFailure);
      }
    });
  });

  it('requires canonical public result shapes while preserving reference-only materialize admission', () => {
    const operation = {
      sessionId: 'session-1',
      operationId: 'operation-1',
      revision: 3,
    };
    const presentation = {
      v: 1,
      operationId: operation.operationId,
      revision: operation.revision,
      kind: 'takeover_external_linked',
      status: 'running',
      phase: 'validating',
    };

    expect(isPackedCandidateMaterializeActionResult({
      ok: true,
      operation,
    })).toBe(true);
    expect(isPackedCandidateOperationActionResult({
      ok: true,
      operation,
    })).toBe(false);
    expect(isPackedCandidateOperationActionResult({
      ok: true,
      operation,
      presentation,
    })).toBe(true);
    expect(isPackedCandidateOperationActionResult({
      ok: true,
      operation,
      presentation: { ...presentation, revision: operation.revision + 1 },
    })).toBe(false);
    const canonicalError = {
      ok: false,
      error: {
        code: 'source_unavailable',
        message: 'Source unavailable',
      },
    };
    expect(isPackedCandidateMaterializeActionResult(canonicalError))
      .toBe(false);
    expect(isPackedCandidateOperationActionResult(canonicalError))
      .toBe(false);
  });

  it.each([
    ['timeline', []],
    ['privateStagingId', 'staging-1'],
    ['generation', 'H'],
    ['linkData', { scope: 'shared' }],
    ['claim', { operationClaimId: 'claim-1' }],
    ['custody', { machineId: 'machine-1', trustedPid: 42 }],
  ])('rejects a strict public operation result containing %s', (
    privateField,
    privateValue,
  ) => {
    expect(isPackedCandidateOperationActionResult({
      ok: true,
      operation: {
        sessionId: 'session-1',
        operationId: 'operation-1',
        revision: 3,
      },
      presentation: {
        v: 1,
        operationId: 'operation-1',
        revision: 3,
        kind: 'takeover_external_linked',
        status: 'running',
        phase: 'validating',
      },
      [privateField]: privateValue,
    })).toBe(false);
  });

  it('accepts only the exact retired public cursor outcomes', () => {
    expect(isPackedCandidateRetiredListCursorEvidence({
      code: 'plugin_external_cursor_invalid',
    })).toBe(true);
    expect(isPackedCandidateRetiredFollowCursorEvidence({
      status: 'unavailable',
      code: 'plugin_external_cursor_invalid',
    })).toBe(true);

    for (const code of [
      'plugin_external_source_unavailable',
      'plugin_operation_deadline_exceeded',
      'plugin_external_list_failed',
    ]) {
      expect(isPackedCandidateRetiredListCursorEvidence({ code })).toBe(false);
      expect(isPackedCandidateRetiredFollowCursorEvidence({
        status: 'unavailable',
        code,
      })).toBe(false);
    }
    expect(isPackedCandidateRetiredFollowCursorEvidence({
      status: 'following',
      code: 'plugin_external_cursor_invalid',
    })).toBe(false);
  });

  it('rejects an unknown private key in an actual public list candidate before projection', () => {
    const candidate = {
      ref: {
        agentId: 'packed-managed-public-agent',
        sourceId: 'packed-source',
        remoteSessionId: 'packed-logical-session',
      },
      title: 'Packed H',
      updatedAtMs: 1,
      capabilities: ['attach', 'transcript', 'follow'],
      takeover: {
        status: 'available',
        storageModes: ['external-linked', 'persisted'],
      },
    };
    expect(isPackedCandidatePublicListPage({
      items: [candidate],
      nextCursor: 'packed-H-cursor',
    })).toBe(true);
    expect(isPackedCandidatePublicListPage({
      items: [{ ...candidate, privateStagingId: 'staging-1' }],
      nextCursor: 'packed-H-cursor',
    })).toBe(false);
  });

  it('derives current-H routing from public ids without generation metadata', () => {
    const observedH = {
      expectedGeneration: 'H' as const,
      candidateTitle: 'Packed H',
      transcriptItemId: 'packed-page-H',
      followItemId: 'packed-follow-H',
    };
    expect(derivePackedCandidatePublicGeneration(observedH)).toBe('H');
    expect(derivePackedCandidatePublicGeneration({
      ...observedH,
      candidateTitle: 'Packed G',
      transcriptItemId: 'packed-page-G',
      followItemId: 'packed-follow-G',
    })).toBeNull();
    expect(derivePackedCandidatePublicGeneration({
      ...observedH,
      followItemId: 'packed-follow-G',
    })).toBeNull();
  });

  it('compares every physical runner identity witness', () => {
    const runnerIdentity = {
      pid: 51_001,
      processStartTimeMs: 1_234_567,
      processCommandHash: `sha256:${'a'.repeat(64)}`,
      snapshotIdentity: `snapshot:${'b'.repeat(64)}`,
    };
    expect(sameCandidateRunnerIdentity(
      runnerIdentity,
      { ...runnerIdentity },
    )).toBe(true);
    for (const changedIdentity of [
      { ...runnerIdentity, pid: runnerIdentity.pid + 1 },
      {
        ...runnerIdentity,
        processStartTimeMs: runnerIdentity.processStartTimeMs + 1,
      },
      {
        ...runnerIdentity,
        processCommandHash: `sha256:${'c'.repeat(64)}`,
      },
      {
        ...runnerIdentity,
        snapshotIdentity: `snapshot:${'d'.repeat(64)}`,
      },
    ]) {
      expect(sameCandidateRunnerIdentity(
        runnerIdentity,
        changedIdentity,
      )).toBe(false);
    }
  });

  it('accepts the exact busy, idle restart, and removed-contribution discriminator', () => {
    expect(() =>
      assertPackedManagedProviderSafeRestartContract(
        validSafeRestartContract,
      )
    ).not.toThrow();
  });

  it.each([
    ['a busy restart that mutates the retained runtime', {
      ...validSafeRestartContract,
      busy: {
        ...validSafeRestartContract.busy,
        agentRuntimeUnchanged: false,
      },
    }],
    ['a busy restart that changes the physical runner immediately', {
      ...validSafeRestartContract,
      busy: {
        ...validSafeRestartContract.busy,
        runnerIdentityUnchangedAfterBusyResult: false,
      },
    }],
    ['a busy restart that changes the physical runner after turn settlement', {
      ...validSafeRestartContract,
      busy: {
        ...validSafeRestartContract.busy,
        runnerIdentityUnchangedAfterHeldTurn: false,
      },
    }],
    ['an idle restart that leaves the stale runtime active', {
      ...validSafeRestartContract,
      idle: {
        ...validSafeRestartContract.idle,
        movedToCurrentAgentRuntime: false,
      },
    }],
    ['a removed Agent restart that queues another Provider start', {
      ...validSafeRestartContract,
      removed: {
        ...validSafeRestartContract.removed,
        providerProcessStartCountAfter: 4,
      },
    }],
  ])('rejects %s', (_label, evidence) => {
    expect(() => assertPackedManagedProviderSafeRestartContract(
      evidence as PackedManagedProviderSafeRestartContractEvidence,
    )).toThrow();
  });

  it.each([
    ['after H/Q adoption', {
      ...validCandidateHandoffContract,
      cumulativeNoReplay: {
        ...validCandidateHandoffContract.cumulativeNoReplay,
        afterGenerationAdoption: {
          retainedInitialTurn: {
            ...validCandidateHandoffContract.cumulativeNoReplay
              .afterGenerationAdoption.retainedInitialTurn,
            outputCount: 2,
          },
        },
      },
    }],
    ['after idle restart', {
      ...validCandidateHandoffContract,
      cumulativeNoReplay: {
        ...validCandidateHandoffContract.cumulativeNoReplay,
        afterIdleRestart: {
          ...validCandidateHandoffContract.cumulativeNoReplay.afterIdleRestart,
          retainedUpdateTurn: {
            ...validCandidateHandoffContract.cumulativeNoReplay
              .afterIdleRestart.retainedUpdateTurn,
            terminalCount: 2,
          },
        },
      },
    }],
    ['after new-Q admission', {
      ...validCandidateHandoffContract,
      cumulativeNoReplay: {
        ...validCandidateHandoffContract.cumulativeNoReplay,
        afterNewProviderAdmission: {
          ...validCandidateHandoffContract.cumulativeNoReplay
            .afterNewProviderAdmission,
          retainedInitialTurn: {
            ...validCandidateHandoffContract.cumulativeNoReplay
              .afterNewProviderAdmission.retainedInitialTurn,
            effectCount: 2,
          },
        },
      },
    }],
  ])('rejects an earlier turn replayed %s', (_label, evidence) => {
    expect(() => assertPackedManagedProviderCandidateHandoffContract(
      evidence as PackedManagedProviderCandidateHandoffContractEvidence,
    )).toThrow();
  });

  it('cumulatively finds a late effect for an earlier revoke sentinel', () => {
    const sentinels = [
      'packed-candidate-revoked-takeover:early',
      'packed-candidate-revoked-reenable:later',
    ] as const;
    expect(countCandidateHandoffRevokedSentinelEffects([], sentinels))
      .toBe(0);
    expect(countCandidateHandoffRevokedSentinelEffects([{
      body: `delayed:${sentinels[0]}`,
    }], sentinels)).toBe(1);
  });

  it('accepts exact candidate authoring, retained/new custody, hard revoke, and final cleanup', () => {
    expect(validCandidateHandoffContract.lifecycle).toMatchObject({
      agent: {
        generations: {
          retainedSessionBeforeUpdate: 'agent-g',
          retainedSessionAfterUpdate: 'agent-g',
          newSessionAfterUpdate: 'agent-h',
        },
      },
      provider: {
        generations: {
          retainedHandleBeforeUpdate: 'provider-p',
          retainedHandleAfterUpdate: 'provider-p',
          newClaimAfterUpdate: 'provider-q',
        },
      },
    });
    const lifecycle = JSON.stringify(validCandidateHandoffContract.lifecycle);
    expect(lifecycle).not.toContain('generationFingerprints');
    expect(lifecycle).not.toContain('sha256:');
    expect(() =>
      assertPackedManagedProviderCandidateHandoffContract(
        validCandidateHandoffContract,
      )
    ).not.toThrow();
  });

  it.each([
    ['routing a new public operation through retained G', {
      ...validCandidateHandoffContract,
      externalSessions: {
        ...validCandidateHandoffContract.externalSessions!,
        generationHandoff: {
          ...validCandidateHandoffContract.externalSessions!.generationHandoff,
          newPublicOperationsObservedGeneration: 'G',
        },
      },
    }],
    ['accepting a G-issued public follow cursor after H adoption', {
      ...validCandidateHandoffContract,
      externalSessions: {
        ...validCandidateHandoffContract.externalSessions!,
        generationHandoff: {
          ...validCandidateHandoffContract.externalSessions!.generationHandoff,
          publicGFollowCursorRetired: false,
        },
      },
    }],
    ['leaving the public G follow active during H replacement', {
      ...validCandidateHandoffContract,
      externalSessions: {
        ...validCandidateHandoffContract.externalSessions!,
        generationHandoff: {
          ...validCandidateHandoffContract.externalSessions!.generationHandoff,
          publicGFollowRetiredOnHReplacement: false,
        },
      },
    }],
    ['delivering more than one public G terminal on retirement', {
      ...validCandidateHandoffContract,
      externalSessions: {
        ...validCandidateHandoffContract.externalSessions!,
        generationHandoff: {
          ...validCandidateHandoffContract.externalSessions!.generationHandoff,
          publicGFollowRetiredExactlyOnce: false,
        },
      },
    }],
    ['delivering a public G event after retirement', {
      ...validCandidateHandoffContract,
      externalSessions: {
        ...validCandidateHandoffContract.externalSessions!,
        generationHandoff: {
          ...validCandidateHandoffContract.externalSessions!.generationHandoff,
          publicGFollowNoPostRetirementEvents: false,
        },
      },
    }],
    ['failing to reacquire H follow after reviewed reinstallation', {
      ...validCandidateHandoffContract,
      externalSessions: {
        ...validCandidateHandoffContract.externalSessions!,
        generationHandoff: {
          ...validCandidateHandoffContract.externalSessions!.generationHandoff,
          hReinstalledAndRetrusted: false,
          reinstalledHFollowReacquired: false,
        },
      },
    }],
    ['failing to route the G logical ref through H', {
      ...validCandidateHandoffContract,
      externalSessions: {
        ...validCandidateHandoffContract.externalSessions!,
        generationHandoff: {
          ...validCandidateHandoffContract.externalSessions!.generationHandoff,
          publicGRefRoutedToH: false,
        },
      },
    }],
    ['substituting the same Provider archive for P and Q', {
      ...validCandidateHandoffContract,
      externalSessions: {
        ...validCandidateHandoffContract.externalSessions!,
        artifacts: {
          ...validCandidateHandoffContract.externalSessions!.artifacts,
          providerQArchiveSha256:
            validCandidateHandoffContract.externalSessions!.artifacts
              .providerPArchiveSha256,
        },
      },
    }],
  ])('rejects External Sessions acceptance that is %s', (_label, evidence) => {
    expect(() => assertPackedManagedProviderCandidateHandoffContract(
      evidence as PackedManagedProviderCandidateHandoffContractEvidence,
    )).toThrow();
  });

  it.each([
    ['a source SDK substitution', {
      ...validCandidateHandoffContract,
      authoring: {
        ...validCandidateHandoffContract.authoring,
        exactCandidateSdk: false,
      },
    }],
    ['duplicate retained-turn output', {
      ...validCandidateHandoffContract,
      turns: {
        ...validCandidateHandoffContract.turns,
        retainedLaterTurn: {
          ...validCandidateHandoffContract.turns.retainedLaterTurn,
          outputCount: 2,
        },
      },
    }],
    ['running H for the retained G turn', {
      ...validCandidateHandoffContract,
      turns: {
        ...validCandidateHandoffContract.turns,
        retainedLaterTurn: {
          ...validCandidateHandoffContract.turns.retainedLaterTurn,
          observedAgentGeneration: 'H',
        },
      },
    }],
    ['starting Q before fresh-session demand', {
      ...validCandidateHandoffContract,
      custody: {
        ...validCandidateHandoffContract.custody,
        providerProcessStartCountBeforeFreshDemand: 3,
      },
    }],
    ['stopping retained P with Q cleanup', {
      ...validCandidateHandoffContract,
      custody: {
        ...validCandidateHandoffContract.custody,
        newProviderExitedWhileRetainedAlive: false,
      },
    }],
    ['resurrecting P after hard revoke', {
      ...validCandidateHandoffContract,
      hardRevoke: {
        ...validCandidateHandoffContract.hardRevoke,
        retainedProviderResurrectionCount: 1,
      },
    }],
    ['restoring retained Provider authority after hard revoke', {
      ...validCandidateHandoffContract,
      hardRevoke: {
        ...validCandidateHandoffContract.hardRevoke,
        retainedProviderAuthorityResurrectionCount: 1,
      },
    }],
    ['starting another Provider process during the revoke window', {
      ...validCandidateHandoffContract,
      hardRevoke: {
        ...validCandidateHandoffContract.hardRevoke,
        revokeWindowProviderProcessStartCount: 1,
      },
    }],
    ['leaving a dynamically observed Provider process alive', {
      ...validCandidateHandoffContract,
      cleanup: {
        ...validCandidateHandoffContract.cleanup,
        providerProcessesAlive: 1,
      },
    }],
    ['leaking an authority file', {
      ...validCandidateHandoffContract,
      cleanup: {
        ...validCandidateHandoffContract.cleanup,
        authorityFilesPresent: 1,
      },
    }],
  ])('rejects %s', (_label, evidence) => {
    expect(() =>
      assertPackedManagedProviderCandidateHandoffContract(
        evidence as PackedManagedProviderCandidateHandoffContractEvidence,
      )
    ).toThrow();
  });
});

const validContinuityContract: PackedManagedProviderContinuityContractEvidence = {
  publicActivationReasons: [
    'explicitStartLocal',
    'catalogProbe',
    'sessionDemand',
  ],
  sessionP: {
    providerStartCount: 1,
    sameProviderProcessAcrossTakeovers: true,
    sameRunnerIdentityAcrossTakeovers: true,
    sameWrapperIdentityAcrossTakeovers: true,
    sameRetainedProviderClaimAcrossTakeovers: true,
    samePublicProviderSessionIdentityAcrossTakeovers: true,
    daemonTakeoverCount: 2,
    providerAttemptCount: 3,
    canonicalSessionCreateCount: 1,
    turns: {
      b: { effectCount: 1, outputCount: 1, terminalCount: 1 },
      c: { effectCount: 1, outputCount: 1, terminalCount: 1 },
      bAfterC: { effectCount: 1, outputCount: 1, terminalCount: 1 },
      cAfterC: { effectCount: 1, outputCount: 1, terminalCount: 1 },
      bAfterHardRevoke: { effectCount: 1, outputCount: 1, terminalCount: 1 },
      cAfterHardRevoke: { effectCount: 1, outputCount: 1, terminalCount: 1 },
    },
    requestAuth: {
      capabilityPathStableAcrossTakeovers: true,
      capabilityRotatedFromAToB: true,
      capabilityRotatedFromBToC: true,
      aCapabilityStatusUnderB: 401,
      bCapabilityStatusUnderB: 200,
      bCapabilityStatusUnderC: 401,
      cCapabilityStatusUnderC: 200,
      selectedCredentialRevisionRotated: true,
      currentCredentialRevisionObserved: true,
      wrapperEffectCountForRotatedCredential: 1,
      wrapperUsedCurrentCredential: true,
    },
  },
  sessionQ: {
    providerStartCount: 1,
    distinctProviderProcess: true,
    providerAttemptCount: 1,
    canonicalSessionCreateCount: 1,
    providerExited: true,
  },
  retainedSessionP: {
    publicSessionPresent: true,
    providerProcessAlive: true,
  },
  hardRevoke: {
    retainedProviderExited: true,
    retainedProviderAuthorityRevoked: true,
    daemonTakeoverCount: 1,
    reenabled: true,
    retainedProviderResurrectionEffectCount: 0,
    retainedProviderAuthorityResurrectionCount: 0,
    revokeWindowProviderProcessStartCount: 0,
  },
};

describe('packed managed Provider continuity contract', () => {
  const validEvidence = validContinuityContract;

  it('accepts exact public activation and per-session process continuity evidence', () => {
    expect(() =>
      assertPackedManagedProviderContinuityContract(validEvidence)
    ).not.toThrow();
  });

  it('rejects a contract that loses canonical B/C settlement, P identity, or P hard-revoke evidence', () => {
    const evidence = {
      ...validEvidence,
      sessionP: {
        ...validEvidence.sessionP,
        samePublicProviderSessionIdentityAcrossTakeovers: false,
        turns: {
          b: { effectCount: 1, outputCount: 0, terminalCount: 1 },
          c: { effectCount: 1, outputCount: 1, terminalCount: 0 },
          bAfterC: { effectCount: 1, outputCount: 0, terminalCount: 1 },
          cAfterC: { effectCount: 1, outputCount: 1, terminalCount: 0 },
          bAfterHardRevoke: { effectCount: 1, outputCount: 0, terminalCount: 1 },
          cAfterHardRevoke: { effectCount: 1, outputCount: 1, terminalCount: 0 },
        },
      },
      hardRevoke: {
        retainedProviderExited: false,
        retainedProviderAuthorityRevoked: false,
        daemonTakeoverCount: 1,
        reenabled: false,
        retainedProviderResurrectionEffectCount: 1,
        retainedProviderAuthorityResurrectionCount: 1,
        revokeWindowProviderProcessStartCount: 1,
      },
    };

    expect(() =>
      assertPackedManagedProviderContinuityContract(
        evidence as unknown as PackedManagedProviderContinuityContractEvidence,
      )
    ).toThrow();
  });

  it.each([
    [
      'a restarted Session P Provider',
      {
        ...validEvidence,
        sessionP: {
          ...validEvidence.sessionP,
          sameProviderProcessAcrossTakeovers: false,
        },
      },
    ],
    [
      'a duplicate Session P Provider start',
      {
        ...validEvidence,
        sessionP: {
          ...validEvidence.sessionP,
          providerStartCount: 2,
        },
      },
    ],
    [
      'a changed runner identity across daemon takeover',
      {
        ...validEvidence,
        sessionP: {
          ...validEvidence.sessionP,
          sameRunnerIdentityAcrossTakeovers: false,
        },
      },
    ],
    [
      'a changed retained P claim across daemon takeover',
      {
        ...validEvidence,
        sessionP: {
          ...validEvidence.sessionP,
          sameRetainedProviderClaimAcrossTakeovers: false,
        },
      },
    ],
    [
      'a changed retained wrapper identity across daemon takeover',
      {
        ...validEvidence,
        sessionP: {
          ...validEvidence.sessionP,
          sameWrapperIdentityAcrossTakeovers: false,
        },
      },
    ],
    [
      'an A request-auth capability accepted by daemon B',
      {
        ...validEvidence,
        sessionP: {
          ...validEvidence.sessionP,
          requestAuth: {
            ...validEvidence.sessionP.requestAuth,
            aCapabilityStatusUnderB: 200,
          },
        },
      },
    ],
    [
      'a request-auth capability that did not rotate across A to B',
      {
        ...validEvidence,
        sessionP: {
          ...validEvidence.sessionP,
          requestAuth: {
            ...validEvidence.sessionP.requestAuth,
            capabilityRotatedFromAToB: false,
          },
        },
      },
    ],
    [
      'a B request-auth capability accepted by daemon C',
      {
        ...validEvidence,
        sessionP: {
          ...validEvidence.sessionP,
          requestAuth: {
            ...validEvidence.sessionP.requestAuth,
            bCapabilityStatusUnderC: 200,
          },
        },
      },
    ],
    [
      'a current C request-auth capability rejected by daemon C',
      {
        ...validEvidence,
        sessionP: {
          ...validEvidence.sessionP,
          requestAuth: {
            ...validEvidence.sessionP.requestAuth,
            cCapabilityStatusUnderC: 401,
          },
        },
      },
    ],
    [
      'a rotated credential not observed by current request auth',
      {
        ...validEvidence,
        sessionP: {
          ...validEvidence.sessionP,
          requestAuth: {
            ...validEvidence.sessionP.requestAuth,
            currentCredentialRevisionObserved: false,
          },
        },
      },
    ],
    [
      'a duplicate retained-wrapper effect for the rotated credential',
      {
        ...validEvidence,
        sessionP: {
          ...validEvidence.sessionP,
          requestAuth: {
            ...validEvidence.sessionP.requestAuth,
            wrapperEffectCountForRotatedCredential: 2,
          },
        },
      },
    ],
    [
      'a retained wrapper using the previous selected credential',
      {
        ...validEvidence,
        sessionP: {
          ...validEvidence.sessionP,
          requestAuth: {
            ...validEvidence.sessionP.requestAuth,
            wrapperUsedCurrentCredential: false,
          },
        },
      },
    ],
    [
      'a reused Provider process for Session Q',
      {
        ...validEvidence,
        sessionQ: {
          ...validEvidence.sessionQ,
          distinctProviderProcess: false,
        },
      },
    ],
    [
      'a retained Session Q Provider after stop',
      {
        ...validEvidence,
        sessionQ: {
          ...validEvidence.sessionQ,
          providerExited: false,
        },
      },
    ],
    [
      'a lost public Session P during daemon takeover',
      {
        ...validEvidence,
        retainedSessionP: {
          ...validEvidence.retainedSessionP,
          publicSessionPresent: false,
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
