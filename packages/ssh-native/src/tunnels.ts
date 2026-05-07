import { getNativeSshAvailability } from './availability';
import { NativeSshError, normalizeNativeSshError } from './errors';
import { getOptionalHappierSshNativeModule } from './HappierSshNative';

import type {
  NativeSshLoopbackTunnelRequest,
  NativeSshLoopbackTunnelResult,
  NativeSshModule,
} from './HappierSshNative.types';

export async function startNativeSshLoopbackTunnel(params: Readonly<{
  request: NativeSshLoopbackTunnelRequest;
  nativeModule?: NativeSshModule | null;
}>): Promise<NativeSshLoopbackTunnelResult> {
  const nativeModule = params.nativeModule === undefined
    ? getOptionalHappierSshNativeModule()
    : params.nativeModule;
  const availability = getNativeSshAvailability({ nativeModule });
  if (!availability.available) {
    throw new NativeSshError({
      code: 'unavailable',
      reason: availability.reason,
      message: 'Native SSH transport is unavailable.',
      detail: availability.detail,
    });
  }
  if (typeof nativeModule?.startLoopbackTunnel !== 'function') {
    throw new NativeSshError({
      code: 'engine-internal',
      message: 'Native SSH loopback tunnels are not implemented by this build.',
    });
  }

  try {
    return await nativeModule.startLoopbackTunnel(params.request);
  } catch (error) {
    throw normalizeNativeSshError(error);
  }
}

export async function stopNativeSshLoopbackTunnel(params: Readonly<{
  nativeTunnelId: string;
  nativeModule?: NativeSshModule | null;
}>): Promise<void> {
  const nativeModule = params.nativeModule === undefined
    ? getOptionalHappierSshNativeModule()
    : params.nativeModule;
  if (typeof nativeModule?.stopLoopbackTunnel !== 'function') {
    return;
  }
  try {
    await nativeModule.stopLoopbackTunnel(params.nativeTunnelId);
  } catch (error) {
    throw normalizeNativeSshError(error);
  }
}
