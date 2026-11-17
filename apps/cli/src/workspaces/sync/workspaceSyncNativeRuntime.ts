import {
  assertMutagenEngineArtifactPayload, ensureInstalledFirstPartyComponent, MUTAGEN_ENGINE_VERSION,
  resolveInstalledFirstPartyComponentPaths, resolveMutagenEngineArtifactPaths, resolveMutagenEngineArtifactTarget,
  type MutagenEngineArtifactTarget,
} from '@happier-dev/cli-common/firstPartyRuntime';
import type { PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';

/** The native process that executes the endpoint resolves its own verified
 * artifact. A controller's executable path is never a guest executable path. */
export async function resolveWorkspaceSyncNativeRuntime(input: Readonly<{
  releaseChannel: PublicReleaseRingId;
  resolveInstalled?: (input: Readonly<{ componentId: 'mutagen-engine'; channel: PublicReleaseRingId }>) => Readonly<{ currentPath: string; resolvedCurrentPath: string | null }>;
  ensureInstalled?: typeof ensureInstalledFirstPartyComponent;
  resolvePaths?: (payloadRoot: string, targetTriple: MutagenEngineArtifactTarget) => Readonly<{ managerPath: string; agentPath: string }>;
  assertPayload?: (input: Readonly<{ payloadRoot: string; targetTriple: MutagenEngineArtifactTarget; engineVersion?: string }>) => Readonly<{ engineVersion: string; protocolEpoch: string }> | Promise<Readonly<{ engineVersion: string; protocolEpoch: string }>>;
  resolveTarget?: typeof resolveMutagenEngineArtifactTarget;
}>) {
  const targetTriple = (input.resolveTarget ?? resolveMutagenEngineArtifactTarget)();
  const validatePayload = (payloadRoot: string) => (input.assertPayload ?? assertMutagenEngineArtifactPayload)({
    payloadRoot, targetTriple, engineVersion: MUTAGEN_ENGINE_VERSION,
  });
  let installed: Readonly<{ currentPath: string; resolvedCurrentPath: string | null }>;
  let manifest: Readonly<{ engineVersion: string; protocolEpoch: string }>;
  try {
    installed = (input.resolveInstalled ?? resolveInstalledFirstPartyComponentPaths)({ componentId: 'mutagen-engine', channel: input.releaseChannel });
    manifest = await validatePayload(installed.resolvedCurrentPath ?? installed.currentPath);
  } catch {
    installed = await (input.ensureInstalled ?? ensureInstalledFirstPartyComponent)({ componentId: 'mutagen-engine',
      channel: input.releaseChannel, versionId: MUTAGEN_ENGINE_VERSION, validatePayload });
    manifest = await validatePayload(installed.resolvedCurrentPath ?? installed.currentPath);
  }
  const paths = (input.resolvePaths ?? resolveMutagenEngineArtifactPaths)(installed.resolvedCurrentPath ?? installed.currentPath, targetTriple);
  return { managerPath: paths.managerPath, agentPath: paths.agentPath, manifest };
}
