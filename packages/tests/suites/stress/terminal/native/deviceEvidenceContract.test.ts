import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

import { bytesSha256Hex } from '../../../../src/testkit/terminal/ansi';
import {
  terminalNativeCaptureAuthorityAllows,
  terminalNativeApprovalSigningPayload,
  terminalNativeCaptureSigningPayload,
  terminalNativeCaptureTimestampIsAllowed,
  type TerminalNativeApprovalPolicy,
  type TerminalNativeCapturePolicy,
} from '../../../../src/testkit/terminal/deviceEvidenceAttestations';
import { validateTerminalNativeDeviceEvidence, type TerminalNativeDeviceEvidence } from '../../../../src/testkit/terminal/deviceEvidence';
import { inspectTerminalNativeAppPackage } from '../../../../src/testkit/terminal/deviceEvidenceAppPackage';
import { validateTerminalNativeDeviceEvidenceWithArtifacts } from '../../../../src/testkit/terminal/deviceEvidenceArtifacts';
import { finalizeTerminalNativeCapture } from '../../../../src/testkit/terminal/deviceEvidenceCaptureCli';
import {
  inspectAndroidPackageWithBuildTools,
  inspectIosPackageWithXcodeTools,
} from '../../../../src/testkit/terminal/deviceEvidencePackageCli';
import { terminalNativeDeviceEvidenceCliExitCode } from '../../../../src/testkit/terminal/deviceEvidenceCli';
import { terminalEvidenceCanonicalJson } from '../../../../src/testkit/terminal/deviceEvidenceCanonical';
import {
  terminalNativeDependencyPinFromPolicy,
  TERMINAL_NATIVE_PACKAGING_GATES,
  TERMINAL_NATIVE_PACKAGING_GATE_TOOLS,
  type TerminalNativeDependencyPin,
  type TerminalNativePackagingGateId,
} from '../../../../src/testkit/terminal/deviceEvidencePins';
import { runTerminalNativeSourceStateCli } from '../../../../src/testkit/terminal/deviceEvidenceSourceStateCli';
import {
  createTerminalNativeRunIdentity,
  createTerminalNativeLoadedAppAttestation,
  createTerminalNativeObservationReport,
  createTerminalNativePackagingAttestation,
  createTerminalNativePackagingGateReport,
  createTerminalNativeRendererBenchmarkReport,
  createTerminalNativeSourceState,
} from '../../../../src/testkit/terminal/deviceEvidenceRunBundle';
import { TERMINAL_NATIVE_DEVICE_ACTION_IDS, getTerminalNativeDeviceRecipe, type TerminalNativeDeviceActionId, type TerminalNativeDeviceRenderer } from '../../../../src/testkit/terminal/native';
import { getTerminalWorkload } from '../../../../src/testkit/terminal/workloads';
import { buildTerminalBenchmarkReport, summarizeTerminalSample } from '../../../../src/testkit/terminal/report';

const START = '2026-08-28T10:00:00.000Z';
const END = '2026-08-28T10:10:00.000Z';
const COMMIT = 'b'.repeat(40);
const RUN_NONCE = 'run-nonce-32-bytes-minimum-abcdef';
const BUILD_ID = 'build-evidence-fixture';
const SOURCE_POLICY = JSON.parse(readFileSync(resolve(process.cwd(), '../terminal-native/native-renderers.json'), 'utf8')) as Record<string, unknown>;

type Mutable<T> = T extends readonly (infer Item)[] ? Mutable<Item>[]
  : T extends object ? { -readonly [Key in keyof T]: Mutable<T[Key]> } : T;

type Fixture = Readonly<{
  root: string;
  evidence: Mutable<TerminalNativeDeviceEvidence>;
  options: Readonly<{
    rendererPolicy: unknown;
    approvalPolicy: TerminalNativeApprovalPolicy;
    capturePolicy: TerminalNativeCapturePolicy;
    nativePackageVersion: string;
  }>;
  rewriteArtifact(id: string, value: unknown): void;
  cleanup(): void;
}>;

const sha = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');

describe('terminal native run identity', () => {
  it('emits identifiers accepted by the embedded app build-identity contract', () => {
    const identity = createTerminalNativeRunIdentity();
    expect(identity.runId).toMatch(/^term-run-[A-Za-z0-9_-]{16,128}$/);
    expect(identity.runNonce).toMatch(/^[A-Za-z0-9_-]{32,128}$/);
    expect(identity.buildEvidenceId).toMatch(/^term-build-[A-Za-z0-9_-]{16,128}$/);
  });
});

describe('terminal native bounded capture authority', () => {
  const authority = {
    id: 'bounded-authority', publicKeyPem: 'unused-by-scope-test',
    validFrom: '2026-08-28T11:30:00.000Z', validUntil: '2026-08-30T23:59:59.000Z',
    scopes: [
      { rendererId: 'ios-ghosttykit' as const, allowedBuildIds: ['ios-build'] },
      { rendererId: 'android-termux' as const, allowedBuildIds: ['android-build'] },
    ],
  };

  it('uses inclusive time bounds and renderer-specific build scopes', () => {
    expect(terminalNativeCaptureTimestampIsAllowed(authority, authority.validFrom)).toBe(true);
    expect(terminalNativeCaptureTimestampIsAllowed(authority, authority.validUntil)).toBe(true);
    expect(terminalNativeCaptureTimestampIsAllowed(authority, '2026-08-28T11:29:59.999Z')).toBe(false);
    expect(terminalNativeCaptureTimestampIsAllowed(authority, '2026-08-30T23:59:59.001Z')).toBe(false);
    expect(terminalNativeCaptureAuthorityAllows(authority, 'ios-ghosttykit', 'ios-build')).toBe(true);
    expect(terminalNativeCaptureAuthorityAllows(authority, 'ios-ghosttykit', 'android-build')).toBe(false);
    expect(terminalNativeCaptureAuthorityAllows(authority, 'android-termux', 'android-build')).toBe(true);
  });
});

type FixtureZipEntry = Readonly<{ name: string; contents: Buffer; method?: 0 | 8 }>;

function apkV2SigningBlock(): Buffer {
  const pair = Buffer.alloc(13);
  pair.writeBigUInt64LE(5n, 0);
  pair.writeUInt32LE(0x7109871a, 8);
  pair[12] = 1;
  const size = BigInt(pair.length + 24);
  const header = Buffer.alloc(8);
  const footer = Buffer.alloc(24);
  header.writeBigUInt64LE(size);
  footer.writeBigUInt64LE(size);
  footer.write('APK Sig Block 42', 8, 'ascii');
  return Buffer.concat([header, pair, footer]);
}

function zipArchive(entries: readonly FixtureZipEntry[], apkSigning = false): Buffer {
  let localOffset = 0;
  const encoded = entries.map(({ name: entryName, contents, method = 0 }) => {
    const name = Buffer.from(entryName);
    const compressed = method === 8 ? deflateRawSync(contents) : contents;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(contents), 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(contents.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc32(contents), 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(contents.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(localOffset, 42);
    const localEntry = Buffer.concat([local, name, compressed]);
    localOffset += localEntry.length;
    return { local: localEntry, central: Buffer.concat([central, name]) };
  });
  const signing = apkSigning ? apkV2SigningBlock() : Buffer.alloc(0);
  const centralDirectory = Buffer.concat(encoded.map((entry) => entry.central));
  const centralOffset = localOffset + signing.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([...encoded.map((entry) => entry.local), signing, centralDirectory, eocd]);
}

function storedZip(entryName: string, contents: Buffer, method: 0 | 8 = 0): Buffer {
  return zipArchive([{ name: entryName, contents, method }]);
}

function androidBinaryManifest(applicationId: string, version: string, buildNumber: string): Buffer {
  const strings = ['manifest', 'package', 'versionName', 'versionCode', applicationId, version, buildNumber];
  const encodedStrings = strings.map((value) => {
    const bytes = Buffer.from(value);
    return Buffer.concat([Buffer.from([value.length, bytes.length]), bytes, Buffer.from([0])]);
  });
  const offsets = Buffer.alloc(strings.length * 4);
  let stringOffset = 0;
  encodedStrings.forEach((value, index) => { offsets.writeUInt32LE(stringOffset, index * 4); stringOffset += value.length; });
  const poolSize = 28 + offsets.length + stringOffset;
  const pool = Buffer.alloc(poolSize);
  pool.writeUInt16LE(0x0001, 0); pool.writeUInt16LE(28, 2); pool.writeUInt32LE(poolSize, 4);
  pool.writeUInt32LE(strings.length, 8); pool.writeUInt32LE(0x100, 16); pool.writeUInt32LE(28 + offsets.length, 20);
  offsets.copy(pool, 28);
  Buffer.concat(encodedStrings).copy(pool, 28 + offsets.length);

  const element = Buffer.alloc(36 + 3 * 20);
  element.writeUInt16LE(0x0102, 0); element.writeUInt16LE(16, 2); element.writeUInt32LE(element.length, 4);
  element.writeUInt32LE(0xffffffff, 16); element.writeUInt32LE(0, 20);
  element.writeUInt16LE(20, 24); element.writeUInt16LE(20, 26); element.writeUInt16LE(3, 28);
  [[1, 4], [2, 5], [3, 6]].forEach(([name, raw], index) => {
    const offset = 36 + index * 20;
    element.writeUInt32LE(0xffffffff, offset); element.writeUInt32LE(name!, offset + 4); element.writeUInt32LE(raw!, offset + 8);
    element.writeUInt16LE(8, offset + 12); element[offset + 15] = 0x03; element.writeUInt32LE(raw!, offset + 16);
  });
  const root = Buffer.alloc(8);
  root.writeUInt16LE(0x0003, 0); root.writeUInt16LE(8, 2); root.writeUInt32LE(root.length + pool.length + element.length, 4);
  return Buffer.concat([root, pool, element]);
}

function iosPlist(applicationId: string, version: string, buildNumber: string, executable: string): Buffer {
  return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${applicationId}</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundleVersion</key><string>${buildNumber}</string>
<key>CFBundleExecutable</key><string>${executable}</string>
</dict></plist>`);
}

function thinMachO(cpuType = 0x0100000c): Buffer {
  const value = Buffer.alloc(32);
  value.writeUInt32LE(0xfeedfacf, 0);
  value.writeUInt32LE(cpuType, 4);
  return value;
}

function representativeAppPackage(input: Readonly<{
  renderer: TerminalNativeDeviceRenderer;
  applicationId: string;
  version: string;
  buildNumber: string;
  identity: Buffer;
  toolchainMarker?: string;
}>): Readonly<{ bytes: Buffer; metadataSha256: string }> {
  if (input.renderer === 'android-termux') {
    const manifest = androidBinaryManifest(input.applicationId, input.version, input.buildNumber);
    return {
      metadataSha256: sha(manifest),
      bytes: zipArchive([
        { name: 'AndroidManifest.xml', contents: manifest },
        { name: 'resources.arsc', contents: Buffer.from('resources') },
        { name: 'classes.dex', contents: Buffer.concat([Buffer.from('dex\n035\0'), Buffer.alloc(32)]) },
        { name: 'lib/arm64-v8a/libappmodules.so', contents: Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(32)]) },
        { name: 'assets/happier-terminal-native-build-identity.json', contents: input.identity },
      ], true),
    };
  }
  const plist = iosPlist(input.applicationId, input.version, input.buildNumber, 'Happier');
  return {
    metadataSha256: sha(plist),
    bytes: zipArchive([
      { name: 'Happier.app/Info.plist', contents: plist },
      { name: 'Happier.app/Happier', contents: thinMachO() },
      { name: 'Happier.app/_CodeSignature/CodeResources', contents: Buffer.from('adhoc') },
      { name: 'Happier.app/happier-terminal-native-build-identity.json', contents: input.identity },
      ...(input.toolchainMarker
        ? [{ name: 'Happier.app/toolchain-output.txt', contents: Buffer.from(input.toolchainMarker) }]
        : []),
    ]),
  };
}

function representativeIosUnsignedSimulator(input: Readonly<{
  applicationId: string;
  version: string;
  buildNumber: string;
  identity: Buffer;
}>): Buffer {
  const plist = iosPlist(input.applicationId, input.version, input.buildNumber, 'Happier');
  return zipArchive([
    { name: 'Happier.app/Info.plist', contents: plist },
    { name: 'Happier.app/Happier', contents: thinMachO() },
    { name: 'Happier.app/happier-terminal-native-build-identity.json', contents: input.identity },
  ]);
}

function representativeIosIpa(input: Readonly<{
  applicationId: string;
  version: string;
  buildNumber: string;
  identity: Buffer;
}>): Buffer {
  const plist = iosPlist(input.applicationId, input.version, input.buildNumber, 'Happier');
  return zipArchive([
    { name: 'Payload/Happier.app/Info.plist', contents: plist },
    { name: 'Payload/Happier.app/Happier', contents: thinMachO() },
    { name: 'Payload/Happier.app/_CodeSignature/CodeResources', contents: Buffer.from('signed') },
    { name: 'Payload/Happier.app/embedded.mobileprovision', contents: Buffer.from('profile') },
    { name: 'Payload/Happier.app/happier-terminal-native-build-identity.json', contents: input.identity },
  ]);
}

function packagingGateDetails(
  renderer: TerminalNativeDeviceRenderer,
  gateId: TerminalNativePackagingGateId,
  binarySha256: string,
  pin: TerminalNativeDependencyPin,
  packageFacts: Readonly<{ metadataSha256: string; applicationId: string; version: string; buildNumber: string }>,
  iosRepeatabilityDetails?: Record<string, unknown>,
): Record<string, unknown> {
  switch (gateId) {
    case 'platform-package-inspection':
      return renderer === 'ios-ghosttykit' ? {
        binarySha256, format: 'ios-simulator-app-archive', applicationId: packageFacts.applicationId,
        version: packageFacts.version, buildNumber: packageFacts.buildNumber, architectures: ['arm64'],
        metadataSha256: packageFacts.metadataSha256, signatureVerified: true, signatureSchemes: ['adhoc'],
        signerCertificateSha256: [], inspector: 'xcode/codesign+plutil+lipo', executable: 'Happier',
        codeSignaturePresent: true, provisioningProfilePresent: false, signingMode: 'simulator-adhoc', teamIdentifier: null,
      } : {
        binarySha256, format: 'android-apk', applicationId: packageFacts.applicationId,
        version: packageFacts.version, buildNumber: packageFacts.buildNumber, architectures: ['arm64-v8a'],
        metadataSha256: packageFacts.metadataSha256, signatureVerified: true, signatureSchemes: ['v2'],
        signerCertificateSha256: ['6'.repeat(64)], inspector: 'android-build-tools/apksigner+aapt2',
        dexFileCount: 1, nativeLibraryCount: 1, resourcesPresent: true,
      };
    case 'repeatable-package-build':
      if (renderer === 'ios-ghosttykit') {
        if (!iosRepeatabilityDetails) throw new Error('missing iOS repeatability fixture details');
        return iosRepeatabilityDetails;
      }
      return { firstBinarySha256: binarySha256, secondBinarySha256: binarySha256, reproducible: true };
    case 'checksum-pinned-artifact':
      return {
        expectedDependencyChecksumSha256: pin.dependencyChecksumSha256,
        observedDependencyChecksumSha256: pin.dependencyChecksumSha256,
        dependencyClosureSha256: pin.dependencyClosureSha256,
      };
    case 'license-notice':
      return {
        licenseExpression: renderer === 'ios-ghosttykit' ? 'MIT' : 'Apache-2.0',
        noticeSha256: '7'.repeat(64),
        noticeIncludesDependencyRevision: true,
      };
    case 'binary-size-budget':
      return { binarySha256, measuredBytes: 1024, budgetBytes: 2048, withinBudget: true };
    case 'abi-smoke-test':
      return { binarySha256, architectures: ['arm64'], requiredSymbols: ['HappierTerminalNative'], missingSymbols: [] };
    case 'wuffs-isolation':
      return { binarySha256, overlappingGlobalSymbolCount: 0, ghosttyPublicAbiPreserved: true };
    case 'app-link':
      return { binarySha256, duplicateSymbolWarnings: 0, requiredNativeModuleSymbolsPresent: true };
    case 'store-export-review':
      return { reviewStatus: 'approved', appStoreExportSucceeded: true, reviewer: 'fixture-store-reviewer' };
    case 'crash-fallback-build-capability':
      return { internalOnly: true, fallbackRenderer: 'xterm-webview', capabilitySymbolPresent: true };
    case 'dependency-closure':
      return { dependencyClosureSha256: pin.dependencyClosureSha256, includedModules: ['terminal-emulator', 'terminal-view'], forbiddenModulesFound: [] };
    case 'forbidden-module-absence':
      return { dependencyClosureSha256: pin.dependencyClosureSha256, forbiddenModulesFound: [] };
    case 'gradle-build':
      return { binarySha256, task: ':app:assembleInternaldevRelease', exitCode: 0 };
  }
}

function actionDetails(id: TerminalNativeDeviceActionId, renderer: TerminalNativeDeviceRenderer, cursor: number) {
  if (id === 'async-byte-write-ack-reject-retry') return {
    terminalId: 'terminal-qa', initialByteOffset: cursor, byteLength: 64,
    rejectedWriteId: 'write-rejected', rejectedOutcome: 'rejected', rejectedAt: START,
    rejectedOffsetAfter: cursor, retryWriteId: 'write-retry', retryOutcome: 'accepted',
    retryFromByteOffset: cursor, acceptedByteOffset: cursor + 64, retryCompletedAt: END,
    rejectionReason: 'qa-injected-rejection',
  };
  if (id === 'hardware-keyboard-chords') return { chords: ['ctrl-c', 'ctrl-l'], terminalObserved: true };
  if (id === 'ime-composition') return { composedText: 'e\u0301', committedText: 'é', terminalObserved: true };
  if (id === 'selection-copy') return { selectedText: 'terminal selection', copiedText: 'terminal selection', copyMatchesSelection: true };
  if (id === 'renderer-crash-fallback') return {
    logicalSessionIdBefore: 'session-qa', logicalSessionIdAfter: 'session-qa',
    terminalIdBefore: 'terminal-qa', terminalIdAfter: 'terminal-qa',
    rendererBefore: renderer, rendererAfter: 'xterm-webview', fallbackObserved: true, contentRetained: true,
    contentMarkerBeforeSha256: 'c'.repeat(64), contentMarkerAfterSha256: 'c'.repeat(64),
  };
  if (id === 'background-resume') return {
    logicalSessionIdBefore: 'session-qa', logicalSessionIdAfter: 'session-qa',
    byteOffsetBefore: cursor, byteOffsetAfter: cursor, contentRetained: true, inputAcceptedAfterResume: true,
  };
  return {
    logicalSessionIdBefore: 'session-qa', logicalSessionIdAfter: 'session-qa',
    initialColumns: 34, initialRows: 18, resizedColumns: 67, resizedRows: 11,
    restoredColumns: 34, restoredRows: 18, contentRetained: true,
  };
}

function createFixture(
  renderer: TerminalNativeDeviceRenderer,
  fixtureOptions: Readonly<{ iosRepeatHashesDiffer?: boolean; iosSecondBuildSucceeded?: boolean }> = {},
): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'term-evidence-v2-'));
  const recipe = getTerminalNativeDeviceRecipe(renderer);
  const runId = `${renderer}-run-v2`;
  const runDir = `.project/logs/e2e/terminal-native/${recipe.platform}/${runId}`;
  const pin = terminalNativeDependencyPinFromPolicy(SOURCE_POLICY, renderer);
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const authorityId = 'fixture-independent-release-owner';
  const approvalPolicy: TerminalNativeApprovalPolicy = {
    schemaVersion: 1,
    authorities: [{ id: authorityId, publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(), rendererIds: ['android-termux'] }],
  };
  const captureKeys = generateKeyPairSync('ed25519');
  const captureAuthorityId = 'fixture-independent-device-capture';
  const capturePolicy: TerminalNativeCapturePolicy = {
    schemaVersion: 2,
    authorities: [{
      id: captureAuthorityId,
      publicKeyPem: captureKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      validFrom: '2026-08-28T09:00:00.000Z',
      validUntil: '2026-08-28T11:00:00.000Z',
      scopes: [
        { rendererId: 'ios-ghosttykit', allowedBuildIds: [BUILD_ID] },
        { rendererId: 'android-termux', allowedBuildIds: [BUILD_ID] },
      ],
    }],
  };
  const applicationId = recipe.platform === 'ios' ? 'dev.happier.app.dev.internal.devclient' : 'dev.happier.app.internaldev';
  const artifacts: Mutable<TerminalNativeDeviceEvidence['artifacts']> = [];
  const artifactPaths = new Map<string, string>();
  const addArtifact = (id: string, kind: TerminalNativeDeviceEvidence['artifacts'][number]['kind'], mediaType: string, bytes: string | Buffer, capturedAt = END) => {
    const extension = mediaType === 'application/json' ? 'json' : kind === 'video' ? 'mp4' : 'bin';
    const path = `${runDir}/${id}.${extension}`;
    const absolute = join(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, bytes);
    artifactPaths.set(id, absolute);
    artifacts.push({ id, kind, path, mediaType, sha256: sha(bytes), capturedAt });
  };
  const rewriteArtifact = (id: string, value: unknown): void => {
    const artifact = artifacts.find((candidate) => candidate.id === id);
    const path = artifactPaths.get(id);
    if (!artifact || !path) throw new Error(`unknown artifact ${id}`);
    const bytes = typeof value === 'string' ? value : terminalEvidenceCanonicalJson(value);
    writeFileSync(path, bytes);
    artifact.sha256 = sha(bytes);
  };

  const unsignedBuildIdentity = {
    schemaVersion: 1,
    kind: 'terminal-native-build-identity',
    authorityId: captureAuthorityId,
    platform: recipe.platform,
    rendererId: renderer,
    buildEvidenceId: BUILD_ID,
    applicationId,
    version: '0.0.0-qa',
    buildNumber: '123',
    sourceStateSha256: 'source-state-placeholder',
    dependencyClosureSha256: pin.dependencyClosureSha256,
    generatedAt: START,
    signatureAlgorithm: 'ed25519',
  };
  const provisionalSourceState = createTerminalNativeSourceState({
    sourceCommit: COMMIT, sourceDirty: true, generatedAt: START,
    inventory: [{ path: 'packages/terminal-native/native-renderers.json', sha256: sha(terminalEvidenceCanonicalJson(SOURCE_POLICY)) }],
  });
  const provisionalSourceStateSha = sha(terminalEvidenceCanonicalJson(provisionalSourceState));
  unsignedBuildIdentity.sourceStateSha256 = provisionalSourceStateSha;
  const buildIdentitySignature = sign(
    null,
    Buffer.from(terminalNativeCaptureSigningPayload(unsignedBuildIdentity)),
    captureKeys.privateKey,
  ).toString('base64');
  const embeddedIdentityBytes = Buffer.from(terminalEvidenceCanonicalJson({ ...unsignedBuildIdentity, signature: buildIdentitySignature }));
  const packageFacts = representativeAppPackage({
    renderer,
    applicationId,
    version: '0.0.0-qa',
    buildNumber: '123',
    identity: embeddedIdentityBytes,
  });
  const appBytes = packageFacts.bytes;
  addArtifact('app-binary', 'app-binary', 'application/octet-stream', appBytes, START);
  let iosRepeatabilityDetails: Record<string, unknown> | undefined;
  if (renderer === 'ios-ghosttykit') {
    const repeatBytes = fixtureOptions.iosRepeatHashesDiffer
      ? representativeAppPackage({
        renderer,
        applicationId,
        version: '0.0.0-qa',
        buildNumber: '123',
        identity: embeddedIdentityBytes,
        toolchainMarker: 'different nondeterministic toolchain output',
      }).bytes
      : appBytes;
    addArtifact('app-binary-repeat', 'app-binary', 'application/octet-stream', repeatBytes, START);
    addArtifact('build-log-first', 'log', 'text/plain', 'xcodebuild\n** BUILD SUCCEEDED **\n', START);
    addArtifact(
      'build-log-second',
      'log',
      'text/plain',
      fixtureOptions.iosSecondBuildSucceeded === false
        ? 'xcodebuild\n** BUILD FAILED **\n'
        : 'xcodebuild\n** BUILD SUCCEEDED **\n',
      START,
    );
    const inspectionFacts = (artifactId: string) => {
      const inspection = inspectTerminalNativeAppPackage(artifactPaths.get(artifactId)!, 'ios');
      return {
        format: inspection.format,
        applicationId: inspection.applicationId,
        version: inspection.version,
        buildNumber: inspection.buildNumber,
        architectures: inspection.architectures,
        metadataSha256: inspection.metadataSha256,
        executable: inspection.executable,
        codeSignaturePresent: inspection.codeSignaturePresent,
        provisioningProfilePresent: inspection.provisioningProfilePresent,
      };
    };
    const build = (binaryArtifactId: string, buildLogArtifactId: string) => ({
      binaryArtifactId,
      binarySha256: artifacts.find((artifact) => artifact.id === binaryArtifactId)!.sha256,
      buildLogArtifactId,
      buildLogSha256: artifacts.find((artifact) => artifact.id === buildLogArtifactId)!.sha256,
      buildSucceeded: true,
      inspection: inspectionFacts(binaryArtifactId),
    });
    const firstBuild = build('app-binary', 'build-log-first');
    const secondBuild = build('app-binary-repeat', 'build-log-second');
    const hashesEqual = firstBuild.binarySha256 === secondBuild.binarySha256;
    iosRepeatabilityDetails = {
      buildCommandSha256: sha('xcodebuild canonical release invocation'),
      buildEnvironmentSha256: sha('canonical TERM iOS QA environment'),
      firstBuild,
      secondBuild,
      artifactHashesEqual: hashesEqual,
      toolchainNondeterminismObserved: !hashesEqual,
    };
  }
  const sourceState = provisionalSourceState;
  addArtifact('source-state', 'source-state', 'application/json', terminalEvidenceCanonicalJson(sourceState), START);
  const sourceStateSha = artifacts.find((artifact) => artifact.id === 'source-state')!.sha256;
  const binarySha = sha(appBytes);

  const packagingReports: Record<string, { tool: string; reportArtifactId: string; reportSha256: string }> = {};
  for (const gateId of TERMINAL_NATIVE_PACKAGING_GATES[renderer]) {
    const reportArtifactId = `packaging-gate-${gateId}`;
    const tool = TERMINAL_NATIVE_PACKAGING_GATE_TOOLS[gateId];
    const report = createTerminalNativePackagingGateReport({
      buildEvidenceId: BUILD_ID, rendererId: renderer, gateId, tool,
      binarySha256: binarySha, sourceStateSha256: sourceStateSha,
      dependencyClosureSha256: pin.dependencyClosureSha256, generatedAt: START,
      details: packagingGateDetails(renderer, gateId, binarySha, pin, {
        ...packageFacts,
        applicationId,
        version: '0.0.0-qa',
        buildNumber: '123',
      }, iosRepeatabilityDetails),
    });
    addArtifact(reportArtifactId, 'packaging-gate-report', 'application/json', terminalEvidenceCanonicalJson(report), START);
    packagingReports[gateId] = {
      tool,
      reportArtifactId,
      reportSha256: artifacts.find((artifact) => artifact.id === reportArtifactId)!.sha256,
    };
  }
  const packaging = createTerminalNativePackagingAttestation({
    buildEvidenceId: BUILD_ID, rendererId: renderer, binarySha256: binarySha,
    sourceStateSha256: sourceStateSha, dependencyClosureSha256: pin.dependencyClosureSha256,
    generatedAt: START,
    reports: packagingReports,
  });
  addArtifact('packaging', 'packaging-report', 'application/json', terminalEvidenceCanonicalJson(packaging), START);
  const runtime = createTerminalNativeLoadedAppAttestation({
    runId, runNonce: RUN_NONCE, buildEvidenceId: BUILD_ID, logicalSessionId: 'session-qa', terminalId: 'terminal-qa', rendererId: renderer,
    applicationId, version: '0.0.0-qa', buildNumber: '123', buildVariant: 'internal-native-enabled',
    binarySha256: binarySha, sourceStateSha256: sourceStateSha, dependencyClosureSha256: pin.dependencyClosureSha256,
    deviceTargetId: 'local-device-target', emittedAt: START,
  });
  addArtifact('runtime', 'runtime-attestation', 'application/json', terminalEvidenceCanonicalJson(runtime), START);
  addArtifact('device-log', 'log', 'text/plain', `run=${runId} nonce=${RUN_NONCE}`);
  addArtifact('accessibility-tree', 'accessibility-tree', 'application/json', terminalEvidenceCanonicalJson({
    schemaVersion: 1, kind: 'terminal-native-accessibility-tree', runId, runNonce: RUN_NONCE,
    buildEvidenceId: BUILD_ID, terminalId: 'terminal-qa', rendererId: renderer, capturedAt: END,
    nodes: [{ role: 'text', label: 'terminal current output' }],
  }));
  addArtifact('screen-reader-video', 'video', 'video/mp4', Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x18]), Buffer.from('ftyp'), Buffer.from('isom0000'),
  ]));

  let cursor = 0;
  const workloads = recipe.requiredWorkloads.map((id) => {
    const fixture = getTerminalWorkload(id);
    const startByteOffset = cursor;
    cursor += fixture.byteLength;
    return {
      id, status: 'passed' as const, startedAt: START, endedAt: END,
      fixtureByteLength: fixture.byteLength, fixtureSha256: bytesSha256Hex(fixture.bytes),
      startByteOffset, acceptedByteOffset: cursor,
      ack: { terminalId: 'terminal-qa', writeId: `write-${id}`, outcome: 'accepted' as const, completedAt: END },
      artifactIds: ['device-log'], reportArtifactId: `report-workload-${id}`,
    };
  });
  const actions = TERMINAL_NATIVE_DEVICE_ACTION_IDS.map((id, sequence) => {
    const startByteOffset = cursor;
    if (id === 'async-byte-write-ack-reject-retry') cursor += 64;
    return {
      id, status: 'passed' as const, startedAt: START, endedAt: END, sequence,
      operationId: `operation-${sequence}`, startByteOffset, acceptedByteOffset: cursor,
      details: actionDetails(id, renderer, startByteOffset), artifactIds: ['device-log'],
      reportArtifactId: `report-action-${id}`,
    };
  });
  const accessibility = [
    { id: 'platform-accessibility-tree' as const, status: 'passed' as const, startedAt: START, endedAt: END,
      details: { terminalNodeCount: 1, usefulContentExposed: true, summary: 'terminal current output' }, artifactIds: ['accessibility-tree'], reportArtifactId: 'report-ax-tree' },
    { id: 'screen-reader-navigation' as const, status: 'passed' as const, startedAt: START, endedAt: END,
      details: { screenReader: recipe.platform === 'ios' ? 'VoiceOver' : 'TalkBack', reachedCurrentOutput: true, spokenSummary: 'terminal current output' }, artifactIds: ['screen-reader-video'], reportArtifactId: 'report-screen-reader' },
    { id: 'copy-selection-link-affordances' as const, status: 'passed' as const, startedAt: START, endedAt: END,
      details: { reachableAffordances: ['copy', 'select', 'open-link'], actionsInvoked: ['copy', 'select', 'open-link'] }, artifactIds: ['accessibility-tree'], reportArtifactId: 'report-ax-actions' },
  ];
  for (const [kind, items] of [['workload', workloads], ['action', actions], ['accessibility', accessibility]] as const) {
    for (const item of items) {
      const report = createTerminalNativeObservationReport({
        runId, runNonce: RUN_NONCE, buildEvidenceId: BUILD_ID, logicalSessionId: 'session-qa', terminalId: 'terminal-qa', rendererId: renderer,
        observationKind: kind, observation: item, recordedAt: END,
      });
      addArtifact(item.reportArtifactId, 'observation-report', 'application/json', terminalEvidenceCanonicalJson(report));
    }
  }

  const benchmarkSamples = recipe.requiredWorkloads.flatMap((workloadId) => {
    const workload = getTerminalWorkload(workloadId);
    return Array.from({ length: 3 }, () => [
      summarizeTerminalSample({
        renderer: 'xterm-webview', workloadId, decodedBytes: workload.byteLength, durationMs: 100,
        ackLatenciesMs: [10], timingBoundary: 'display-observed', observationSource: 'loaded-device',
        environment: { platform: recipe.platform, targetId: 'local-device-target', applicationId, buildEvidenceId: BUILD_ID },
      }),
      summarizeTerminalSample({
        renderer, workloadId, decodedBytes: workload.byteLength,
        durationMs: renderer === 'android-termux' ? 50 : 100,
        ackLatenciesMs: [10], timingBoundary: 'display-observed', observationSource: 'loaded-device',
        environment: { platform: recipe.platform, targetId: 'local-device-target', applicationId, buildEvidenceId: BUILD_ID },
      }),
    ]).flat();
  });
  const benchmark = buildTerminalBenchmarkReport({
    measurementScope: 'renderer', suite: `${renderer}-loaded-comparison`,
    startedAt: START, endedAt: END, samples: benchmarkSamples,
  });
  const benchmarkReport = createTerminalNativeRendererBenchmarkReport({
    runId, runNonce: RUN_NONCE, buildEvidenceId: BUILD_ID,
    logicalSessionId: 'session-qa', terminalId: 'terminal-qa', rendererId: renderer,
    applicationId, binarySha256: binarySha, deviceTargetId: 'local-device-target',
    platform: recipe.platform, benchmark, recordedAt: END,
  });
  addArtifact('renderer-comparison', 'renderer-benchmark', 'application/json', terminalEvidenceCanonicalJson(benchmarkReport));

  let approvalArtifactId: string | null = null;
  if (renderer === 'android-termux') {
    approvalArtifactId = 'release-approval';
    const unsigned = {
      schemaVersion: 1, kind: 'terminal-native-release-approval', authorityId,
      decision: 'approved', rendererId: renderer, dependencyClosureSha256: pin.dependencyClosureSha256,
      dependencyRevision: pin.dependencyRevision, approvedAt: END, signatureAlgorithm: 'ed25519',
    };
    const signature = sign(null, Buffer.from(terminalNativeApprovalSigningPayload(unsigned)), privateKey).toString('base64');
    addArtifact(approvalArtifactId, 'release-approval', 'application/json', terminalEvidenceCanonicalJson({ ...unsigned, signature }));
  }

  const capturedArtifacts = artifacts
    .filter((artifact) => artifact.kind !== 'release-approval')
    .map((artifact) => ({ id: artifact.id, kind: artifact.kind, sha256: artifact.sha256, capturedAt: artifact.capturedAt }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const unsignedCapture = {
    schemaVersion: 1,
    kind: 'terminal-native-capture-attestation',
    authorityId: captureAuthorityId,
    runId,
    runNonce: RUN_NONCE,
    buildEvidenceId: BUILD_ID,
    logicalSessionId: 'session-qa',
    terminalId: 'terminal-qa',
    rendererId: renderer,
    applicationId,
    binarySha256: binarySha,
    sourceStateSha256: sourceStateSha,
    dependencyClosureSha256: pin.dependencyClosureSha256,
    deviceTargetId: 'local-device-target',
    startedAt: START,
    endedAt: END,
    artifacts: capturedArtifacts,
    signedAt: END,
    signatureAlgorithm: 'ed25519',
  };
  const captureSignature = sign(
    null,
    Buffer.from(terminalNativeCaptureSigningPayload(unsignedCapture)),
    captureKeys.privateKey,
  ).toString('base64');
  addArtifact('capture-attestation', 'capture-attestation', 'application/json', terminalEvidenceCanonicalJson({
    ...unsignedCapture,
    signature: captureSignature,
  }));

  const evidence: Mutable<TerminalNativeDeviceEvidence> = {
    schemaVersion: 2, runId, runNonce: RUN_NONCE, buildEvidenceId: BUILD_ID, evidenceSource: 'loaded-native-app',
    startedAt: START, endedAt: END, platform: recipe.platform,
    captureAuthority: captureAuthorityId,
    captureAttestationArtifactId: 'capture-attestation',
    app: {
      applicationId, version: '0.0.0-qa', buildNumber: '123', buildVariant: 'internal-native-enabled',
      sourceCommit: COMMIT, sourceDirty: true, sourceStateSha256: sourceStateSha, sourceStateArtifactId: 'source-state',
      runtimeAttestationArtifactId: 'runtime', packagingReportArtifactId: 'packaging', nativeEnabled: true,
      binarySha256: binarySha, binaryArtifactId: 'app-binary',
    },
    device: { model: 'QA Device', osName: recipe.platform === 'ios' ? 'iOS' : 'Android', osVersion: '1.0', architecture: 'arm64', simulator: true, targetId: 'local-device-target' },
    renderer: {
      id: renderer,
      implementation: renderer === 'ios-ghosttykit' ? 'ghosttykit' : 'termux-terminal-renderer',
      nativePackageVersion: '0.0.0',
      dependencyName: pin.dependencyName,
      dependencyRevision: pin.dependencyRevision,
      dependencyChecksumSha256: pin.dependencyChecksumSha256,
      dependencyClosureSha256: pin.dependencyClosureSha256,
    },
    logicalSessionId: 'session-qa', terminalId: 'terminal-qa', workloads, actions, accessibility,
    rendererComparison: {
      status: 'passed', baselineRenderer: 'xterm-webview', candidateRenderer: renderer,
      timingBoundary: 'display-observed', observationSource: 'loaded-device',
      minThroughputRatio: renderer === 'android-termux' ? 1.25 : 0.75,
      minSamplesPerWorkload: 3, reportArtifactId: 'renderer-comparison',
    },
    artifacts,
    externalApproval: renderer === 'android-termux'
      ? { required: true, status: 'approved', authority: authorityId, exactDependencyClosureSha256: pin.dependencyClosureSha256, recordedAt: END, approvalArtifactId }
      : { required: false, status: 'not-required', authority: null, exactDependencyClosureSha256: pin.dependencyClosureSha256, recordedAt: END, approvalArtifactId: null },
  };
  return {
    root,
    evidence,
    options: { rendererPolicy: SOURCE_POLICY, approvalPolicy, capturePolicy, nativePackageVersion: '0.0.0' },
    rewriteArtifact,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function validate(fixture: Fixture) {
  return validateTerminalNativeDeviceEvidenceWithArtifacts(fixture.evidence, fixture.root, fixture.options);
}

describe('stress: TERM-7b evidence contract v2', () => {
  it.each(['ios-ghosttykit', 'android-termux'] as const)('inspects a representative real %s package structure', (renderer) => {
    const root = mkdtempSync(join(tmpdir(), 'term-package-fixture-'));
    try {
      const applicationId = renderer === 'ios-ghosttykit' ? 'dev.happier.app.dev.internal.devclient' : 'dev.happier.app.internaldev';
      const representative = representativeAppPackage({
        renderer, applicationId, version: '0.0.0-qa', buildNumber: '123', identity: Buffer.from('{"fixture":true}'),
      });
      const path = join(root, renderer === 'ios-ghosttykit' ? 'app.zip' : 'app.apk');
      writeFileSync(path, representative.bytes);
      expect(inspectTerminalNativeAppPackage(path, renderer === 'ios-ghosttykit' ? 'ios' : 'android')).toMatchObject({
        applicationId, version: '0.0.0-qa', buildNumber: '123', architectures: renderer === 'ios-ghosttykit' ? ['arm64'] : ['arm64-v8a'],
      });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('distinguishes valid unsigned simulator archives from signed device IPA structure', () => {
    const root = mkdtempSync(join(tmpdir(), 'term-ios-package-variants-'));
    try {
      const applicationId = 'dev.happier.app.dev.internal.devclient';
      const simulatorPath = join(root, 'simulator.zip');
      writeFileSync(simulatorPath, representativeIosUnsignedSimulator({
        applicationId, version: '1.2.3', buildNumber: '42', identity: Buffer.from('{}'),
      }));
      expect(inspectTerminalNativeAppPackage(simulatorPath, 'ios')).toMatchObject({
        format: 'ios-simulator-app-archive', applicationId, codeSignaturePresent: false,
        provisioningProfilePresent: false, packageSignatureEnvelope: [],
      });

      const ipaPath = join(root, 'device.ipa');
      writeFileSync(ipaPath, representativeIosIpa({
        applicationId, version: '1.2.3', buildNumber: '42', identity: Buffer.from('{}'),
      }));
      expect(inspectTerminalNativeAppPackage(ipaPath, 'ios')).toMatchObject({
        format: 'ios-ipa', applicationId, codeSignaturePresent: true,
        provisioningProfilePresent: true, packageSignatureEnvelope: ['codesign'],
      });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('rejects identity-only, cross-platform, unsigned, and malformed package fixtures', () => {
    const root = mkdtempSync(join(tmpdir(), 'term-package-red-'));
    try {
      const identityOnly = join(root, 'identity-only.apk');
      writeFileSync(identityOnly, storedZip('assets/happier-terminal-native-build-identity.json', Buffer.from('{}')));
      expect(() => inspectTerminalNativeAppPackage(identityOnly, 'android')).toThrow(/AndroidManifest/);

      const crossPlatform = join(root, 'cross-platform.zip');
      writeFileSync(crossPlatform, representativeAppPackage({
        renderer: 'android-termux', applicationId: 'dev.happier.app.internaldev', version: '1.0.0', buildNumber: '1', identity: Buffer.from('{}'),
      }).bytes);
      expect(() => inspectTerminalNativeAppPackage(crossPlatform, 'ios')).toThrow(/top-level .app/);

      const unsigned = join(root, 'unsigned.apk');
      const manifest = androidBinaryManifest('dev.happier.app.internaldev', '1.0.0', '1');
      writeFileSync(unsigned, zipArchive([
        { name: 'AndroidManifest.xml', contents: manifest }, { name: 'resources.arsc', contents: Buffer.from('resources') },
        { name: 'classes.dex', contents: Buffer.concat([Buffer.from('dex\n035\0'), Buffer.alloc(32)]) },
        { name: 'lib/arm64-v8a/libappmodules.so', contents: Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(32)]) },
        { name: 'assets/happier-terminal-native-build-identity.json', contents: Buffer.from('{}') },
      ]));
      expect(() => inspectTerminalNativeAppPackage(unsigned, 'android')).toThrow(/signing envelope/);

      const duplicateIdentity = join(root, 'duplicate-identity.apk');
      const duplicateEntries = [
        { name: 'AndroidManifest.xml', contents: manifest }, { name: 'resources.arsc', contents: Buffer.from('resources') },
        { name: 'classes.dex', contents: Buffer.concat([Buffer.from('dex\n035\0'), Buffer.alloc(32)]) },
        { name: 'lib/arm64-v8a/libappmodules.so', contents: Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(32)]) },
        { name: 'assets/happier-terminal-native-build-identity.json', contents: Buffer.from('{}') },
        { name: 'other/happier-terminal-native-build-identity.json', contents: Buffer.from('{"ambiguous":true}') },
      ];
      writeFileSync(duplicateIdentity, zipArchive(duplicateEntries, true));
      expect(() => inspectTerminalNativeAppPackage(duplicateIdentity, 'android')).toThrow(/exactly one TERM build identity/);

      const malformedMachO = join(root, 'malformed-ios.zip');
      const plist = iosPlist('dev.happier.app.dev.internal.devclient', '1.0.0', '1', 'Happier');
      writeFileSync(malformedMachO, zipArchive([
        { name: 'Happier.app/Info.plist', contents: plist }, { name: 'Happier.app/Happier', contents: Buffer.alloc(32) },
        { name: 'Happier.app/_CodeSignature/CodeResources', contents: Buffer.from('adhoc') },
        { name: 'Happier.app/happier-terminal-native-build-identity.json', contents: Buffer.from('{}') },
      ]));
      expect(() => inspectTerminalNativeAppPackage(malformedMachO, 'ios')).toThrow(/Mach-O/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('binds canonical Android and iOS tool output to directly inspected package facts', () => {
    const root = mkdtempSync(join(tmpdir(), 'term-package-tools-'));
    try {
      const android = representativeAppPackage({
        renderer: 'android-termux', applicationId: 'dev.happier.app.internaldev', version: '1.2.3', buildNumber: '42', identity: Buffer.from('{}'),
      });
      const apk = join(root, 'app.apk');
      writeFileSync(apk, android.bytes);
      expect(inspectAndroidPackageWithBuildTools({
        binaryPath: apk, aapt2Path: '/sdk/aapt2', apksignerPath: '/sdk/apksigner',
        run: (command) => command.endsWith('aapt2')
          ? "package: name='dev.happier.app.internaldev' versionCode='42' versionName='1.2.3'\n"
          : `Verifies\nVerified using v1 scheme (JAR signing): false\nVerified using v2 scheme (APK Signature Scheme v2): true\nSigner #1 certificate SHA-256 digest: ${'6'.repeat(64)}\n`,
      })).toMatchObject({ applicationId: 'dev.happier.app.internaldev', signatureSchemes: ['v2'], signerCertificateSha256: ['6'.repeat(64)] });
      expect(() => inspectAndroidPackageWithBuildTools({
        binaryPath: apk, aapt2Path: '/sdk/aapt2', apksignerPath: '/sdk/apksigner',
        run: (command) => command.endsWith('aapt2')
          ? "package: name='dev.happier.wrong' versionCode='42' versionName='1.2.3'\n"
          : `Verifies\nVerified using v2 scheme (APK Signature Scheme v2): true\nSigner #1 certificate SHA-256 digest: ${'6'.repeat(64)}\n`,
      })).toThrow(/metadata does not match/);
      expect(() => inspectAndroidPackageWithBuildTools({
        binaryPath: apk, aapt2Path: '/sdk/aapt2', apksignerPath: '/sdk/apksigner',
        run: (command) => command.endsWith('aapt2')
          ? "package: name='dev.happier.app.internaldev' versionCode='42' versionName='1.2.3'\n"
          : 'Verifies\nVerified using v2 scheme (APK Signature Scheme v2): true\n',
      })).toThrow(/signer certificate SHA-256/);

      const ios = representativeAppPackage({
        renderer: 'ios-ghosttykit', applicationId: 'dev.happier.app.dev.internal.devclient', version: '1.2.3', buildNumber: '42', identity: Buffer.from('{}'),
      });
      const appZip = join(root, 'app.zip');
      writeFileSync(appZip, ios.bytes);
      expect(inspectIosPackageWithXcodeTools({
        binaryPath: appZip, signingMode: 'simulator-adhoc',
        run: (command, args) => {
          if (command === 'unzip') { execFileSync(command, [...args]); return ''; }
          if (command === 'lipo') return 'arm64\n';
          if (command === 'codesign' && args.includes('-d')) return 'Identifier=dev.happier.app.dev.internal.devclient\nSignature=adhoc\nTeamIdentifier=not set\n';
          return '';
        },
      })).toMatchObject({ applicationId: 'dev.happier.app.dev.internal.devclient', signingMode: 'simulator-adhoc', signatureSchemes: ['adhoc'] });

      const unsignedZip = join(root, 'unsigned-simulator.zip');
      writeFileSync(unsignedZip, representativeIosUnsignedSimulator({
        applicationId: 'dev.happier.app.dev.internal.devclient', version: '1.2.3', buildNumber: '42', identity: Buffer.from('{}'),
      }));
      expect(inspectIosPackageWithXcodeTools({
        binaryPath: unsignedZip, signingMode: 'simulator-unsigned',
        run: (command, args) => {
          if (command === 'unzip') { execFileSync(command, [...args]); return ''; }
          if (command === 'lipo') return 'arm64\n';
          if (command === 'codesign') throw new Error('unsigned simulator inspection must not invoke codesign');
          return '';
        },
      })).toMatchObject({
        signingMode: 'simulator-unsigned', signatureVerified: false, signatureSchemes: [],
        signerCertificateSha256: [], codeSignaturePresent: false, teamIdentifier: null,
      });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('only finalizes capture evidence with a registered, renderer-scoped matching private key', () => {
    const root = mkdtempSync(join(tmpdir(), 'term-capture-finalizer-'));
    const keys = generateKeyPairSync('ed25519');
    const wrongKeys = generateKeyPairSync('ed25519');
    const relativeArtifact = '.project/logs/e2e/terminal-native/ios/run/device.log';
    const absoluteArtifact = join(root, relativeArtifact);
    mkdirSync(dirname(absoluteArtifact), { recursive: true });
    writeFileSync(absoluteArtifact, 'captured output');
    const unsignedBuildIdentity = {
      schemaVersion: 1, kind: 'terminal-native-build-identity', authorityId: 'qa-capture',
      platform: 'ios', rendererId: 'ios-ghosttykit', buildEvidenceId: BUILD_ID,
      applicationId: 'dev.happier.app.dev.internal.devclient', version: '0.0.0-qa', buildNumber: '123',
      sourceStateSha256: 'c'.repeat(64), dependencyClosureSha256: 'a'.repeat(64),
      generatedAt: START, signatureAlgorithm: 'ed25519',
    };
    const identitySignature = sign(
      null,
      Buffer.from(terminalNativeCaptureSigningPayload(unsignedBuildIdentity)),
      keys.privateKey,
    ).toString('base64');
    const appBytes = representativeAppPackage({
      renderer: 'ios-ghosttykit',
      applicationId: 'dev.happier.app.dev.internal.devclient',
      version: '0.0.0-qa',
      buildNumber: '123',
      identity: Buffer.from(terminalEvidenceCanonicalJson({ ...unsignedBuildIdentity, signature: identitySignature })),
    }).bytes;
    const relativeApp = '.project/logs/e2e/terminal-native/ios/run/Happier.zip';
    writeFileSync(join(root, relativeApp), appBytes);
    const draft = {
      runId: 'run', runNonce: RUN_NONCE, buildEvidenceId: BUILD_ID, platform: 'ios',
      logicalSessionId: 'session', terminalId: 'terminal', startedAt: START, endedAt: END,
      renderer: { id: 'ios-ghosttykit', dependencyClosureSha256: 'a'.repeat(64) },
      app: { applicationId: 'dev.happier.app.dev.internal.devclient', binarySha256: sha(appBytes), binaryArtifactId: 'app-binary', sourceStateSha256: 'c'.repeat(64) },
      device: { targetId: 'simulator' },
      artifacts: [
        { id: 'app-binary', kind: 'app-binary', path: relativeApp, mediaType: 'application/octet-stream', sha256: sha(appBytes), capturedAt: START },
        { id: 'device-log', kind: 'log', path: relativeArtifact, mediaType: 'text/plain', sha256: sha('captured output'), capturedAt: END },
      ],
    } as unknown as TerminalNativeDeviceEvidence;
    const policy: TerminalNativeCapturePolicy = {
      schemaVersion: 2,
      authorities: [{
        id: 'qa-capture',
        publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        validFrom: '2026-08-28T09:00:00.000Z',
        validUntil: '2026-08-28T11:00:00.000Z',
        scopes: [{ rendererId: 'ios-ghosttykit', allowedBuildIds: [BUILD_ID] }],
      }],
    };
    try {
      expect(() => finalizeTerminalNativeCapture({
        repositoryRoot: root, draft, authorityId: 'unknown',
        privateKeyPem: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
        capturePolicy: policy, attestationPath: join(root, '.project/logs/e2e/terminal-native/ios/run/capture.json'),
      })).toThrow('not registered');
      expect(() => finalizeTerminalNativeCapture({
        repositoryRoot: root, draft, authorityId: 'qa-capture',
        privateKeyPem: wrongKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
        capturePolicy: policy, attestationPath: join(root, '.project/logs/e2e/terminal-native/ios/run/capture.json'),
      })).toThrow('does not match');
      expect(() => finalizeTerminalNativeCapture({
        repositoryRoot: root, draft: { ...draft, buildEvidenceId: 'wrong-build' }, authorityId: 'qa-capture',
        privateKeyPem: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
        capturePolicy: policy, attestationPath: join(root, '.project/logs/e2e/terminal-native/ios/run/capture.json'),
      })).toThrow(/not scoped.*build wrong-build/);
      expect(() => finalizeTerminalNativeCapture({
        repositoryRoot: root, draft: { ...draft, startedAt: '2026-08-28T08:59:59.000Z' }, authorityId: 'qa-capture',
        privateKeyPem: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
        capturePolicy: policy, attestationPath: join(root, '.project/logs/e2e/terminal-native/ios/run/capture.json'),
      })).toThrow(/run start.*outside/);
      expect(() => finalizeTerminalNativeCapture({
        repositoryRoot: root, draft: { ...draft, endedAt: '2026-08-28T11:00:00.001Z' }, authorityId: 'qa-capture',
        privateKeyPem: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
        capturePolicy: policy, attestationPath: join(root, '.project/logs/e2e/terminal-native/ios/run/capture.json'),
      })).toThrow(/run end.*outside/);
      expect(() => finalizeTerminalNativeCapture({
        repositoryRoot: root, draft, authorityId: 'qa-capture',
        privateKeyPem: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
        capturePolicy: policy, attestationPath: join(root, '.project/logs/e2e/terminal-native/ios/run/capture.json'),
        clock: () => new Date('2026-08-28T11:00:00.001Z'),
      })).toThrow(/capture signing time.*outside/);
      const finalized = finalizeTerminalNativeCapture({
        repositoryRoot: root, draft, authorityId: 'qa-capture',
        privateKeyPem: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
        capturePolicy: policy, attestationPath: join(root, '.project/logs/e2e/terminal-native/ios/run/capture.json'),
        clock: () => new Date(END),
      });
      expect(finalized).toMatchObject({ captureAuthority: 'qa-capture', captureAttestationArtifactId: 'capture-attestation' });
      expect(finalized.artifacts.at(-1)).toMatchObject({ kind: 'capture-attestation' });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('rejects a self-authored run bundle without a trusted capture attestation', () => {
    const fixture = createFixture('ios-ghosttykit');
    try {
      fixture.evidence.captureAuthority = 'untrusted-capture-authority';
      expect(validate(fixture).accepted).toBe(false);
      expect(validate(fixture).issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'untrusted-capture-authority' }),
      ]));
    } finally { fixture.cleanup(); }
  });

  it('rejects capture policies used for an unauthorized build or outside their validity window', () => {
    const wrongBuild = createFixture('ios-ghosttykit');
    try {
      const policy = wrongBuild.options.capturePolicy as Mutable<TerminalNativeCapturePolicy>;
      policy.authorities[0]!.scopes[0]!.allowedBuildIds = ['another-build'];
      expect(validate(wrongBuild).issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'untrusted-capture-authority' }),
      ]));
    } finally { wrongBuild.cleanup(); }

    const premature = createFixture('ios-ghosttykit');
    try {
      const policy = premature.options.capturePolicy as Mutable<TerminalNativeCapturePolicy>;
      policy.authorities[0]!.validFrom = '2026-08-28T10:00:00.001Z';
      expect(validate(premature).issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'build-identity-outside-authority-window' }),
        expect.objectContaining({ code: 'capture-outside-authority-window' }),
      ]));
    } finally { premature.cleanup(); }

    const expired = createFixture('android-termux');
    try {
      const policy = expired.options.capturePolicy as Mutable<TerminalNativeCapturePolicy>;
      policy.authorities[0]!.validUntil = '2026-08-28T10:09:59.999Z';
      expect(validate(expired).issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'capture-outside-authority-window' }),
      ]));
    } finally { expired.cleanup(); }
  });

  it('fails closed instead of throwing for malformed capture and approval authority registries', () => {
    const fixture = createFixture('android-termux');
    try {
      const malformedOptions = {
        ...fixture.options,
        capturePolicy: { schemaVersion: 2, authorities: [{ id: fixture.evidence.captureAuthority, publicKeyPem: 'not-a-key', validFrom: START, validUntil: END, scopes: null }] },
        approvalPolicy: { schemaVersion: 1, authorities: [{ id: fixture.evidence.externalApproval.authority, publicKeyPem: 'not-a-key', rendererIds: null }] },
      } as unknown as Fixture['options'];
      const result = validateTerminalNativeDeviceEvidenceWithArtifacts(fixture.evidence, fixture.root, malformedOptions);
      expect(result.accepted).toBe(false);
      expect(result.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'capture-policy-invalid' }),
        expect.objectContaining({ code: 'approval-policy-invalid' }),
      ]));
    } finally { fixture.cleanup(); }
  });

  it('rejects post-capture artifact edits even when the edited artifact hash is refreshed', () => {
    const fixture = createFixture('ios-ghosttykit');
    try {
      const artifact = fixture.evidence.artifacts.find((item) => item.id === 'runtime')!;
      const report = JSON.parse(readFileSync(join(fixture.root, artifact.path), 'utf8'));
      report.buildVariant = 'edited-after-capture';
      fixture.rewriteArtifact('runtime', report);
      expect(validate(fixture).issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'capture-attestation-mismatch' }),
      ]));
    } finally { fixture.cleanup(); }
  });

  it('rejects a forged capture signature from an otherwise trusted authority', () => {
    const fixture = createFixture('ios-ghosttykit');
    try {
      const artifact = fixture.evidence.artifacts.find((item) => item.id === 'capture-attestation')!;
      const report = JSON.parse(readFileSync(join(fixture.root, artifact.path), 'utf8'));
      report.signature = Buffer.alloc(64, 7).toString('base64');
      fixture.rewriteArtifact('capture-attestation', report);
      expect(validate(fixture).issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'invalid-capture-signature' }),
      ]));
    } finally { fixture.cleanup(); }
  });

  it('rejects a capture attestation signed before the run ended', () => {
    const fixture = createFixture('ios-ghosttykit');
    try {
      const artifact = fixture.evidence.artifacts.find((item) => item.id === 'capture-attestation')!;
      const report = JSON.parse(readFileSync(join(fixture.root, artifact.path), 'utf8'));
      report.signedAt = START;
      fixture.rewriteArtifact('capture-attestation', report);
      expect(validate(fixture).issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'capture-signed-before-run-end' }),
      ]));
    } finally { fixture.cleanup(); }
  });

  it('rejects a retained app package that omits its signed embedded TERM build identity', () => {
    const fixture = createFixture('ios-ghosttykit');
    try {
      const packageWithoutIdentity = storedZip('Payload/Happier.app/unrelated.txt', Buffer.from('not an identity'));
      fixture.rewriteArtifact('app-binary', packageWithoutIdentity);
      fixture.evidence.app.binarySha256 = sha(packageWithoutIdentity);
      expect(validate(fixture).issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'embedded-build-identity-unreadable' }),
      ]));
    } finally { fixture.cleanup(); }
  });

  it('rejects generic packaging pass labels without gate-specific measured output', () => {
    const fixture = createFixture('ios-ghosttykit');
    try {
      const gateArtifact = fixture.evidence.artifacts.find((artifact) => artifact.id === 'packaging-gate-repeatable-package-build')!;
      const gateReport = JSON.parse(readFileSync(join(fixture.root, gateArtifact.path), 'utf8'));
      gateReport.details = { command: 'validate:repeatable-package-build', outcome: 'passed' };
      fixture.rewriteArtifact(gateArtifact.id, gateReport);
      expect(validate(fixture).accepted).toBe(false);
      expect(validate(fixture).issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'packaging-gate-details-invalid' }),
      ]));
    } finally { fixture.cleanup(); }
  });

  it('rejects a bare iOS reproducible assertion without two retained build artifacts and inspections', () => {
    const fixture = createFixture('ios-ghosttykit');
    try {
      const gateArtifact = fixture.evidence.artifacts.find((artifact) => artifact.id === 'packaging-gate-repeatable-package-build')!;
      const gateReport = JSON.parse(readFileSync(join(fixture.root, gateArtifact.path), 'utf8'));
      gateReport.details = {
        firstBinarySha256: fixture.evidence.app.binarySha256,
        secondBinarySha256: fixture.evidence.app.binarySha256,
        reproducible: true,
      };
      fixture.rewriteArtifact(gateArtifact.id, gateReport);
      expect(validate(fixture).issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'packaging-gate-details-invalid' }),
      ]));
    } finally { fixture.cleanup(); }
  });

  it('accepts two inspected iOS builds with stable signed inputs while recording toolchain hash variance', () => {
    const fixture = createFixture('ios-ghosttykit', { iosRepeatHashesDiffer: true });
    try {
      const result = validate(fixture);
      expect(result, JSON.stringify(result.issues, null, 2)).toMatchObject({
        schemaValid: true,
        deviceAcceptanceReady: true,
        releaseApprovalReady: true,
        accepted: true,
      });
    } finally { fixture.cleanup(); }
  });

  it('rejects iOS repeatability evidence whose retained build log lacks Xcode success', () => {
    const fixture = createFixture('ios-ghosttykit', { iosSecondBuildSucceeded: false });
    try {
      expect(validate(fixture).issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'ios-repeatability-build-not-proven' }),
      ]));
    } finally { fixture.cleanup(); }
  });

  it('produces a canonical source-state inventory from a build root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'term-source-state-'));
    try {
      for (const file of ['app.json', 'package.json', 'yarn.lock', 'apps/ui/index.ts', 'packages/example/index.ts', 'scripts/example.mjs']) {
        mkdirSync(dirname(join(root, file)), { recursive: true });
        writeFileSync(join(root, file), file);
      }
      const output = join(root, '.project/logs/e2e/terminal-native/ios/run/source-state.json');
      expect(await runTerminalNativeSourceStateCli([root, output, COMMIT, 'true'])).toBe(0);
      const report = JSON.parse(readFileSync(output, 'utf8'));
      expect(report).toMatchObject({ schemaVersion: 1, kind: 'terminal-native-source-state', sourceCommit: COMMIT, sourceDirty: true });
      expect(report.inventory.map((entry: { path: string }) => entry.path)).toEqual([
        'app.json', 'apps/ui/index.ts', 'package.json', 'packages/example/index.ts', 'scripts/example.mjs', 'yarn.lock',
      ]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each(['ios-ghosttykit', 'android-termux'] as const)('accepts a fully bound %s run bundle', (renderer) => {
    const fixture = createFixture(renderer);
    try {
      const result = validate(fixture);
      expect(result, JSON.stringify(result.issues, null, 2)).toMatchObject({ schemaValid: true, deviceAcceptanceReady: true, releaseApprovalReady: true, accepted: true });
    }
    finally { fixture.cleanup(); }
  });

  it('rejects schema v1 explicitly', () => {
    expect(validateTerminalNativeDeviceEvidence({ schemaVersion: 1 })).toEqual(expect.objectContaining({ accepted: false }));
    expect(validateTerminalNativeDeviceEvidence({ schemaVersion: 1 }).issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'unsupported-schema-version' })]));
  });

  it.each([
    ['edited claim', (f: Fixture) => { f.evidence.actions[1]!.status = 'failed'; }],
    ['wrong app', (f: Fixture) => { f.evidence.app.applicationId = 'com.fabricated.app'; }],
    ['wrong app version', (f: Fixture) => { f.evidence.app.version = '99.99.99'; }],
    ['wrong app build', (f: Fixture) => { f.evidence.app.buildNumber = '999'; }],
    ['wrong app binary', (f: Fixture) => { f.evidence.app.binarySha256 = '9'.repeat(64); }],
    ['wrong source', (f: Fixture) => { f.evidence.app.sourceCommit = '1'.repeat(40); }],
    ['wrong dependency', (f: Fixture) => { f.evidence.renderer.dependencyRevision = 'wrong-revision'; }],
    ['wrong dependency checksum', (f: Fixture) => { f.evidence.renderer.dependencyChecksumSha256 = '8'.repeat(64); }],
    ['wrong build id', (f: Fixture) => { f.evidence.buildEvidenceId = 'other-build'; }],
    ['wrong run nonce', (f: Fixture) => { f.evidence.runNonce = 'other-run-nonce'; }],
  ])('rejects %s mutation without regenerated semantic proof', (_name, mutate) => {
    const fixture = createFixture('android-termux');
    try { mutate(fixture); expect(validate(fixture).accepted).toBe(false); }
    finally { fixture.cleanup(); }
  });

  it('rejects arbitrary text masquerading as a semantic report', () => {
    const fixture = createFixture('ios-ghosttykit');
    try { fixture.rewriteArtifact('runtime', 'not-json'); expect(validate(fixture).issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'invalid-semantic-artifact' })])); }
    finally { fixture.cleanup(); }
  });

  it('rejects arbitrary bytes masquerading as app and video containers', () => {
    const fixture = createFixture('ios-ghosttykit');
    try {
      fixture.rewriteArtifact('app-binary', 'not-an-app-archive');
      fixture.evidence.app.binarySha256 = fixture.evidence.artifacts.find((item) => item.id === 'app-binary')!.sha256;
      fixture.rewriteArtifact('screen-reader-video', 'not-a-video');
      expect(validate(fixture).issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'invalid-app-package' }),
        expect.objectContaining({ code: 'invalid-video-container' }),
      ]));
    } finally { fixture.cleanup(); }
  });

  it('rejects source inventory tampering and unsupported source schemas', () => {
    const fixture = createFixture('ios-ghosttykit');
    try {
      fixture.rewriteArtifact('source-state', { schemaVersion: 9, kind: 'terminal-native-source-state', sourceCommit: COMMIT, sourceDirty: true, inventory: [] });
      fixture.evidence.app.sourceStateSha256 = fixture.evidence.artifacts.find((item) => item.id === 'source-state')!.sha256;
      expect(validate(fixture).issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'invalid-source-state-report' })]));
    } finally { fixture.cleanup(); }
  });

  it.each((['ios-ghosttykit', 'android-termux'] as const).flatMap((renderer) =>
    TERMINAL_NATIVE_PACKAGING_GATES[renderer].map((gateId) => [renderer, gateId] as const)))('rejects missing %s packaging gate %s', (renderer, gateId) => {
    const fixture = createFixture(renderer);
    try {
      const artifact = fixture.evidence.artifacts.find((item) => item.id === 'packaging')!;
      const report = JSON.parse(readFileSync(join(fixture.root, artifact.path), 'utf8'));
      report.gates = report.gates.filter((gate: { id: string }) => gate.id !== gateId);
      fixture.rewriteArtifact('packaging', report);
      expect(validate(fixture).issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'packaging-gate-not-proven' })]));
    } finally { fixture.cleanup(); }
  });

  it.each((['ios-ghosttykit', 'android-termux'] as const).flatMap((renderer) =>
    TERMINAL_NATIVE_PACKAGING_GATES[renderer].map((gateId) => [renderer, gateId] as const)))('rejects contradictory %s packaging gate %s', (renderer, gateId) => {
    const fixture = createFixture(renderer);
    try {
      const gateArtifact = fixture.evidence.artifacts.find((artifact) => artifact.id === `packaging-gate-${gateId}`)!;
      const gateReport = JSON.parse(readFileSync(join(fixture.root, gateArtifact.path), 'utf8'));
      gateReport.details = {};
      fixture.rewriteArtifact(gateArtifact.id, gateReport);
      expect(validate(fixture).issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'packaging-gate-details-invalid' }),
      ]));
    } finally { fixture.cleanup(); }
  });

  it('rejects workload-to-action offset discontinuity and reordered actions', () => {
    const fixture = createFixture('ios-ghosttykit');
    try {
      fixture.evidence.actions[0]!.startByteOffset += 1;
      [fixture.evidence.actions[0], fixture.evidence.actions[1]] = [fixture.evidence.actions[1]!, fixture.evidence.actions[0]!];
      expect(validate(fixture).issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'action-offset-discontinuity' }),
        expect.objectContaining({ code: 'action-order-mismatch' }),
      ]));
    } finally { fixture.cleanup(); }
  });

  it('rejects crash continuity without matching before/after content markers', () => {
    const fixture = createFixture('ios-ghosttykit');
    try {
      const crash = fixture.evidence.actions.find((item) => item.id === 'renderer-crash-fallback')!;
      crash.details.contentMarkerAfterSha256 = 'd'.repeat(64);
      expect(validate(fixture).issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'content-marker-mismatch' })]));
    } finally { fixture.cleanup(); }
  });

  it('rejects stale and cross-run artifacts', () => {
    const fixture = createFixture('ios-ghosttykit');
    try {
      fixture.evidence.artifacts.find((item) => item.id === fixture.evidence.workloads[0]!.reportArtifactId)!.capturedAt = '2026-08-27T10:00:00.000Z';
      fixture.evidence.artifacts.find((item) => item.id === 'device-log')!.path = '.project/logs/e2e/terminal-native/ios/another-run/device-log.bin';
      expect(validate(fixture).issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'stale-observation-artifact' }),
        expect.objectContaining({ code: 'artifact-run-path-mismatch' }),
      ]));
    } finally { fixture.cleanup(); }
  });

  it('rejects one semantic report reused for another observation', () => {
    const fixture = createFixture('ios-ghosttykit');
    try {
      fixture.evidence.workloads[1]!.reportArtifactId = fixture.evidence.workloads[0]!.reportArtifactId;
      expect(validate(fixture).issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'observation-report-mismatch' })]));
    } finally { fixture.cleanup(); }
  });

  it.each([
    ['missing baseline', (report: any) => { report.benchmark.samples = report.benchmark.samples.filter((sample: any) => sample.renderer !== 'xterm-webview'); }],
    ['parser-only candidate', (report: any) => { report.benchmark.samples.filter((sample: any) => sample.renderer === 'android-termux').forEach((sample: any) => { sample.timingBoundary = 'parser-write-complete'; }); }],
    ['cross-device sample', (report: any) => { report.benchmark.samples[0].environment.targetId = 'another-device'; }],
    ['insufficient samples', (report: any) => { report.benchmark.samples = report.benchmark.samples.filter((sample: any, index: number) => sample.workloadId !== 'ansi-burst' || index < 4); }],
    ['material performance regression', (report: any) => { report.benchmark.samples.filter((sample: any) => sample.renderer === 'android-termux').forEach((sample: any) => { sample.durationMs = 200; sample.throughputMiBps = (sample.decodedBytes / (1024 * 1024)) / 0.2; }); }],
  ])('rejects renderer benchmark evidence with %s', (_name, mutate) => {
    const fixture = createFixture('android-termux');
    try {
      const artifact = fixture.evidence.artifacts.find((item) => item.id === 'renderer-comparison')!;
      const report = JSON.parse(readFileSync(join(fixture.root, artifact.path), 'utf8'));
      mutate(report);
      fixture.rewriteArtifact('renderer-comparison', report);
      expect(validate(fixture).accepted).toBe(false);
      expect(validate(fixture).issues.some((item) => item.code.startsWith('renderer-benchmark')
        || item.code === 'invalid-renderer-benchmark-report')).toBe(true);
    } finally { fixture.cleanup(); }
  });

  it('rejects forged, untrusted, and wrong-closure approval records', () => {
    const fixture = createFixture('android-termux');
    try {
      const artifact = fixture.evidence.artifacts.find((item) => item.id === 'release-approval')!;
      const report = JSON.parse(readFileSync(join(fixture.root, artifact.path), 'utf8'));
      report.signature = Buffer.from('forged').toString('base64');
      fixture.rewriteArtifact('release-approval', report);
      expect(validate(fixture).issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'invalid-approval-signature' })]));
      fixture.evidence.externalApproval.authority = 'invented-authority';
      fixture.evidence.externalApproval.exactDependencyClosureSha256 = 'e'.repeat(64);
      expect(validate(fixture).issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'untrusted-approval-authority' }),
        expect.objectContaining({ code: 'approval-closure-mismatch' }),
      ]));
    } finally { fixture.cleanup(); }
  });

  it('rejects an approval issued for another dependency revision', () => {
    const fixture = createFixture('android-termux');
    try {
      const artifact = fixture.evidence.artifacts.find((item) => item.id === 'release-approval')!;
      const report = JSON.parse(readFileSync(join(fixture.root, artifact.path), 'utf8'));
      report.dependencyRevision = 'another-termux-revision';
      fixture.rewriteArtifact('release-approval', report);
      expect(validate(fixture).issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'approval-record-mismatch' })]));
    } finally { fixture.cleanup(); }
  });

  it('keeps unsigned pending Android approval usable only in device-acceptance mode', () => {
    const fixture = createFixture('android-termux');
    try {
      fixture.evidence.externalApproval.status = 'pending';
      fixture.evidence.externalApproval.authority = null;
      fixture.evidence.externalApproval.approvalArtifactId = null;
      const result = validate(fixture);
      expect(result).toMatchObject({ schemaValid: true, deviceAcceptanceReady: true, releaseApprovalReady: false, accepted: false });
      expect(terminalNativeDeviceEvidenceCliExitCode(result, true)).toBe(0);
      expect(terminalNativeDeviceEvidenceCliExitCode(result, false)).toBe(1);
    } finally { fixture.cleanup(); }
  });

  it('rejects checksum tampering and symlink escape', () => {
    const fixture = createFixture('ios-ghosttykit');
    const outside = `${fixture.root}-outside`;
    try {
      const binary = fixture.evidence.artifacts.find((item) => item.id === 'app-binary')!;
      writeFileSync(join(fixture.root, binary.path), 'tampered');
      expect(validate(fixture).issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'artifact-checksum-mismatch' })]));
      rmSync(join(fixture.root, binary.path));
      writeFileSync(outside, 'outside');
      symlinkSync(outside, join(fixture.root, binary.path));
      expect(validate(fixture).issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'artifact-outside-repository' })]));
    } finally { fixture.cleanup(); rmSync(outside, { force: true }); }
  });
});
