import type {
  PluginInstallReviewPrincipalDigest,
  PluginInstallReviewPrincipalPresentationV1,
} from '@happier-dev/protocol';

import { createPluginRegistryStateStore } from '@/plugins/store/registry/currentState';
import { pluginInstallReviewPrincipalPresentationMatchesDigest } from '@/plugins/daemon/installReviewPrincipal';
import type { CurrentPluginInstallReviewPrincipalReader } from './rawCredentialMaterializer';

type InstallReviewPrincipalSnapshotReader = Readonly<{
  readSnapshot(): Promise<Readonly<{
    installReviewPrincipalDigestsByPluginId: Readonly<
      Record<string, PluginInstallReviewPrincipalDigest>
    >;
    installReviewPrincipalPresentationsByPluginId: Readonly<
      Record<string, PluginInstallReviewPrincipalPresentationV1>
    >;
  }>>;
}>;

/**
 * Adapts the registry's one atomic snapshot to raw-credential authorization.
 * Runtime G currentness is deliberately owned by the materializer's admitted-runtime port:
 * an ordinary same-principal G→H install must not retire retained G authority.
 */
export function createRegistryInstallReviewPrincipalReader(input: Readonly<{
  happyHomeDir?: string;
  snapshotReader?: InstallReviewPrincipalSnapshotReader;
}> = {}): CurrentPluginInstallReviewPrincipalReader {
  const snapshotReader = input.snapshotReader ?? createPluginRegistryStateStore({
    ...(input.happyHomeDir ? { happyHomeDir: input.happyHomeDir } : {}),
  });
  return Object.freeze({
    async readCurrent({ pluginId, signal }) {
      signal.throwIfAborted();
      const snapshot = await snapshotReader.readSnapshot();
      signal.throwIfAborted();
      const digest = snapshot.installReviewPrincipalDigestsByPluginId[pluginId];
      if (!digest) return null;
      const presentation = snapshot.installReviewPrincipalPresentationsByPluginId[pluginId];
      return Object.freeze({
        digest,
        presentation: presentation
          && pluginInstallReviewPrincipalPresentationMatchesDigest(digest, presentation)
          ? presentation
          : null,
      });
    },
  });
}
