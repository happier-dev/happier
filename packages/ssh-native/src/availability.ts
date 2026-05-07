import { getOptionalHappierSshNativeModule } from './HappierSshNative';

import type {
  NativeSshAvailability,
  NativeSshEngine,
  NativeSshModule,
  NativeSshUnavailableReason,
} from './HappierSshNative.types';

export type NativeSshRuntimePlatform = 'ios' | 'android' | 'web' | 'desktop' | 'unknown';

export type NativeSshAvailabilityOptions = Readonly<{
  nativeModule?: NativeSshModule | null;
  platform?: NativeSshRuntimePlatform;
  buildIncluded?: boolean;
}>;

const AVAILABLE_PLATFORMS = new Set<NativeSshRuntimePlatform>(['ios', 'android']);
const ENGINES = new Set<NativeSshEngine>(['russh', 'libssh2']);

export function createUnavailableNativeSshAvailability(
  reason: NativeSshUnavailableReason,
  detail?: string,
): NativeSshAvailability {
  return detail ? { available: false, reason, detail } : { available: false, reason };
}

export function normalizeNativeSshAvailability(value: unknown): NativeSshAvailability {
  if (!value || typeof value !== 'object') {
    return createUnavailableNativeSshAvailability(
      'engine-unavailable',
      'HappierSshNative returned an invalid availability payload.',
    );
  }

  const payload = value as Partial<NativeSshAvailability>;
  if (payload.available === true) {
    const platform = payload.platform;
    const engine = payload.engine;
    const moduleVersion = payload.moduleVersion;
    if ((platform === 'ios' || platform === 'android') && ENGINES.has(engine as NativeSshEngine) && typeof moduleVersion === 'string' && moduleVersion.length > 0) {
      return {
        available: true,
        platform,
        engine: engine as NativeSshEngine,
        moduleVersion,
        supportsLoopbackTunnel: payload.supportsLoopbackTunnel === true,
        supportsPersistentHostKeyStorage: payload.supportsPersistentHostKeyStorage === true,
      };
    }
    return createUnavailableNativeSshAvailability(
      'engine-unavailable',
      'HappierSshNative returned an invalid availability payload.',
    );
  }

  if (payload.available === false && isNativeSshUnavailableReason(payload.reason)) {
    return typeof payload.detail === 'string'
      ? createUnavailableNativeSshAvailability(payload.reason, payload.detail)
      : createUnavailableNativeSshAvailability(payload.reason);
  }

  return createUnavailableNativeSshAvailability(
    'engine-unavailable',
    'HappierSshNative returned an invalid availability payload.',
  );
}

export function getNativeSshAvailability(options: NativeSshAvailabilityOptions = {}): NativeSshAvailability {
  if (options.buildIncluded === false) {
    return createUnavailableNativeSshAvailability('build-not-included', 'Native SSH transport was excluded at build time.');
  }

  const nativeModule = options.nativeModule === undefined ? getOptionalHappierSshNativeModule() : options.nativeModule;
  if (nativeModule) {
    try {
      return normalizeNativeSshAvailability(nativeModule.getAvailability());
    } catch {
      return createUnavailableNativeSshAvailability('engine-unavailable', 'HappierSshNative availability check failed.');
    }
  }

  const platform = options.platform ?? 'unknown';
  if (!AVAILABLE_PLATFORMS.has(platform)) {
    return createUnavailableNativeSshAvailability(
      'unsupported-platform',
      'Native SSH transport is only available on iOS and Android native builds.',
    );
  }

  return createUnavailableNativeSshAvailability(
    'native-module-missing',
    'HappierSshNative is not linked in this native build.',
  );
}

function isNativeSshUnavailableReason(value: unknown): value is NativeSshUnavailableReason {
  return (
    value === 'unsupported-platform' ||
    value === 'native-module-missing' ||
    value === 'feature-disabled' ||
    value === 'build-not-included' ||
    value === 'engine-unavailable'
  );
}
