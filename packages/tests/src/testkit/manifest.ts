import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

type DaemonRunnerContinuityPhaseValues<T> = Readonly<{
  a: T;
  b: T;
  c: T;
}>;

type DaemonRunnerContinuityOptionalIdentityEvidence = Readonly<{
  availability: 'observed' | 'unknown';
  identityFingerprints: DaemonRunnerContinuityPhaseValues<string | null>;
  distinctIdentityCount: 1 | null;
  stableAcrossAllPhases: true | null;
}>;

export type DaemonRunnerLaunchEntrypointKind =
  | 'source'
  | 'candidate_artifact'
  | 'not_proven';

export type DaemonRunnerRuntimeIdentityKind =
  | 'mutable_runtime'
  | 'immutable_snapshot'
  | 'versioned_runtime'
  | 'unclassified';

export type RetainedPluginLifecycleManifestEvidence = Readonly<{
  agent: Readonly<{
    generations: Readonly<{
      retainedSessionBeforeUpdate: string;
      retainedSessionAfterUpdate: string;
      newSessionAfterUpdate: string;
    }>;
    distinctGenerationCount: 2;
    retainedLaterTurn: 'completed';
    newSessionFirstTurn: 'completed';
  }>;
  provider: Readonly<{
    generations: Readonly<{
      retainedHandleBeforeUpdate: string;
      retainedHandleAfterUpdate: string;
      newClaimAfterUpdate: string;
    }>;
    distinctGenerationCount: 2;
    retainedHandleUse: 'continued';
    newClaim: 'admitted';
  }>;
}>;

export type DaemonRunnerContinuityManifestEvidence = Readonly<{
  runtime: Readonly<{
    launchEntrypointKind: DaemonRunnerLaunchEntrypointKind;
    identityKind: DaemonRunnerRuntimeIdentityKind;
    entrypointIdentityFingerprints: DaemonRunnerContinuityPhaseValues<string>;
    distinctEntrypointIdentityCount: 1;
    stableAcrossAllPhases: true;
  }>;
  runner: Readonly<{
    identityFingerprints: DaemonRunnerContinuityPhaseValues<string>;
    processCommandHashFingerprints: DaemonRunnerContinuityPhaseValues<string>;
    distinctIdentityCount: 1;
    distinctProcessCommandHashCount: 1;
    aliveAcrossAllPhases: true;
  }>;
  phaseCount: 3;
  daemon: Readonly<{
    identityFingerprints: DaemonRunnerContinuityPhaseValues<string>;
    distinctIdentityCount: 3;
    replacedAcrossAllPhases: true;
  }>;
  logicalSession: Readonly<{
    identityFingerprints: DaemonRunnerContinuityPhaseValues<string>;
    distinctIdentityCount: 1;
    stableAcrossAllPhases: true;
  }>;
  executionAuthority: Readonly<{
    retainedAgentBindingFingerprints: DaemonRunnerContinuityPhaseValues<string>;
    distinctRetainedAgentBindingCount: 1;
    stableAcrossAllPhases: true;
  }>;
  underlyingAgent: Readonly<{
    childProcess: DaemonRunnerContinuityOptionalIdentityEvidence;
    vendorSession: DaemonRunnerContinuityOptionalIdentityEvidence;
  }>;
  authority: Readonly<{
    capabilityFingerprints: DaemonRunnerContinuityPhaseValues<string>;
    distinctCapabilityCount: 3;
    rotatedAcrossAllPhases: true;
    currentAcceptedAcrossAllPhases: true;
    predecessorRejectedAtBAndC: true;
  }>;
  turns: Readonly<{
    completedTurnFingerprints: DaemonRunnerContinuityPhaseValues<string>;
    distinctCompletedTurnCount: 3;
    matchingAssistantTranscriptOutputCounts: Readonly<{ b: 1; c: 1 }>;
    matchingEffectCounts: Readonly<{ b: 1; c: 1 }>;
    terminalEventCounts: Readonly<{ b: 1; c: 1 }>;
    activeTurnCrossedAToB: true;
    exactlyOneMatchingAssistantTranscriptOutputPerLaterPhase: true;
    exactlyOneMatchingEffectPerLaterPhase: true;
    exactlyOneTerminalEventPerLaterPhase: true;
  }>;
  retainedPluginLifecycle?: RetainedPluginLifecycleManifestEvidence;
}>;

function requireExactKeys(
  value: unknown,
  expectedKeys: readonly string[],
  field: string,
): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid daemon runner continuity exact keys: ${field}`);
  }
  const actualKeys = Object.keys(value);
  if (
    actualKeys.length !== expectedKeys.length
    || expectedKeys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
  ) {
    throw new Error(`Invalid daemon runner continuity exact keys: ${field}`);
  }
}

function requireExactPhaseKeys(value: unknown, field: string): void {
  requireExactKeys(value, ['a', 'b', 'c'], field);
}

function requireExactDaemonRunnerContinuityEvidenceKeys(
  evidence: DaemonRunnerContinuityManifestEvidence,
): void {
  const evidenceKeys = [
    'phaseCount',
    'runtime',
    'daemon',
    'runner',
    'logicalSession',
    'executionAuthority',
    'underlyingAgent',
    'authority',
    'turns',
  ];
  if (evidence.retainedPluginLifecycle !== undefined) {
    evidenceKeys.push('retainedPluginLifecycle');
  }
  requireExactKeys(evidence, evidenceKeys, 'evidence');
  requireExactKeys(
    evidence.daemon,
    ['identityFingerprints', 'distinctIdentityCount', 'replacedAcrossAllPhases'],
    'daemon',
  );
  requireExactPhaseKeys(evidence.daemon.identityFingerprints, 'daemon.identityFingerprints');
  requireExactKeys(
    evidence.runtime,
    [
      'launchEntrypointKind',
      'identityKind',
      'entrypointIdentityFingerprints',
      'distinctEntrypointIdentityCount',
      'stableAcrossAllPhases',
    ],
    'runtime',
  );
  requireExactPhaseKeys(
    evidence.runtime.entrypointIdentityFingerprints,
    'runtime.entrypointIdentityFingerprints',
  );
  requireExactKeys(
    evidence.runner,
    [
      'identityFingerprints',
      'processCommandHashFingerprints',
      'distinctIdentityCount',
      'distinctProcessCommandHashCount',
      'aliveAcrossAllPhases',
    ],
    'runner',
  );
  requireExactPhaseKeys(evidence.runner.identityFingerprints, 'runner.identityFingerprints');
  requireExactPhaseKeys(
    evidence.runner.processCommandHashFingerprints,
    'runner.processCommandHashFingerprints',
  );
  requireExactKeys(
    evidence.logicalSession,
    ['identityFingerprints', 'distinctIdentityCount', 'stableAcrossAllPhases'],
    'logicalSession',
  );
  requireExactPhaseKeys(
    evidence.logicalSession.identityFingerprints,
    'logicalSession.identityFingerprints',
  );
  requireExactKeys(evidence.executionAuthority, [
    'retainedAgentBindingFingerprints',
    'distinctRetainedAgentBindingCount',
    'stableAcrossAllPhases',
  ], 'executionAuthority');
  requireExactPhaseKeys(
    evidence.executionAuthority.retainedAgentBindingFingerprints,
    'executionAuthority.retainedAgentBindingFingerprints',
  );
  requireExactKeys(evidence.underlyingAgent, [
    'childProcess',
    'vendorSession',
  ], 'underlyingAgent');
  for (const [field, value] of [
    ['underlyingAgent.childProcess', evidence.underlyingAgent.childProcess],
    ['underlyingAgent.vendorSession', evidence.underlyingAgent.vendorSession],
  ] as const) {
    requireExactKeys(value, [
      'availability',
      'identityFingerprints',
      'distinctIdentityCount',
      'stableAcrossAllPhases',
    ], field);
    requireExactPhaseKeys(value.identityFingerprints, `${field}.identityFingerprints`);
  }
  requireExactKeys(evidence.authority, [
    'capabilityFingerprints',
    'distinctCapabilityCount',
    'rotatedAcrossAllPhases',
    'currentAcceptedAcrossAllPhases',
    'predecessorRejectedAtBAndC',
  ], 'authority');
  requireExactPhaseKeys(
    evidence.authority.capabilityFingerprints,
    'authority.capabilityFingerprints',
  );
  requireExactKeys(evidence.turns, [
    'completedTurnFingerprints',
    'distinctCompletedTurnCount',
    'matchingAssistantTranscriptOutputCounts',
    'matchingEffectCounts',
    'terminalEventCounts',
    'activeTurnCrossedAToB',
    'exactlyOneMatchingAssistantTranscriptOutputPerLaterPhase',
    'exactlyOneMatchingEffectPerLaterPhase',
    'exactlyOneTerminalEventPerLaterPhase',
  ], 'turns');
  requireExactPhaseKeys(
    evidence.turns.completedTurnFingerprints,
    'turns.completedTurnFingerprints',
  );
  requireExactKeys(
    evidence.turns.matchingAssistantTranscriptOutputCounts,
    ['b', 'c'],
    'turns.matchingAssistantTranscriptOutputCounts',
  );
  requireExactKeys(
    evidence.turns.matchingEffectCounts,
    ['b', 'c'],
    'turns.matchingEffectCounts',
  );
  requireExactKeys(
    evidence.turns.terminalEventCounts,
    ['b', 'c'],
    'turns.terminalEventCounts',
  );
}

function requireSha256Fingerprint(value: string, field: string): string {
  if (!/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`Invalid daemon runner continuity SHA-256 fingerprint: ${field}`);
  }
  return value;
}

function requireOpaqueGenerationIdentity(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new Error(`Invalid retained plugin lifecycle generation identity: ${field}`);
  }
  return value;
}

function sanitizePhaseFingerprints(
  values: DaemonRunnerContinuityPhaseValues<string>,
  field: string,
): DaemonRunnerContinuityPhaseValues<string> {
  return {
    a: requireSha256Fingerprint(values.a, `${field}.a`),
    b: requireSha256Fingerprint(values.b, `${field}.b`),
    c: requireSha256Fingerprint(values.c, `${field}.c`),
  };
}

function distinctPhaseValueCount(values: DaemonRunnerContinuityPhaseValues<string>): number {
  return new Set([values.a, values.b, values.c]).size;
}

export function sanitizeRetainedPluginLifecycleManifestEvidence(
  evidence: RetainedPluginLifecycleManifestEvidence,
): RetainedPluginLifecycleManifestEvidence {
  requireExactKeys(evidence, ['agent', 'provider'], 'retainedPluginLifecycle');
  requireExactKeys(evidence.agent, [
    'generations',
    'distinctGenerationCount',
    'retainedLaterTurn',
    'newSessionFirstTurn',
  ], 'retainedPluginLifecycle.agent');
  requireExactKeys(evidence.agent.generations, [
    'retainedSessionBeforeUpdate',
    'retainedSessionAfterUpdate',
    'newSessionAfterUpdate',
  ], 'retainedPluginLifecycle.agent.generations');
  requireExactKeys(evidence.provider, [
    'generations',
    'distinctGenerationCount',
    'retainedHandleUse',
    'newClaim',
  ], 'retainedPluginLifecycle.provider');
  requireExactKeys(evidence.provider.generations, [
    'retainedHandleBeforeUpdate',
    'retainedHandleAfterUpdate',
    'newClaimAfterUpdate',
  ], 'retainedPluginLifecycle.provider.generations');

  const agent = evidence.agent.generations;
  const provider = evidence.provider.generations;
  if (
    evidence.agent.distinctGenerationCount !== 2
    || evidence.agent.retainedLaterTurn !== 'completed'
    || evidence.agent.newSessionFirstTurn !== 'completed'
    || agent.retainedSessionBeforeUpdate !== agent.retainedSessionAfterUpdate
    || agent.retainedSessionBeforeUpdate === agent.newSessionAfterUpdate
    || new Set(Object.values(agent)).size !== 2
    || evidence.provider.distinctGenerationCount !== 2
    || evidence.provider.retainedHandleUse !== 'continued'
    || evidence.provider.newClaim !== 'admitted'
    || provider.retainedHandleBeforeUpdate !== provider.retainedHandleAfterUpdate
    || provider.retainedHandleBeforeUpdate === provider.newClaimAfterUpdate
    || new Set(Object.values(provider)).size !== 2
  ) {
    throw new Error('Invalid distinct retained plugin lifecycle generation evidence');
  }

  return {
    agent: {
      generations: {
        retainedSessionBeforeUpdate: requireOpaqueGenerationIdentity(
          agent.retainedSessionBeforeUpdate,
          'retainedPluginLifecycle.agent.generations.retainedSessionBeforeUpdate',
        ),
        retainedSessionAfterUpdate: requireOpaqueGenerationIdentity(
          agent.retainedSessionAfterUpdate,
          'retainedPluginLifecycle.agent.generations.retainedSessionAfterUpdate',
        ),
        newSessionAfterUpdate: requireOpaqueGenerationIdentity(
          agent.newSessionAfterUpdate,
          'retainedPluginLifecycle.agent.generations.newSessionAfterUpdate',
        ),
      },
      distinctGenerationCount: 2,
      retainedLaterTurn: 'completed',
      newSessionFirstTurn: 'completed',
    },
    provider: {
      generations: {
        retainedHandleBeforeUpdate: requireOpaqueGenerationIdentity(
          provider.retainedHandleBeforeUpdate,
          'retainedPluginLifecycle.provider.generations.retainedHandleBeforeUpdate',
        ),
        retainedHandleAfterUpdate: requireOpaqueGenerationIdentity(
          provider.retainedHandleAfterUpdate,
          'retainedPluginLifecycle.provider.generations.retainedHandleAfterUpdate',
        ),
        newClaimAfterUpdate: requireOpaqueGenerationIdentity(
          provider.newClaimAfterUpdate,
          'retainedPluginLifecycle.provider.generations.newClaimAfterUpdate',
        ),
      },
      distinctGenerationCount: 2,
      retainedHandleUse: 'continued',
      newClaim: 'admitted',
    },
  };
}

function sanitizeOptionalIdentityEvidence(
  evidence: DaemonRunnerContinuityOptionalIdentityEvidence,
  field: string,
): DaemonRunnerContinuityOptionalIdentityEvidence {
  const values = evidence.identityFingerprints;
  if (evidence.availability === 'unknown') {
    if (
      values.a !== null
      || values.b !== null
      || values.c !== null
      || evidence.distinctIdentityCount !== null
      || evidence.stableAcrossAllPhases !== null
    ) {
      throw new Error('Invalid daemon runner continuity evidence contract');
    }
    return {
      availability: 'unknown',
      identityFingerprints: { a: null, b: null, c: null },
      distinctIdentityCount: null,
      stableAcrossAllPhases: null,
    };
  }
  if (
    values.a === null
    || values.b === null
    || values.c === null
    || evidence.distinctIdentityCount !== 1
    || evidence.stableAcrossAllPhases !== true
    || new Set([values.a, values.b, values.c]).size !== 1
  ) {
    throw new Error('Invalid daemon runner continuity evidence contract');
  }
  return {
    availability: 'observed',
    identityFingerprints: {
      a: requireSha256Fingerprint(values.a, `${field}.identityFingerprints.a`),
      b: requireSha256Fingerprint(values.b, `${field}.identityFingerprints.b`),
      c: requireSha256Fingerprint(values.c, `${field}.identityFingerprints.c`),
    },
    distinctIdentityCount: 1,
    stableAcrossAllPhases: true,
  };
}

export function sanitizeDaemonRunnerContinuityManifestEvidence(
  evidence: DaemonRunnerContinuityManifestEvidence,
): DaemonRunnerContinuityManifestEvidence {
  requireExactDaemonRunnerContinuityEvidenceKeys(evidence);
  const retainedPluginLifecycle = evidence.retainedPluginLifecycle === undefined
    ? undefined
    : sanitizeRetainedPluginLifecycleManifestEvidence(evidence.retainedPluginLifecycle);
  if (
    evidence.phaseCount !== 3
    || !['source', 'candidate_artifact', 'not_proven'].includes(
      evidence.runtime.launchEntrypointKind,
    )
    || ![
      'mutable_runtime',
      'immutable_snapshot',
      'versioned_runtime',
      'unclassified',
    ].includes(evidence.runtime.identityKind)
    || (
      evidence.runtime.launchEntrypointKind === 'source'
      && evidence.runtime.identityKind !== 'mutable_runtime'
    )
    || (
      evidence.runtime.launchEntrypointKind === 'candidate_artifact'
      && evidence.runtime.identityKind !== 'immutable_snapshot'
      && evidence.runtime.identityKind !== 'versioned_runtime'
    )
    || (
      evidence.runtime.launchEntrypointKind === 'candidate_artifact'
      && evidence.underlyingAgent.childProcess.availability !== 'observed'
    )
    || evidence.runtime.distinctEntrypointIdentityCount !== 1
    || evidence.runtime.stableAcrossAllPhases !== true
    || evidence.daemon.distinctIdentityCount !== 3
    || evidence.daemon.replacedAcrossAllPhases !== true
    || evidence.runner.distinctIdentityCount !== 1
    || evidence.runner.distinctProcessCommandHashCount !== 1
    || evidence.runner.aliveAcrossAllPhases !== true
    || evidence.logicalSession.distinctIdentityCount !== 1
    || evidence.logicalSession.stableAcrossAllPhases !== true
    || evidence.executionAuthority.distinctRetainedAgentBindingCount !== 1
    || evidence.executionAuthority.stableAcrossAllPhases !== true
    || !['observed', 'unknown'].includes(evidence.underlyingAgent.childProcess.availability)
    || !['observed', 'unknown'].includes(evidence.underlyingAgent.vendorSession.availability)
    || evidence.authority.distinctCapabilityCount !== 3
    || evidence.authority.rotatedAcrossAllPhases !== true
    || evidence.authority.currentAcceptedAcrossAllPhases !== true
    || evidence.authority.predecessorRejectedAtBAndC !== true
    || evidence.turns.distinctCompletedTurnCount !== 3
    || evidence.turns.matchingAssistantTranscriptOutputCounts.b !== 1
    || evidence.turns.matchingAssistantTranscriptOutputCounts.c !== 1
    || evidence.turns.matchingEffectCounts.b !== 1
    || evidence.turns.matchingEffectCounts.c !== 1
    || evidence.turns.terminalEventCounts.b !== 1
    || evidence.turns.terminalEventCounts.c !== 1
    || evidence.turns.activeTurnCrossedAToB !== true
    || evidence.turns.exactlyOneMatchingAssistantTranscriptOutputPerLaterPhase !== true
    || evidence.turns.exactlyOneMatchingEffectPerLaterPhase !== true
    || evidence.turns.exactlyOneTerminalEventPerLaterPhase !== true
    || distinctPhaseValueCount(evidence.daemon.identityFingerprints) !== 3
    || distinctPhaseValueCount(evidence.runtime.entrypointIdentityFingerprints) !== 1
    || distinctPhaseValueCount(evidence.runner.identityFingerprints) !== 1
    || distinctPhaseValueCount(evidence.runner.processCommandHashFingerprints) !== 1
    || distinctPhaseValueCount(evidence.logicalSession.identityFingerprints) !== 1
    || distinctPhaseValueCount(evidence.executionAuthority.retainedAgentBindingFingerprints) !== 1
    || distinctPhaseValueCount(evidence.authority.capabilityFingerprints) !== 3
    || distinctPhaseValueCount(evidence.turns.completedTurnFingerprints) !== 3
  ) {
    throw new Error('Invalid daemon runner continuity evidence contract');
  }
  return {
    phaseCount: 3,
    runtime: {
      launchEntrypointKind: evidence.runtime.launchEntrypointKind,
      identityKind: evidence.runtime.identityKind,
      entrypointIdentityFingerprints: sanitizePhaseFingerprints(
        evidence.runtime.entrypointIdentityFingerprints,
        'runtime.entrypointIdentityFingerprints',
      ),
      distinctEntrypointIdentityCount: 1,
      stableAcrossAllPhases: true,
    },
    daemon: {
      identityFingerprints: sanitizePhaseFingerprints(
        evidence.daemon.identityFingerprints,
        'daemon.identityFingerprints',
      ),
      distinctIdentityCount: 3,
      replacedAcrossAllPhases: true,
    },
    runner: {
      identityFingerprints: sanitizePhaseFingerprints(
        evidence.runner.identityFingerprints,
        'runner.identityFingerprints',
      ),
      processCommandHashFingerprints: sanitizePhaseFingerprints(
        evidence.runner.processCommandHashFingerprints,
        'runner.processCommandHashFingerprints',
      ),
      distinctIdentityCount: 1,
      distinctProcessCommandHashCount: 1,
      aliveAcrossAllPhases: true,
    },
    logicalSession: {
      identityFingerprints: sanitizePhaseFingerprints(
        evidence.logicalSession.identityFingerprints,
        'logicalSession.identityFingerprints',
      ),
      distinctIdentityCount: 1,
      stableAcrossAllPhases: true,
    },
    executionAuthority: {
      retainedAgentBindingFingerprints: sanitizePhaseFingerprints(
        evidence.executionAuthority.retainedAgentBindingFingerprints,
        'executionAuthority.retainedAgentBindingFingerprints',
      ),
      distinctRetainedAgentBindingCount: 1,
      stableAcrossAllPhases: true,
    },
    underlyingAgent: {
      childProcess: sanitizeOptionalIdentityEvidence(
        evidence.underlyingAgent.childProcess,
        'underlyingAgent.childProcess',
      ),
      vendorSession: sanitizeOptionalIdentityEvidence(
        evidence.underlyingAgent.vendorSession,
        'underlyingAgent.vendorSession',
      ),
    },
    authority: {
      capabilityFingerprints: sanitizePhaseFingerprints(
        evidence.authority.capabilityFingerprints,
        'authority.capabilityFingerprints',
      ),
      distinctCapabilityCount: 3,
      rotatedAcrossAllPhases: true,
      currentAcceptedAcrossAllPhases: true,
      predecessorRejectedAtBAndC: true,
    },
    turns: {
      completedTurnFingerprints: sanitizePhaseFingerprints(
        evidence.turns.completedTurnFingerprints,
        'turns.completedTurnFingerprints',
      ),
      distinctCompletedTurnCount: 3,
      matchingAssistantTranscriptOutputCounts: { b: 1, c: 1 },
      matchingEffectCounts: { b: 1, c: 1 },
      terminalEventCounts: { b: 1, c: 1 },
      activeTurnCrossedAToB: true,
      exactlyOneMatchingAssistantTranscriptOutputPerLaterPhase: true,
      exactlyOneMatchingEffectPerLaterPhase: true,
      exactlyOneTerminalEventPerLaterPhase: true,
    },
    ...(retainedPluginLifecycle === undefined ? {} : { retainedPluginLifecycle }),
  };
}

export type TestManifest = {
  startedAt: string;
  runId?: string;
  testName?: string;
  seed?: number;
  ports?: { server?: number };
  baseUrl?: string;
  sessionIds?: string[];
  env?: Record<string, string | undefined>;
  targetMode?: 'light' | 'full-compose' | 'external';
  topology?: {
    kind: 'light' | 'full-compose' | 'external';
    composeProjectName?: string;
    services?: string[];
    expectedApiReplicas?: number;
    expectedWorkerReplicas?: number;
    resolvedApiReplicas?: number;
    resolvedWorkerReplicas?: number;
    baseUrl?: string;
    ports?: Record<string, number | undefined>;
  };
  scenario?: {
    name: string;
    resolvedConfig?: Record<string, unknown>;
  };
  artifacts?: {
    composeFile?: string;
    gatewayConfigFile?: string;
    summaryFile?: string;
    dockerLogsFile?: string;
    dockerPsFile?: string;
  };
  results?: {
    status: 'passed' | 'failed' | 'running';
    startedAt: string;
    endedAt?: string;
    failureClassification?: 'none' | 'flaky' | 'deterministic' | 'unknown';
    daemonRunnerContinuity?: DaemonRunnerContinuityManifestEvidence;
  };
};

export function writeTestManifest(testDir: string, manifest: TestManifest): string {
  const path = resolve(testDir, 'manifest.json');
  const sanitizedManifest = manifest.results?.daemonRunnerContinuity === undefined
    ? manifest
    : {
        ...manifest,
        results: {
          ...manifest.results,
          daemonRunnerContinuity: sanitizeDaemonRunnerContinuityManifestEvidence(
            manifest.results.daemonRunnerContinuity,
          ),
        },
      };
  writeFileSync(path, `${JSON.stringify(sanitizedManifest, null, 2)}\n`, 'utf8');
  return path;
}
