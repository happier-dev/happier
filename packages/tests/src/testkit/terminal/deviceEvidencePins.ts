import { terminalEvidenceSha256 } from './deviceEvidenceCanonical';
import type { TerminalNativeDeviceRenderer } from './native';

type JsonObject = Record<string, unknown>;

export type TerminalNativeDependencyPin = Readonly<{
  rendererId: TerminalNativeDeviceRenderer;
  dependencyName: string;
  dependencyRevision: string;
  dependencyChecksumSha256: string;
  dependencyClosureSha256: string;
  closure: Readonly<Record<string, unknown>>;
}>;

function object(value: unknown, path: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as JsonObject;
}

function string(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${path} must be a non-empty string`);
  return value;
}

export function terminalNativeDependencyPinFromPolicy(
  policyValue: unknown,
  rendererId: TerminalNativeDeviceRenderer,
): TerminalNativeDependencyPin {
  const policy = object(policyValue, 'native-renderers.json');
  if (rendererId === 'ios-ghosttykit') {
    const ios = object(policy.iosGhostty, 'iosGhostty');
    const artifact = object(ios.artifact, 'iosGhostty.artifact');
    const upstream = object(ios.upstream, 'iosGhostty.upstream');
    const closure = {
      integration: string(ios.integration, 'iosGhostty.integration'),
      source: string(artifact.source, 'iosGhostty.artifact.source'),
      upstreamRelease: string(artifact.upstreamRelease, 'iosGhostty.artifact.upstreamRelease'),
      upstreamCommit: string(upstream.observedCommit, 'iosGhostty.upstream.observedCommit'),
      upstreamZipSha256: string(artifact.upstreamZipSha256, 'iosGhostty.artifact.upstreamZipSha256'),
      expandedSha256: string(artifact.expandedSha256, 'iosGhostty.artifact.expandedSha256'),
      requiredSlices: artifact.requiredSlices,
      wuffsIsolation: object(artifact.linkCompatibility, 'iosGhostty.artifact.linkCompatibility'),
    };
    return {
      rendererId,
      dependencyName: 'libghostty-spm',
      dependencyRevision: closure.upstreamCommit,
      dependencyChecksumSha256: closure.expandedSha256,
      dependencyClosureSha256: terminalEvidenceSha256(closure),
      closure,
    };
  }

  const android = object(policy.androidTermux, 'androidTermux');
  const upstream = object(android.upstream, 'androidTermux.upstream');
  const sourceArchive = object(upstream.sourceArchive, 'androidTermux.upstream.sourceArchive');
  const closure = {
    integration: string(android.integration, 'androidTermux.integration'),
    upstreamName: string(upstream.name, 'androidTermux.upstream.name'),
    upstreamCommit: string(upstream.observedCommit, 'androidTermux.upstream.observedCommit'),
    sourceArchiveSha256: string(sourceArchive.sha256, 'androidTermux.upstream.sourceArchive.sha256'),
    modules: upstream.modules,
    forbiddenModules: android.forbiddenModules,
    sourceStrategy: android.sourceStrategy,
  };
  return {
    rendererId,
    dependencyName: 'termux-app-terminal-libraries',
    dependencyRevision: closure.upstreamCommit,
    dependencyChecksumSha256: closure.sourceArchiveSha256,
    dependencyClosureSha256: terminalEvidenceSha256(closure),
    closure,
  };
}

export const TERMINAL_NATIVE_PACKAGING_GATES = {
  'ios-ghosttykit': [
    'platform-package-inspection', 'repeatable-package-build', 'checksum-pinned-artifact', 'license-notice',
    'binary-size-budget', 'abi-smoke-test', 'wuffs-isolation', 'app-link',
    'store-export-review', 'crash-fallback-build-capability',
  ],
  'android-termux': [
    'platform-package-inspection', 'repeatable-package-build', 'dependency-closure', 'license-notice',
    'forbidden-module-absence', 'gradle-build', 'binary-size-budget',
    'abi-smoke-test', 'crash-fallback-build-capability',
  ],
} as const satisfies Record<TerminalNativeDeviceRenderer, readonly string[]>;

export type TerminalNativePackagingGateId =
  typeof TERMINAL_NATIVE_PACKAGING_GATES[TerminalNativeDeviceRenderer][number];

export const TERMINAL_NATIVE_PACKAGING_GATE_TOOLS: Readonly<Record<TerminalNativePackagingGateId, string>> = {
  'platform-package-inspection': 'terminal-native:platform-package-inspection',
  'repeatable-package-build': 'terminal-native:repeatable-package-build',
  'checksum-pinned-artifact': 'terminal-native:checksum',
  'license-notice': 'terminal-native:license-notice',
  'binary-size-budget': 'terminal-native:size-budget',
  'abi-smoke-test': 'terminal-native:abi-smoke',
  'wuffs-isolation': 'terminal-native:ios-wuffs-isolation',
  'app-link': 'terminal-native:ios-app-link',
  'store-export-review': 'terminal-native:ios-store-export-review',
  'crash-fallback-build-capability': 'terminal-native:crash-fallback-capability',
  'dependency-closure': 'terminal-native:android-dependency-closure',
  'forbidden-module-absence': 'terminal-native:android-forbidden-modules',
  'gradle-build': 'terminal-native:android-gradle-build',
};

const isObject = (value: unknown): value is JsonObject => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isSha256 = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string' && item.length > 0);

export function validateTerminalNativePackagingGateDetails(input: Readonly<{
  rendererId: TerminalNativeDeviceRenderer;
  gateId: TerminalNativePackagingGateId;
  tool: unknown;
  details: unknown;
  binarySha256: string;
  sourceStateSha256: string;
  dependencyPin: TerminalNativeDependencyPin;
}>): readonly string[] {
  const errors: string[] = [];
  const expectedTool = TERMINAL_NATIVE_PACKAGING_GATE_TOOLS[input.gateId];
  if (input.tool !== expectedTool) errors.push(`tool must equal ${expectedTool}`);
  if (!isObject(input.details)) return [...errors, 'details must be an object'];
  const details = input.details;
  const exactKeys = (keys: readonly string[]) => {
    const actual = Object.keys(details).sort();
    const expected = [...keys].sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
      errors.push(`details keys must equal ${expected.join(',')}`);
    }
  };
  const binary = (key: string) => {
    if (details[key] !== input.binarySha256) errors.push(`${key} must bind the retained binary`);
  };
  const closure = (key: string) => {
    if (details[key] !== input.dependencyPin.dependencyClosureSha256) errors.push(`${key} must bind the dependency closure`);
  };

  switch (input.gateId) {
    case 'platform-package-inspection': {
      const commonKeys = [
        'binarySha256', 'format', 'applicationId', 'version', 'buildNumber', 'architectures',
        'metadataSha256', 'signatureVerified', 'signatureSchemes', 'signerCertificateSha256', 'inspector',
      ];
      exactKeys(input.rendererId === 'ios-ghosttykit'
        ? [...commonKeys, 'executable', 'codeSignaturePresent', 'provisioningProfilePresent', 'signingMode', 'teamIdentifier']
        : [...commonKeys, 'dexFileCount', 'nativeLibraryCount', 'resourcesPresent']);
      binary('binarySha256');
      if (details.format !== (input.rendererId === 'ios-ghosttykit' ? 'ios-simulator-app-archive' : 'android-apk')
        && !(input.rendererId === 'ios-ghosttykit' && details.format === 'ios-ipa')) errors.push('format must name the inspected platform package');
      for (const key of ['applicationId', 'version', 'buildNumber', 'metadataSha256', 'inspector']) {
        if (typeof details[key] !== 'string' || String(details[key]).trim().length === 0) errors.push(`${key} must be non-empty`);
      }
      if (!isSha256(details.metadataSha256)) errors.push('metadataSha256 must be a SHA-256');
      if (!isStringArray(details.architectures) || details.architectures.length === 0) errors.push('architectures must be non-empty');
      if (!isStringArray(details.signatureSchemes)) errors.push('signatureSchemes must be an array of non-empty strings');
      if (!Array.isArray(details.signerCertificateSha256) || !details.signerCertificateSha256.every(isSha256)) {
        errors.push('signerCertificateSha256 must contain SHA-256 certificate digests');
      }
      if (input.rendererId === 'ios-ghosttykit') {
        if (typeof details.executable !== 'string' || details.executable.trim().length === 0) errors.push('executable must be non-empty');
        if (typeof details.codeSignaturePresent !== 'boolean') errors.push('codeSignaturePresent must be boolean');
        if (typeof details.provisioningProfilePresent !== 'boolean') errors.push('provisioningProfilePresent must be boolean');
        if (!['simulator-unsigned', 'simulator-adhoc', 'device-development', 'device-distribution', 'app-store-export'].includes(String(details.signingMode))) {
          errors.push('signingMode must name an accepted iOS signing mode');
        }
        if (details.signingMode === 'simulator-unsigned') {
          if (details.signatureVerified !== false || details.codeSignaturePresent !== false
            || (details.signatureSchemes as unknown[]).length !== 0 || details.teamIdentifier !== null
            || (details.signerCertificateSha256 as unknown[]).length !== 0) {
            errors.push('unsigned simulator package must not claim signature verification, schemes, team, or certificate');
          }
        } else if (details.signingMode === 'simulator-adhoc') {
          if (details.signatureVerified !== true || details.codeSignaturePresent !== true
            || !(details.signatureSchemes as unknown[]).includes('adhoc')
            || details.teamIdentifier !== null || (details.signerCertificateSha256 as unknown[]).length !== 0) {
            errors.push('simulator adhoc signing must be verified without a team or certificate');
          }
        } else if (details.signatureVerified !== true || details.codeSignaturePresent !== true
          || typeof details.teamIdentifier !== 'string' || details.teamIdentifier.trim().length === 0
          || (details.signerCertificateSha256 as unknown[]).length < 1 || details.provisioningProfilePresent !== true) {
          errors.push('device/export signing must bind team, certificate, and provisioning profile');
        }
      } else {
        if (details.signatureVerified !== true) errors.push('Android APK signatureVerified must be true');
        if (!Number.isInteger(details.dexFileCount) || (details.dexFileCount as number) < 1) errors.push('dexFileCount must be positive');
        if (!Number.isInteger(details.nativeLibraryCount) || (details.nativeLibraryCount as number) < 1) errors.push('nativeLibraryCount must be positive');
        if (details.resourcesPresent !== true) errors.push('resourcesPresent must be true');
        if (!Array.isArray(details.signatureSchemes)
          || !(details.signatureSchemes as string[]).some((scheme) => ['v2', 'v3', 'v3.1'].includes(scheme))) {
          errors.push('Android APK must verify a v2/v3 signing scheme');
        }
        if (!Array.isArray(details.signerCertificateSha256)
          || (details.signerCertificateSha256 as unknown[]).length < 1) errors.push('Android APK must bind a signer certificate digest');
      }
      break;
    }
    case 'repeatable-package-build':
      exactKeys(['firstBinarySha256', 'secondBinarySha256', 'reproducible']);
      binary('firstBinarySha256'); binary('secondBinarySha256');
      if (details.reproducible !== true) errors.push('reproducible must be true');
      break;
    case 'checksum-pinned-artifact':
      exactKeys(['expectedDependencyChecksumSha256', 'observedDependencyChecksumSha256', 'dependencyClosureSha256']);
      if (details.expectedDependencyChecksumSha256 !== input.dependencyPin.dependencyChecksumSha256
        || details.observedDependencyChecksumSha256 !== input.dependencyPin.dependencyChecksumSha256) {
        errors.push('expected and observed dependency checksums must equal the canonical pin');
      }
      closure('dependencyClosureSha256');
      break;
    case 'license-notice': {
      exactKeys(['licenseExpression', 'noticeSha256', 'noticeIncludesDependencyRevision']);
      const expectedLicense = input.rendererId === 'ios-ghosttykit' ? 'MIT' : 'Apache-2.0';
      if (details.licenseExpression !== expectedLicense) errors.push(`licenseExpression must equal ${expectedLicense}`);
      if (!isSha256(details.noticeSha256)) errors.push('noticeSha256 must be a SHA-256');
      if (details.noticeIncludesDependencyRevision !== true) errors.push('noticeIncludesDependencyRevision must be true');
      break;
    }
    case 'binary-size-budget':
      exactKeys(['binarySha256', 'measuredBytes', 'budgetBytes', 'withinBudget']);
      binary('binarySha256');
      if (!Number.isInteger(details.measuredBytes) || (details.measuredBytes as number) < 1) errors.push('measuredBytes must be positive');
      if (!Number.isInteger(details.budgetBytes) || (details.budgetBytes as number) < (details.measuredBytes as number)) errors.push('budgetBytes must cover measuredBytes');
      if (details.withinBudget !== true) errors.push('withinBudget must be true');
      break;
    case 'abi-smoke-test':
      exactKeys(['binarySha256', 'architectures', 'requiredSymbols', 'missingSymbols']);
      binary('binarySha256');
      if (!isStringArray(details.architectures) || details.architectures.length === 0) errors.push('architectures must be non-empty');
      if (!isStringArray(details.requiredSymbols) || details.requiredSymbols.length === 0) errors.push('requiredSymbols must be non-empty');
      if (!Array.isArray(details.missingSymbols) || details.missingSymbols.length !== 0) errors.push('missingSymbols must be empty');
      break;
    case 'wuffs-isolation':
      exactKeys(['binarySha256', 'overlappingGlobalSymbolCount', 'ghosttyPublicAbiPreserved']);
      binary('binarySha256');
      if (details.overlappingGlobalSymbolCount !== 0) errors.push('overlappingGlobalSymbolCount must be zero');
      if (details.ghosttyPublicAbiPreserved !== true) errors.push('ghosttyPublicAbiPreserved must be true');
      break;
    case 'app-link':
      exactKeys(['binarySha256', 'duplicateSymbolWarnings', 'requiredNativeModuleSymbolsPresent']);
      binary('binarySha256');
      if (details.duplicateSymbolWarnings !== 0) errors.push('duplicateSymbolWarnings must be zero');
      if (details.requiredNativeModuleSymbolsPresent !== true) errors.push('requiredNativeModuleSymbolsPresent must be true');
      break;
    case 'store-export-review':
      exactKeys(['reviewStatus', 'appStoreExportSucceeded', 'reviewer']);
      if (details.reviewStatus !== 'approved') errors.push('reviewStatus must equal approved');
      if (details.appStoreExportSucceeded !== true) errors.push('appStoreExportSucceeded must be true');
      if (typeof details.reviewer !== 'string' || details.reviewer.trim().length === 0) errors.push('reviewer must be non-empty');
      break;
    case 'crash-fallback-build-capability':
      exactKeys(['internalOnly', 'fallbackRenderer', 'capabilitySymbolPresent']);
      if (details.internalOnly !== true) errors.push('internalOnly must be true');
      if (details.fallbackRenderer !== 'xterm-webview') errors.push('fallbackRenderer must equal xterm-webview');
      if (details.capabilitySymbolPresent !== true) errors.push('capabilitySymbolPresent must be true');
      break;
    case 'dependency-closure':
      exactKeys(['dependencyClosureSha256', 'includedModules', 'forbiddenModulesFound']);
      closure('dependencyClosureSha256');
      const includedModules = details.includedModules;
      if (!isStringArray(includedModules)
        || !['terminal-emulator', 'terminal-view'].every((module) => includedModules.includes(module))) {
        errors.push('includedModules must contain terminal-emulator and terminal-view');
      }
      if (!Array.isArray(details.forbiddenModulesFound) || details.forbiddenModulesFound.length !== 0) errors.push('forbiddenModulesFound must be empty');
      break;
    case 'forbidden-module-absence':
      exactKeys(['dependencyClosureSha256', 'forbiddenModulesFound']);
      closure('dependencyClosureSha256');
      if (!Array.isArray(details.forbiddenModulesFound) || details.forbiddenModulesFound.length !== 0) errors.push('forbiddenModulesFound must be empty');
      break;
    case 'gradle-build':
      exactKeys(['binarySha256', 'task', 'exitCode']);
      binary('binarySha256');
      if (typeof details.task !== 'string' || details.task.trim().length === 0) errors.push('task must be non-empty');
      if (details.exitCode !== 0) errors.push('exitCode must be zero');
      break;
  }
  return errors;
}
