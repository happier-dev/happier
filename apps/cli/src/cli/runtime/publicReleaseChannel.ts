import {
  resolveManagedCliReleaseChannelSync,
} from '@happier-dev/cli-common/firstPartyRuntime';
import {
  getReleaseRingCatalogEntry,
  type PublicReleaseRingId,
} from '@happier-dev/release-runtime/releaseRings';

export function inferPublicReleaseRingIdFromEnvAndArgv(params: Readonly<{
  env: NodeJS.ProcessEnv;
  argv: readonly string[];
  argv0?: string | null;
  execPath?: string | null;
  additionalCandidates?: readonly string[];
}>): PublicReleaseRingId {
  return resolveManagedCliReleaseChannelSync({
    argv: params.argv,
    argv0: params.argv0,
    execPath: params.execPath,
    processEnv: params.env,
    additionalCandidates: params.additionalCandidates,
  }).ringId;
}

export function resolvePublicReleaseRingIdFromCliArgs(params: Readonly<{
  args: readonly string[];
  invokedPath: string;
}>): PublicReleaseRingId {
  return resolveManagedCliReleaseChannelSync({
    args: params.args,
    invokedPath: params.invokedPath,
    markerFallback: 'never',
  }).ringId;
}

export function resolvePublicReleaseRingRollingSuffix(
  ring: PublicReleaseRingId | undefined | null,
): 'stable' | 'preview' | 'dev' {
  const resolved: PublicReleaseRingId = ring ?? 'stable';
  // Public release rings always define rolling suffixes.
  return getReleaseRingCatalogEntry(resolved).rollingReleaseSuffix ?? (resolved === 'publicdev' ? 'dev' : resolved);
}

export function resolveReleaseRingScopedBasename(base: string, ring: PublicReleaseRingId | undefined | null): string {
  const name = String(base ?? '').trim();
  if (!name) {
    throw new Error('base is required');
  }
  const resolved: PublicReleaseRingId = ring ?? 'stable';
  if (resolved === 'stable') return name;
  return `${name}.${resolvePublicReleaseRingRollingSuffix(resolved)}`;
}

export function resolveDaemonStateBasenameForRing(ring: PublicReleaseRingId | undefined | null): string {
  const resolved: PublicReleaseRingId = ring ?? 'stable';
  if (resolved === 'stable') return 'daemon.state.json';
  return `daemon.${resolvePublicReleaseRingRollingSuffix(resolved)}.state.json`;
}
