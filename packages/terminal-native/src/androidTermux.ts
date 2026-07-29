import {
  createUnavailableTerminalNativeAvailability,
  isTerminalNativeFallbackRequired,
} from './availability';

import type {
  TerminalNativeAvailability,
  TerminalNativeUnavailableReason,
} from './HappierTerminalNative.types';

export type AndroidTermuxModule = Readonly<{
  name: 'terminal-view' | 'terminal-emulator';
  path: string;
  license: 'Apache-2.0';
}>;

export type AndroidTermuxForbiddenModule = Readonly<{
  name: 'app' | 'termux-shared';
  reason: string;
}>;

export type AndroidTermuxGateInputs = Readonly<{
  dependencyClosureApproved: boolean;
  legalAccepted: boolean;
  artifactsLinked: boolean;
  gradleBuildProven: boolean;
  abiSmokePassed: boolean;
  crashFallbackProven: boolean;
  nativeAccessibilityProven: boolean;
  moduleVersion: string;
}>;

export type AndroidTermuxDiagnosticBlocker = Readonly<{
  reason: TerminalNativeUnavailableReason;
  detail: string;
}>;

export type AndroidTermuxSourceStrategy = Readonly<{
  kind: 'ignored-source-extract';
  vendorRoot: 'android/termux/vendor';
  metadataFile: 'android/termux/vendor/TERMUX-SOURCE.json';
  fetchScript: 'scripts/fetchTermuxAndroid.mjs';
  gradleConsumesWhenPresent: true;
}>;

export type AndroidTermuxRendererDiagnostic = Readonly<{
  availability: TerminalNativeAvailability;
  renderer: 'android-termux';
  fallbackRenderer: 'xterm-webview';
  fallbackRequired: boolean;
  remoteSessionAdapterRequired: true;
  requiredModules: readonly AndroidTermuxModule[];
  forbiddenModules: readonly AndroidTermuxForbiddenModule[];
  blockers: readonly AndroidTermuxDiagnosticBlocker[];
}>;

export const ANDROID_TERMUX_REQUIRED_MODULES: readonly AndroidTermuxModule[] = [
  {
    name: 'terminal-view',
    path: 'terminal-view',
    license: 'Apache-2.0',
  },
  {
    name: 'terminal-emulator',
    path: 'terminal-emulator',
    license: 'Apache-2.0',
  },
];

export const ANDROID_TERMUX_FORBIDDEN_MODULES: readonly AndroidTermuxForbiddenModule[] = [
  {
    name: 'app',
    reason: 'The full Termux app is GPL-3.0-only and is out of scope for the native renderer package.',
  },
  {
    name: 'termux-shared',
    reason: 'TERM-6 only approves terminal-view and terminal-emulator until dependency closure review says otherwise.',
  },
];

export const ANDROID_TERMUX_SOURCE_STRATEGY: AndroidTermuxSourceStrategy = {
  kind: 'ignored-source-extract',
  vendorRoot: 'android/termux/vendor',
  metadataFile: 'android/termux/vendor/TERMUX-SOURCE.json',
  fetchScript: 'scripts/fetchTermuxAndroid.mjs',
  gradleConsumesWhenPresent: true,
};

const DEFAULT_ANDROID_TERMUX_GATE_INPUTS: AndroidTermuxGateInputs = {
  dependencyClosureApproved: false,
  legalAccepted: false,
  artifactsLinked: false,
  gradleBuildProven: false,
  abiSmokePassed: false,
  crashFallbackProven: false,
  nativeAccessibilityProven: false,
  moduleVersion: '0.0.0',
};

export function createAndroidTermuxRendererDiagnostic(
  inputs: Partial<AndroidTermuxGateInputs> = {},
): AndroidTermuxRendererDiagnostic {
  const gates: AndroidTermuxGateInputs = {
    ...DEFAULT_ANDROID_TERMUX_GATE_INPUTS,
    ...inputs,
  };
  const blockers = collectAndroidTermuxBlockers(gates);
  const availability: TerminalNativeAvailability = blockers.length > 0
    ? createUnavailableTerminalNativeAvailability(blockers[0].reason, blockers[0].detail)
    : {
      available: true,
      platform: 'android',
      renderer: 'android-termux',
      moduleVersion: gates.moduleVersion,
      accessibility: gates.nativeAccessibilityProven ? 'native' : 'fallback-required',
    };

  return {
    availability,
    renderer: 'android-termux',
    fallbackRenderer: 'xterm-webview',
    fallbackRequired: isTerminalNativeFallbackRequired(availability),
    remoteSessionAdapterRequired: true,
    requiredModules: ANDROID_TERMUX_REQUIRED_MODULES,
    forbiddenModules: ANDROID_TERMUX_FORBIDDEN_MODULES,
    blockers,
  };
}

function collectAndroidTermuxBlockers(
  gates: AndroidTermuxGateInputs,
): AndroidTermuxDiagnosticBlocker[] {
  const blockers: AndroidTermuxDiagnosticBlocker[] = [];
  if (!gates.artifactsLinked) {
    blockers.push({
      reason: 'artifact-missing',
      detail: 'Termux terminal-view/terminal-emulator source is not present in android/termux/vendor.',
    });
  }
  if (!gates.dependencyClosureApproved) {
    blockers.push({
      reason: 'dependency-closure-unapproved',
      detail: 'The selected Termux dependency closure has not been approved.',
    });
  }
  if (!gates.legalAccepted) {
    blockers.push({
      reason: 'legal-not-approved',
      detail: 'Android Termux legal/product approval has not passed.',
    });
  }
  if (!gates.gradleBuildProven) {
    blockers.push({
      reason: 'renderer-unavailable',
      detail: 'Repeatable Gradle/AAR packaging proof has not passed.',
    });
  }
  if (!gates.abiSmokePassed) {
    blockers.push({
      reason: 'abi-unsupported',
      detail: 'Android Termux ABI smoke has not passed for the supported ABI matrix.',
    });
  }
  if (!gates.crashFallbackProven) {
    blockers.push({
      reason: 'renderer-unavailable',
      detail: 'Native renderer crash-to-WebView fallback proof has not passed.',
    });
  }
  return blockers;
}
