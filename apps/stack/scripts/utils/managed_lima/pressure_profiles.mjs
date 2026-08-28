const PRESSURE_PROFILES = Object.freeze({
  none: Object.freeze({ swapGiB: 0, zswap: false }),
  swap64: Object.freeze({ swapGiB: 64, zswap: false }),
  'swap64-zswap': Object.freeze({ swapGiB: 64, zswap: true }),
  swap128: Object.freeze({ swapGiB: 128, zswap: false }),
  'swap128-zswap': Object.freeze({ swapGiB: 128, zswap: true }),
  swap256: Object.freeze({ swapGiB: 256, zswap: false }),
  'swap256-zswap': Object.freeze({ swapGiB: 256, zswap: true }),
});

const FREE_SPACE_RESERVE_GIB = 32;

export function resolveManagedLimaPressureProfile(value = 'none') {
  const name = String(value ?? '').trim().toLowerCase();
  const profile = PRESSURE_PROFILES[name];
  if (!profile) {
    throw new Error(`[managed-lima] unknown managed Lima pressure profile: ${JSON.stringify(name)}`);
  }
  return {
    name,
    swapGiB: profile.swapGiB,
    zswap: profile.zswap,
    freeSpaceReserveGiB: FREE_SPACE_RESERVE_GIB,
  };
}
