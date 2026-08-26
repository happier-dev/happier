import { validateManagedLimaInstanceName } from './profiles.mjs';
import { resolveManagedLimaPressureProfile } from './pressure_profiles.mjs';

export async function configureManagedLimaGuestPressure({
  executor,
  instance: rawInstance,
  profile: rawProfile,
  scriptSource,
}) {
  if (!executor || typeof executor.capture !== 'function') {
    throw new Error('[managed-lima] executor is required');
  }
  const instance = validateManagedLimaInstanceName(rawInstance);
  const profile = resolveManagedLimaPressureProfile(rawProfile?.name ?? rawProfile);
  const source = String(scriptSource ?? '');
  if (!source.trim()) throw new Error('[managed-lima] guest pressure script is empty');

  const result = await executor.capture('limactl', [
    'shell', instance, '--',
    'env',
    `HAPPIER_SWAP_GIB=${profile.swapGiB}`,
    `HAPPIER_ZSWAP=${profile.zswap ? '1' : '0'}`,
    `HAPPIER_SWAP_FREE_RESERVE_GIB=${profile.freeSpaceReserveGiB}`,
    'bash', '-s',
  ], { input: source });
  if (result.exitCode !== 0) {
    const detail = String(result.err || result.out || '').trim();
    throw new Error(`[managed-lima] guest pressure configuration failed: ${detail || 'limactl shell failed'}`);
  }
  const line = String(result.out ?? '').trim().split('\n').at(-1) ?? '';
  let observed;
  try {
    observed = JSON.parse(line);
  } catch {
    throw new Error('[managed-lima] guest pressure configuration returned invalid status');
  }
  return { profile: profile.name, ...observed };
}
