import cliDistBuildManifest from '../../cliDistBuildManifest.cjs';
import { resolveWorkspaceBuildMode } from '../../workspaceChildBuildEnv.mjs';

export async function shouldReuseCliDistSnapshot(params: Readonly<{
  distEntrypointPath: string;
  requiredInputFingerprint?: string;
  env?: NodeJS.ProcessEnv;
}>): Promise<boolean> {
  const requiredInputFingerprint = String(params.requiredInputFingerprint ?? '')
    .trim()
    .toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(requiredInputFingerprint)) return false;
  const distManifest = cliDistBuildManifest.readCliDistBuildManifest(params.distEntrypointPath);
  return distManifest.ok
    && (!distManifest.manifest?.stalePackages?.length || resolveWorkspaceBuildMode({ env: params.env ?? process.env }) === 'qa-runtime')
    && distManifest.manifest?.inputFingerprint === requiredInputFingerprint;
}
