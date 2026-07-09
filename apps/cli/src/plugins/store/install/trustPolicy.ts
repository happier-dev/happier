import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

import type { PluginSourceSpecV1 } from '@happier-dev/protocol';
import type { PluginCompatibilityDiagnostic } from '@/plugins/validation/diagnostics/types';

export type LocalPluginInstallTrustDecision = Readonly<{
  trustPolicy: PluginSourceSpecV1['trustPolicy'];
  installPolicy: PluginSourceSpecV1['installPolicy'];
  devWatch: boolean;
  diagnostics: readonly PluginCompatibilityDiagnostic[];
}>;

async function isPathInsideRoot(params: Readonly<{
  path: string;
  root?: string;
}>): Promise<boolean> {
  const root = typeof params.root === 'string' ? params.root.trim() : '';
  if (!root) {
    return false;
  }

  let rootRealPath: string;
  try {
    rootRealPath = await realpath(resolve(root));
  } catch {
    return false;
  }

  const relativePath = relative(rootRealPath, params.path);
  return relativePath === '' || (!!relativePath && !relativePath.startsWith('..') && !isAbsolute(relativePath));
}

export async function resolveLocalPluginInstallTrust(params: Readonly<{
  dev?: boolean;
  pluginRootPath: string;
  workspaceRoot?: string;
  sourceSpecOverride?: PluginSourceSpecV1;
  defaultTrustPolicy: PluginSourceSpecV1['trustPolicy'];
  defaultInstallPolicy: PluginSourceSpecV1['installPolicy'];
}>): Promise<LocalPluginInstallTrustDecision> {
  const override = params.sourceSpecOverride?.kind === 'path' ? params.sourceSpecOverride : null;
  if (params.dev === true) {
    const workspaceLocal = await isPathInsideRoot({
      path: params.pluginRootPath,
      root: params.workspaceRoot,
    });
    const diagnostics = workspaceLocal
      ? []
      : [{
          code: 'plugin_trust_approval_required',
          message: [
            `Dev install requested for '${params.pluginRootPath}', but that path is outside the current workspace root '${resolve(params.workspaceRoot ?? '')}'.`,
            `The plugin remains trustPolicy:'prompt' and executable daemon code will not load until trust is approved.`,
            `Install from within the workspace containing the plugin, or run 'happier plugins install . --dev' from the plugin root.`,
          ].join(' '),
        } satisfies PluginCompatibilityDiagnostic];
    return {
      trustPolicy: workspaceLocal ? 'local_trusted' : 'prompt',
      installPolicy: 'link',
      devWatch: workspaceLocal,
      diagnostics,
    };
  }

  return {
    trustPolicy: override?.trustPolicy ?? params.defaultTrustPolicy,
    installPolicy: override?.installPolicy ?? params.defaultInstallPolicy,
    devWatch: false,
    diagnostics: [],
  };
}
