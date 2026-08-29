import { readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateTermuxAndroidSource } from './termuxAndroidSource.mjs';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const rendererPolicy = JSON.parse(await readFile(join(packageRoot, 'native-renderers.json'), 'utf-8'));
const termuxPolicy = rendererPolicy.androidTermux;
const vendorRoot = process.env.HAPPIER_TERMINAL_NATIVE_TERMUX_VENDOR
  ?? join(packageRoot, termuxPolicy.sourceStrategy.vendorRoot);

const source = await inspectSource();
const gates = readAndroidTermuxGates();
const blockers = collectBlockers({ source, gates });
const available = blockers.length === 0;
const accessibility = gates.nativeAccessibilityProven ? 'native' : 'fallback-required';
const reason = available ? 'available' : blockers[0].reason;
const detail = available
  ? 'Android Termux source and hard package gates passed.'
  : blockers[0].detail;

process.stdout.write(`${JSON.stringify({
  status: available ? 'ok' : 'blocked',
  platform: 'android',
  renderer: termuxPolicy.renderer,
  reason,
  fallbackRenderer: 'xterm-webview',
  fallbackRequired: !available || accessibility !== 'native',
  availability: available
    ? {
      available: true,
      platform: 'android',
      renderer: termuxPolicy.renderer,
      moduleVersion: '0.0.0',
      accessibility,
    }
    : {
      available: false,
      reason,
      detail,
    },
  source,
  gates,
  blockers,
  requiredModules: termuxPolicy.upstream.modules,
  forbiddenModules: termuxPolicy.forbiddenModules,
  remoteSessionAdapter: termuxPolicy.remoteSessionAdapter,
  interaction: termuxPolicy.interactionModel,
  gradle: {
    status: source.status === 'ok' ? 'source-present' : 'source-missing',
    detail: source.status === 'ok'
      ? 'Gradle will compile the ignored Termux terminal source closure from android/termux/vendor.'
      : 'Termux terminal-view/terminal-emulator source is not present for Gradle consumption.',
  },
  abi: {
    status: 'unverified',
    requiredSmoke: ['arm64-v8a', 'x86_64'],
  },
  requiredGates: termuxPolicy.gates,
  license: termuxPolicy.license,
  remediation: available
    ? [
      accessibility === 'native'
        ? 'Android Termux native renderer gates passed for default native accessibility selection.'
        : 'Use terminalRendererPreference=native to opt into Android native while the custom accessibility model is still fallback-required.',
      'Keep xterm WebView available as the crash fallback.',
    ]
    : source.status === 'ok'
      ? [
        'Run the Android Kotlin compile and device smoke with the ignored Termux source present.',
        'Keep xterm WebView selected until source, package, ABI, crash fallback, and accessibility gates pass.',
      ]
    : [
      'Set HAPPIER_TERMINAL_NATIVE_TERMUX_SOURCE_ROOT to a locally audited Termux checkout, then run scripts/fetchTermuxAndroid.mjs to extract only terminal-view and terminal-emulator into android/termux/vendor.',
      'Keep xterm WebView selected until source, package, crash fallback, and accessibility gates pass.',
    ],
})}\n`);

async function inspectSource() {
  if (!await exists(vendorRoot)) {
    return {
      strategy: termuxPolicy.sourceStrategy,
      status: 'missing',
      reason: 'artifact-missing',
      detail: 'Termux terminal-view/terminal-emulator source is not present in android/termux/vendor.',
    };
  }

  const validation = await validateTermuxAndroidSource({ sourceRoot: vendorRoot });
  if (validation.status !== 'ok') {
    return {
      strategy: termuxPolicy.sourceStrategy,
      status: 'blocked',
      reason: validation.reason,
      detail: 'The Termux Android vendor source closure does not match the approved terminal-only policy.',
      validation,
    };
  }

  return {
    strategy: termuxPolicy.sourceStrategy,
    status: 'ok',
    metadata: validation.metadata,
    modules: validation.modules,
    forbiddenPresent: validation.forbiddenPresent,
    forbiddenReferences: validation.forbiddenReferences,
  };
}

function readAndroidTermuxGates() {
  return {
    dependencyClosureApproved: readBooleanEnv('HAPPIER_TERMINAL_NATIVE_ANDROID_DEPENDENCY_CLOSURE_APPROVED'),
    gradleBuildProven: readBooleanEnv('HAPPIER_TERMINAL_NATIVE_ANDROID_GRADLE_BUILD_PROVEN'),
    abiSmokePassed: readBooleanEnv('HAPPIER_TERMINAL_NATIVE_ANDROID_ABI_SMOKE_PASSED'),
    crashFallbackProven: readBooleanEnv('HAPPIER_TERMINAL_NATIVE_ANDROID_CRASH_FALLBACK_PROVEN'),
    nativeAccessibilityProven: readBooleanEnv('HAPPIER_TERMINAL_NATIVE_ANDROID_ACCESSIBILITY_NATIVE'),
  };
}

function collectBlockers({ source, gates }) {
  const blockers = [];
  if (source.status !== 'ok') {
    blockers.push({
      reason: source.reason,
      detail: source.detail,
    });
  }
  if (!gates.dependencyClosureApproved) {
    blockers.push({
      reason: 'dependency-closure-unapproved',
      detail: 'The selected Termux dependency closure has not been approved.',
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

function readBooleanEnv(name) {
  const value = process.env[name]?.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
