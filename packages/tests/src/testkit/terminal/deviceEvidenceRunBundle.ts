import { createPrivateKey, randomBytes, randomUUID, sign } from 'node:crypto';

import { terminalEvidenceSha256 } from './deviceEvidenceCanonical';
import { terminalNativeCaptureSigningPayload, terminalNativeObservationDigest } from './deviceEvidenceAttestations';
import type { TerminalNativeDeviceArtifact, TerminalNativeDeviceEvidence } from './deviceEvidence';
import { TERMINAL_NATIVE_PACKAGING_GATES } from './deviceEvidencePins';
import type { TerminalNativeDeviceRenderer } from './native';
import {
  compareTerminalRenderers,
  type TerminalBenchmarkReport,
} from './report';

export function createTerminalNativeRunIdentity(): Readonly<{
  runId: string;
  runNonce: string;
  buildEvidenceId: string;
}> {
  return {
    runId: `term-run-${randomUUID()}`,
    runNonce: randomBytes(32).toString('base64url'),
    buildEvidenceId: `term-build-${randomUUID()}`,
  };
}

export function createTerminalNativeCaptureAttestation(input: Readonly<{
  authorityId: string;
  privateKeyPem: string;
  evidence: Omit<TerminalNativeDeviceEvidence, 'captureAuthority' | 'captureAttestationArtifactId'>
    & Partial<Pick<TerminalNativeDeviceEvidence, 'captureAuthority' | 'captureAttestationArtifactId'>>;
  artifacts: readonly TerminalNativeDeviceArtifact[];
  signedAt: string;
}>): Readonly<Record<string, unknown>> {
  const evidence = input.evidence;
  const artifacts = input.artifacts
    .filter((artifact) => artifact.kind !== 'capture-attestation' && artifact.kind !== 'release-approval')
    .map(({ id, kind, sha256, capturedAt }) => ({ id, kind, sha256, capturedAt }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const unsigned = {
    schemaVersion: 1,
    kind: 'terminal-native-capture-attestation',
    authorityId: input.authorityId,
    runId: evidence.runId,
    runNonce: evidence.runNonce,
    buildEvidenceId: evidence.buildEvidenceId,
    logicalSessionId: evidence.logicalSessionId,
    terminalId: evidence.terminalId,
    rendererId: evidence.renderer.id,
    applicationId: evidence.app.applicationId,
    binarySha256: evidence.app.binarySha256,
    sourceStateSha256: evidence.app.sourceStateSha256,
    dependencyClosureSha256: evidence.renderer.dependencyClosureSha256,
    deviceTargetId: evidence.device.targetId,
    startedAt: evidence.startedAt,
    endedAt: evidence.endedAt,
    artifacts,
    signedAt: input.signedAt,
    signatureAlgorithm: 'ed25519',
  };
  const signature = sign(
    null,
    Buffer.from(terminalNativeCaptureSigningPayload(unsigned)),
    createPrivateKey(input.privateKeyPem),
  ).toString('base64');
  return { ...unsigned, signature };
}

export function createTerminalNativeSourceState(input: Readonly<{
  sourceCommit: string;
  sourceDirty: boolean;
  generatedAt: string;
  inventory: readonly Readonly<{ path: string; sha256: string }>[];
}>): Readonly<Record<string, unknown>> {
  const inventory = [...input.inventory].sort((left, right) => left.path.localeCompare(right.path));
  if (inventory.length === 0 || new Set(inventory.map((entry) => entry.path)).size !== inventory.length) {
    throw new Error('source-state inventory must be non-empty and contain unique paths');
  }
  return {
    schemaVersion: 1,
    kind: 'terminal-native-source-state',
    sourceCommit: input.sourceCommit,
    sourceDirty: input.sourceDirty,
    generatedAt: input.generatedAt,
    inventory,
    inventorySha256: terminalEvidenceSha256(inventory),
  };
}

export function createTerminalNativeLoadedAppAttestation(input: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return { schemaVersion: 1, kind: 'terminal-native-loaded-app-attestation', origin: 'loaded-native-app', ...input };
}

export function createTerminalNativePackagingAttestation(input: Readonly<{
  buildEvidenceId: string;
  rendererId: TerminalNativeDeviceRenderer;
  binarySha256: string;
  sourceStateSha256: string;
  dependencyClosureSha256: string;
  generatedAt: string;
  reports: Readonly<Record<string, Readonly<{ tool: string; reportArtifactId: string; reportSha256: string }>>>;
}>): Readonly<Record<string, unknown>> {
  const gates = TERMINAL_NATIVE_PACKAGING_GATES[input.rendererId].map((id) => {
    const report = input.reports[id];
    if (!report) throw new Error(`missing packaging report for ${id}`);
    return { id, status: 'passed', tool: report.tool, reportArtifactId: report.reportArtifactId, reportSha256: report.reportSha256 };
  });
  return {
    schemaVersion: 1,
    kind: 'terminal-native-packaging-attestation',
    buildEvidenceId: input.buildEvidenceId,
    rendererId: input.rendererId,
    binarySha256: input.binarySha256,
    sourceStateSha256: input.sourceStateSha256,
    dependencyClosureSha256: input.dependencyClosureSha256,
    generatedAt: input.generatedAt,
    gates,
  };
}

export function createTerminalNativePackagingGateReport(input: Readonly<{
  buildEvidenceId: string;
  rendererId: TerminalNativeDeviceRenderer;
  gateId: string;
  tool: string;
  binarySha256: string;
  sourceStateSha256: string;
  dependencyClosureSha256: string;
  generatedAt: string;
  details: Readonly<Record<string, unknown>>;
}>): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: 1,
    kind: 'terminal-native-packaging-gate-report',
    buildEvidenceId: input.buildEvidenceId,
    rendererId: input.rendererId,
    gateId: input.gateId,
    status: 'passed',
    tool: input.tool,
    binarySha256: input.binarySha256,
    sourceStateSha256: input.sourceStateSha256,
    dependencyClosureSha256: input.dependencyClosureSha256,
    generatedAt: input.generatedAt,
    details: input.details,
  };
}

export function createTerminalNativeObservationReport(input: Readonly<{
  runId: string;
  runNonce: string;
  buildEvidenceId: string;
  logicalSessionId: string;
  terminalId: string;
  rendererId: TerminalNativeDeviceRenderer;
  observationKind: 'workload' | 'action' | 'accessibility';
  observation: Readonly<Record<string, unknown>>;
  recordedAt: string;
}>): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: 1,
    kind: 'terminal-native-observation-report',
    runId: input.runId,
    runNonce: input.runNonce,
    buildEvidenceId: input.buildEvidenceId,
    logicalSessionId: input.logicalSessionId,
    terminalId: input.terminalId,
    rendererId: input.rendererId,
    observationKind: input.observationKind,
    observationId: input.observation.id,
    observationSha256: terminalNativeObservationDigest(input.observation),
    recordedAt: input.recordedAt,
  };
}

export function createTerminalNativeRendererBenchmarkReport(input: Readonly<{
  runId: string;
  runNonce: string;
  buildEvidenceId: string;
  logicalSessionId: string;
  terminalId: string;
  rendererId: TerminalNativeDeviceRenderer;
  applicationId: string;
  binarySha256: string;
  deviceTargetId: string;
  platform: 'ios' | 'android';
  benchmark: TerminalBenchmarkReport;
  recordedAt: string;
}>): Readonly<Record<string, unknown>> {
  const minThroughputRatio = input.platform === 'android' ? 1.25 : 0.75;
  const comparison = compareTerminalRenderers(input.benchmark, {
    baselineRenderer: 'xterm-webview',
    candidateRenderer: input.rendererId,
    timingBoundary: 'display-observed',
    minThroughputRatio,
    minSamplesPerWorkload: 3,
  });
  return {
    schemaVersion: 1,
    kind: 'terminal-native-renderer-benchmark',
    runId: input.runId,
    runNonce: input.runNonce,
    buildEvidenceId: input.buildEvidenceId,
    logicalSessionId: input.logicalSessionId,
    terminalId: input.terminalId,
    rendererId: input.rendererId,
    applicationId: input.applicationId,
    binarySha256: input.binarySha256,
    deviceTargetId: input.deviceTargetId,
    platform: input.platform,
    baselineRenderer: 'xterm-webview',
    candidateRenderer: input.rendererId,
    timingBoundary: 'display-observed',
    observationSource: 'loaded-device',
    minThroughputRatio,
    minSamplesPerWorkload: 3,
    benchmark: input.benchmark,
    comparison,
    recordedAt: input.recordedAt,
  };
}
