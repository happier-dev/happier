import { bytesSha256Hex } from './ansi';
import {
  TERMINAL_NATIVE_ACCESSIBILITY_DEVICE_EVIDENCE_IDS,
  type TerminalNativeAccessibilityDeviceEvidenceId,
} from './accessibility';
import {
  TERMINAL_NATIVE_DEVICE_ACTION_IDS,
  getTerminalNativeDeviceRecipe,
  type TerminalNativeDeviceActionId,
  type TerminalNativeDevicePlatform,
  type TerminalNativeDeviceRenderer,
} from './native';
import { getTerminalWorkload, type TerminalWorkloadId } from './workloads';

export const TERMINAL_NATIVE_DEVICE_EVIDENCE_SCHEMA_VERSION = 2 as const;

export const TERMINAL_NATIVE_DEVICE_ARTIFACT_KINDS = [
  'app-binary',
  'screenshot',
  'video',
  'log',
  'accessibility-tree',
  'device-report',
  'source-state',
  'runtime-attestation',
  'packaging-report',
  'packaging-gate-report',
  'observation-report',
  'renderer-benchmark',
  'release-approval',
  'capture-attestation',
] as const;

export type TerminalNativeDeviceArtifactKind =
  typeof TERMINAL_NATIVE_DEVICE_ARTIFACT_KINDS[number];

export type TerminalNativeDeviceArtifact = Readonly<{
  id: string;
  kind: TerminalNativeDeviceArtifactKind;
  path: string;
  mediaType: string;
  sha256: string;
  capturedAt: string;
}>;

export type TerminalNativeDeviceWorkloadEvidence = Readonly<{
  id: TerminalWorkloadId;
  status: 'passed' | 'failed';
  startedAt: string;
  endedAt: string;
  fixtureByteLength: number;
  fixtureSha256: string;
  startByteOffset: number;
  acceptedByteOffset: number;
  ack: Readonly<{
    terminalId: string;
    writeId: string;
    outcome: 'accepted' | 'rejected';
    completedAt: string;
  }>;
  artifactIds: readonly string[];
  reportArtifactId: string;
}>;

export type TerminalNativeDeviceActionEvidence = Readonly<{
  id: TerminalNativeDeviceActionId;
  status: 'passed' | 'failed';
  startedAt: string;
  endedAt: string;
  sequence: number;
  operationId: string;
  startByteOffset: number;
  acceptedByteOffset: number;
  details: Readonly<Record<string, unknown>>;
  artifactIds: readonly string[];
  reportArtifactId: string;
}>;

export type TerminalNativeAccessibilityEvidence = Readonly<{
  id: TerminalNativeAccessibilityDeviceEvidenceId;
  status: 'passed' | 'failed';
  startedAt: string;
  endedAt: string;
  details: Readonly<Record<string, unknown>>;
  artifactIds: readonly string[];
  reportArtifactId: string;
}>;

export type TerminalNativeExternalApproval = Readonly<{
  required: boolean;
  status: 'approved' | 'pending' | 'rejected' | 'not-required';
  authority: string | null;
  exactDependencyClosureSha256: string;
  recordedAt: string;
  approvalArtifactId: string | null;
}>;

export type TerminalNativeRendererComparisonEvidence = Readonly<{
  status: 'passed' | 'failed';
  baselineRenderer: 'xterm-webview';
  candidateRenderer: TerminalNativeDeviceRenderer;
  timingBoundary: 'display-observed';
  observationSource: 'loaded-device';
  minThroughputRatio: number;
  minSamplesPerWorkload: 3;
  reportArtifactId: string;
}>;

export type TerminalNativeDeviceEvidence = Readonly<{
  schemaVersion: typeof TERMINAL_NATIVE_DEVICE_EVIDENCE_SCHEMA_VERSION;
  runId: string;
  runNonce: string;
  buildEvidenceId: string;
  evidenceSource: 'loaded-native-app';
  captureAuthority: string;
  captureAttestationArtifactId: string;
  startedAt: string;
  endedAt: string;
  platform: TerminalNativeDevicePlatform;
  app: Readonly<{
    applicationId: string;
    version: string;
    buildNumber: string;
    buildVariant: string;
    sourceCommit: string;
    sourceDirty: boolean;
    sourceStateSha256: string;
    sourceStateArtifactId: string;
    runtimeAttestationArtifactId: string;
    packagingReportArtifactId: string;
    nativeEnabled: true;
    binarySha256: string;
    binaryArtifactId: string;
  }>;
  device: Readonly<{
    model: string;
    osName: string;
    osVersion: string;
    architecture: string;
    simulator: boolean;
    targetId: string;
  }>;
  renderer: Readonly<{
    id: TerminalNativeDeviceRenderer;
    implementation: 'ghosttykit' | 'termux-terminal-renderer';
    nativePackageVersion: string;
    dependencyName: string;
    dependencyRevision: string;
    dependencyChecksumSha256: string;
    dependencyClosureSha256: string;
  }>;
  logicalSessionId: string;
  terminalId: string;
  workloads: readonly TerminalNativeDeviceWorkloadEvidence[];
  actions: readonly TerminalNativeDeviceActionEvidence[];
  accessibility: readonly TerminalNativeAccessibilityEvidence[];
  rendererComparison: TerminalNativeRendererComparisonEvidence;
  artifacts: readonly TerminalNativeDeviceArtifact[];
  externalApproval: TerminalNativeExternalApproval;
}>;

export type TerminalNativeDeviceEvidenceIssue = Readonly<{
  code: string;
  path: string;
  message: string;
}>;

export type TerminalNativeDeviceEvidenceValidation = Readonly<{
  schemaValid: boolean;
  deviceAcceptanceReady: boolean;
  releaseApprovalReady: boolean;
  accepted: boolean;
  platform: TerminalNativeDevicePlatform | null;
  renderer: TerminalNativeDeviceRenderer | null;
  issues: readonly TerminalNativeDeviceEvidenceIssue[];
}>;

type JsonObject = Record<string, unknown>;

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const ARTIFACT_PATH_PATTERN = /^(?:[^/]+\/)*\.project\/logs\/(?:e2e\/terminal-native|terminal-bench)\/.+/;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function hasOnlyKeys(
  value: JsonObject,
  allowed: readonly string[],
  path: string,
  issue: (code: string, path: string, message: string) => void,
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      issue('unknown-field', `${path}.${key}`, 'field is not part of the TERM-7b evidence schema');
    }
  }
}

function requireString(
  value: unknown,
  path: string,
  issue: (code: string, path: string, message: string) => void,
): value is string {
  if (!isNonEmptyString(value)) {
    issue('invalid-string', path, 'must be a non-empty string');
    return false;
  }
  return true;
}

function requireTimestamp(
  value: unknown,
  path: string,
  issue: (code: string, path: string, message: string) => void,
): value is string {
  if (!isTimestamp(value)) {
    issue('invalid-timestamp', path, 'must be an ISO-compatible timestamp');
    return false;
  }
  return true;
}

function validateInterval(
  value: JsonObject,
  path: string,
  issue: (code: string, path: string, message: string) => void,
): void {
  const hasStart = requireTimestamp(value.startedAt, `${path}.startedAt`, issue);
  const hasEnd = requireTimestamp(value.endedAt, `${path}.endedAt`, issue);
  if (hasStart && hasEnd && Date.parse(value.endedAt as string) < Date.parse(value.startedAt as string)) {
    issue('invalid-interval', path, 'endedAt must not precede startedAt');
  }
}

function validateTimestampInsideInterval(
  value: unknown,
  interval: JsonObject,
  path: string,
  issue: (code: string, path: string, message: string) => void,
): void {
  if (!isTimestamp(value) || !isTimestamp(interval.startedAt) || !isTimestamp(interval.endedAt)) return;
  const instant = Date.parse(value);
  if (instant < Date.parse(interval.startedAt) || instant > Date.parse(interval.endedAt)) {
    issue('timestamp-outside-observation', path, 'must fall within the observation startedAt/endedAt interval');
  }
}

function validateArtifactReferences(
  refs: unknown,
  path: string,
  artifactKinds: ReadonlyMap<string, TerminalNativeDeviceArtifactKind>,
  allowedKinds: readonly TerminalNativeDeviceArtifactKind[],
  issue: (code: string, path: string, message: string) => void,
): void {
  if (!Array.isArray(refs) || refs.length === 0) {
    issue('missing-artifact-reference', path, 'must reference at least one captured artifact');
    return;
  }
  const seen = new Set<string>();
  let hasProofArtifact = false;
  refs.forEach((ref, index) => {
    if (!isNonEmptyString(ref)) {
      issue('invalid-artifact-reference', `${path}[${index}]`, 'must be a non-empty artifact id');
    } else if (seen.has(ref)) {
      issue('duplicate-artifact-reference', `${path}[${index}]`, `duplicates artifact id ${ref}`);
    } else if (!artifactKinds.has(ref)) {
      issue('unknown-artifact-reference', `${path}[${index}]`, `references unknown artifact id ${ref}`);
    } else if (allowedKinds.includes(artifactKinds.get(ref)!)) {
      hasProofArtifact = true;
    }
    if (typeof ref === 'string') seen.add(ref);
  });
  if (!hasProofArtifact) {
    issue('missing-proof-artifact', path, `must reference at least one ${allowedKinds.join(' or ')} artifact`);
  }
}

function validateBooleanDetail(
  details: JsonObject,
  key: string,
  path: string,
  issue: (code: string, path: string, message: string) => void,
): void {
  if (details[key] !== true) {
    issue('failed-action-invariant', `${path}.${key}`, 'must be true');
  }
}

function validateActionDetails(
  id: TerminalNativeDeviceActionId,
  details: JsonObject,
  context: Readonly<{ logicalSessionId: string | null; terminalId: string | null; renderer: TerminalNativeDeviceRenderer | null }>,
  path: string,
  issue: (code: string, path: string, message: string) => void,
): void {
  if (id === 'async-byte-write-ack-reject-retry') {
    hasOnlyKeys(details, [
      'terminalId', 'initialByteOffset', 'byteLength', 'rejectedWriteId', 'rejectedOutcome',
      'rejectedAt', 'rejectedOffsetAfter', 'retryWriteId', 'retryOutcome', 'retryFromByteOffset',
      'acceptedByteOffset', 'retryCompletedAt', 'rejectionReason',
    ], path, issue);
    const initial = details.initialByteOffset;
    const byteLength = details.byteLength;
    if (!isNonNegativeInteger(initial)) issue('invalid-offset', `${path}.initialByteOffset`, 'must be a non-negative integer');
    if (!Number.isInteger(byteLength) || (byteLength as number) < 1) issue('invalid-byte-length', `${path}.byteLength`, 'must be a positive integer');
    requireString(details.rejectedWriteId, `${path}.rejectedWriteId`, issue);
    requireString(details.retryWriteId, `${path}.retryWriteId`, issue);
    requireString(details.rejectionReason, `${path}.rejectionReason`, issue);
    if (details.terminalId !== context.terminalId) issue('ack-terminal-mismatch', `${path}.terminalId`, 'must equal the run terminalId');
    if (details.rejectedOutcome !== 'rejected') issue('rejection-outcome-mismatch', `${path}.rejectedOutcome`, 'must equal rejected');
    if (details.retryOutcome !== 'accepted') issue('retry-outcome-mismatch', `${path}.retryOutcome`, 'must equal accepted');
    requireTimestamp(details.rejectedAt, `${path}.rejectedAt`, issue);
    requireTimestamp(details.retryCompletedAt, `${path}.retryCompletedAt`, issue);
    if (details.rejectedWriteId === details.retryWriteId) issue('reused-write-id', path, 'retry must use a distinct write id');
    if (isNonNegativeInteger(initial) && details.rejectedOffsetAfter !== initial) {
      issue('rejection-advanced-offset', `${path}.rejectedOffsetAfter`, 'rejected write must not advance the byte offset');
    }
    if (isNonNegativeInteger(initial) && details.retryFromByteOffset !== initial) {
      issue('retry-offset-mismatch', `${path}.retryFromByteOffset`, 'retry must start from the original byte offset');
    }
    if (isNonNegativeInteger(initial) && Number.isInteger(byteLength)
      && details.acceptedByteOffset !== initial + (byteLength as number)) {
      issue('accepted-offset-mismatch', `${path}.acceptedByteOffset`, 'accepted retry must advance by exactly byteLength');
    }
    return;
  }

  if (id === 'renderer-crash-fallback') {
    hasOnlyKeys(details, [
      'logicalSessionIdBefore', 'logicalSessionIdAfter', 'terminalIdBefore', 'terminalIdAfter',
      'rendererBefore', 'rendererAfter', 'fallbackObserved', 'contentRetained',
      'contentMarkerBeforeSha256', 'contentMarkerAfterSha256',
    ], path, issue);
    if (details.logicalSessionIdBefore !== context.logicalSessionId || details.logicalSessionIdAfter !== context.logicalSessionId) {
      issue('session-continuity-failed', path, 'crash fallback must preserve the run logicalSessionId');
    }
    if (details.terminalIdBefore !== context.terminalId || details.terminalIdAfter !== context.terminalId) {
      issue('terminal-continuity-failed', path, 'crash fallback must preserve the run terminalId');
    }
    if (details.rendererBefore !== context.renderer || details.rendererAfter !== 'xterm-webview') {
      issue('fallback-renderer-mismatch', path, 'must transition from the native renderer to xterm-webview');
    }
    validateBooleanDetail(details, 'fallbackObserved', path, issue);
    validateBooleanDetail(details, 'contentRetained', path, issue);
    if (typeof details.contentMarkerBeforeSha256 !== 'string' || !SHA256_PATTERN.test(details.contentMarkerBeforeSha256)) {
      issue('invalid-content-marker', `${path}.contentMarkerBeforeSha256`, 'must be a lowercase SHA-256');
    }
    if (details.contentMarkerAfterSha256 !== details.contentMarkerBeforeSha256) {
      issue('content-marker-mismatch', `${path}.contentMarkerAfterSha256`, 'must match the pre-crash content marker');
    }
    return;
  }

  if (id === 'background-resume') {
    hasOnlyKeys(details, [
      'logicalSessionIdBefore', 'logicalSessionIdAfter', 'byteOffsetBefore', 'byteOffsetAfter',
      'contentRetained', 'inputAcceptedAfterResume',
    ], path, issue);
    if (details.logicalSessionIdBefore !== context.logicalSessionId || details.logicalSessionIdAfter !== context.logicalSessionId) {
      issue('session-continuity-failed', path, 'background/resume must preserve the run logicalSessionId');
    }
    if (!isNonNegativeInteger(details.byteOffsetBefore) || !isNonNegativeInteger(details.byteOffsetAfter)
      || (details.byteOffsetAfter as number) < (details.byteOffsetBefore as number)) {
      issue('resume-offset-regression', path, 'resume byte offset must be non-negative and must not regress');
    }
    validateBooleanDetail(details, 'contentRetained', path, issue);
    validateBooleanDetail(details, 'inputAcceptedAfterResume', path, issue);
    return;
  }

  if (id === 'resize-orientation') {
    hasOnlyKeys(details, [
      'logicalSessionIdBefore', 'logicalSessionIdAfter', 'initialColumns', 'initialRows',
      'resizedColumns', 'resizedRows', 'restoredColumns', 'restoredRows', 'contentRetained',
    ], path, issue);
    if (details.logicalSessionIdBefore !== context.logicalSessionId || details.logicalSessionIdAfter !== context.logicalSessionId) {
      issue('session-continuity-failed', path, 'rotation/resize must preserve the run logicalSessionId');
    }
    for (const key of ['initialColumns', 'initialRows', 'resizedColumns', 'resizedRows', 'restoredColumns', 'restoredRows']) {
      if (!Number.isInteger(details[key]) || (details[key] as number) < 1) {
        issue('invalid-grid-size', `${path}.${key}`, 'must be a positive integer');
      }
    }
    if (details.initialColumns === details.resizedColumns && details.initialRows === details.resizedRows) {
      issue('resize-not-observed', path, 'resized grid must differ from the initial grid');
    }
    if (details.initialColumns !== details.restoredColumns || details.initialRows !== details.restoredRows) {
      issue('grid-not-restored', path, 'restored grid must equal the initial grid');
    }
    validateBooleanDetail(details, 'contentRetained', path, issue);
    return;
  }

  if (id === 'hardware-keyboard-chords') {
    hasOnlyKeys(details, ['chords', 'terminalObserved'], path, issue);
    if (!Array.isArray(details.chords) || details.chords.length === 0
      || !details.chords.every(isNonEmptyString)) {
      issue('missing-keyboard-chords', `${path}.chords`, 'must list at least one exercised hardware chord');
    }
    validateBooleanDetail(details, 'terminalObserved', path, issue);
    return;
  }

  if (id === 'ime-composition') {
    hasOnlyKeys(details, ['composedText', 'committedText', 'terminalObserved'], path, issue);
    requireString(details.composedText, `${path}.composedText`, issue);
    requireString(details.committedText, `${path}.committedText`, issue);
    validateBooleanDetail(details, 'terminalObserved', path, issue);
    return;
  }

  hasOnlyKeys(details, ['selectedText', 'copiedText', 'copyMatchesSelection'], path, issue);
  requireString(details.selectedText, `${path}.selectedText`, issue);
  requireString(details.copiedText, `${path}.copiedText`, issue);
  if (details.selectedText !== details.copiedText || details.copyMatchesSelection !== true) {
    issue('selection-copy-mismatch', path, 'copiedText must exactly match selectedText');
  }
}

function validateAccessibilityDetails(
  id: TerminalNativeAccessibilityDeviceEvidenceId,
  details: JsonObject,
  path: string,
  issue: (code: string, path: string, message: string) => void,
): void {
  if (id === 'platform-accessibility-tree') {
    hasOnlyKeys(details, ['terminalNodeCount', 'usefulContentExposed', 'summary'], path, issue);
    if (!Number.isInteger(details.terminalNodeCount) || (details.terminalNodeCount as number) < 1) {
      issue('missing-accessibility-node', `${path}.terminalNodeCount`, 'must record at least one terminal accessibility node');
    }
    validateBooleanDetail(details, 'usefulContentExposed', path, issue);
    requireString(details.summary, `${path}.summary`, issue);
    return;
  }
  if (id === 'screen-reader-navigation') {
    hasOnlyKeys(details, ['screenReader', 'reachedCurrentOutput', 'spokenSummary'], path, issue);
    requireString(details.screenReader, `${path}.screenReader`, issue);
    validateBooleanDetail(details, 'reachedCurrentOutput', path, issue);
    requireString(details.spokenSummary, `${path}.spokenSummary`, issue);
    return;
  }
  hasOnlyKeys(details, ['reachableAffordances', 'actionsInvoked'], path, issue);
  const expected = ['copy', 'select', 'open-link'];
  for (const key of ['reachableAffordances', 'actionsInvoked']) {
    const values = details[key];
    if (!Array.isArray(values) || expected.some((item) => !values.includes(item))) {
      issue('missing-accessible-affordance', `${path}.${key}`, `must include ${expected.join(', ')}`);
    }
  }
}

export function validateTerminalNativeDeviceEvidence(value: unknown): TerminalNativeDeviceEvidenceValidation {
  const issues: TerminalNativeDeviceEvidenceIssue[] = [];
  const issue = (code: string, path: string, message: string): void => {
    issues.push({ code, path, message });
  };
  if (!isObject(value)) {
    issue('invalid-root', '$', 'evidence must be a JSON object');
    return {
      schemaValid: false,
      deviceAcceptanceReady: false,
      releaseApprovalReady: false,
      accepted: false,
      platform: null,
      renderer: null,
      issues,
    };
  }

  hasOnlyKeys(value, [
    'schemaVersion', 'runId', 'runNonce', 'buildEvidenceId', 'evidenceSource', 'captureAuthority',
    'captureAttestationArtifactId', 'startedAt', 'endedAt', 'platform',
    'app', 'device', 'renderer', 'logicalSessionId', 'terminalId', 'workloads',
    'actions', 'accessibility', 'rendererComparison', 'artifacts', 'externalApproval',
  ], '$', issue);
  if (value.schemaVersion !== TERMINAL_NATIVE_DEVICE_EVIDENCE_SCHEMA_VERSION) {
    issue('unsupported-schema-version', '$.schemaVersion', `must equal ${TERMINAL_NATIVE_DEVICE_EVIDENCE_SCHEMA_VERSION}`);
  }
  requireString(value.runId, '$.runId', issue);
  if (!isNonEmptyString(value.runId) || !/^[A-Za-z0-9._-]+$/.test(value.runId)) {
    issue('invalid-run-id', '$.runId', 'must be path-safe');
  }
  if (!isNonEmptyString(value.runNonce) || value.runNonce.length < 32) {
    issue('invalid-run-nonce', '$.runNonce', 'must contain at least 32 characters of app-emitted nonce material');
  }
  if (!isNonEmptyString(value.buildEvidenceId) || value.buildEvidenceId.length < 16) {
    issue('invalid-build-evidence-id', '$.buildEvidenceId', 'must contain at least 16 characters');
  }
  if (value.evidenceSource !== 'loaded-native-app') {
    issue('invalid-evidence-source', '$.evidenceSource', 'must equal loaded-native-app');
  }
  requireString(value.captureAuthority, '$.captureAuthority', issue);
  requireString(value.captureAttestationArtifactId, '$.captureAttestationArtifactId', issue);
  validateInterval(value, '$', issue);

  const platform = value.platform === 'ios' || value.platform === 'android' ? value.platform : null;
  if (!platform) issue('invalid-platform', '$.platform', 'must equal ios or android');
  requireString(value.logicalSessionId, '$.logicalSessionId', issue);
  requireString(value.terminalId, '$.terminalId', issue);

  if (!isObject(value.app)) {
    issue('invalid-object', '$.app', 'must be an object');
  } else {
    hasOnlyKeys(value.app, [
      'applicationId', 'version', 'buildNumber', 'buildVariant', 'sourceCommit',
      'sourceDirty', 'sourceStateSha256', 'sourceStateArtifactId', 'nativeEnabled',
      'binarySha256', 'binaryArtifactId', 'runtimeAttestationArtifactId',
      'packagingReportArtifactId',
    ], '$.app', issue);
    for (const key of ['applicationId', 'version', 'buildNumber', 'buildVariant']) {
      requireString(value.app[key], `$.app.${key}`, issue);
    }
    if (typeof value.app.sourceCommit !== 'string' || !COMMIT_PATTERN.test(value.app.sourceCommit)) {
      issue('invalid-source-commit', '$.app.sourceCommit', 'must be a lowercase 40-character Git commit');
    }
    if (typeof value.app.sourceDirty !== 'boolean') issue('invalid-boolean', '$.app.sourceDirty', 'must be boolean');
    if (typeof value.app.sourceStateSha256 !== 'string' || !SHA256_PATTERN.test(value.app.sourceStateSha256)) {
      issue('invalid-checksum', '$.app.sourceStateSha256', 'must be a lowercase SHA-256');
    }
    requireString(value.app.sourceStateArtifactId, '$.app.sourceStateArtifactId', issue);
    requireString(value.app.runtimeAttestationArtifactId, '$.app.runtimeAttestationArtifactId', issue);
    requireString(value.app.packagingReportArtifactId, '$.app.packagingReportArtifactId', issue);
    if (value.app.nativeEnabled !== true) issue('native-not-enabled', '$.app.nativeEnabled', 'must be true');
    if (typeof value.app.binarySha256 !== 'string' || !SHA256_PATTERN.test(value.app.binarySha256)) {
      issue('invalid-checksum', '$.app.binarySha256', 'must be a lowercase SHA-256');
    }
    requireString(value.app.binaryArtifactId, '$.app.binaryArtifactId', issue);
  }

  if (!isObject(value.device)) {
    issue('invalid-object', '$.device', 'must be an object');
  } else {
    hasOnlyKeys(value.device, ['model', 'osName', 'osVersion', 'architecture', 'simulator', 'targetId'], '$.device', issue);
    for (const key of ['model', 'osName', 'osVersion', 'architecture', 'targetId']) {
      requireString(value.device[key], `$.device.${key}`, issue);
    }
    if (typeof value.device.simulator !== 'boolean') issue('invalid-boolean', '$.device.simulator', 'must be boolean');
  }

  let renderer: TerminalNativeDeviceRenderer | null = null;
  if (!isObject(value.renderer)) {
    issue('invalid-object', '$.renderer', 'must be an object');
  } else {
    hasOnlyKeys(value.renderer, [
      'id', 'implementation', 'nativePackageVersion', 'dependencyName',
      'dependencyRevision', 'dependencyChecksumSha256', 'dependencyClosureSha256',
    ], '$.renderer', issue);
    if (value.renderer.id === 'ios-ghosttykit' || value.renderer.id === 'android-termux') {
      renderer = value.renderer.id;
    } else {
      issue('invalid-renderer', '$.renderer.id', 'must name a TERM native renderer');
    }
    const expectedImplementation = renderer === 'ios-ghosttykit' ? 'ghosttykit' : 'termux-terminal-renderer';
    if (renderer && value.renderer.implementation !== expectedImplementation) {
      issue('renderer-implementation-mismatch', '$.renderer.implementation', `must equal ${expectedImplementation}`);
    }
    for (const key of ['nativePackageVersion', 'dependencyName', 'dependencyRevision']) {
      requireString(value.renderer[key], `$.renderer.${key}`, issue);
    }
    if (typeof value.renderer.dependencyChecksumSha256 !== 'string'
      || !SHA256_PATTERN.test(value.renderer.dependencyChecksumSha256)) {
      issue('invalid-checksum', '$.renderer.dependencyChecksumSha256', 'must be a lowercase SHA-256');
    }
    if (typeof value.renderer.dependencyClosureSha256 !== 'string'
      || !SHA256_PATTERN.test(value.renderer.dependencyClosureSha256)) {
      issue('invalid-checksum', '$.renderer.dependencyClosureSha256', 'must be a lowercase SHA-256');
    }
  }
  if (platform && renderer) {
    const recipe = getTerminalNativeDeviceRecipe(renderer);
    if (recipe.platform !== platform) {
      issue('platform-renderer-mismatch', '$.renderer.id', `${renderer} does not run on ${platform}`);
    }
  }

  if (!isObject(value.rendererComparison)) {
    issue('invalid-object', '$.rendererComparison', 'must be an object');
  } else {
    hasOnlyKeys(value.rendererComparison, [
      'status', 'baselineRenderer', 'candidateRenderer', 'timingBoundary',
      'observationSource', 'minThroughputRatio', 'minSamplesPerWorkload', 'reportArtifactId',
    ], '$.rendererComparison', issue);
    if (value.rendererComparison.status !== 'passed') {
      issue('renderer-comparison-not-passed', '$.rendererComparison.status', 'must equal passed');
    }
    if (value.rendererComparison.baselineRenderer !== 'xterm-webview') {
      issue('renderer-comparison-baseline-mismatch', '$.rendererComparison.baselineRenderer', 'must equal xterm-webview');
    }
    if (renderer && value.rendererComparison.candidateRenderer !== renderer) {
      issue('renderer-comparison-candidate-mismatch', '$.rendererComparison.candidateRenderer', 'must equal the loaded native renderer');
    }
    if (value.rendererComparison.timingBoundary !== 'display-observed') {
      issue('renderer-comparison-boundary-mismatch', '$.rendererComparison.timingBoundary', 'must equal display-observed; parser/write ACK timing is not display evidence');
    }
    if (value.rendererComparison.observationSource !== 'loaded-device') {
      issue('renderer-comparison-source-mismatch', '$.rendererComparison.observationSource', 'must equal loaded-device');
    }
    const expectedRatio = platform === 'android' ? 1.25 : 0.75;
    if (value.rendererComparison.minThroughputRatio !== expectedRatio) {
      issue('renderer-comparison-threshold-mismatch', '$.rendererComparison.minThroughputRatio', `must equal the packet-owned ${expectedRatio} floor`);
    }
    if (value.rendererComparison.minSamplesPerWorkload !== 3) {
      issue('renderer-comparison-sample-floor-mismatch', '$.rendererComparison.minSamplesPerWorkload', 'must equal 3');
    }
    requireString(value.rendererComparison.reportArtifactId, '$.rendererComparison.reportArtifactId', issue);
  }

  const artifactKinds = new Map<string, TerminalNativeDeviceArtifactKind>();
  if (!Array.isArray(value.artifacts) || value.artifacts.length === 0) {
    issue('missing-artifacts', '$.artifacts', 'must contain captured device artifacts');
  } else {
    value.artifacts.forEach((rawArtifact, index) => {
      const path = `$.artifacts[${index}]`;
      if (!isObject(rawArtifact)) {
        issue('invalid-object', path, 'must be an object');
        return;
      }
      hasOnlyKeys(rawArtifact, ['id', 'kind', 'path', 'mediaType', 'sha256', 'capturedAt'], path, issue);
      if (requireString(rawArtifact.id, `${path}.id`, issue)) {
        if (artifactKinds.has(rawArtifact.id)) issue('duplicate-artifact-id', `${path}.id`, `duplicates ${rawArtifact.id}`);
        if (TERMINAL_NATIVE_DEVICE_ARTIFACT_KINDS.includes(rawArtifact.kind as TerminalNativeDeviceArtifactKind)) {
          artifactKinds.set(rawArtifact.id, rawArtifact.kind as TerminalNativeDeviceArtifactKind);
        }
      }
      if (!TERMINAL_NATIVE_DEVICE_ARTIFACT_KINDS.includes(rawArtifact.kind as TerminalNativeDeviceArtifactKind)) {
        issue('invalid-artifact-kind', `${path}.kind`, 'must name a supported artifact kind');
      }
      if (!isNonEmptyString(rawArtifact.path) || rawArtifact.path.startsWith('/')
        || rawArtifact.path.split('/').includes('..') || !ARTIFACT_PATH_PATTERN.test(rawArtifact.path)) {
        issue('invalid-artifact-path', `${path}.path`, 'must be a relative path under an ignored .project/logs/e2e/terminal-native or terminal-bench directory');
      }
      if (isNonEmptyString(value.runId) && isNonEmptyString(rawArtifact.path)
        && !rawArtifact.path.split('/').includes(value.runId)) {
        issue('artifact-run-path-mismatch', `${path}.path`, 'artifact path must be scoped under the evidence runId directory');
      }
      requireString(rawArtifact.mediaType, `${path}.mediaType`, issue);
      if (typeof rawArtifact.sha256 !== 'string' || !SHA256_PATTERN.test(rawArtifact.sha256)) {
        issue('invalid-checksum', `${path}.sha256`, 'must be a lowercase SHA-256');
      }
      requireTimestamp(rawArtifact.capturedAt, `${path}.capturedAt`, issue);
    });
  }

  if (isObject(value.app) && isNonEmptyString(value.app.binaryArtifactId)) {
    const app = value.app;
    const binaryArtifact = Array.isArray(value.artifacts)
      ? value.artifacts.find((candidate) => isObject(candidate) && candidate.id === app.binaryArtifactId)
      : undefined;
    if (!isObject(binaryArtifact)) {
      issue('missing-binary-artifact', '$.app.binaryArtifactId', 'must reference the retained loaded app binary artifact');
    } else {
      if (binaryArtifact.kind !== 'app-binary') {
        issue('invalid-binary-artifact-kind', '$.app.binaryArtifactId', 'must reference an app-binary artifact');
      }
      if (binaryArtifact.sha256 !== app.binarySha256) {
        issue('binary-checksum-mismatch', '$.app.binarySha256', 'must equal the referenced app-binary artifact SHA-256');
      }
    }
  }
  if (isObject(value.app) && isNonEmptyString(value.app.sourceStateArtifactId)) {
    const app = value.app;
    const sourceStateArtifact = Array.isArray(value.artifacts)
      ? value.artifacts.find((candidate) => isObject(candidate) && candidate.id === app.sourceStateArtifactId)
      : undefined;
    if (!isObject(sourceStateArtifact)) {
      issue('missing-source-state-artifact', '$.app.sourceStateArtifactId', 'must reference the retained build source-state manifest');
    } else {
      if (sourceStateArtifact.kind !== 'source-state') {
        issue('invalid-source-state-artifact-kind', '$.app.sourceStateArtifactId', 'must reference a source-state artifact');
      }
      if (sourceStateArtifact.sha256 !== app.sourceStateSha256) {
        issue('source-state-checksum-mismatch', '$.app.sourceStateSha256', 'must equal the referenced source-state artifact SHA-256');
      }
    }
  }
  if (isObject(value.app)) {
    for (const [field, kind] of [
      ['runtimeAttestationArtifactId', 'runtime-attestation'],
      ['packagingReportArtifactId', 'packaging-report'],
    ] as const) {
      const artifactId = value.app[field];
      if (!isNonEmptyString(artifactId)) continue;
      const artifact = Array.isArray(value.artifacts)
        ? value.artifacts.find((candidate) => isObject(candidate) && candidate.id === artifactId)
        : undefined;
      if (!isObject(artifact)) {
        issue(`missing-${kind}`, `$.app.${field}`, `must reference a ${kind} artifact`);
      } else if (artifact.kind !== kind) {
        issue(`invalid-${kind}-kind`, `$.app.${field}`, `must reference a ${kind} artifact`);
      }
    }
  }
  if (isObject(value.rendererComparison) && isNonEmptyString(value.rendererComparison.reportArtifactId)) {
    const reportArtifactId = value.rendererComparison.reportArtifactId;
    const comparisonArtifact = Array.isArray(value.artifacts)
      ? value.artifacts.find((candidate) => isObject(candidate) && candidate.id === reportArtifactId)
      : undefined;
    if (!isObject(comparisonArtifact)) {
      issue('missing-renderer-benchmark', '$.rendererComparison.reportArtifactId', 'must reference a renderer-benchmark artifact');
    } else if (comparisonArtifact.kind !== 'renderer-benchmark') {
      issue('invalid-renderer-benchmark-kind', '$.rendererComparison.reportArtifactId', 'must reference a renderer-benchmark artifact');
    }
  }
  if (isNonEmptyString(value.captureAttestationArtifactId)) {
    const captureArtifact = Array.isArray(value.artifacts)
      ? value.artifacts.find((candidate) => isObject(candidate) && candidate.id === value.captureAttestationArtifactId)
      : undefined;
    if (!isObject(captureArtifact)) {
      issue('missing-capture-attestation', '$.captureAttestationArtifactId', 'must reference a trusted capture-attestation artifact');
    } else if (captureArtifact.kind !== 'capture-attestation') {
      issue('invalid-capture-attestation-kind', '$.captureAttestationArtifactId', 'must reference a capture-attestation artifact');
    }
  }

  const recipe = renderer ? getTerminalNativeDeviceRecipe(renderer) : null;
  const workloadIds = new Set<string>();
  const writeIds = new Set<string>();
  let previousAcceptedByteOffset: number | null = null;
  if (!Array.isArray(value.workloads)) {
    issue('invalid-array', '$.workloads', 'must be an array');
  } else {
    value.workloads.forEach((rawWorkload, index) => {
      const path = `$.workloads[${index}]`;
      if (!isObject(rawWorkload)) {
        issue('invalid-object', path, 'must be an object');
        return;
      }
      hasOnlyKeys(rawWorkload, [
        'id', 'status', 'startedAt', 'endedAt', 'fixtureByteLength', 'fixtureSha256',
        'startByteOffset', 'acceptedByteOffset', 'ack', 'artifactIds', 'reportArtifactId',
      ], path, issue);
      if (!recipe?.requiredWorkloads.includes(rawWorkload.id as TerminalWorkloadId)) {
        issue('unexpected-workload', `${path}.id`, 'must be a workload required by the renderer recipe');
      } else {
        const id = rawWorkload.id as TerminalWorkloadId;
        const expectedId = recipe.requiredWorkloads[index];
        if (id !== expectedId) {
          issue('workload-order-mismatch', `${path}.id`, `must equal ${expectedId ?? 'no additional workload'} at index ${index}`);
        }
        if (workloadIds.has(id)) issue('duplicate-workload', `${path}.id`, `duplicates ${id}`);
        workloadIds.add(id);
        const fixture = getTerminalWorkload(id);
        if (rawWorkload.fixtureByteLength !== fixture.byteLength) {
          issue('fixture-byte-length-mismatch', `${path}.fixtureByteLength`, `must equal repository fixture length ${fixture.byteLength}`);
        }
        if (rawWorkload.fixtureSha256 !== bytesSha256Hex(fixture.bytes)) {
          issue('fixture-checksum-mismatch', `${path}.fixtureSha256`, 'must equal the repository fixture SHA-256');
        }
        if (isNonNegativeInteger(rawWorkload.startByteOffset)
          && rawWorkload.acceptedByteOffset !== rawWorkload.startByteOffset + fixture.byteLength) {
          issue('accepted-offset-mismatch', `${path}.acceptedByteOffset`, 'must advance exactly by the fixture byte length');
        }
        if (previousAcceptedByteOffset !== null && rawWorkload.startByteOffset !== previousAcceptedByteOffset) {
          issue('workload-offset-gap', `${path}.startByteOffset`, `must continue from prior accepted offset ${previousAcceptedByteOffset}`);
        }
      }
      if (rawWorkload.status !== 'passed') issue('workload-not-passed', `${path}.status`, 'must equal passed');
      validateInterval(rawWorkload, path, issue);
      validateTimestampInsideInterval(rawWorkload.startedAt, value, `${path}.startedAt`, issue);
      validateTimestampInsideInterval(rawWorkload.endedAt, value, `${path}.endedAt`, issue);
      if (!isNonNegativeInteger(rawWorkload.startByteOffset)) issue('invalid-offset', `${path}.startByteOffset`, 'must be a non-negative integer');
      if (!isNonNegativeInteger(rawWorkload.acceptedByteOffset)) issue('invalid-offset', `${path}.acceptedByteOffset`, 'must be a non-negative integer');
      if (!isObject(rawWorkload.ack)) {
        issue('invalid-object', `${path}.ack`, 'must be an object');
      } else {
        hasOnlyKeys(rawWorkload.ack, ['terminalId', 'writeId', 'outcome', 'completedAt'], `${path}.ack`, issue);
        if (rawWorkload.ack.terminalId !== value.terminalId) issue('ack-terminal-mismatch', `${path}.ack.terminalId`, 'must equal the run terminalId');
        requireString(rawWorkload.ack.writeId, `${path}.ack.writeId`, issue);
        if (isNonEmptyString(rawWorkload.ack.writeId)) {
          if (writeIds.has(rawWorkload.ack.writeId)) issue('duplicate-write-id', `${path}.ack.writeId`, 'write ids must be unique within a run');
          writeIds.add(rawWorkload.ack.writeId);
        }
        if (rawWorkload.ack.outcome !== 'accepted') issue('ack-not-accepted', `${path}.ack.outcome`, 'must equal accepted');
        requireTimestamp(rawWorkload.ack.completedAt, `${path}.ack.completedAt`, issue);
        validateTimestampInsideInterval(rawWorkload.ack.completedAt, rawWorkload, `${path}.ack.completedAt`, issue);
      }
      validateArtifactReferences(
        rawWorkload.artifactIds,
        `${path}.artifactIds`,
        artifactKinds,
        ['screenshot', 'video', 'log', 'device-report'],
        issue,
      );
      if (!isNonEmptyString(rawWorkload.reportArtifactId)
        || artifactKinds.get(rawWorkload.reportArtifactId) !== 'observation-report') {
        issue('invalid-observation-report', `${path}.reportArtifactId`, 'must reference an observation-report artifact');
      }
      if (isNonNegativeInteger(rawWorkload.acceptedByteOffset)) {
        previousAcceptedByteOffset = rawWorkload.acceptedByteOffset;
      }
    });
  }
  for (const id of recipe?.requiredWorkloads ?? []) {
    if (!workloadIds.has(id)) issue('missing-workload', '$.workloads', `missing required workload ${id}`);
  }

  const actionIds = new Set<string>();
  const operationIds = new Set<string>();
  let actionCursor: number | null = previousAcceptedByteOffset;
  if (!Array.isArray(value.actions)) {
    issue('invalid-array', '$.actions', 'must be an array');
  } else {
    value.actions.forEach((rawAction, index) => {
      const path = `$.actions[${index}]`;
      if (!isObject(rawAction)) {
        issue('invalid-object', path, 'must be an object');
        return;
      }
      hasOnlyKeys(rawAction, [
        'id', 'status', 'startedAt', 'endedAt', 'sequence', 'operationId',
        'startByteOffset', 'acceptedByteOffset', 'details', 'artifactIds', 'reportArtifactId',
      ], path, issue);
      if (!TERMINAL_NATIVE_DEVICE_ACTION_IDS.includes(rawAction.id as TerminalNativeDeviceActionId)) {
        issue('unexpected-action', `${path}.id`, 'must name a required TERM-7b action');
      } else {
        const id = rawAction.id as TerminalNativeDeviceActionId;
        if (id !== TERMINAL_NATIVE_DEVICE_ACTION_IDS[index]) {
          issue('action-order-mismatch', `${path}.id`, `must equal ${TERMINAL_NATIVE_DEVICE_ACTION_IDS[index] ?? 'no additional action'} at index ${index}`);
        }
        if (actionIds.has(id)) issue('duplicate-action', `${path}.id`, `duplicates ${id}`);
        actionIds.add(id);
        if (!isObject(rawAction.details)) {
          issue('invalid-object', `${path}.details`, 'must be an object');
        } else {
          validateActionDetails(id, rawAction.details, {
            logicalSessionId: isNonEmptyString(value.logicalSessionId) ? value.logicalSessionId : null,
            terminalId: isNonEmptyString(value.terminalId) ? value.terminalId : null,
            renderer,
          }, `${path}.details`, issue);
          if (id === 'async-byte-write-ack-reject-retry') {
            for (const key of ['rejectedWriteId', 'retryWriteId'] as const) {
              const writeId = rawAction.details[key];
              if (isNonEmptyString(writeId)) {
                if (writeIds.has(writeId)) issue('duplicate-write-id', `${path}.details.${key}`, 'write ids must be unique within a run');
                writeIds.add(writeId);
              }
            }
            validateTimestampInsideInterval(rawAction.details.rejectedAt, rawAction, `${path}.details.rejectedAt`, issue);
            validateTimestampInsideInterval(rawAction.details.retryCompletedAt, rawAction, `${path}.details.retryCompletedAt`, issue);
            if (isTimestamp(rawAction.details.rejectedAt) && isTimestamp(rawAction.details.retryCompletedAt)
              && Date.parse(rawAction.details.retryCompletedAt) < Date.parse(rawAction.details.rejectedAt)) {
              issue('retry-precedes-rejection', `${path}.details.retryCompletedAt`, 'retry completion must not precede rejection');
            }
            if (rawAction.details.initialByteOffset !== rawAction.startByteOffset
              || rawAction.details.acceptedByteOffset !== rawAction.acceptedByteOffset) {
              issue('ack-action-offset-mismatch', path, 'ACK action details must equal the action continuity offsets');
            }
          }
        }
      }
      if (rawAction.status !== 'passed') issue('action-not-passed', `${path}.status`, 'must equal passed');
      validateInterval(rawAction, path, issue);
      if (rawAction.sequence !== index) issue('action-sequence-mismatch', `${path}.sequence`, `must equal ${index}`);
      requireString(rawAction.operationId, `${path}.operationId`, issue);
      if (isNonEmptyString(rawAction.operationId)) {
        if (operationIds.has(rawAction.operationId)) issue('duplicate-operation-id', `${path}.operationId`, 'operation ids must be unique within a run');
        operationIds.add(rawAction.operationId);
      }
      if (!isNonNegativeInteger(rawAction.startByteOffset) || !isNonNegativeInteger(rawAction.acceptedByteOffset)) {
        issue('invalid-action-offset', path, 'action offsets must be non-negative integers');
      } else {
        if (actionCursor !== null && rawAction.startByteOffset !== actionCursor) {
          issue('action-offset-discontinuity', `${path}.startByteOffset`, `must equal previous accepted offset ${actionCursor}`);
        }
        if (rawAction.acceptedByteOffset < rawAction.startByteOffset) {
          issue('action-offset-regression', `${path}.acceptedByteOffset`, 'must not precede startByteOffset');
        }
        actionCursor = rawAction.acceptedByteOffset;
      }
      validateTimestampInsideInterval(rawAction.startedAt, value, `${path}.startedAt`, issue);
      validateTimestampInsideInterval(rawAction.endedAt, value, `${path}.endedAt`, issue);
      validateArtifactReferences(
        rawAction.artifactIds,
        `${path}.artifactIds`,
        artifactKinds,
        ['screenshot', 'video', 'log', 'device-report'],
        issue,
      );
      if (!isNonEmptyString(rawAction.reportArtifactId)
        || artifactKinds.get(rawAction.reportArtifactId) !== 'observation-report') {
        issue('invalid-observation-report', `${path}.reportArtifactId`, 'must reference an observation-report artifact');
      }
    });
  }
  for (const id of TERMINAL_NATIVE_DEVICE_ACTION_IDS) {
    if (!actionIds.has(id)) issue('missing-action', '$.actions', `missing required action ${id}`);
  }

  const accessibilityIds = new Set<string>();
  if (!Array.isArray(value.accessibility)) {
    issue('invalid-array', '$.accessibility', 'must be an array');
  } else {
    value.accessibility.forEach((rawEvidence, index) => {
      const path = `$.accessibility[${index}]`;
      if (!isObject(rawEvidence)) {
        issue('invalid-object', path, 'must be an object');
        return;
      }
      hasOnlyKeys(rawEvidence, ['id', 'status', 'startedAt', 'endedAt', 'details', 'artifactIds', 'reportArtifactId'], path, issue);
      if (!TERMINAL_NATIVE_ACCESSIBILITY_DEVICE_EVIDENCE_IDS.includes(rawEvidence.id as TerminalNativeAccessibilityDeviceEvidenceId)) {
        issue('unexpected-accessibility-evidence', `${path}.id`, 'must name a required accessibility item');
      } else {
        const id = rawEvidence.id as TerminalNativeAccessibilityDeviceEvidenceId;
        if (accessibilityIds.has(id)) issue('duplicate-accessibility-evidence', `${path}.id`, `duplicates ${id}`);
        accessibilityIds.add(id);
        if (!isObject(rawEvidence.details)) {
          issue('invalid-object', `${path}.details`, 'must be an object');
        } else {
          validateAccessibilityDetails(id, rawEvidence.details, `${path}.details`, issue);
        }
      }
      if (rawEvidence.status !== 'passed') issue('accessibility-not-passed', `${path}.status`, 'must equal passed');
      validateInterval(rawEvidence, path, issue);
      validateTimestampInsideInterval(rawEvidence.startedAt, value, `${path}.startedAt`, issue);
      validateTimestampInsideInterval(rawEvidence.endedAt, value, `${path}.endedAt`, issue);
      validateArtifactReferences(
        rawEvidence.artifactIds,
        `${path}.artifactIds`,
        artifactKinds,
        rawEvidence.id === 'screen-reader-navigation'
          ? ['video']
          : rawEvidence.id === 'copy-selection-link-affordances'
            ? ['accessibility-tree', 'video', 'log']
            : ['accessibility-tree'],
        issue,
      );
      if (!isNonEmptyString(rawEvidence.reportArtifactId)
        || artifactKinds.get(rawEvidence.reportArtifactId) !== 'observation-report') {
        issue('invalid-observation-report', `${path}.reportArtifactId`, 'must reference an observation-report artifact');
      }
    });
  }
  for (const id of TERMINAL_NATIVE_ACCESSIBILITY_DEVICE_EVIDENCE_IDS) {
    if (!accessibilityIds.has(id)) issue('missing-accessibility-evidence', '$.accessibility', `missing required accessibility evidence ${id}`);
  }

  let releaseApprovalReady = false;
  if (!isObject(value.externalApproval)) {
    issue('invalid-object', '$.externalApproval', 'must be an object');
  } else {
    hasOnlyKeys(value.externalApproval, [
      'required', 'status', 'authority', 'exactDependencyClosureSha256', 'recordedAt', 'approvalArtifactId',
    ], '$.externalApproval', issue);
    if (typeof value.externalApproval.required !== 'boolean') {
      issue('invalid-boolean', '$.externalApproval.required', 'must be boolean');
    }
    const validStatuses = ['approved', 'pending', 'rejected', 'not-required'];
    if (!validStatuses.includes(value.externalApproval.status as string)) {
      issue('invalid-approval-status', '$.externalApproval.status', 'must be approved, pending, rejected, or not-required');
    }
    if (platform === 'android' && value.externalApproval.required !== true) {
      issue('android-approval-required', '$.externalApproval.required', 'Android Termux dependency closure requires external legal/product approval');
    }
    if (value.externalApproval.required === true) {
      releaseApprovalReady = value.externalApproval.status === 'approved';
      if (!releaseApprovalReady) {
        issue('external-approval-not-ready', '$.externalApproval.status', 'required external approval must be approved for release readiness');
      }
      requireString(value.externalApproval.authority, '$.externalApproval.authority', issue);
      if (!isNonEmptyString(value.externalApproval.approvalArtifactId)
        || artifactKinds.get(value.externalApproval.approvalArtifactId) !== 'release-approval') {
        issue('invalid-release-approval-artifact', '$.externalApproval.approvalArtifactId', 'must reference a release-approval artifact');
      }
    } else {
      releaseApprovalReady = value.externalApproval.status === 'not-required';
      if (!releaseApprovalReady) {
        issue('approval-state-mismatch', '$.externalApproval.status', 'must equal not-required when approval is not required');
      }
      if (value.externalApproval.authority !== null) issue('approval-authority-mismatch', '$.externalApproval.authority', 'must be null when approval is not required');
      if (value.externalApproval.approvalArtifactId !== null) {
        issue('approval-artifacts-mismatch', '$.externalApproval.approvalArtifactId', 'must be null when approval is not required');
      }
    }
    if (typeof value.externalApproval.exactDependencyClosureSha256 !== 'string'
      || !SHA256_PATTERN.test(value.externalApproval.exactDependencyClosureSha256)) {
      issue('invalid-checksum', '$.externalApproval.exactDependencyClosureSha256', 'must be a lowercase SHA-256');
    }
    requireTimestamp(value.externalApproval.recordedAt, '$.externalApproval.recordedAt', issue);
    if (isObject(value.renderer)
      && value.externalApproval.exactDependencyClosureSha256 !== value.renderer.dependencyClosureSha256) {
      issue('approval-closure-mismatch', '$.externalApproval.exactDependencyClosureSha256', 'must equal the renderer dependency closure SHA-256');
    }
  }

  const releaseIssueCodes = new Set([
    'external-approval-not-ready', 'approval-state-mismatch', 'approval-authority-mismatch',
    'approval-artifacts-mismatch', 'android-approval-required',
    'invalid-release-approval-artifact',
  ]);
  const schemaValid = !issues.some((entry) => !releaseIssueCodes.has(entry.code));
  const deviceAcceptanceReady = schemaValid;
  if (issues.some((entry) => releaseIssueCodes.has(entry.code))) releaseApprovalReady = false;
  const accepted = deviceAcceptanceReady && releaseApprovalReady;
  return {
    schemaValid,
    deviceAcceptanceReady,
    releaseApprovalReady,
    accepted,
    platform,
    renderer,
    issues,
  };
}

export function formatTerminalNativeDeviceEvidenceValidation(
  result: TerminalNativeDeviceEvidenceValidation,
): string {
  const header = [
    `TERM-7b loaded-device evidence: ${result.accepted ? 'accepted' : 'rejected'}`,
    `schema=${result.schemaValid ? 'valid' : 'invalid'}`,
    `device=${result.deviceAcceptanceReady ? 'accepted' : 'incomplete'}`,
    `releaseApproval=${result.releaseApprovalReady ? 'ready' : 'not-ready'}`,
    `platform=${result.platform ?? 'unknown'}`,
    `renderer=${result.renderer ?? 'unknown'}`,
  ].join(' ');
  if (result.issues.length === 0) return header;
  return [header, ...result.issues.map((entry) => `- ${entry.path} [${entry.code}] ${entry.message}`)].join('\n');
}
