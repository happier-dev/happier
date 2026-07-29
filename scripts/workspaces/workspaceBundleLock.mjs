// Repository-facing compatibility path. The dependency-free canonical implementation lives in
// cli-common so build scripts, stack orchestration, and bundled component tooling share one owner.
export * from '../../packages/cli-common/workspaceBundleLock.mjs';
