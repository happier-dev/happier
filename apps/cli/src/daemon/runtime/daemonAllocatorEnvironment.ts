/**
 * glibc allocator settings for the resident daemon process only (LEAN-DAEMON U5, owner decision D3).
 * Two arenas and low trim/mmap thresholds return idle memory to the OS; measured on the shipped Node
 * payload (daemon only, children not inheriting): daemon RSS at N=0 545 -> 472 MiB, paired n=3.
 * glibc reads GLIBC_TUNABLES once at exec, so the launch owners add it and the daemon removes it from
 * its own environment at start: Session hosts, workers and Agents never inherit it. musl and the
 * other platforms ignore it; it is added on Linux only. A person's own GLIBC_TUNABLES always wins.
 */
export const DAEMON_GLIBC_TUNABLES = 'glibc.malloc.arena_max=2:glibc.malloc.trim_threshold=65536:glibc.malloc.mmap_threshold=65536';

export function withDaemonAllocatorEnvironment<T extends Record<string, string | undefined>>(env: T, platform: NodeJS.Platform): T {
  if (platform !== 'linux' || env.GLIBC_TUNABLES !== undefined) return env;
  return { ...env, GLIBC_TUNABLES: DAEMON_GLIBC_TUNABLES };
}

export function releaseDaemonAllocatorEnvironment(env: NodeJS.ProcessEnv): void {
  if (env.GLIBC_TUNABLES === DAEMON_GLIBC_TUNABLES) delete env.GLIBC_TUNABLES;
}
