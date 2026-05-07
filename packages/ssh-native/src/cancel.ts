import { NativeSshError, normalizeNativeSshError } from './errors';
import { getOptionalHappierSshNativeModule } from './HappierSshNative';

import type { NativeSshModule } from './HappierSshNative.types';

export async function cancelNativeSshRequest(params: Readonly<{
  requestId: string;
  nativeModule?: NativeSshModule | null;
}>): Promise<void> {
  const requestId = params.requestId.trim();
  if (!requestId) {
    throw new NativeSshError({
      code: 'engine-internal',
      message: 'Invalid native SSH cancellation request.',
    });
  }

  const nativeModule = params.nativeModule === undefined
    ? getOptionalHappierSshNativeModule()
    : params.nativeModule;
  if (typeof nativeModule?.cancelRequest !== 'function') {
    return;
  }

  try {
    await nativeModule.cancelRequest(requestId);
  } catch (error) {
    throw normalizeNativeSshError(error);
  }
}
