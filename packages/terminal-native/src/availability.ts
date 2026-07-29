import { getOptionalHappierTerminalNativeModule } from './HappierTerminalNative';

import type {
  TerminalNativeAccessibility,
  TerminalNativeAvailability,
  TerminalNativeModule,
  TerminalNativePlatform,
  TerminalNativeRenderer,
  TerminalNativeRuntimePlatform,
  TerminalNativeUnavailableReason,
} from './HappierTerminalNative.types';

export type TerminalNativeAvailabilityOptions = Readonly<{
  nativeModule?: TerminalNativeModule | null;
  platform?: TerminalNativeRuntimePlatform;
  buildIncluded?: boolean;
  featureEnabled?: boolean;
  accessibilityAccepted?: boolean;
}>;

export type TerminalNativeAvailabilityDiagnostic = Readonly<{
  availability: TerminalNativeAvailability;
  fallbackRenderer: 'xterm-webview';
  fallbackRequired: boolean;
  blockers: ReadonlyArray<Readonly<{
    reason: TerminalNativeUnavailableReason;
    detail?: string;
  }>>;
}>;

const RENDERERS = new Set<TerminalNativeRenderer>(['ios-ghosttykit', 'android-termux']);
const ACCESSIBILITY_STATES = new Set<TerminalNativeAccessibility>(['native', 'fallback-required']);

export function createUnavailableTerminalNativeAvailability(
  reason: TerminalNativeUnavailableReason,
  detail?: string,
): TerminalNativeAvailability {
  return detail ? { available: false, reason, detail } : { available: false, reason };
}

export function normalizeTerminalNativeAvailability(value: unknown): TerminalNativeAvailability {
  if (!value || typeof value !== 'object') {
    return createUnavailableTerminalNativeAvailability(
      'renderer-unavailable',
      'HappierTerminalNative returned an invalid availability payload.',
    );
  }

  const payload = value as Partial<TerminalNativeAvailability>;
  if (payload.available === true) {
    const platform = payload.platform;
    const renderer = payload.renderer;
    const moduleVersion = payload.moduleVersion;
    const accessibility = payload.accessibility;
    if (
      (platform === 'ios' || platform === 'android') &&
      RENDERERS.has(renderer as TerminalNativeRenderer) &&
      rendererMatchesPlatform(platform, renderer as TerminalNativeRenderer) &&
      typeof moduleVersion === 'string' &&
      moduleVersion.length > 0 &&
      ACCESSIBILITY_STATES.has(accessibility as TerminalNativeAccessibility)
    ) {
      return {
        available: true,
        platform,
        renderer: renderer as TerminalNativeRenderer,
        moduleVersion,
        accessibility: accessibility as TerminalNativeAccessibility,
      };
    }
    return createUnavailableTerminalNativeAvailability(
      'renderer-unavailable',
      'HappierTerminalNative returned an invalid availability payload.',
    );
  }

  if (payload.available === false && isTerminalNativeUnavailableReason(payload.reason)) {
    return typeof payload.detail === 'string'
      ? createUnavailableTerminalNativeAvailability(payload.reason, payload.detail)
      : createUnavailableTerminalNativeAvailability(payload.reason);
  }

  return createUnavailableTerminalNativeAvailability(
    'renderer-unavailable',
    'HappierTerminalNative returned an invalid availability payload.',
  );
}

export function getTerminalNativeAvailability(
  options: TerminalNativeAvailabilityOptions = {},
): TerminalNativeAvailability {
  if (options.buildIncluded === false) {
    return createUnavailableTerminalNativeAvailability(
      'build-not-included',
      'Native terminal renderers were excluded at build time.',
    );
  }

  if (options.featureEnabled === false) {
    return createUnavailableTerminalNativeAvailability(
      'feature-disabled',
      'Native terminal renderer features are disabled.',
    );
  }

  const platform = options.platform ?? 'unknown';
  if (!isTerminalNativePlatform(platform)) {
    return createUnavailableTerminalNativeAvailability(
      'unsupported-platform',
      'Native terminal renderers are only available on iOS and Android native builds.',
    );
  }

  const nativeModule = options.nativeModule === undefined
    ? getOptionalHappierTerminalNativeModule()
    : options.nativeModule;

  if (nativeModule) {
    let normalized: TerminalNativeAvailability;
    try {
      normalized = normalizeTerminalNativeAvailability(nativeModule.getAvailability());
    } catch {
      return createUnavailableTerminalNativeAvailability(
        'renderer-unavailable',
        'HappierTerminalNative availability check failed.',
      );
    }

    if (normalized.available && normalized.platform !== platform) {
      return createUnavailableTerminalNativeAvailability(
        'renderer-unavailable',
        'HappierTerminalNative returned renderer availability for a different platform.',
      );
    }

    if (
      normalized.available &&
      normalized.accessibility !== 'native' &&
      options.accessibilityAccepted !== true
    ) {
      return createUnavailableTerminalNativeAvailability(
        'accessibility-unproven',
        'Native terminal renderer accessibility has not been accepted for default selection.',
      );
    }
    return normalized;
  }

  return createUnavailableTerminalNativeAvailability(
    'native-module-missing',
    'HappierTerminalNative is not linked in this native build.',
  );
}

export function getTerminalNativeAvailabilityDiagnostic(
  options: TerminalNativeAvailabilityOptions = {},
): TerminalNativeAvailabilityDiagnostic {
  const availability = getTerminalNativeAvailability(options);
  return {
    availability,
    fallbackRenderer: 'xterm-webview',
    fallbackRequired: isTerminalNativeFallbackRequired(availability),
    blockers: availability.available
      ? []
      : [typeof availability.detail === 'string'
        ? { reason: availability.reason, detail: availability.detail }
        : { reason: availability.reason }],
  };
}

export function isTerminalNativeFallbackRequired(availability: TerminalNativeAvailability): boolean {
  return !availability.available || availability.accessibility !== 'native';
}

function isTerminalNativePlatform(value: TerminalNativeRuntimePlatform): value is TerminalNativePlatform {
  return value === 'ios' || value === 'android';
}

function rendererMatchesPlatform(platform: TerminalNativePlatform, renderer: TerminalNativeRenderer): boolean {
  return (
    (platform === 'ios' && renderer === 'ios-ghosttykit') ||
    (platform === 'android' && renderer === 'android-termux')
  );
}

function isTerminalNativeUnavailableReason(value: unknown): value is TerminalNativeUnavailableReason {
  return (
    value === 'unsupported-platform' ||
    value === 'native-module-missing' ||
    value === 'feature-disabled' ||
    value === 'build-not-included' ||
    value === 'legal-not-approved' ||
    value === 'dependency-closure-unapproved' ||
    value === 'package-proof-unaccepted' ||
    value === 'artifact-missing' ||
    value === 'abi-unsupported' ||
    value === 'renderer-unavailable' ||
    value === 'surface-not-ready' ||
    value === 'accessibility-unproven'
  );
}
