import type { CreateSessionRuntimeParamsV1 } from '@happier-dev/plugin-sdk';

const OPENCODE_PROVIDER_CONFIG_RELATIVE_PATH = 'opencode/opencode.json';

export function applyOpenCodeProviderBindingToSessionParams(
  sessionParams: CreateSessionRuntimeParamsV1,
): CreateSessionRuntimeParamsV1 {
  const materialization = sessionParams.providerBindingMaterialization;
  if (!materialization) return sessionParams;
  if (materialization.kind !== 'configFile') {
    throw new Error('OpenCode requires config-file provider materialization');
  }
  const relativePaths = materialization.relativePaths.map((value) => value.replaceAll('\\', '/'));
  if (relativePaths.length !== 1 || relativePaths[0] !== OPENCODE_PROVIDER_CONFIG_RELATIVE_PATH) {
    throw new Error('OpenCode provider materialization is missing its canonical config file');
  }

  return {
    ...sessionParams,
    env: {
      ...(sessionParams.env ?? {}),
      XDG_CONFIG_HOME: materialization.rootPath,
    },
  };
}
