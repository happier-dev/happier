import { createHash, createPublicKey } from 'node:crypto';
import { closeSync, openSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

import { validateTerminalNativeDeviceEvidence, type TerminalNativeDeviceEvidenceIssue, type TerminalNativeDeviceEvidenceValidation } from './deviceEvidence';
import {
  terminalNativeCaptureAuthorityAllows,
  terminalNativeCaptureTimestampIsAllowed,
  terminalNativeObservationDigest,
  verifyTerminalNativeApprovalSignature,
  verifyTerminalNativeCaptureSignature,
  type TerminalNativeApprovalPolicy,
  type TerminalNativeCapturePolicy,
} from './deviceEvidenceAttestations';
import { terminalEvidenceCanonicalJson, terminalEvidenceSha256 } from './deviceEvidenceCanonical';
import {
  TERMINAL_NATIVE_PACKAGING_GATES,
  terminalNativeDependencyPinFromPolicy,
  validateTerminalNativePackagingGateDetails,
  type TerminalNativeDependencyPin,
  type TerminalNativePackagingGateId,
} from './deviceEvidencePins';
import { getTerminalNativeDeviceRecipe, type TerminalNativeDeviceRenderer } from './native';
import { compareTerminalRenderers, parseTerminalBenchmarkReport } from './report';
import { getTerminalWorkload } from './workloads';
import {
  inspectTerminalNativeAppPackage,
  type TerminalNativeAppPackageInspection,
} from './deviceEvidenceAppPackage';

type JsonObject = Record<string, unknown>;
export type TerminalNativeEvidenceValidationOptions = Readonly<{
  rendererPolicy?: unknown;
  approvalPolicy?: TerminalNativeApprovalPolicy;
  capturePolicy?: TerminalNativeCapturePolicy;
  nativePackageVersion?: string;
}>;

const isObject = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

function validApprovalAuthorityPolicy(value: unknown): boolean {
  if (!isObject(value) || value.schemaVersion !== 1 || !Array.isArray(value.authorities)) return false;
  const ids = new Set<string>();
  return value.authorities.every((candidate) => {
    if (!isObject(candidate) || !isString(candidate.id) || ids.has(candidate.id)
      || !isString(candidate.publicKeyPem) || !Array.isArray(candidate.rendererIds)
      || candidate.rendererIds.length === 0
      || new Set(candidate.rendererIds).size !== candidate.rendererIds.length
      || !candidate.rendererIds.every((renderer) => renderer === 'ios-ghosttykit' || renderer === 'android-termux')) return false;
    ids.add(candidate.id);
    try {
      return createPublicKey(candidate.publicKeyPem).asymmetricKeyType === 'ed25519';
    } catch {
      return false;
    }
  });
}

function validCaptureAuthorityPolicy(value: unknown): boolean {
  if (!isObject(value) || value.schemaVersion !== 2 || !Array.isArray(value.authorities)) return false;
  const ids = new Set<string>();
  return value.authorities.every((candidate) => {
    if (!isObject(candidate) || !isString(candidate.id) || ids.has(candidate.id)
      || !isString(candidate.publicKeyPem) || !isString(candidate.validFrom) || !isString(candidate.validUntil)
      || !Array.isArray(candidate.scopes) || candidate.scopes.length === 0
      || !Number.isFinite(Date.parse(candidate.validFrom)) || !Number.isFinite(Date.parse(candidate.validUntil))
      || Date.parse(candidate.validFrom) > Date.parse(candidate.validUntil)) return false;
    const rendererIds = new Set<string>();
    const scopesValid = candidate.scopes.every((scope) => {
      if (!isObject(scope) || (scope.rendererId !== 'ios-ghosttykit' && scope.rendererId !== 'android-termux')
        || rendererIds.has(scope.rendererId) || !Array.isArray(scope.allowedBuildIds)
        || scope.allowedBuildIds.length === 0 || new Set(scope.allowedBuildIds).size !== scope.allowedBuildIds.length
        || !scope.allowedBuildIds.every(isString)) return false;
      rendererIds.add(scope.rendererId);
      return true;
    });
    if (!scopesValid) return false;
    ids.add(candidate.id);
    try {
      return createPublicKey(candidate.publicKeyPem).asymmetricKeyType === 'ed25519';
    } catch {
      return false;
    }
  });
}

function sha256File(path: string): string {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const descriptor = openSync(path, 'r');
  try {
    let bytesRead = 0;
    do {
      bytesRead = readSync(descriptor, buffer, 0, buffer.byteLength, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    closeSync(descriptor);
  }
  return hash.digest('hex');
}

function readHeader(path: string): Buffer {
  const buffer = Buffer.alloc(16);
  const descriptor = openSync(path, 'r');
  try {
    const length = readSync(descriptor, buffer, 0, buffer.byteLength, 0);
    return buffer.subarray(0, length);
  } finally {
    closeSync(descriptor);
  }
}

function isInsideEvidence(root: string, path: string): boolean {
  const normalized = relative(root, path).split(sep).join('/');
  return /(?:^|\/)\.project\/logs\/(?:e2e\/terminal-native|terminal-bench)\/.+/.test(normalized);
}

function parseJson(path: string, issue: (code: string, path: string, message: string) => void, issuePath: string): JsonObject | null {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!isObject(value)) throw new Error('root must be an object');
    return value;
  } catch (error) {
    issue('invalid-semantic-artifact', issuePath, error instanceof Error ? error.message : String(error));
    return null;
  }
}

function loadPolicies(root: string, options: TerminalNativeEvidenceValidationOptions) {
  const packageRoot = join(root, 'packages', 'terminal-native');
  const rendererPolicy = options.rendererPolicy ?? JSON.parse(readFileSync(join(packageRoot, 'native-renderers.json'), 'utf8'));
  const approvalPolicy = options.approvalPolicy
    ?? JSON.parse(readFileSync(join(packageRoot, 'release-approval-authorities.json'), 'utf8')) as TerminalNativeApprovalPolicy;
  const capturePolicy = options.capturePolicy
    ?? JSON.parse(readFileSync(join(packageRoot, 'device-evidence-capture-authorities.json'), 'utf8')) as TerminalNativeCapturePolicy;
  const nativePackageVersion = options.nativePackageVersion
    ?? (JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as JsonObject).version;
  return { rendererPolicy, approvalPolicy, capturePolicy, nativePackageVersion };
}

const same = (left: unknown, right: unknown): boolean => terminalEvidenceCanonicalJson(left) === terminalEvidenceCanonicalJson(right);

export function validateTerminalNativeDeviceEvidenceWithArtifacts(
  value: unknown,
  repositoryRoot: string,
  options: TerminalNativeEvidenceValidationOptions = {},
): TerminalNativeDeviceEvidenceValidation {
  const base = validateTerminalNativeDeviceEvidence(value);
  if (!isObject(value) || !Array.isArray(value.artifacts)) return base;
  const root = realpathSync(resolve(repositoryRoot));
  const artifactIssues: TerminalNativeDeviceEvidenceIssue[] = [];
  const issue = (code: string, path: string, message: string): void => { artifactIssues.push({ code, path, message }); };
  const artifactFiles = new Map<string, string>();
  const artifacts = new Map<string, JsonObject>();

  value.artifacts.forEach((artifact, index) => {
    if (!isObject(artifact) || !isString(artifact.id) || !isString(artifact.path) || typeof artifact.sha256 !== 'string') return;
    artifacts.set(artifact.id, artifact);
    const resolvedPath = resolve(root, artifact.path);
    if (resolvedPath !== root && !resolvedPath.startsWith(`${root}${sep}`)) {
      issue('artifact-outside-repository', `$.artifacts[${index}].path`, 'resolved artifact path escapes the repository root');
      return;
    }
    if (!isInsideEvidence(root, resolvedPath)) {
      issue('artifact-outside-evidence-directory', `$.artifacts[${index}].path`, 'artifact must remain under a terminal evidence directory');
      return;
    }
    try {
      const realPath = realpathSync(resolvedPath);
      if (realPath !== root && !realPath.startsWith(`${root}${sep}`)) {
        issue('artifact-outside-repository', `$.artifacts[${index}].path`, 'artifact symlink resolves outside the repository root');
        return;
      }
      if (!isInsideEvidence(root, realPath)) {
        issue('artifact-outside-evidence-directory', `$.artifacts[${index}].path`, 'artifact symlink escapes the evidence directory');
        return;
      }
      if (!statSync(realPath).isFile()) {
        issue('artifact-not-file', `$.artifacts[${index}].path`, 'artifact is not a regular file');
        return;
      }
      if (sha256File(realPath) !== artifact.sha256) {
        issue('artifact-checksum-mismatch', `$.artifacts[${index}].sha256`, `recorded SHA-256 does not match ${artifact.path}`);
      }
      const header = readHeader(realPath);
      if (artifact.kind === 'app-binary' && !(header[0] === 0x50 && header[1] === 0x4b)) {
        issue('invalid-app-package', `$.artifacts[${index}]`, 'retained iOS archive or Android APK must be a ZIP container');
      }
      if (artifact.kind === 'video' && !(artifact.mediaType === 'video/mp4'
        && header.length >= 12 && header.subarray(4, 8).toString('ascii') === 'ftyp')) {
        issue('invalid-video-container', `$.artifacts[${index}]`, 'video proof must be an MP4 container');
      }
      if (artifact.kind === 'screenshot' && !(
        (artifact.mediaType === 'image/png' && header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
        || (artifact.mediaType === 'image/jpeg' && header[0] === 0xff && header[1] === 0xd8)
      )) {
        issue('invalid-screenshot-container', `$.artifacts[${index}]`, 'screenshot proof must match its PNG or JPEG media type');
      }
      artifactFiles.set(artifact.id, realPath);
    } catch {
      issue('artifact-missing', `$.artifacts[${index}].path`, `artifact does not exist: ${artifact.path}`);
    }
  });

  let policies: ReturnType<typeof loadPolicies> | null = null;
  try { policies = loadPolicies(root, options); } catch (error) {
    issue('evidence-policy-unreadable', '$', error instanceof Error ? error.message : String(error));
  }
  const approvalPolicyValid = policies ? validApprovalAuthorityPolicy(policies.approvalPolicy) : false;
  const capturePolicyValid = policies ? validCaptureAuthorityPolicy(policies.capturePolicy) : false;
  if (policies && !approvalPolicyValid) {
    issue('approval-policy-invalid', '$', 'release approval authority policy must use schema version 1');
  }
  if (policies && !capturePolicyValid) {
    issue('capture-policy-invalid', '$', 'capture authority policy must use schema version 2 with bounded renderer/build scopes and validity windows');
  }
  const rendererId = isObject(value.renderer) && (value.renderer.id === 'ios-ghosttykit' || value.renderer.id === 'android-termux')
    ? value.renderer.id as TerminalNativeDeviceRenderer : null;
  const runContext = {
    runId: value.runId, runNonce: value.runNonce, buildEvidenceId: value.buildEvidenceId,
    logicalSessionId: value.logicalSessionId, terminalId: value.terminalId, rendererId,
  };

  let expectedPin: TerminalNativeDependencyPin | null = null;
  if (policies && rendererId && isObject(value.renderer)) {
    try {
      const expected = terminalNativeDependencyPinFromPolicy(policies.rendererPolicy, rendererId);
      expectedPin = expected;
      for (const key of ['dependencyName', 'dependencyRevision', 'dependencyChecksumSha256', 'dependencyClosureSha256'] as const) {
        if (value.renderer[key] !== expected[key]) issue('renderer-pin-mismatch', `$.renderer.${key}`, `must equal canonical value ${expected[key]}`);
      }
      if (value.renderer.nativePackageVersion !== policies.nativePackageVersion) {
        issue('native-package-version-mismatch', '$.renderer.nativePackageVersion', `must equal ${String(policies.nativePackageVersion)}`);
      }
      if (isObject(value.app) && isObject((policies.rendererPolicy as JsonObject).deviceEvidence)) {
        const evidencePolicy = (policies.rendererPolicy as JsonObject).deviceEvidence as JsonObject;
        const allowed = isObject(evidencePolicy.allowedApplicationIds) ? evidencePolicy.allowedApplicationIds[value.platform as string] : null;
        if (!Array.isArray(allowed) || !allowed.includes(value.app.applicationId)) {
          issue('application-id-not-allowed', '$.app.applicationId', 'must be an internal QA app id allowed by native-renderers.json');
        }
      }
    } catch (error) {
      issue('renderer-policy-invalid', '$.renderer', error instanceof Error ? error.message : String(error));
    }
  }

  let packageInspection: TerminalNativeAppPackageInspection | null = null;
  if (policies && rendererId && isObject(value.app) && (value.platform === 'ios' || value.platform === 'android')) {
    const binaryPath = artifactFiles.get(String(value.app.binaryArtifactId));
    if (!binaryPath) {
      issue('embedded-build-identity-unreadable', '$.app.binaryArtifactId', 'retained app binary is unavailable for embedded identity extraction');
    } else {
      try {
        packageInspection = inspectTerminalNativeAppPackage(binaryPath, value.platform);
        const embedded = packageInspection.identity;
        const authority = capturePolicyValid
          ? policies.capturePolicy.authorities.find((candidate) => candidate.id === embedded.authorityId)
          : undefined;
        const expectedEmbedded = {
          schemaVersion: 1,
          kind: 'terminal-native-build-identity',
          authorityId: value.captureAuthority,
          platform: value.platform,
          rendererId,
          buildEvidenceId: value.buildEvidenceId,
          applicationId: value.app.applicationId,
          version: value.app.version,
          buildNumber: value.app.buildNumber,
          sourceStateSha256: value.app.sourceStateSha256,
          dependencyClosureSha256: isObject(value.renderer) ? value.renderer.dependencyClosureSha256 : null,
          generatedAt: embedded.generatedAt,
          signatureAlgorithm: 'ed25519',
          signature: embedded.signature,
        };
        if (!same(embedded, expectedEmbedded)
          || typeof embedded.generatedAt !== 'string'
          || Date.parse(embedded.generatedAt) > Date.parse(String(value.startedAt))) {
          issue('embedded-build-identity-mismatch', '$.app.binaryArtifactId', 'embedded TERM identity must bind the exact app/build/source/dependency tuple');
        } else if (packageInspection.applicationId !== value.app.applicationId
          || packageInspection.version !== value.app.version
          || packageInspection.buildNumber !== value.app.buildNumber) {
          issue('app-package-metadata-mismatch', '$.app.binaryArtifactId', 'platform package metadata must equal the evidence app identity');
        } else if (!authority || !terminalNativeCaptureAuthorityAllows(authority, rendererId, String(value.buildEvidenceId))) {
          issue('untrusted-build-identity-authority', '$.app.binaryArtifactId', 'embedded TERM identity authority is not registered for this renderer');
        } else if (!terminalNativeCaptureTimestampIsAllowed(authority, embedded.generatedAt)) {
          issue('build-identity-outside-authority-window', '$.app.binaryArtifactId', 'embedded TERM identity was generated outside the capture authority validity window');
        } else if (!verifyTerminalNativeCaptureSignature(embedded, authority)) {
          issue('invalid-build-identity-signature', '$.app.binaryArtifactId', 'embedded TERM identity signature is invalid');
        }
      } catch (error) {
        issue('embedded-build-identity-unreadable', '$.app.binaryArtifactId', error instanceof Error ? error.message : String(error));
      }
    }
  }

  const semantic = (id: unknown, kind: string, path: string): JsonObject | null => {
    if (!isString(id)) return null;
    const artifact = artifacts.get(id);
    const file = artifactFiles.get(id);
    if (!artifact || artifact.kind !== kind || !file) return null;
    if (artifact.mediaType !== 'application/json') {
      issue('semantic-artifact-media-type', path, 'machine-readable attestation must use application/json');
      return null;
    }
    return parseJson(file, issue, path);
  };

  for (const [artifactId, artifact] of artifacts) {
    if (artifact.kind !== 'accessibility-tree') continue;
    const file = artifactFiles.get(artifactId);
    if (!file || artifact.mediaType !== 'application/json') {
      issue('invalid-accessibility-tree-report', `$.artifacts.${artifactId}`, 'accessibility tree must be application/json');
      continue;
    }
    const report = parseJson(file, issue, `$.artifacts.${artifactId}`);
    if (!report || report.schemaVersion !== 1 || report.kind !== 'terminal-native-accessibility-tree'
      || report.runId !== value.runId || report.runNonce !== value.runNonce
      || report.buildEvidenceId !== value.buildEvidenceId || report.terminalId !== value.terminalId
      || report.rendererId !== rendererId || !Array.isArray(report.nodes) || report.nodes.length === 0
      || report.capturedAt !== artifact.capturedAt) {
      issue('invalid-accessibility-tree-report', `$.artifacts.${artifactId}`, 'accessibility tree must bind this run/build/terminal/renderer and contain nodes');
    }
  }

  if (isObject(value.app)) {
    const source = semantic(value.app.sourceStateArtifactId, 'source-state', '$.app.sourceStateArtifactId');
    if (source) {
      const inventory = Array.isArray(source.inventory) ? source.inventory : null;
      const paths = inventory?.map((entry) => isObject(entry) ? entry.path : null) ?? [];
      const valid = inventory && inventory.length > 0
        && inventory.every((entry) => isObject(entry) && isString(entry.path) && /^[a-f0-9]{64}$/.test(String(entry.sha256)))
        && paths.every((path, index) => index === 0 || String(paths[index - 1]).localeCompare(String(path)) < 0);
      if (source.schemaVersion !== 1 || source.kind !== 'terminal-native-source-state' || !valid) {
        issue('invalid-source-state-report', '$.app.sourceStateArtifactId', 'must have schema v1 and a sorted unique path/SHA-256 inventory');
      } else if (source.inventorySha256 !== terminalEvidenceSha256(inventory)) {
        issue('source-inventory-digest-mismatch', '$.app.sourceStateArtifactId', 'inventorySha256 must bind the canonical inventory');
      }
      if (source.sourceCommit !== value.app.sourceCommit || source.sourceDirty !== value.app.sourceDirty) {
        issue('source-state-identity-mismatch', '$.app.sourceStateArtifactId', 'source identity does not match evidence');
      }
      if (typeof source.generatedAt !== 'string' || !Number.isFinite(Date.parse(source.generatedAt))
        || Date.parse(source.generatedAt) > Date.parse(String(value.startedAt))) {
        issue('source-state-time-mismatch', '$.app.sourceStateArtifactId', 'source-state must be generated no later than the loaded run');
      }
    }

    const runtime = semantic(value.app.runtimeAttestationArtifactId, 'runtime-attestation', '$.app.runtimeAttestationArtifactId');
    if (runtime) {
      const expected = {
        schemaVersion: 1, kind: 'terminal-native-loaded-app-attestation', origin: 'loaded-native-app', ...runContext,
        applicationId: value.app.applicationId, version: value.app.version, buildNumber: value.app.buildNumber,
        buildVariant: value.app.buildVariant, binarySha256: value.app.binarySha256,
        sourceStateSha256: value.app.sourceStateSha256,
        dependencyClosureSha256: isObject(value.renderer) ? value.renderer.dependencyClosureSha256 : null,
        deviceTargetId: isObject(value.device) ? value.device.targetId : null, emittedAt: runtime.emittedAt,
      };
      if (!same(runtime, expected) || typeof runtime.emittedAt !== 'string'
        || Date.parse(runtime.emittedAt) < Date.parse(String(value.startedAt))
        || Date.parse(runtime.emittedAt) > Date.parse(String(value.endedAt))) {
        issue('runtime-attestation-mismatch', '$.app.runtimeAttestationArtifactId', 'must exactly bind this loaded app, build, source, dependency, device, and run interval');
      }
    }

    const packaging = semantic(value.app.packagingReportArtifactId, 'packaging-report', '$.app.packagingReportArtifactId');
    if (packaging && rendererId) {
      const gates = Array.isArray(packaging.gates) ? packaging.gates : [];
      const gateMap = new Map(gates.filter(isObject).map((gate) => [gate.id, gate]));
      if (packaging.schemaVersion !== 1 || packaging.kind !== 'terminal-native-packaging-attestation'
        || packaging.buildEvidenceId !== value.buildEvidenceId || packaging.rendererId !== rendererId
        || packaging.binarySha256 !== value.app.binarySha256 || packaging.sourceStateSha256 !== value.app.sourceStateSha256
        || packaging.dependencyClosureSha256 !== (value.renderer as JsonObject).dependencyClosureSha256) {
        issue('packaging-attestation-mismatch', '$.app.packagingReportArtifactId', 'must bind the exact build, binary, source, renderer, and dependency closure');
      }
      if (typeof packaging.generatedAt !== 'string' || !Number.isFinite(Date.parse(packaging.generatedAt))
        || Date.parse(packaging.generatedAt) > Date.parse(String(value.startedAt))) {
        issue('packaging-time-mismatch', '$.app.packagingReportArtifactId', 'packaging attestation must precede the loaded run');
      }
      for (const gateId of TERMINAL_NATIVE_PACKAGING_GATES[rendererId]) {
        const gate = gateMap.get(gateId);
        if (!gate || gate.status !== 'passed' || !isString(gate.tool) || !isString(gate.reportArtifactId)
          || !/^[a-f0-9]{64}$/.test(String(gate.reportSha256))) {
          issue('packaging-gate-not-proven', '$.app.packagingReportArtifactId', `missing valid passed gate ${gateId}`);
          continue;
        }
        const gateArtifact = artifacts.get(gate.reportArtifactId);
        const gateReport = semantic(gate.reportArtifactId, 'packaging-gate-report', `$.app.packagingReportArtifactId.gates.${gateId}`);
        if (gateReport && expectedPin) {
          const detailErrors = validateTerminalNativePackagingGateDetails({
            rendererId,
            gateId: gateId as TerminalNativePackagingGateId,
            tool: gate.tool,
            details: gateReport.details,
            binarySha256: String(value.app.binarySha256),
            sourceStateSha256: String(value.app.sourceStateSha256),
            dependencyPin: expectedPin,
          });
          for (const detailError of detailErrors) {
            issue('packaging-gate-details-invalid', `$.app.packagingReportArtifactId.gates.${gateId}`, detailError);
          }
          if (gateId === 'platform-package-inspection' && packageInspection && isObject(gateReport.details)) {
            const details = gateReport.details;
            const expectedFacts = {
              binarySha256: value.app.binarySha256,
              format: packageInspection.format,
              applicationId: packageInspection.applicationId,
              version: packageInspection.version,
              buildNumber: packageInspection.buildNumber,
              architectures: packageInspection.architectures,
              metadataSha256: packageInspection.metadataSha256,
            };
            for (const [key, expectedValue] of Object.entries(expectedFacts)) {
              if (!same(details[key], expectedValue)) {
                issue('platform-package-inspection-mismatch', `$.app.packagingReportArtifactId.gates.${gateId}.${key}`, `${key} must equal the directly inspected app package`);
              }
            }
            if (rendererId === 'android-termux') {
              for (const [key, expectedValue] of Object.entries({
                dexFileCount: packageInspection.dexFileCount,
                nativeLibraryCount: packageInspection.nativeLibraryCount,
                resourcesPresent: packageInspection.resourcesPresent,
              })) {
                if (!same(details[key], expectedValue)) {
                  issue('platform-package-inspection-mismatch', `$.app.packagingReportArtifactId.gates.${gateId}.${key}`, `${key} must equal the directly inspected APK`);
                }
              }
              if (!Array.isArray(details.signatureSchemes)
                || !details.signatureSchemes.every((scheme) => packageInspection.packageSignatureEnvelope.includes(String(scheme)))) {
                issue('platform-package-signature-mismatch', `$.app.packagingReportArtifactId.gates.${gateId}.signatureSchemes`, 'apksigner schemes must be present in the retained APK signing envelope');
              }
            } else {
              for (const [key, expectedValue] of Object.entries({
                executable: packageInspection.executable,
                codeSignaturePresent: packageInspection.codeSignaturePresent,
                provisioningProfilePresent: packageInspection.provisioningProfilePresent,
              })) {
                if (!same(details[key], expectedValue)) {
                  issue('platform-package-inspection-mismatch', `$.app.packagingReportArtifactId.gates.${gateId}.${key}`, `${key} must equal the directly inspected iOS app archive`);
                }
              }
              const expectedSimulatorMode = packageInspection.codeSignaturePresent ? 'simulator-adhoc' : 'simulator-unsigned';
              if (isObject(value.device) && value.device.simulator === true && details.signingMode !== expectedSimulatorMode) {
                issue('platform-package-signing-mode-mismatch', `$.app.packagingReportArtifactId.gates.${gateId}.signingMode`, `simulator evidence must use ${expectedSimulatorMode}`);
              }
              if (isObject(value.device) && value.device.simulator === false
                && typeof details.signingMode === 'string' && details.signingMode.startsWith('simulator-')) {
                issue('platform-package-signing-mode-mismatch', `$.app.packagingReportArtifactId.gates.${gateId}.signingMode`, 'physical-device evidence cannot use a simulator signing mode');
              }
            }
            if (isObject(value.device)) {
              const expectedAbi = value.platform === 'android'
                ? ({ arm64: 'arm64-v8a', arm: 'armeabi-v7a', x86: 'x86', x86_64: 'x86_64' } as Record<string, string>)[String(value.device.architecture)]
                : String(value.device.architecture);
              if (!expectedAbi || !packageInspection.architectures.includes(expectedAbi)) {
                issue('platform-package-abi-mismatch', '$.device.architecture', 'retained package must contain the loaded device architecture');
              }
            }
          }
        }
        if (!gateArtifact || gateArtifact.sha256 !== gate.reportSha256 || !gateReport) {
          issue('packaging-gate-report-mismatch', '$.app.packagingReportArtifactId', `gate ${gateId} must reference its exact semantic report`);
          continue;
        }
        const expectedGate = {
          schemaVersion: 1,
          kind: 'terminal-native-packaging-gate-report',
          buildEvidenceId: value.buildEvidenceId,
          rendererId,
          gateId,
          status: 'passed',
          tool: gate.tool,
          binarySha256: value.app.binarySha256,
          sourceStateSha256: value.app.sourceStateSha256,
          dependencyClosureSha256: (value.renderer as JsonObject).dependencyClosureSha256,
          generatedAt: gateReport.generatedAt,
          details: gateReport.details,
        };
        if (!same(gateReport, expectedGate) || !isObject(gateReport.details)
          || typeof gateReport.generatedAt !== 'string'
          || Date.parse(gateReport.generatedAt) > Date.parse(String(value.startedAt))) {
          issue('packaging-gate-report-mismatch', '$.app.packagingReportArtifactId', `gate ${gateId} report does not bind this exact build`);
        }
      }
      if (gates.length !== TERMINAL_NATIVE_PACKAGING_GATES[rendererId].length) {
        issue('packaging-gate-set-mismatch', '$.app.packagingReportArtifactId', 'must contain exactly the packet-owned gate set');
      }
    }
  }

  const observations = (items: unknown, kind: string, basePath: string): void => {
    if (!Array.isArray(items)) return;
    items.forEach((item, index) => {
      if (!isObject(item)) return;
      const report = semantic(item.reportArtifactId, 'observation-report', `${basePath}[${index}].reportArtifactId`);
      if (!report) return;
      const expected = {
        schemaVersion: 1, kind: 'terminal-native-observation-report', ...runContext,
        observationKind: kind, observationId: item.id,
        observationSha256: terminalNativeObservationDigest(item), recordedAt: report.recordedAt,
      };
      if (!same(report, expected) || typeof report.recordedAt !== 'string'
        || Date.parse(report.recordedAt) < Date.parse(String(item.startedAt))
        || Date.parse(report.recordedAt) > Date.parse(String(item.endedAt))) {
        issue('observation-report-mismatch', `${basePath}[${index}].reportArtifactId`, 'must bind the exact observation, run, session, renderer, and interval');
      }
      const artifact = artifacts.get(String(item.reportArtifactId));
      if (artifact && (Date.parse(String(artifact.capturedAt)) < Date.parse(String(item.startedAt))
        || Date.parse(String(artifact.capturedAt)) > Date.parse(String(item.endedAt)))) {
        issue('stale-observation-artifact', `${basePath}[${index}].reportArtifactId`, 'capture must fall inside the observation interval');
      }
      if (Array.isArray(item.artifactIds)) {
        for (const artifactId of item.artifactIds) {
          const proof = artifacts.get(String(artifactId));
          if (proof && (Date.parse(String(proof.capturedAt)) < Date.parse(String(item.startedAt))
            || Date.parse(String(proof.capturedAt)) > Date.parse(String(item.endedAt)))) {
            issue('stale-observation-artifact', `${basePath}[${index}].artifactIds`, `artifact ${String(artifactId)} falls outside the observation interval`);
          }
        }
      }
    });
  };
  observations(value.workloads, 'workload', '$.workloads');
  observations(value.actions, 'action', '$.actions');
  observations(value.accessibility, 'accessibility', '$.accessibility');

  if (rendererId && isObject(value.rendererComparison) && isObject(value.app) && isObject(value.device)) {
    const benchmarkArtifactId = value.rendererComparison.reportArtifactId;
    const benchmarkArtifact = artifacts.get(String(benchmarkArtifactId));
    const benchmarkEnvelope = semantic(benchmarkArtifactId, 'renderer-benchmark', '$.rendererComparison.reportArtifactId');
    if (!benchmarkArtifact || !benchmarkEnvelope) {
      issue('renderer-benchmark-not-proven', '$.rendererComparison.reportArtifactId', 'must reference a parsed renderer-benchmark artifact');
    } else {
      const expectedRatio = value.platform === 'android' ? 1.25 : 0.75;
      const expectedEnvelopeIdentity = {
        schemaVersion: 1,
        kind: 'terminal-native-renderer-benchmark',
        ...runContext,
        applicationId: value.app.applicationId,
        binarySha256: value.app.binarySha256,
        deviceTargetId: value.device.targetId,
        platform: value.platform,
        baselineRenderer: 'xterm-webview',
        candidateRenderer: rendererId,
        timingBoundary: 'display-observed',
        observationSource: 'loaded-device',
        minThroughputRatio: expectedRatio,
        minSamplesPerWorkload: 3,
      };
      for (const [key, expected] of Object.entries(expectedEnvelopeIdentity)) {
        if (benchmarkEnvelope[key] !== expected) {
          issue('renderer-benchmark-identity-mismatch', `$.rendererComparison.reportArtifactId.${key}`, `must equal ${String(expected)}`);
        }
      }
      if (typeof benchmarkEnvelope.recordedAt !== 'string'
        || Date.parse(benchmarkEnvelope.recordedAt) < Date.parse(String(value.startedAt))
        || Date.parse(benchmarkEnvelope.recordedAt) > Date.parse(String(value.endedAt))
        || benchmarkArtifact.capturedAt !== benchmarkEnvelope.recordedAt) {
        issue('renderer-benchmark-time-mismatch', '$.rendererComparison.reportArtifactId', 'benchmark capture must fall inside this loaded run');
      }
      try {
        const benchmark = parseTerminalBenchmarkReport(benchmarkEnvelope.benchmark);
        const recipe = getTerminalNativeDeviceRecipe(rendererId);
        if (Date.parse(benchmark.startedAt) < Date.parse(String(value.startedAt))
          || Date.parse(benchmark.endedAt) > Date.parse(String(value.endedAt))) {
          issue('renderer-benchmark-time-mismatch', '$.rendererComparison.reportArtifactId.benchmark', 'benchmark interval must fall inside this loaded run');
        }
        const expectedEnvironment = terminalEvidenceCanonicalJson({
          platform: value.platform,
          targetId: value.device.targetId,
          applicationId: value.app.applicationId,
          buildEvidenceId: value.buildEvidenceId,
        });
        for (const sample of benchmark.samples) {
          if (sample.observationSource !== 'loaded-device' || sample.timingBoundary !== 'display-observed') {
            issue('renderer-benchmark-boundary-mismatch', '$.rendererComparison.reportArtifactId.benchmark.samples', 'every sample must be loaded-device display-observed evidence');
          }
          if (sample.renderer !== 'xterm-webview' && sample.renderer !== rendererId) {
            issue('renderer-benchmark-renderer-mismatch', '$.rendererComparison.reportArtifactId.benchmark.samples', 'samples may contain only xterm-webview and the loaded native renderer');
          }
          if (terminalEvidenceCanonicalJson(sample.environment ?? null) !== expectedEnvironment) {
            issue('renderer-benchmark-environment-mismatch', '$.rendererComparison.reportArtifactId.benchmark.samples', 'every sample must bind the exact device, app, and build evidence id');
          }
          if (sample.decodedBytes !== getTerminalWorkload(sample.workloadId).byteLength) {
            issue('renderer-benchmark-fixture-mismatch', '$.rendererComparison.reportArtifactId.benchmark.samples', 'decoded bytes must equal the canonical workload fixture length');
          }
        }
        if (benchmark.totals.loss.gaps !== 0 || benchmark.totals.loss.truncations !== 0 || benchmark.totals.loss.droppedFrames !== 0) {
          issue('renderer-benchmark-byte-loss', '$.rendererComparison.reportArtifactId.benchmark.totals.loss', 'comparison evidence must record no gaps, truncations, or dropped frames');
        }
        const sampleKeys = new Set(benchmark.samples.map((sample) => `${sample.renderer}:${sample.workloadId}`));
        for (const workloadId of recipe.requiredWorkloads) {
          for (const renderer of ['xterm-webview', rendererId]) {
            if (!sampleKeys.has(`${renderer}:${workloadId}`)) {
              issue('renderer-benchmark-workload-missing', '$.rendererComparison.reportArtifactId.benchmark.samples', `missing ${renderer}:${workloadId}`);
            }
          }
        }
        const comparison = compareTerminalRenderers(benchmark, {
          baselineRenderer: 'xterm-webview',
          candidateRenderer: rendererId,
          timingBoundary: 'display-observed',
          minThroughputRatio: expectedRatio,
          minSamplesPerWorkload: 3,
        });
        if (!same(benchmarkEnvelope.comparison, comparison) || comparison.status !== 'passed'
          || comparison.comparedWorkloads !== recipe.requiredWorkloads.length) {
          issue('renderer-benchmark-comparison-failed', '$.rendererComparison.reportArtifactId.comparison', 'recomputed native-vs-WebView comparison must pass every canonical workload');
        }
        const expectedEvidenceComparison = {
          status: comparison.status,
          baselineRenderer: 'xterm-webview',
          candidateRenderer: rendererId,
          timingBoundary: 'display-observed',
          observationSource: 'loaded-device',
          minThroughputRatio: expectedRatio,
          minSamplesPerWorkload: 3,
          reportArtifactId: benchmarkArtifactId,
        };
        if (!same(value.rendererComparison, expectedEvidenceComparison)) {
          issue('renderer-benchmark-claim-mismatch', '$.rendererComparison', 'evidence summary must equal the recomputed benchmark result and packet thresholds');
        }
      } catch (error) {
        issue('invalid-renderer-benchmark-report', '$.rendererComparison.reportArtifactId', error instanceof Error ? error.message : String(error));
      }
    }
  }

  if (isObject(value.externalApproval) && value.externalApproval.required === true) {
    const approval = semantic(value.externalApproval.approvalArtifactId, 'release-approval', '$.externalApproval.approvalArtifactId');
    const authorityId = value.externalApproval.authority;
    const authority = approvalPolicyValid
      ? policies?.approvalPolicy.authorities.find((candidate) => candidate.id === authorityId)
      : undefined;
    if (!authority || !rendererId || !authority.rendererIds.includes(rendererId)) {
      issue('untrusted-approval-authority', '$.externalApproval.authority', 'authority must be independently registered for this renderer');
    } else if (approval) {
      if (approval.schemaVersion !== 1 || approval.kind !== 'terminal-native-release-approval'
        || approval.authorityId !== authority.id || approval.decision !== 'approved'
        || approval.rendererId !== rendererId || approval.dependencyClosureSha256 !== (value.renderer as JsonObject).dependencyClosureSha256
        || approval.dependencyRevision !== (value.renderer as JsonObject).dependencyRevision
        || approval.approvedAt !== value.externalApproval.recordedAt) {
        issue('approval-record-mismatch', '$.externalApproval.approvalArtifactId', 'must bind the exact authority, renderer revision, closure, decision, and timestamp');
      } else if (!verifyTerminalNativeApprovalSignature(approval, authority)) {
        issue('invalid-approval-signature', '$.externalApproval.approvalArtifactId', 'signature is not valid for the governed authority');
      }
    }
  }

  const captureArtifactId = value.captureAttestationArtifactId;
  const capture = semantic(captureArtifactId, 'capture-attestation', '$.captureAttestationArtifactId');
  const captureAuthorityId = value.captureAuthority;
  const captureAuthority = capturePolicyValid
    ? policies?.capturePolicy.authorities.find((candidate) => candidate.id === captureAuthorityId)
    : undefined;
  if (!capture) {
    issue('missing-capture-attestation', '$.captureAttestationArtifactId', 'strict device acceptance requires a signed capture attestation');
  } else if (!captureAuthority || !rendererId
    || !terminalNativeCaptureAuthorityAllows(captureAuthority, rendererId, String(value.buildEvidenceId))) {
    issue('untrusted-capture-authority', '$.captureAuthority', 'capture authority must be independently registered for this renderer');
  } else if (isObject(value.app) && isObject(value.device) && isObject(value.renderer)) {
    const signedArtifacts = [...artifacts.values()]
      .filter((artifact) => artifact.id !== captureArtifactId && artifact.kind !== 'release-approval')
      .map((artifact) => ({ id: artifact.id, kind: artifact.kind, sha256: artifact.sha256, capturedAt: artifact.capturedAt }))
      .sort((left, right) => String(left.id).localeCompare(String(right.id)));
    const expectedCapture = {
      schemaVersion: 1,
      kind: 'terminal-native-capture-attestation',
      authorityId: captureAuthority.id,
      ...runContext,
      applicationId: value.app.applicationId,
      binarySha256: value.app.binarySha256,
      sourceStateSha256: value.app.sourceStateSha256,
      dependencyClosureSha256: value.renderer.dependencyClosureSha256,
      deviceTargetId: value.device.targetId,
      startedAt: value.startedAt,
      endedAt: value.endedAt,
      artifacts: signedArtifacts,
      signedAt: capture.signedAt,
      signatureAlgorithm: 'ed25519',
      signature: capture.signature,
    };
    if (!same(capture, expectedCapture)) {
      issue('capture-attestation-mismatch', '$.captureAttestationArtifactId', 'capture attestation must bind the complete exact run artifact inventory');
    } else if (![value.startedAt, value.endedAt, capture.signedAt].every((timestamp) => (
      typeof timestamp === 'string' && terminalNativeCaptureTimestampIsAllowed(captureAuthority, timestamp)
    ))) {
      issue('capture-outside-authority-window', '$.captureAttestationArtifactId', 'run start, run end, and capture signature must fall inside the authority validity window');
    } else if (Date.parse(String(capture.signedAt)) < Date.parse(String(value.endedAt))) {
      issue('capture-signed-before-run-end', '$.captureAttestationArtifactId', 'capture attestation cannot be signed before the captured run ends');
    } else if (!verifyTerminalNativeCaptureSignature(capture, captureAuthority)) {
      issue('invalid-capture-signature', '$.captureAttestationArtifactId', 'capture signature is not valid for the governed authority');
    }
  }

  if (artifactIssues.length === 0) return base;
  const releaseCodes = new Set(['untrusted-approval-authority', 'approval-record-mismatch', 'invalid-approval-signature']);
  const hasDeviceIssue = artifactIssues.some((entry) => !releaseCodes.has(entry.code));
  return {
    ...base,
    schemaValid: hasDeviceIssue ? false : base.schemaValid,
    deviceAcceptanceReady: hasDeviceIssue ? false : base.deviceAcceptanceReady,
    releaseApprovalReady: false,
    accepted: false,
    issues: [...base.issues, ...artifactIssues],
  };
}
