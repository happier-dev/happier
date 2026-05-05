import { PET_DAEMON_RPC_DEBOUNCE_LIMITS_V1 } from '@happier-dev/protocol';

export type PetRpcRateLimitOperation =
  | 'discoverPackages'
  | 'validatePackage'
  | 'importPackage'
  | 'forgetLocalPackage'
  | 'readPreviewAsset';

export type PetRpcRateLimiter = Readonly<{
  tryConsume(operation: PetRpcRateLimitOperation): boolean;
}>;

const DEFAULT_MIN_INTERVALS_MS: Readonly<Record<PetRpcRateLimitOperation, number>> = {
  discoverPackages: PET_DAEMON_RPC_DEBOUNCE_LIMITS_V1.discoverPackagesMinIntervalMs,
  validatePackage: PET_DAEMON_RPC_DEBOUNCE_LIMITS_V1.validatePackageMinIntervalMs,
  importPackage: PET_DAEMON_RPC_DEBOUNCE_LIMITS_V1.importPackageMinIntervalMs,
  forgetLocalPackage: PET_DAEMON_RPC_DEBOUNCE_LIMITS_V1.forgetLocalPackageMinIntervalMs,
  readPreviewAsset: PET_DAEMON_RPC_DEBOUNCE_LIMITS_V1.readPreviewAssetMinIntervalMs,
};

export function createPetRpcRateLimiter(options: Readonly<{
  minIntervalsMs?: Partial<Record<PetRpcRateLimitOperation, number>>;
  nowMs?: () => number;
}> = {}): PetRpcRateLimiter {
  const nowMs = options.nowMs ?? Date.now;
  const acceptedAtByOperation = new Map<PetRpcRateLimitOperation, number>();

  return {
    tryConsume(operation) {
      const minIntervalMs = options.minIntervalsMs?.[operation] ?? DEFAULT_MIN_INTERVALS_MS[operation];
      const now = nowMs();
      const previous = acceptedAtByOperation.get(operation);
      if (previous !== undefined && now - previous < minIntervalMs) {
        return false;
      }
      acceptedAtByOperation.set(operation, now);
      return true;
    },
  };
}
