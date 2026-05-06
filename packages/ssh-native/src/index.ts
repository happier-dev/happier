export { HAPPIER_SSH_NATIVE_MODULE_NAME, getOptionalHappierSshNativeModule } from './HappierSshNative';
export {
  createUnavailableNativeSshAvailability,
  getNativeSshAvailability,
  normalizeNativeSshAvailability,
} from './availability';
export { NativeSshError, normalizeNativeSshError } from './errors';
export { normalizeHostKeyFingerprintSha256 } from './hostKey';

import { getNativeSshAvailability } from './availability';
import { NativeSshError, normalizeNativeSshError } from './errors';
import { getOptionalHappierSshNativeModule } from './HappierSshNative';

import type {
  NativeSshAvailability,
  NativeSshAuthRequest,
  NativeSshEngine,
  NativeSshExecRequest,
  NativeSshExecResult,
  NativeSshHostKeyPromptEvent,
  NativeSshHostKeyVerification,
  NativeSshModule,
  NativeSshProgressEvent,
  NativeSshSubscription,
  NativeSshUnavailableReason,
} from './HappierSshNative.types';

export type {
  NativeSshAvailability,
  NativeSshAuthRequest,
  NativeSshEngine,
  NativeSshExecRequest,
  NativeSshExecResult,
  NativeSshHostKeyPromptEvent,
  NativeSshHostKeyVerification,
  NativeSshModule,
  NativeSshProgressEvent,
  NativeSshSubscription,
  NativeSshUnavailableReason,
} from './HappierSshNative.types';
export type { NativeSshAvailabilityOptions, NativeSshRuntimePlatform } from './availability';
export type { NativeSshErrorCode, NativeSshErrorInit } from './errors';

export async function executeNativeSshCommand(request: NativeSshExecRequest): Promise<NativeSshExecResult> {
  const nativeModule = getOptionalHappierSshNativeModule();
  const availability = getNativeSshAvailability({ nativeModule });
  if (!availability.available) {
    throw new NativeSshError({
      code: 'unavailable',
      reason: availability.reason,
      message: 'Native SSH transport is unavailable.',
      detail: availability.detail,
    });
  }

  if (!nativeModule) {
    throw new NativeSshError({
      code: 'unavailable',
      reason: 'native-module-missing',
      message: 'Native SSH transport is unavailable.',
    });
  }

  try {
    return await nativeModule.exec(request);
  } catch (error) {
    throw normalizeNativeSshError(error);
  }
}
